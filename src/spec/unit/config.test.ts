import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAudioConfig, pairingToken } from "../../plugin/index.ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

test("audio configuration cannot silently fall back to a cloud provider", () => {
  const cfg: OpenClawConfig = { tools: { media: { models: [
    { type: "cli", command: "whisper-cli", args: [], capabilities: ["audio"] },
    { type: "provider", provider: "openai", model: "whisper-1", capabilities: ["audio"] },
  ], audio: { enabled: false } } } };
  const before = structuredClone(cfg);
  const local = localAudioConfig(cfg);
  assert.deepEqual(cfg, before);
  assert.equal(local.tools?.media?.audio?.enabled, true);
  assert.equal(local.tools?.media?.models?.length, 1);
  assert.equal(local.tools?.media?.models?.[0]?.type, "cli");
  assert.throws(() => localAudioConfig({}));
});

test("pairing credentials persist with private file permissions and concurrent setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scribe-token-"));
  try {
    const tokens = await Promise.all(Array.from({ length: 20 }, () => pairingToken(dir)));
    assert.equal(new Set(tokens).size, 1); assert.equal(tokens[0]!.length, 43);
    const path = join(dir, "scribe/pairing-token");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), tokens[0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
