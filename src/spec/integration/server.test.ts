import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createScribe } from "../../plugin/server.ts";
import { encodeAudio } from "../../shared/protocol.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

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
