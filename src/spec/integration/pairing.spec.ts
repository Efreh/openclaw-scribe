import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(repo, "src/node_modules/openclaw/openclaw.mjs");
const { version } = JSON.parse(await readFile(join(repo, "src/package.json"), "utf8"));

test("installed pair command prints the complete persistent token without logging it", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "scribe-pair-cli-"));
  const configPath = join(root, "openclaw.json");
  const logPath = join(root, "cli.log");
  const env = {
    PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8",
    OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath,
  };
  async function command(args: string[]) {
    const { stdout } = await run(process.execPath, [cli, ...args], { env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  }
  try {
    await writeFile(configPath, JSON.stringify({
      gateway: { mode: "local" },
      plugins: { allow: ["openclaw-scribe"] },
      logging: { file: logPath, level: "info" },
    }), { mode: 0o600 });
    await command(["plugins", "install", `npm-pack:${join(repo, `artifacts/efreh-openclaw-scribe-${version}.tgz`)}`, "--force", "--accept-capabilities"]);
    const cfg = JSON.parse(await readFile(configPath, "utf8"));
    cfg.plugins.entries["openclaw-scribe"].config = { port: 21989 };
    await writeFile(configPath, JSON.stringify(cfg));
    let previous: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const stdout = await command(["scribe", "pair"]);
      const settings = JSON.parse(stdout.slice(stdout.lastIndexOf("{")));
      const stored = (await readFile(join(root, "scribe/pairing-token"), "utf8")).trim();
      assert.equal(settings.url, "ws://127.0.0.1:21989");
      assert.ok(settings.token === stored, "pair must return the entire stored token, without redaction");
      assert.match(settings.token, /^[\w-]{43}$/);
      assert.ok(previous === undefined || previous === settings.token, "pair must reuse the existing token");
      assert.ok(!(await readFile(logPath, "utf8")).includes(stored), "pair credentials must not enter OpenClaw log files");
      previous = settings.token;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
