import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AudioChunk, Line } from "../shared/protocol.ts";

const run = promisify(execFile);
export const DIARIZATION_MODEL = "nemotron-diar";
export type DiarizationConfig = { command: string; model: string; device?: string };
export type Turn = { start: number; end: number; speaker: number };
export type CapturedLine = Line & { speakerId: string; durationMs: number };
export type Transcribe = (chunk: AudioChunk, language: string) => Promise<string>;
export async function defaultDiarizationCommand() {
  const local = join(homedir(), ".local", "bin", "nemo-speech");
  try { await access(local); return local; } catch { return "nemo-speech"; }
}

// Use the vendor's indexed download, cache, resume, and SHA-256 verification.
// This pulls only the diarization model, never an additional ASR model.
export async function prepareDiarization(command: string): Promise<DiarizationConfig> {
  let stdout: string;
  try { ({ stdout } = await run(command, ["--json", "pull", DIARIZATION_MODEL], { timeout: 600_000, maxBuffer: 1024 * 1024 })); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Установите официальный nemo-speech (NeMo-Speech.cpp), затем повторите openclaw scribe setup --diarization");
    throw error;
  }
  const result = JSON.parse(stdout) as { artifacts?: { role?: string; path?: string; repo?: string }[] };
  const artifact = result.artifacts?.find((item) => item.role === "diarization" && item.repo === "nvidia/Nemotron-3-Diarization");
  if (!artifact?.path || !isAbsolute(artifact.path) || !(await stat(artifact.path)).isFile()) {
    throw new Error("nemo-speech did not return the installed Nemotron diarization model");
  }
  return { command, model: artifact.path, device: "auto" };
}

export function parseTurns(raw: unknown, duration: number): Turn[] {
  const segments = (raw as { segments?: unknown[] } | null)?.segments;
  if (!Array.isArray(segments) || segments.length > 100_000) throw new Error("Invalid diarization result");
  return segments.map((value) => {
    const v = value as Partial<Turn>;
    if (!v || typeof v.start !== "number" || typeof v.end !== "number" || !Number.isFinite(v.start) || !Number.isFinite(v.end)
      || v.start < 0 || v.end <= v.start || v.end > duration + 0.2
      || !Number.isInteger(v.speaker) || v.speaker! < 1 || v.speaker! > 8) throw new Error("Invalid diarization segment");
    return { start: v.start, end: Math.min(duration, v.end), speaker: v.speaker! };
  }).filter((v) => v.end > v.start).sort((a, b) => a.start - b.start || a.speaker - b.speaker);
}

// Model inference and speaker identity tracking belong entirely to NeMo.
// Partition overlapping model turns only to avoid transcribing the same mixed audio twice.
export function speechIntervals(turns: Turn[]): { start: number; end: number; speakers: number[] }[] {
  const events = turns.flatMap((turn) => [{ at: turn.start, speaker: turn.speaker, delta: 1 }, { at: turn.end, speaker: turn.speaker, delta: -1 }])
    .sort((a, b) => a.at - b.at);
  const active = new Map<number, number>();
  const result: { start: number; end: number; speakers: number[] }[] = [];
  let previous = 0;
  for (let index = 0; index < events.length;) {
    const at = events[index]!.at;
    const speakers = [...active.keys()].sort((a, b) => a - b);
    if (at > previous && speakers.length) {
      const last = result.at(-1);
      if (last && last.end === previous && last.speakers.join() === speakers.join()) last.end = at;
      else result.push({ start: previous, end: at, speakers });
    }
    while (index < events.length && events[index]!.at === at) {
      const event = events[index++]!;
      const count = (active.get(event.speaker) ?? 0) + event.delta;
      if (count > 0) active.set(event.speaker, count); else active.delete(event.speaker);
    }
    previous = at;
  }
  return result;
}

export async function diarizeFile(config: DiarizationConfig, path: string, duration: number): Promise<Turn[]> {
  // An absolute, existing local model path prevents inference-time downloads.
  if (!isAbsolute(config.model) || !(await stat(config.model)).isFile()) throw new Error("Local diarization model is missing; run openclaw scribe setup --diarization");
  const { stdout } = await run(config.command, ["--json", "diarize", path, "--model", config.model,
    "--preset", "v3-offline", "--device", config.device ?? "auto"], { timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 });
  return parseTurns(JSON.parse(stdout), duration);
}
