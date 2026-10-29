import { encodeAudio, SAMPLE_RATE, validateEndpoint, VERSION } from "../shared/protocol.ts";
import type { Channel, ServerMessage } from "../shared/protocol.ts";
import { idle } from "./state.ts";
import type { Settings, State, Tab } from "./state.ts";

let state: State = idle();
let socket: WebSocket | undefined;
let context: AudioContext | undefined;
let streams: MediaStream[] = [];
let nodes: AudioWorkletNode[] = [];
let unacked = new Set<string>();
let lastPublish = 0;
let stopping = false;
let showText = true;

function setPreview(enabled: boolean) {
  showText = enabled;
  if (state.fullRecording && !enabled && state.status === "recording") { state.lines = []; state.warning = undefined; publish(); }
  if (state.fullRecording && state.status === "recording" && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "preview", enabled: showText }));
  }
}

function publish(force = true) {
  if (!force && Date.now() - lastPublish < 200) return;
  lastPublish = Date.now();
  void chrome.runtime.sendMessage({ target: "background", action: "state", state }).catch(() => {});
}
async function release() {
  streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  streams = [];
  nodes.forEach((node) => { node.port.onmessage = null; node.disconnect(); }); nodes = [];
  await context?.close().catch(() => {}); context = undefined;
  state.levels = { tab: 0, mic: 0 };
}
async function fail(error: unknown) {
  state.error = error instanceof Error ? error.message : String(error);
  state.status = "error";
  state.endedAt ??= Date.now();
  if (state.fullRecording) state.lines = [];
  stopping = true;
  await release();
  socket?.close(); socket = undefined;
  publish();
}
async function attach(stream: MediaStream, channel: Channel) {
  streams.push(stream);
  const source = context!.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context!, "scribe-recorder");
  let sequence = 0;
  recorder.port.onmessage = ({ data }) => {
    if (data.type === "level") { state.levels[channel] = data.value; publish(false); }
    if (data.type === "audio") {
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (unacked.size >= 12 || socket.bufferedAmount > 4 * 1024 * 1024) {
        void fail(new Error("Распознавание не успевает за записью. Запись остановлена, проверьте OpenClaw.")); return;
      }
      unacked.add(`${channel}:${sequence}`);
      socket.send(encodeAudio({ channel, sequence: sequence++, samples: data.samples, offsetMs: data.offsetMs }));
    }
  };
  source.connect(recorder).connect(context!.destination);
  stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => { if (!stopping) void stop(); }));
  nodes.push(recorder);
}

