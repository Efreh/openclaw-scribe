import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createScribe } from "../../plugin/server.ts";
import { createRecordingSession } from "../../plugin/recording.ts";
import { openRecordingDirectory } from "../../plugin/folders.ts";
import { encodeAudio } from "../../shared/protocol.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

const token = "retention-test-token";
const origin = "chrome-extension://" + "a".repeat(32);
function events(socket: WebSocket) {
  const seen: ServerMessage[] = [];
  const waiters: { type: string; resolve: (event: ServerMessage) => void }[] = [];
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString()) as ServerMessage; seen.push(event);
    for (const waiter of [...waiters]) if (waiter.type === event.type) {
      waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event);
    }
  });
  return { seen, wait(type: ServerMessage["type"]) {
    return Promise.resolve(seen.find((event) => event.type === type))
      .then((event) => event ?? new Promise<ServerMessage>((resolve) => waiters.push({ type, resolve })));
  } };
}

for (const diarization of [false, true]) for (const saveAudio of [false, true]) for (const preview of [false, true]) {
  test("recording matrix " + JSON.stringify({ diarization, saveAudio, preview }), { timeout: 10_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "scribe-retention-"));
    const workDir = join(root, "work"), recordingsDir = join(root, "recordings");
    await mkdir(workDir);
    let stopped = false, diarizations = 0;
    const calls: string[] = [], archived: string[] = [];
    const full = diarization || saveAudio;
    const server = createScribe({ port: 0, token, warn() {}, diarizationAvailable: true,
      async transcribe(chunk) { calls.push((stopped ? "final:" : "live:") + chunk.channel); return (stopped ? "final-" : "live-") + chunk.channel; },
      createRecording: (hello, sessionId) => createRecordingSession({ workDir, recordingsDir, sessionId, language: hello.language, saveAudio: hello.saveAudio,
        diarize: hello.diarization ? async () => { diarizations++; return [{ start: 0, end: 1, speaker: 1 }]; } : undefined }),
    });
    await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
      void server.provider.start!({ session: { sessionId: "matrix", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
        async onUtterance(line) { archived.push(line.text); } });
    } });
    const port = await server.start();
    const socket = new WebSocket("ws://127.0.0.1:" + port, { origin }); const received = events(socket);
    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "start", version: 1, token, title: "Test", url: "", language: "ru", diarization, saveAudio, preview }));
      const ready = await received.wait("ready");
      assert.ok(ready.type === "ready"); assert.equal(ready.fullRecording, full); assert.equal(ready.saveAudio, saveAudio);
      for (const channel of ["tab", "mic"] as const) {
        socket.send(encodeAudio({ channel, sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
        while (!received.seen.some((event) => event.type === "ack" && event.channel === channel)) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (!full || preview) while (!received.seen.some((event) => event.type === "line" && event.line.speaker === (channel === "tab" ? "Вкладка" : "Микрофон"))) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      assert.equal(calls.length, full && !preview ? 0 : 2);
      assert.deepEqual(archived, full ? [] : ["live-tab", "live-mic"]);
      if (full && preview) {
        const [directory] = await readdir(workDir);
        for (const file of await readdir(join(workDir, directory!))) {
          assert.ok(!(await readFile(join(workDir, directory!, file))).includes(Buffer.from("live-")), "ephemeral preview must not be written to disk");
        }
      }
      stopped = true; socket.send(JSON.stringify({ type: "stop" }));
      const result = await received.wait("stopped"); assert.ok(result.type === "stopped");
      assert.deepEqual(archived, full ? ["final-tab", "final-mic"] : ["live-tab", "live-mic"]);
      assert.deepEqual(calls.filter((call) => call.startsWith("final:")), full ? ["final:tab", "final:mic"] : []);
      assert.equal(diarizations, diarization ? 1 : 0);
      assert.deepEqual(await readdir(workDir), []);
      assert.equal(Boolean(result.audio), saveAudio);
      if (saveAudio) {
        assert.ok(result.audio); assert.equal(result.audio.recovery, false);
        assert.ok(result.audio.directory.startsWith(recordingsDir + "/")); assert.deepEqual(result.audio.files, ["tab", "mic"]);
        for (const channel of result.audio.files) {
          const file = join(result.audio.directory, channel + ".wav"), data = await readFile(file);
          assert.equal(data.readUInt32LE(40), 32_000); assert.equal(data.length, 32_044);
          assert.equal((await stat(file)).mode & 0o777, 0o600);
        }
        assert.equal((await stat(result.audio.directory)).mode & 0o777, 0o700);
      }
    } finally { socket.terminate(); await server.stop(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const saveAudio of [false, true]) test("native archive failure retains audio, saveAudio=" + saveAudio, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe-retain-error-"));
  const server = createScribe({ port: 0, token, warn() {}, transcribe: async () => "main result",
    createRecording: (hello, sessionId) => createRecordingSession({ workDir: root, recordingsDir: join(root, "saved"), sessionId,
      language: hello.language, saveAudio: hello.saveAudio, diarize: async () => [{ start: 0, end: 1, speaker: 1 }] }),
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void server.provider.start!({ session: { sessionId: "archive-error", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance() { throw new Error("native archive unavailable"); } });
  } });
  const port = await server.start(), socket = new WebSocket("ws://127.0.0.1:" + port, { origin }), received = events(socket);
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "start", version: 1, token, title: "", url: "", language: "ru", diarization: true, saveAudio, preview: false }));
    await received.wait("ready");
    socket.send(encodeAudio({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
    socket.send(JSON.stringify({ type: "stop" }));
    const result = await received.wait("error"); assert.ok(result.type === "error" && result.audio);
    assert.equal(result.audio.recovery, true); assert.equal((await stat(join(result.audio.directory, "tab.wav"))).size, 32_044);
    assert.ok(!received.seen.some((event) => event.type === "stopped" || event.type === "transcript"));
  } finally { socket.terminate(); await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test("folder access requires pairing, does not start capture, and opens the exact existing directory", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe-folder-")), recordingsDir = join(root, "saved"), workDir = join(root, "work");
  const directory = join(recordingsDir, "recording-ABC123"); await mkdir(directory, { recursive: true }); await mkdir(workDir);
  await writeFile(join(directory, "tab.wav"), Buffer.alloc(46));
  const opened: string[] = [];
  const openFolder = (id: string, recovery: boolean) => openRecordingDirectory({ recordingsDir, workDir, id, recovery, launch: async (path) => { opened.push(path); } });
  let occupied = false;
  const server = createScribe({ port: 0, token, warn() {}, transcribe: async () => "", openRecording: openFolder });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() { occupied = true; } });
  const port = await server.start();
  try {
    for (const valid of [false, true]) {
      const socket = new WebSocket("ws://127.0.0.1:" + port, { origin }), received = events(socket);
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "open-recording", token: valid ? token : "bad-token", recordingId: "recording-ABC123", recovery: false }));
      await received.wait(valid ? "folder-opened" : "error"); socket.terminate();
    }
    assert.deepEqual(opened, [directory]); assert.equal(occupied, false);
    await assert.rejects(openFolder("../outside", false));
    await assert.rejects(openFolder("recording-missing", false));
    await symlink(directory, join(recordingsDir, "recording-LINK12"));
    await assert.rejects(openFolder("recording-LINK12", false));
    await rm(join(directory, "tab.wav"));
    await assert.rejects(openFolder("recording-ABC123", false));
    assert.deepEqual(opened, [directory]);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test("unexpected browser disconnect preserves full recording without archiving a partial final", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe-disconnect-"));
  let empty!: () => void;
  const ended = new Promise<void>((resolve) => { empty = resolve; });
  let calls = 0;
  const server = createScribe({ port: 0, token, warn() {}, transcribe: async () => { calls++; return "must not finalize"; },
    createRecording: (hello, sessionId) => createRecordingSession({ workDir: root, recordingsDir: join(root, "saved"), sessionId, language: hello.language, saveAudio: true }),
  });
  await server.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() { empty(); }, onOccupied() {
    void server.provider.start!({ session: { sessionId: "disconnected", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance() { assert.fail("Incomplete capture must not become a successful final"); } });
  } });
  const port = await server.start(), socket = new WebSocket("ws://127.0.0.1:" + port, { origin }), received = events(socket);
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "start", version: 1, token, title: "", url: "", language: "ru", saveAudio: true, preview: false }));
    await received.wait("ready");
    socket.send(encodeAudio({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) }));
    await received.wait("ack"); socket.close(); await ended;
    const [folder] = await readdir(root);
    assert.equal((await stat(join(root, folder!, "tab.wav"))).size, 32_044); assert.equal(calls, 0);
  } finally { socket.terminate(); await server.stop(); await rm(root, { recursive: true, force: true }); }
});
