import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createScribe } from "../../plugin/server.ts";
import { encodeAudio } from "../../shared/protocol.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { createRecordingSession } from "../../plugin/recording.ts";
import type { Turn } from "../../plugin/diarization.ts";

const token = "test-token-not-a-real-credential";
const origin = `chrome-extension://${"a".repeat(32)}`;
const hello = { type: "start", version: 1, token, title: "Test meeting", url: "https://example.test/room", language: "ru" };

function messages(ws: WebSocket) {
  const pending: { predicate: (v: ServerMessage) => boolean; resolve: (v: ServerMessage) => void }[] = [];
  const seen: ServerMessage[] = [];
  ws.on("message", (data) => {
    const value = JSON.parse(data.toString()) as ServerMessage;
    seen.push(value);
    for (const waiter of [...pending]) if (waiter.predicate(value)) { pending.splice(pending.indexOf(waiter), 1); waiter.resolve(value); }
  });
  return {
    seen,
    waitFor(predicate: (v: ServerMessage) => boolean) {
      const match = seen.find(predicate);
      return match ? Promise.resolve(match) : new Promise<ServerMessage>((resolve) => pending.push({ predicate, resolve }));
    },
    wait(type: ServerMessage["type"]) {
      const match = seen.find((v) => v.type === type);
      return match ? Promise.resolve(match) : new Promise<ServerMessage>((resolve) => pending.push({ predicate: (v) => v.type === type, resolve }));
    },
  };
}

test("real WS → local transcription → native sink; stop drains both channels before finalization", { timeout: 10_000 }, async () => {
  const lines: unknown[] = []; const calls: string[] = [];
  let finalized = false;
  const server = createScribe({ port: 0, token, warn: () => {}, async transcribe(chunk, language) {
    assert.equal(language, "ru"); calls.push(chunk.channel); return `speech-${chunk.channel}`;
  } });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void server.provider.start!({ session: { sessionId: "test-session", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance(line) { lines.push(line); }, async onStatus(status) { if (!status.active) finalized = true; },
    });
  } });
  const port = await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, preview: false })); await events.wait("ready");
    for (const channel of ["tab", "mic"] as const) ws.send(encodeAudio({ channel, sequence: 0, offsetMs: 500, samples: new Int16Array(16_000).fill(1000) }));
    ws.send(JSON.stringify({ type: "stop" }));
    await events.wait("stopped");
    assert.deepEqual(calls, ["tab", "mic"]); assert.equal(lines.length, 2); assert.equal(finalized, true);
    assert.equal(events.seen.filter((v) => v.type === "ack").length, 2);
    assert.deepEqual(events.seen.filter((v) => v.type === "line").map((v) => v.type === "line" && v.line.speaker), ["Вкладка", "Микрофон"]);
  } finally { ws.terminate(); await server.stop(); }
});

test("bad token cannot create a native capture; ordinary websites cannot connect", { timeout: 10_000 }, async () => {
  let started = false;
  const server = createScribe({ port: 0, token, warn: () => {}, transcribe: async () => "unused" });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onOccupied() { started = true; }, onEmpty() {} });
  const port = await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, token: "wrong" }));
    const error = await events.wait("error"); assert.equal(error.type, "error"); assert.equal(started, false);
    const web = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://evil.test" });
    const [failure] = await once(web, "error"); assert.match(String(failure), /401/); web.terminate();
  } finally { ws.terminate(); await server.stop(); }
});