async function start(request: { streamId: string; tab: Tab; settings: Settings }) {
  if (state.status === "recording" || state.status === "starting" || state.status === "stopping") throw new Error("Запись уже запущена");
  const config = request.settings;
  showText = config.showText;
  const endpoint = validateEndpoint(config.url);
  if (!config.token.trim()) throw new Error("Укажите токен из openclaw scribe pair");
  state = { ...idle(), status: "starting", tab: request.tab, diarization: config.diarization, saveAudio: config.saveAudio,
    fullRecording: config.diarization || config.saveAudio, microphone: config.microphone }; stopping = false;
  unacked = new Set(); publish();
  // Consume Chrome's one-use stream ID immediately, before waiting for network/native startup.
  const constraints = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: request.streamId } } as unknown as MediaTrackConstraints;
  const tabStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }).catch((error: DOMException) => {
    throw new Error(`Не удалось захватить звук вкладки: ${error.message} (${error.name})`);
  });
  streams.push(tabStream);
  context = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (context.sampleRate !== SAMPLE_RATE) throw new Error("Браузер не поддерживает захват 16 kHz");
  context.createMediaStreamSource(tabStream).connect(context.destination); // tabCapture otherwise mutes playback.
  await context.resume();
  const connection = new WebSocket(endpoint);
  socket = connection;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenClaw не ответил за 20 секунд")), 20_000);
    const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    connection.onopen = () => connection.send(JSON.stringify({
      type: "start", version: VERSION, token: config.token.trim(), title: request.tab.title,
      url: request.tab.url, language: config.language, diarization: config.diarization, saveAudio: config.saveAudio, preview: showText,
    }));
    connection.onerror = () => done(new Error("Нет соединения с плагином OpenClaw"));
    connection.onclose = () => {
      if (socket !== connection) return;
      if (state.status === "starting") done(new Error("OpenClaw закрыл соединение"));
      else if (state.status !== "idle" && state.status !== "done" && state.status !== "error") void fail(new Error("Соединение прервано. Запись остановлена."));
    };
    connection.onmessage = ({ data }) => {
      if (socket !== connection) return;
      const event = JSON.parse(String(data)) as ServerMessage;
      if (event.type === "ready") {
        if (config.diarization && event.diarization !== true) { done(new Error("Обновите плагин OpenClaw Scribe для разделения собеседников")); return; }
        if (config.diarization && typeof event.preview !== "boolean") { done(new Error("Обновите плагин OpenClaw Scribe для независимого демо и обработки после записи")); return; }
        if (state.fullRecording && event.fullRecording !== true) { done(new Error("Обновите плагин OpenClaw Scribe для сохранения аудио и полной записи")); return; }
        if (config.saveAudio && event.saveAudio !== true) { done(new Error("Плагин не подтвердил сохранение аудио. Обновите OpenClaw Scribe")); return; }
        if (state.fullRecording) connection.send(JSON.stringify({ type: "preview", enabled: showText }));
        state.sessionId = event.sessionId; done();
      }
      if (event.type === "ack") unacked.delete(`${event.channel}:${event.sequence}`);
      if (event.type === "line" && (!state.fullRecording || (showText && state.status === "recording"))) { state.lines = [...state.lines, event.line].slice(-100); publish(); }
      if (event.type === "transcript") { state.lines = event.lines.slice(-100); publish(); }
      if (event.type === "warning") { state.warning = event.message; publish(); }
      if (event.type === "progress") {
        state.progress = event.stage === "diarization" ? "Разделение голосов…" : `Итоговый текст: ${event.done}/${event.total}`;
        publish();
      }
      if (event.type === "error") {
        if (event.audio) state.audio = event.audio;
        if (state.status === "starting") done(new Error(event.message));
        else void fail(new Error(event.message));
      }
      if (event.type === "stopped") {
        state.status = "done"; state.audio = event.audio; state.progress = undefined; state.warning = undefined; stopping = true;
        void release().then(() => { publish(); connection.close(); if (socket === connection) socket = undefined; });
      }
    };
  });
  let micStream: MediaStream | undefined;
  if (config.microphone !== "none") {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(config.microphone !== "default" ? { deviceId: { exact: config.microphone } } : {}),
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
    } catch {
      throw new Error("Нет доступа к выбранному микрофону. Разрешите его в настройках расширения или выберите «Без микрофона».");
    }
    streams.push(micStream);
  }
  await context.audioWorklet.addModule("worklet.js");
  streams = []; // attach takes ownership of both streams.
  await attach(tabStream, "tab");
  if (micStream) await attach(micStream, "mic");
  await context.resume();
  state.startedAt = Date.now(); state.status = "recording"; publish();
}

async function stop() {
  if (stopping || state.status !== "recording") return;
  stopping = true; state.status = "stopping"; state.endedAt = Date.now(); state.warning = undefined;
  if (state.fullRecording) state.lines = [];
  publish();
  await Promise.all(nodes.map((node) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Не удалось завершить аудиодорожку")), 3000);
    const onMessage = ({ data }: MessageEvent) => {
      if (data.type !== "flushed") return;
      clearTimeout(timer); node.port.removeEventListener("message", onMessage); resolve();
    };
    node.port.addEventListener("message", onMessage); node.port.postMessage("flush");
  })));
  await release(); publish();
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("Соединение прервано до сохранения стенограммы");
  socket.send(JSON.stringify({ type: "stop" }));
}

chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  if (request.target !== "offscreen") return;
  if (request.action === "preview" && typeof request.enabled === "boolean") {
    setPreview(request.enabled); respond({ ok: true }); return;
  }
  const run = request.action === "start" ? start(request) : stop();
  void run.then(() => respond({ ok: true }), async (error) => {
    await fail(error); respond({ error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
