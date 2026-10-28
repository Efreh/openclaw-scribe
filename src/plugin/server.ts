import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { VerifyClientCallbackSync } from "ws";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { decodeAudio, MAX_AUDIO_BYTES, parseHello, SAMPLE_RATE } from "../shared/protocol.ts";
import type { AudioChunk, Hello, ServerMessage } from "../shared/protocol.ts";

type Provider = Parameters<OpenClawPluginApi["registerTranscriptSourceProvider"]>[0];
type Capture = Parameters<NonNullable<Provider["start"]>>[0];
type Watch = Parameters<NonNullable<Provider["watchOccupancy"]>>[0];
type Recording = {
  socket: WebSocket; hello: Hello; capture?: Capture; work: Promise<void>;
  pending: number; sequence: { tab: number; mic: number }; closing: boolean;
  ready: (sessionId: string) => void; end?: Promise<void>;
};
export type ScribeOptions = {
  token: string; port: number; extensionIds?: string[];
  transcribe: (chunk: AudioChunk, language: string) => Promise<string>;
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

  async function finish(current: Recording, notify = true) {
    if (current.end) return current.end;
    current.closing = true;
    watcher?.onEmpty();
    current.end = (async () => {
      await current.work;
      const capture = current.capture;
      if (capture && notify) {
        await capture.onStatus?.({ sessionId: capture.session.sessionId, active: false, source: capture.session.source });
      }
      if (capture) send(current.socket, { type: "stopped", sessionId: capture.session.sessionId });
      if (recording === current) recording = undefined;
      current.socket.close(1000, "Recording ended");
    })();
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
      current.ready(request.session.sessionId);
      return { ok: true, session: { ...request.session, title: current.hello.title || "Browser recording" } };
    },
    async stop(request) {
      const current = recording;
      if (current?.capture?.session.sessionId === request.sessionId) await finish(current, false);
      return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
    },
    async status(source) {
      return [{ active: Boolean(recording && !recording.closing), source, sessionId: recording?.capture?.session.sessionId }];
    },
  };

  function fail(current: Recording, error: unknown) {
    send(current.socket, { type: "error", message: message(error) });
    options.warn(`Scribe capture failed: ${message(error)}`);
    current.socket.close(1011, "Capture failed");
    void finish(current).catch((error) => options.warn(`Scribe finalization failed: ${message(error)}`));
  }

  async function begin(socket: WebSocket, raw: unknown) {
    const hello = parseHello(raw);
    const expected = Buffer.from(options.token);
    const supplied = Buffer.from(hello.token);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("Invalid pairing token");
    if (recording) throw new Error("Another recording is already active");
    if (!watcher) throw new Error("Run openclaw scribe setup, then restart the Gateway");
    let resolveReady!: (sessionId: string) => void;
    const attached = new Promise<string>((resolve) => { resolveReady = resolve; });
    const current: Recording = {
      socket, hello, work: Promise.resolve(), pending: 0, sequence: { tab: 0, mic: 0 }, closing: false,
      ready: resolveReady,
    };
    recording = current;
    watcher.onOccupied();
    const timeout = setTimeout(() => fail(current, new Error("OpenClaw did not start transcript capture within 15 seconds")), 15_000);
    try {
      const sessionId = await attached;
      if (!current.closing && socket.readyState === WebSocket.OPEN) send(socket, { type: "ready", sessionId });
    } finally { clearTimeout(timeout); }
  }

  function acceptAudio(current: Recording, bytes: Uint8Array) {
    if (!current.capture || current.closing) throw new Error("Recording is not ready");
    const chunk = decodeAudio(bytes);
    if (chunk.sequence !== current.sequence[chunk.channel]++) throw new Error("Audio sequence mismatch");
    if (++current.pending > 12) throw new Error("Transcription cannot keep up; recording stopped to avoid losing audio");
    current.work = current.work.then(async () => {
      // Skip only near-digital silence. Do not send silence to Whisper, which can hallucinate text.
      const rms = Math.sqrt(chunk.samples.reduce((sum, v) => sum + v * v, 0) / chunk.samples.length) / 32768;
      const text = rms < 0.001 || chunk.samples.length < SAMPLE_RATE / 5
        ? "" : (await options.transcribe(chunk, current.hello.language)).trim();
      if (text) {
        const speaker = chunk.channel === "mic" ? "Микрофон" : "Вкладка";
        const started = Date.parse(current.capture!.session.startedAt);
        await current.capture!.onUtterance({
          id: `${current.capture!.session.sessionId}:${chunk.channel}:${chunk.sequence}`,
          sessionId: current.capture!.session.sessionId,
          startedAt: new Date(started + chunk.offsetMs).toISOString(),
          endedAt: new Date(started + chunk.offsetMs + chunk.samples.length / SAMPLE_RATE * 1000).toISOString(),
          speaker: { id: chunk.channel, label: speaker }, text, final: true,
        });
        send(current.socket, { type: "line", line: { speaker, text, offsetMs: chunk.offsetMs } });
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
              acceptAudio(current, new Uint8Array(data as Buffer));
              return;
            }
            const value = JSON.parse(data.toString()) as { type?: string };
            if (value.type === "stop" && current) {
              void finish(current).catch((error) => fail(current, error));
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
          if (recording?.socket === socket) void finish(recording).catch((error) => options.warn(message(error)));
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
