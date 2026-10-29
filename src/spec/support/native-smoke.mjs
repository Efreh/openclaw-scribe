// Opt-in hardware proof. All writes/installations are confined to a new temporary OpenClaw profile.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const run = promisify(execFile);
const audio = process.argv[process.argv.indexOf("--audio") + 1];
const diarization = process.argv.includes("--diarization");
const language = process.argv.includes("--language") ? process.argv[process.argv.indexOf("--language") + 1] : "ru";
const duration = process.argv.includes("--duration") ? process.argv[process.argv.indexOf("--duration") + 1] : "12";
if (!process.argv.includes("--audio") || !audio) throw new Error("Usage: npm run test:native -- --audio /path/to/public-test-audio.wav");
const cli = process.env.OPENCLAW_BIN || "openclaw";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { version } = JSON.parse(await readFile(join(repo, "src/package.json"), "utf8"));
const root = await mkdtemp(join(tmpdir(), "scribe-native-"));
const cfgPath = join(root, "openclaw.json");
const inherited = Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "TMPDIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const env = { ...inherited, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: cfgPath, OPENCLAW_SKIP_CHANNELS: "1" };
async function command(args, isolated = true) {
  const result = await run(cli, args, { env: isolated ? env : process.env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}
async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const number = server.address().port; await new Promise((r) => server.close(r)); return number;
}
const gatewayPort = await port(), scribePort = await port();
const media = JSON.parse(await command(["config", "get", "tools.media", "--json"], false));
await writeFile(cfgPath, JSON.stringify({
  gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token: randomBytes(32).toString("base64url") }, controlUi: { enabled: false } },
  agents: { defaults: { model: { primary: "unconfigured/disabled" } } },
  tools: { media }, plugins: { allow: ["openclaw-scribe"] },
}), { mode: 0o600 });
await command(["plugins", "install", `npm-pack:${join(repo, `artifacts/efreh-openclaw-scribe-${version}.tgz`)}`, "--force", "--accept-capabilities"]);
const config = JSON.parse(await readFile(cfgPath, "utf8"));
const asrConfig = process.argv.includes("--asr-config")
  ? JSON.parse(await readFile(process.argv[process.argv.indexOf("--asr-config") + 1], "utf8")) : undefined;
config.plugins.entries["openclaw-scribe"].config = { port: scribePort, ...(asrConfig ? { asr: asrConfig } : {}) };
await writeFile(cfgPath, JSON.stringify(config));
await command(["scribe", "setup", ...(diarization ? ["--diarization"] : [])]);
const inspection = JSON.parse(await command(["plugins", "inspect", "openclaw-scribe", "--runtime", "--json"]));
assert.equal(inspection.plugin.status, "loaded"); assert.deepEqual(inspection.diagnostics, []);
let log = "";
const gateway = spawn(cli, ["gateway", "run", "--allow-unconfigured", "--port", String(gatewayPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
gateway.stdout.on("data", (data) => { log += data; }); gateway.stderr.on("data", (data) => { log += data; });
let ws;
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    if (gateway.exitCode !== null) throw new Error(`Test Gateway exited: ${gateway.exitCode}`);
    const ready = await new Promise((resolve) => { const s = connect(scribePort, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
    if (ready) break;
    if (Date.now() > deadline) throw new Error("Test Scribe server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  // Native configured-source service may arm its watcher just after the plugin service starts.
  await new Promise((r) => setTimeout(r, 2000));
  const token = (await readFile(join(root, "scribe/pairing-token"), "utf8")).trim();
  ws = new WebSocket(`ws://127.0.0.1:${scribePort}`, { origin: `chrome-extension://${"a".repeat(32)}` });
  const events = [];
  ws.on("message", (data) => events.push(JSON.parse(data.toString())));
  async function wait(type) {
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const error = events.find((v) => v.type === "error"); if (error) throw new Error(error.message);
      const found = events.find((v) => v.type === type); if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${type}`);
  }
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "start", version: 1, token, title: "Scribe native package smoke test", url: "https://example.test/public-audio", language, diarization }));
  const { sessionId } = await wait("ready");
  const { stdout: pcm } = await run("ffmpeg", ["-v", "error", "-i", resolve(audio), "-t", duration, "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  for (let offset = 0, sequence = 0; offset < pcm.length; offset += 320_000, sequence++) {
    const audio = pcm.subarray(offset, offset + 320_000);
    const frame = Buffer.alloc(10 + audio.length); frame[0] = 1; frame[1] = 0;
    frame.writeUInt32LE(sequence, 2); frame.writeUInt32LE(offset / 32, 6); audio.copy(frame, 10); ws.send(frame);
  }
  ws.send(JSON.stringify({ type: "stop" }));
  await wait("stopped");
  const sessions = JSON.parse(await command(["transcripts", "list", "--json"]));
  const session = sessions.find((s) => s.sessionId === sessionId);
  assert.ok(session); assert.ok(session.stoppedAt); assert.equal(session.hasSummary, true);
  const transcript = JSON.parse(await command(["transcripts", "path", session.selector, "--transcript", "--json"]));
  const contents = await readFile(transcript.path, "utf8");
  assert.ok(contents.length > 50); assert.ok(events.some((v) => v.type === "line"));
  const finalLines = events.find((v) => v.type === "transcript")?.lines ?? [];
  const speakers = [...new Set(finalLines.map((line) => line.speaker))];
  if (diarization) {
    assert.ok(contents.includes("Участник 1")); assert.ok(contents.includes("Участник 2"));
    assert.ok(!events.some((v) => v.type === "warning"), "native diarization must not fall back to the draft");
  }
  const proof = { ok: true, asrBackend: asrConfig?.backend ?? "openclaw", packageVersion: version, hostVersion: "2026.10.7", sessionId, chunks: events.filter((v) => v.type === "ack").length, lines: events.filter((v) => v.type === "line").length, diarization, speakers, finalLines: finalLines.length, hasNativeSummary: session.hasSummary, isolatedProfile: root };
  await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  await writeFile(join(root, "gateway.log"), log); console.error(`Native proof diagnostics: ${root}/gateway.log`); throw error;
} finally {
  ws?.terminate();
  if (gateway.exitCode === null) {
    const exited = once(gateway, "exit"); gateway.kill("SIGTERM");
    let timer;
    try { await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => { gateway.kill("SIGKILL"); r(); }, 10_000); })]); }
    finally { clearTimeout(timer); }
  }
}