test("diarization commits final speakers only, keeps identities, and drains before native finalization", { timeout: 10_000 }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-final-"));
  const lines: { speaker?: { id?: string; label: string }; startedAt?: string }[] = [];
  const lifecycle: string[] = [];
  let release!: (turns: Turn[]) => void;
  const pending = new Promise<Turn[]>((resolve) => { release = resolve; });
  const server = createScribe({ port: 0, token, warn: () => {}, transcribe: async (chunk) => `speech-${chunk.channel}-${chunk.samples.length}`,
    createRecording: (hello, sessionId) => createRecordingSession({ workDir, sessionId, language: hello.language, diarize: async () => pending }),
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() { lifecycle.push("empty"); }, onOccupied() {
    void server.provider.start!({ session: { sessionId: "diar-test", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance(line) { lines.push(line); lifecycle.push("line"); }, async onStatus(status) { if (!status.active) lifecycle.push("finalized"); },
    });
  } });
  const port = await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, diarization: true }));
    const ready = await events.wait("ready"); assert.ok(ready.type === "ready" && ready.diarization);
    for (let sequence = 0; sequence < 2; sequence++) ws.send(encodeAudio({ channel: "tab", sequence, offsetMs: sequence * 1000, samples: new Int16Array(16_000).fill(1000) }));
    ws.send(encodeAudio({ channel: "mic", sequence: 0, offsetMs: 500, samples: new Int16Array(16_000).fill(1000) }));
    ws.send(JSON.stringify({ type: "stop" }));
    await events.wait("progress");
    assert.equal(lines.length, 0, "live draft must not be duplicated in append-only native storage");
    assert.deepEqual(lifecycle, [], "capture must remain occupied during final diarization");
    release([{ start: 0, end: 0.5, speaker: 1 }, { start: 0.5, end: 1.2, speaker: 2 }, { start: 1.2, end: 2, speaker: 1 }]);
    await events.wait("stopped");
    assert.deepEqual(lines.filter((line) => line.speaker?.id?.startsWith("tab:")).map((line) => line.speaker?.label), ["Участник 1", "Участник 2", "Участник 1"]);
    assert.equal(lines.filter((line) => line.speaker?.id === "mic").length, 1);
    assert.deepEqual(lifecycle.slice(-2), ["finalized", "empty"]);
    assert.deepEqual(await readdir(workDir), [], "successful finalization must remove temporary audio");
    assert.equal(events.seen.filter((event) => event.type === "transcript").length, 1);
  } finally { release([]); ws.terminate(); await server.stop(); await rm(workDir, { recursive: true, force: true }); }
});

test("failed finalization retains both private WAVs but never substitutes demo text", { timeout: 10_000 }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-no-demo-fallback-"));
  const lines: unknown[] = [];
  let stagedPath = "";
  const server = createScribe({ port: 0, token, warn: () => {}, transcribe: async () => "ephemeral demo only",
    async createRecording(hello, sessionId) {
      const staged = await createRecordingSession({ workDir, sessionId, language: hello.language, diarize: async () => { throw new Error("test model unavailable"); } });
      stagedPath = staged.path; return staged;
    },
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void server.provider.start!({ session: { sessionId: "no-fallback", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance(line) { lines.push(line); },
    });
  } });
  const port = await server.start(); const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, diarization: true, preview: true })); await events.wait("ready");
    for (const channel of ["tab", "mic"] as const) ws.send(encodeAudio({ channel, sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
    await events.wait("line");
    await events.waitFor((v) => v.type === "ack" && v.channel === "mic");
    ws.send(JSON.stringify({ type: "stop" }));
    const error = await events.wait("error");
    assert.ok(error.type === "error" && error.message.includes(stagedPath));
    await once(ws, "close");
    assert.deepEqual(lines, [], "demo must not be used as an archive fallback");
    assert.ok(!events.seen.some((event) => event.type === "stopped" || event.type === "transcript"));
    assert.equal((await stat(stagedPath)).mode & 0o777, 0o700);
    for (const channel of ["tab", "mic"]) {
      const wave = await readFile(join(stagedPath, `${channel}.wav`));
      assert.equal(wave.readUInt32LE(40), 32_000); assert.equal(wave.length, 32_044);
      assert.equal((await stat(join(stagedPath, `${channel}.wav`))).mode & 0o777, 0o600);
    }
    for (const name of await readdir(stagedPath)) {
      assert.ok(!(await readFile(join(stagedPath, name))).includes(Buffer.from("ephemeral demo only")), "no demo text on disk");
    }
  } finally { ws.terminate(); await server.stop(); await rm(workDir, { recursive: true, force: true }); }
});

