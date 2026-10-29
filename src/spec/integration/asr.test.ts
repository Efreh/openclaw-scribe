import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAsr, createWorkerAsr } from "../../plugin/asr.ts";
const fixture = fileURLToPath(new URL("../support/asr-worker.mjs", import.meta.url));

test("resident adapter reuses one model process and splits final turns below the model limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scribe-asr-"));
  const asr = await createAsr({
    config: { backend: "worker", command: process.execPath, args: [fixture], maxChunkSeconds: 20 },
    hostConfig: {}, workDir: dir, native: async () => { throw new Error("Unexpected fallback"); },
  });
  try {
    const result = await asr.transcribe({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(30 * 16000) }, "ru");
    const [a, b] = result.split(" ").map((part) => part.split(":"));
    assert.equal(a![0], b![0]); assert.equal(a![1], "1"); assert.equal(b![1], "2");
    assert.equal(a![2], "20"); assert.equal(b![2], "10"); assert.equal(a![3], "ru");
    const next = await asr.transcribe({ channel: "mic", sequence: 0, offsetMs: 0, samples: new Int16Array(16000) }, "en");
    assert.equal(next, [a![0], "3", "1", "en"].join(":"));
    assert.deepEqual(await readdir(dir), []);
  } finally { await asr.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("worker crash, malformed response, inference error and timeouts reject explicitly without hanging", async () => {
  for (const mode of ["crash", "invalid", "error", "hang", "startup-hang"]) {
    const worker = createWorkerAsr({
      command: process.execPath, args: [fixture, mode],
      timeoutSeconds: 0.3, startupTimeoutSeconds: mode === "startup-hang" ? 0.3 : 5,
    });
    try { await assert.rejects(worker.transcribe("/unused.wav", "ru")); }
    finally { await worker.stop(); }
    await assert.rejects(worker.transcribe("/unused.wav", "ru"), /stopped/);
  }
  const missing = createWorkerAsr({ command: "/no-such-scribe-worker" });
  await assert.rejects(missing.transcribe("/unused.wav", "ru"), /Cannot start/);
  await missing.stop();
});

test("native local CLI remains selectable and does not require a GigaAM runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scribe-native-adapter-"));
  let calls = 0;
  const asr = await createAsr({
    hostConfig: { tools: { media: { models: [{ type: "cli", command: "custom-asr", capabilities: ["audio"] }] } } },
    workDir: dir,
    native: async (_path, language, cfg) => {
      calls++; assert.equal(language, "ru"); assert.equal(cfg.tools?.media?.models?.[0]?.command, "custom-asr");
      return "other model";
    },
  });
  try {
    assert.equal(await asr.transcribe({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(16000) }, "ru"), "other model");
    assert.equal(calls, 1); assert.deepEqual(await readdir(dir), []);
  } finally { await asr.stop(); await rm(dir, { recursive: true, force: true }); }
});
