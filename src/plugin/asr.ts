import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { SAMPLE_RATE, wav } from "../shared/protocol.ts";
import type { Transcribe } from "./diarization.ts";

type WorkerOptions = {
  command: string; args?: string[]; maxChunkSeconds?: number;
  startupTimeoutSeconds?: number; timeoutSeconds?: number;
};
export type AsrConfig =
  | { backend: "openclaw" }
  | ({ backend: "worker" } & WorkerOptions)
  | { backend: "gigaam"; python: string; modelDir: string; device?: string; threads?: number };

export function localAudioConfig(cfg: OpenClawConfig): OpenClawConfig {
  const media = cfg.tools?.media;
  const models = (media?.models ?? [])
    .filter((model) => model.type === "cli" && (!model.capabilities || model.capabilities.includes("audio")));
  if (!models.length) throw new Error("Configure a local audio CLI in OpenClaw tools.media, or choose Scribe asr.backend");
  return { ...cfg, tools: { ...cfg.tools, media: {
    ...media, models, audio: { ...media?.audio, enabled: true },
  } } };
}

// Model-agnostic JSONL over private pipes, not an additional network backend.
// One resident child per plugin service; no shell, cloud fallback or audio in logs.
export function createWorkerAsr(options: WorkerOptions) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready: Promise<void> | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let pending: { id: number; resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  let nextId = 0;
  let queue = Promise.resolve();
  let stopped = false;
  let retiring = Promise.resolve();
  const maxChunkSeconds = options.maxChunkSeconds ?? 20;
  if (!(maxChunkSeconds >= 0.2 && maxChunkSeconds <= 30)) throw new Error("Invalid ASR maxChunkSeconds");

  function fail(proc: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== proc) return;
    child = undefined; ready = undefined;
    rejectReady?.(error); rejectReady = undefined;
    pending?.reject(error); pending = undefined;
    proc.stdin.destroy();
    retiring = new Promise<void>((resolve) => {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      proc.once("close", () => { clearTimeout(timer); resolve(); });
      proc.kill("SIGTERM");
    });
  }

  async function start() {
    if (stopped) throw new Error("ASR worker stopped");
    if (ready) return ready;
    await retiring;
    if (stopped) throw new Error("ASR worker stopped");
    const proc = spawn(options.command, options.args ?? [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    let resolveReady!: () => void;
    ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Consume vendor diagnostics without logging audio/text or filling a pipe.
    proc.stderr.resume();
    let buffer = "";
    let announced = false;
    const timer = setTimeout(() => fail(proc, new Error("ASR worker startup timed out")), (options.startupTimeoutSeconds ?? 120) * 1000);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 131072) { fail(proc, new Error("ASR worker response too large")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line) as { type?: string; id?: number; text?: string; error?: string; maxSeconds?: number };
          if (!announced && value.type === "ready") {
            if (typeof value.maxSeconds !== "number" || !Number.isFinite(value.maxSeconds) || value.maxSeconds < maxChunkSeconds) {
              throw new Error("ASR worker audio limit is below configured maxChunkSeconds");
            }
            announced = true; clearTimeout(timer); rejectReady = undefined; resolveReady();
          } else if (announced && pending && value.id === pending.id
            && ((typeof value.text === "string" && value.error === undefined) || typeof value.error === "string")) {
            const request = pending; pending = undefined;
            if (value.error !== undefined) request.reject(new Error(value.error.slice(0, 1000)));
            else request.resolve(value.text!);
          } else throw new Error("Invalid ASR worker response");
        } catch (error) { fail(proc, error instanceof Error ? error : new Error("Invalid ASR worker response")); return; }
      }
    });
    proc.on("error", () => fail(proc, new Error("Cannot start ASR worker; check command and environment")));
    proc.stdin.on("error", () => fail(proc, new Error("ASR worker input closed")));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (child === proc) {
        // The process has already closed: no need to wait for another close event.
        child = undefined; ready = undefined;
        const error = new Error(`ASR worker exited (${code})`);
        rejectReady?.(error); rejectReady = undefined;
        pending?.reject(error); pending = undefined;
      }
    });
    return ready;
  }

  return {
    maxChunkSeconds,
    transcribe(filePath: string, language: string): Promise<string> {
      const result = queue.then(async () => {
        await start();
        const proc = child!;
        return new Promise<string>((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => fail(proc, new Error("ASR transcription timed out")), (options.timeoutSeconds ?? 120) * 1000);
          pending = {
            id, resolve: (text) => { clearTimeout(timer); resolve(text); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          };
          proc.stdin.write(`${JSON.stringify({ id, filePath, language })}\n`);
        });
      });
      queue = result.then(() => {}, () => {});
      return result;
    },
    async stop() {
      stopped = true;
      if (child) fail(child, new Error("ASR worker stopped"));
      await retiring;
      await queue;
    },
  };
}

export async function createAsr(options: {
  config?: AsrConfig; hostConfig: OpenClawConfig; workDir: string;
  native: (filePath: string, language: string, config: OpenClawConfig) => Promise<string>;
}) {
  const config = options.config;
  let worker: ReturnType<typeof createWorkerAsr> | undefined;
  let nativeConfig: OpenClawConfig | undefined;
  if (!config || config.backend === "openclaw") nativeConfig = localAudioConfig(options.hostConfig);
  else if (config.backend === "worker") worker = createWorkerAsr(config);
  else {
    if (!isAbsolute(config.modelDir)) throw new Error("GigaAM modelDir must be absolute");
    await access(join(config.modelDir, "multilingual_large_ctc.ckpt"));
    worker = createWorkerAsr({
      command: config.python,
      args: ["-u", fileURLToPath(new URL("./gigaam-worker.py", import.meta.url)), "--model-dir", config.modelDir,
        "--device", config.device ?? "auto", "--threads", String(config.threads ?? 6)],
      maxChunkSeconds: 20,
    });
  }
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const transcribe: Transcribe = async (chunk, language) => {
    const dir = await mkdtemp(join(options.workDir, "chunk-"));
    try {
      const texts: string[] = [];
      const limit = Math.floor((worker?.maxChunkSeconds ?? 30) * SAMPLE_RATE);
      // Also bound final diarized turns: GigaAM's official short-form limit is 25 s.
      for (let offset = 0; offset < chunk.samples.length; offset += limit) {
        const filePath = join(dir, "audio.wav");
        await writeFile(filePath, wav(chunk.samples.subarray(offset, offset + limit)), { mode: 0o600 });
        texts.push(worker ? await worker.transcribe(filePath, language) : await options.native(filePath, language, nativeConfig!));
      }
      return texts.map((text) => text.trim()).filter(Boolean).join(" ");
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  return { transcribe, stop: async () => { await worker?.stop(); } };
}