for (const preview of [undefined, false, true]) test(`diarization preview=${preview}: no live archival and both sources get independent final ASR`, { timeout: 10_000 }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-preview-mode-"));
  const lines: { text: string; speaker?: { id?: string } }[] = [];
  const calls: { channel: string; stopped: boolean }[] = [];
  let stopped = false;
  const server = createScribe({ port: 0, token, warn: () => {},
    async transcribe(chunk) { calls.push({ channel: chunk.channel, stopped }); return `${stopped ? "final" : "demo"}-${chunk.channel}`; },
    createRecording: (hello, sessionId) => createRecordingSession({ workDir, sessionId, language: hello.language,
      diarize: async () => [{ start: 0, end: 1, speaker: 1 }],
    }),
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void server.provider.start!({ session: { sessionId: "preview-mode", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance(line) { lines.push(line); },
    });
  } });
  const port = await server.start(); const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, diarization: true, preview })); await events.wait("ready");
    for (const channel of ["tab", "mic"] as const) {
      ws.send(encodeAudio({ channel, sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
      await events.waitFor((v) => v.type === "ack" && v.channel === channel);
      if (preview) await events.waitFor((v) => v.type === "line" && v.line.text === `demo-${channel}`);
    }
    assert.equal(lines.length, 0);
    assert.equal(calls.length, preview ? 2 : 0, "hidden mode must not invoke ASR during recording");
    const [dir] = await readdir(workDir);
    for (const name of await readdir(join(workDir, dir!))) {
      assert.ok(!(await readFile(join(workDir, dir!, name))).includes(Buffer.from("demo-")));
    }
    stopped = true; ws.send(JSON.stringify({ type: "stop" })); await events.wait("stopped");
    assert.deepEqual(calls.filter((call) => call.stopped).map((call) => call.channel), ["tab", "mic"]);
    assert.deepEqual(lines.map((line) => line.text), ["final-tab", "final-mic"], "no demo reuse, including microphone");
    assert.deepEqual(await readdir(workDir), []);
  } finally { ws.terminate(); await server.stop(); await rm(workDir, { recursive: true, force: true }); }
});

test("demo toggles cancel stale work; a slow or failed demo cannot hold audio ACKs or supply final text", { timeout: 10_000 }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-preview-toggle-"));
  const calls: string[] = []; const lines: { text: string }[] = [];
  let stopped = false;
  let release!: () => void;
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const server = createScribe({ port: 0, token, warn: () => {},
    async transcribe(chunk) {
      if (stopped) return `final-${chunk.channel}`;
      calls.push(`${chunk.channel}:${chunk.sequence}`);
      if (calls.length === 1) { started(); await blocked; return "stale demo"; }
      throw new Error("demo unavailable");
    },
    createRecording: (hello, sessionId) => createRecordingSession({ workDir, sessionId, language: hello.language,
      diarize: async () => [{ start: 0, end: 4, speaker: 1 }],
    }),
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void server.provider.start!({ session: { sessionId: "toggle", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance(line) { lines.push(line); },
    });
  } });
  const port = await server.start(); const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  const sendChunk = async (sequence: number) => {
    ws.send(encodeAudio({ channel: "tab", sequence, offsetMs: sequence * 1000, samples: new Int16Array(16_000).fill(1000) }));
    await events.waitFor((v) => v.type === "ack" && v.sequence === sequence);
  };
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, diarization: true, preview: false })); await events.wait("ready");
    await sendChunk(0); assert.deepEqual(calls, []);
    ws.send(JSON.stringify({ type: "preview", enabled: true })); await sendChunk(1); await inFlight;
    // The model is blocked, but microphone and tab recording still ACK immediately.
    ws.send(encodeAudio({ channel: "mic", sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
    await events.waitFor((v) => v.type === "ack" && v.channel === "mic");
    ws.send(JSON.stringify({ type: "preview", enabled: false })); await sendChunk(2);
    release();
    ws.send(JSON.stringify({ type: "preview", enabled: true })); await sendChunk(3);
    await events.wait("warning");
    assert.deepEqual(calls, ["tab:1", "tab:3"], "queued microphone demo must be discarded after toggle");
    assert.equal(events.seen.filter((v) => v.type === "line").length, 0, "late demo result must not reappear after disabling");
    stopped = true; ws.send(JSON.stringify({ type: "stop" })); await events.wait("stopped");
    assert.deepEqual(lines.map((line) => line.text), ["final-tab", "final-mic"]);
    assert.deepEqual(await readdir(workDir), []);
  } finally { release(); ws.terminate(); await server.stop(); await rm(workDir, { recursive: true, force: true }); }
});

test("requested diarization is rejected explicitly when the backend is not configured", { timeout: 10_000 }, async () => {
  let occupied = false;
  const server = createScribe({ port: 0, token, warn: () => {}, transcribe: async () => "unused" });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() { occupied = true; } });
  const port = await server.start(); const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, diarization: true }));
    const event = await events.wait("error"); assert.ok(event.type === "error" && event.message.includes("setup --diarization"));
    assert.equal(occupied, false);
  } finally { ws.terminate(); await server.stop(); }
});
