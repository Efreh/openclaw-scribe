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
import { createDiarizationSession } from "../../plugin/diarization.ts";
import type { CapturedLine, Turn } from "../../plugin/diarization.ts";

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
    await once(ws, "open"); ws.send(JSON.stringify(hello)); await events.wait("ready");
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
    createDiarization: (hello, sessionId) => createDiarizationSession({ workDir, sessionId, language: hello.language, diarize: async () => pending }),
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

test("failed diarization saves the draft explicitly and retains a private recoverable WAV", { timeout: 10_000 }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-fallback-"));
  const lines: { speaker?: { label: string }; text: string }[] = [];
  let stagedPath = "";
  const server = createScribe({ port: 0, token, warn: () => {}, transcribe: async () => "preserved draft",
    async createDiarization(hello, sessionId) {
      const staged = await createDiarizationSession({ workDir, sessionId, language: hello.language, diarize: async () => { throw new Error("test model unavailable"); } });
      stagedPath = staged.path; return staged;
    },
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void server.provider.start!({ session: { sessionId: "fallback", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance(line) { lines.push(line); },
    });
  } });
  const port = await server.start(); const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }); const events = messages(ws);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ ...hello, diarization: true })); await events.wait("ready");
    ws.send(encodeAudio({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
    ws.send(JSON.stringify({ type: "stop" })); await events.wait("stopped");
    assert.deepEqual(lines.map((line) => [line.speaker?.label, line.text]), [["Вкладка", "preserved draft"]]);
    assert.ok(events.seen.some((event) => event.type === "warning"));
    const wave = await readFile(join(stagedPath, "tab.wav"));
    assert.equal(wave.readUInt32LE(40), 32_000); assert.equal(wave.length, 32_044);
    assert.equal((await stat(stagedPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stagedPath, "tab.wav"))).mode & 0o777, 0o600);
    const drafts = (await readFile(join(stagedPath, "draft.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as CapturedLine);
    assert.equal(drafts[0]?.text, "preserved draft");
  } finally { ws.terminate(); await server.stop(); await rm(workDir, { recursive: true, force: true }); }
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
