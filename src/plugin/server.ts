import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { VerifyClientCallbackSync } from "ws";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { decodeAudio, hasAudio, MAX_AUDIO_BYTES, parseHello, SAMPLE_RATE } from "../shared/protocol.ts";
import type { AudioChunk, AudioRecording, Hello, ServerMessage } from "../shared/protocol.ts";
import type { CapturedLine } from "./diarization.ts";
import type { RecordingSession } from "./recording.ts";

type Provider = Parameters<OpenClawPluginApi["registerTranscriptSourceProvider"]>[0];
type Capture = Parameters<NonNullable<Provider["start"]>>[0];
type Watch = Parameters<NonNullable<Provider["watchOccupancy"]>>[0];
type Recording = {
  socket: WebSocket; hello: Hello; capture?: Capture; work: Promise<void>;
  pending: number; sequence: { tab: number; mic: number }; closing: boolean;
  ready: (sessionId: string) => void; rejectReady: (error: Error) => void; end?: Promise<void>;
  staged?: RecordingSession; failure?: Error;
  previewEnabled: boolean; previewEpoch: number; previewPending: number; previewWork: Promise<void>;
};
export type ScribeOptions = {
  token: string; port: number; extensionIds?: string[];
  transcribe: (chunk: AudioChunk, language: string) => Promise<string>;
  createRecording?: (hello: Hello, sessionId: string) => Promise<RecordingSession>;
  diarizationAvailable?: boolean;
  openRecording?: (id: string, recovery: boolean) => Promise<void>;
  warn: (message: string) => void;
};
const send = (socket: WebSocket, value: ServerMessage) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
};
const message = (error: unknown) => error instanceof Error ? error.message : "Recording failed";

export function createScribe(options: ScribeOptions) {
  let watcher: Watch | undefined;
  let recording: Recording | undefined;
  let server: WebSocketServer | undefined;

  async function commit(current: Recording, line: CapturedLine, id: string) {
    const started = Date.parse(current.capture!.session.startedAt);
    await current.capture!.onUtterance({
      id: `${current.capture!.session.sessionId}:${id}`, sessionId: current.capture!.session.sessionId,
      startedAt: new Date(started + line.offsetMs).toISOString(),
      endedAt: new Date(started + line.offsetMs + line.durationMs).toISOString(),
      speaker: { id: line.speakerId, label: line.speaker }, text: line.text, final: true,
    });
  }

  async function finish(current: Recording, notify = true) {
    if (current.end) return current.end;
    current.closing = true;
    current.end = (async () => {
      await current.work;
      // Finish the one in-flight demo; queued demos are discarded on stop.
      await current.previewWork;
      const capture = current.capture;
      let lines: CapturedLine[] | undefined;
      if (current.failure) throw current.failure;
      if (capture && current.staged) {
        if (current.hello.diarization) send(current.socket, { type: "progress", stage: "diarization", done: 0, total: 0 });
        lines = await current.staged.finalize(options.transcribe, (done, total) => send(current.socket, { type: "progress", stage: "transcription", done, total }));
        // Demo text never enters native storage, final ASR, or a fallback.
        for (const [index, line] of lines.entries()) await commit(current, line, `final:${index}`);
      }
      if (capture && notify) {
        await capture.onStatus?.({ sessionId: capture.session.sessionId, active: false, source: capture.session.source });
      }
      const audio = await current.staged?.complete();
      if (lines) send(current.socket, { type: "transcript", lines: lines.slice(-100) });
      if (capture) send(current.socket, { type: "stopped", sessionId: capture.session.sessionId, audio });
    })().catch(async (error) => {
      let audio: AudioRecording | undefined;
      try { audio = await current.staged?.recover(); } catch { /* Keep the directory even if closing a damaged file failed. */ }
      send(current.socket, { type: "error", audio, message: `Не удалось сохранить стенограмму: ${message(error)}${current.staged ? `. Временная запись: ${current.staged.path}` : ""}` });
      throw error;
    }).finally(() => {
      if (recording === current) recording = undefined;
      // Native capture must stay occupied until final utterances have been delivered.
      watcher?.onEmpty();
      current.socket.close(1000, "Recording ended");
    });
    return current.end;
  }

  const provider: Provider = {
    id: "openclaw-scribe", name: "OpenClaw Scribe", sourceKinds: ["live-audio"],
    async watchOccupancy(request) {
      if (watcher) return { ok: false, error: "Configure only one OpenClaw Scribe transcript source" };
      watcher = request;
      return { ok: true, value: { stop() { if (watcher === request) watcher = undefined; } } };
    },
    async start(request) {
      const current = recording;
      if (!current || current.closing || current.capture) return { ok: false, error: "No browser recording waiting to start" };
      current.capture = request;
      try {
        if (current.hello.diarization || current.hello.saveAudio) {
          current.work = options.createRecording!(current.hello, request.session.sessionId).then((session) => { current.staged = session; });
          await current.work;
        }
        if (current.closing) return { ok: false, error: "Browser recording closed during startup" };
      } catch (error) {
        current.work = Promise.resolve();
        const failure = error instanceof Error ? error : new Error(message(error));
        current.rejectReady(failure); fail(current, failure);
        return { ok: false, error: failure.message };
      }
      current.ready(request.session.sessionId);
      return { ok: true, session: { ...request.session, title: current.hello.title || "Browser recording" } };
    },
    async stop(request) {
      const current = recording;
      if (current?.capture?.session.sessionId === request.sessionId) await finish(current, false);
      return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
    },
    async status(source) {
      return [{ active: Boolean(recording), source, sessionId: recording?.capture?.session.sessionId }];
    },
  };

  function fail(current: Recording, error: unknown) {
    current.failure ??= error instanceof Error ? error : new Error(message(error));
    options.warn(`Scribe capture failed: ${message(error)}`);
    void finish(current).catch((error) => options.warn(`Scribe finalization failed: ${message(error)}`));
  }

  function authenticate(token: unknown) {
    if (typeof token !== "string" || token.length > 256) throw new Error("Invalid pairing token");
    const expected = Buffer.from(options.token);
    const supplied = Buffer.from(token);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("Invalid pairing token");
  }

  async function begin(socket: WebSocket, raw: unknown) {
    const hello = parseHello(raw);
    authenticate(hello.token);
    if (recording) throw new Error("Another recording is already active");
    if (!watcher) throw new Error("Run openclaw scribe setup, then restart the Gateway");
    if (hello.diarization && (options.diarizationAvailable === false || !options.createRecording)) throw new Error("Для разделения собеседников выполните openclaw scribe setup --diarization и перезапустите Gateway");
    if ((hello.diarization || hello.saveAudio) && !options.createRecording) throw new Error("Обновите плагин OpenClaw Scribe для полной записи");
    let resolveReady!: (sessionId: string) => void;
    let rejectReady!: (error: Error) => void;
    const attached = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const current: Recording = {
      socket, hello, work: Promise.resolve(), pending: 0, sequence: { tab: 0, mic: 0 }, closing: false,
      ready: resolveReady, rejectReady,
      previewEnabled: hello.preview === true, previewEpoch: 0, previewPending: 0, previewWork: Promise.resolve(),
    };
    recording = current;
    watcher.onOccupied();
    const timeout = setTimeout(() => {
      const error = new Error("OpenClaw did not start transcript capture within 15 seconds");
      rejectReady(error); fail(current, error);
    }, 15_000);
    try {
      const sessionId = await attached;
      if (!current.closing && socket.readyState === WebSocket.OPEN) send(socket, {
        type: "ready", sessionId, diarization: Boolean(hello.diarization), preview: current.previewEnabled, saveAudio: Boolean(hello.saveAudio), fullRecording: Boolean(current.staged),
      });
    } finally { clearTimeout(timeout); }
  }

  function preview(current: Recording, chunk: AudioChunk) {
    // A slow or failed optional demo must not delay recording or fill its queue.
    if (!current.previewEnabled || current.closing || current.previewPending >= 2 || !hasAudio(chunk.samples)) return;
    const epoch = current.previewEpoch;
    current.previewPending++;
    current.previewWork = current.previewWork.then(async () => {
      if (!current.previewEnabled || current.closing || epoch !== current.previewEpoch) return;
      const text = (await options.transcribe(chunk, current.hello.language)).trim();
      if (text && current.previewEnabled && !current.closing && epoch === current.previewEpoch) {
        send(current.socket, { type: "line", line: {
          speaker: chunk.channel === "mic" ? "Микрофон" : "Вкладка", text, offsetMs: chunk.offsetMs,
        } });
      }
    }).catch(() => {
      if (!current.closing && epoch === current.previewEpoch) send(current.socket, {
        type: "warning", message: "Не удалось распознать демо-фрагмент. Основная запись продолжается; итог будет обработан после остановки.",
      });
    }).finally(() => { current.previewPending--; });
  }

  function acceptAudio(current: Recording, bytes: Uint8Array) {
    if (!current.capture || current.closing) throw new Error("Recording is not ready");
    const chunk = decodeAudio(bytes);
    const previewEpoch = current.previewEpoch;
    const previewEnabled = current.previewEnabled;
    if (chunk.sequence !== current.sequence[chunk.channel]++) throw new Error("Audio sequence mismatch");
    if (++current.pending > 12) throw new Error("Transcription cannot keep up; recording stopped to avoid losing audio");
    current.work = current.work.then(async () => {
      if (current.failure) return;
      await current.staged?.append(chunk);
      if (current.staged) {
        if (previewEnabled && previewEpoch === current.previewEpoch) preview(current, chunk);
        send(current.socket, { type: "ack", channel: chunk.channel, sequence: chunk.sequence });
        return;
      }
      const text = !hasAudio(chunk.samples) ? "" : (await options.transcribe(chunk, current.hello.language)).trim();
      if (text) {
        const line = { speaker: chunk.channel === "mic" ? "Микрофон" : "Вкладка", speakerId: chunk.channel,
          text, offsetMs: chunk.offsetMs, durationMs: chunk.samples.length / SAMPLE_RATE * 1000 };
        await commit(current, line, `${chunk.channel}:${chunk.sequence}`);
        send(current.socket, { type: "line", line });
      }
      send(current.socket, { type: "ack", channel: chunk.channel, sequence: chunk.sequence });
    }).catch((error) => fail(current, error)).finally(() => { current.pending--; });
  }

  return {
    provider,
    async start() {
      server = new WebSocketServer({
        host: "127.0.0.1", port: options.port, maxPayload: MAX_AUDIO_BYTES,
        perMessageDeflate: false,
        verifyClient: (({ origin }) => {
          const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
          return Boolean(match && (!options.extensionIds?.length || options.extensionIds.includes(match[1]!)));
        }) satisfies VerifyClientCallbackSync,
      });
      server.on("connection", (socket) => {
        let starting = false;
        const authTimeout = setTimeout(() => socket.close(1008, "Start message required"), 5000);
        socket.on("error", () => {});
        socket.on("message", (data, binary) => {
          const current = recording?.socket === socket ? recording : undefined;
          try {
            if (binary) {
              if (!current) throw new Error("Authenticate before sending audio");
              if (!current.closing) acceptAudio(current, new Uint8Array(data as Buffer));
              return;
            }
            const value = JSON.parse(data.toString()) as { type?: string; enabled?: unknown; token?: unknown; recordingId?: unknown; recovery?: unknown };
            if (value.type === "open-recording" && !starting && !current) {
              starting = true; clearTimeout(authTimeout);
              authenticate(value.token);
              if (typeof value.recordingId !== "string" || typeof value.recovery !== "boolean" || !options.openRecording) throw new Error("Открытие папки записи недоступно");
              void options.openRecording(value.recordingId, value.recovery).then(() => {
                send(socket, { type: "folder-opened" }); socket.close(1000, "Folder opened");
              }, (error) => { send(socket, { type: "error", message: `Не удалось открыть папку на компьютере OpenClaw: ${message(error)}` }); socket.close(1000); });
            } else if (value.type === "stop" && current) {
              void finish(current).catch((error) => fail(current, error));
            } else if (value.type === "preview" && current && !current.closing && typeof value.enabled === "boolean") {
              current.previewEnabled = value.enabled;
              current.previewEpoch++;
            } else if (value.type === "start" && !starting) {
              starting = true;
              clearTimeout(authTimeout);
              void begin(socket, value).catch((error) => {
                send(socket, { type: "error", message: message(error) }); socket.close(1008, "Start failed");
              });
            } else throw new Error("Unexpected message");
          } catch (error) {
            send(socket, { type: "error", message: message(error) }); socket.close(1008, "Invalid message");
          }
        });
        socket.on("close", () => {
          clearTimeout(authTimeout);
          if (recording?.socket === socket) {
            const current = recording;
            if (!current.closing) current.failure ??= new Error("Соединение с браузером прервано до завершения записи");
            void finish(current).catch((error) => options.warn(message(error)));
          }
        });
      });
      server.on("error", (error) => options.warn(`Scribe transport error: ${message(error)}`));
      await once(server, "listening");
      return (server.address() as { port: number }).port;
    },
    async stop() {
      if (recording) await finish(recording);
      for (const socket of server?.clients ?? []) socket.terminate();
      if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    },
  };
}
