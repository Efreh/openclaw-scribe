import { execFile } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { hasAudio, SAMPLE_RATE, wavHeader } from "../shared/protocol.ts";
import type { AudioChunk, Channel, Line } from "../shared/protocol.ts";

const run = promisify(execFile);
export const DIARIZATION_MODEL = "nemotron-diar";
const MAX_SECONDS = 4 * 60 * 60;
export type DiarizationConfig = { command: string; model: string; device?: string };
export type Turn = { start: number; end: number; speaker: number };
export type CapturedLine = Line & { speakerId: string; durationMs: number };
export type Transcribe = (chunk: AudioChunk, language: string) => Promise<string>;
export type DiarizationSession = {
  path: string;
  append: (chunk: AudioChunk) => Promise<void>;
  finalize: (transcribe: Transcribe, progress: (done: number, total: number) => void) => Promise<CapturedLine[]>;
  dispose: () => Promise<void>;
};

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

export async function createDiarizationSession(options: {
  workDir: string; sessionId: string; language: string;
  diarize: (path: string, duration: number) => Promise<Turn[]>;
}): Promise<DiarizationSession> {
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(options.workDir, "recording-"));
  type Track = { path: string; file?: FileHandle; samples: number };
  const tracks: Record<Channel, Track> = {
    tab: { path: join(path, "tab.wav"), samples: 0 },
    mic: { path: join(path, "mic.wav"), samples: 0 },
  };
  const micChunks: { start: number; end: number; sequence: number; offsetMs: number }[] = [];

  async function openTrack(track: Track) {
    track.file = await open(track.path, "wx+", 0o600);
    await track.file.write(wavHeader(0), 0, 44, 0);
  }
  async function closeAudio() {
    await Promise.all(Object.values(tracks).map(async (track) => {
      if (!track.file) return;
      const current = track.file; track.file = undefined;
      try { await current.write(wavHeader(track.samples), 0, 44, 0); await current.sync(); }
      finally { await current.close(); }
    }));
  }
  try {
    await openTrack(tracks.tab);
    await writeFile(join(path, "session.json"), JSON.stringify({ sessionId: options.sessionId, language: options.language }), { mode: 0o600 });
    await writeFile(join(path, "mic-chunks.jsonl"), "", { mode: 0o600 });
  } catch (error) { await closeAudio(); await rm(path, { recursive: true, force: true }); throw error; }

  return {
    path,
    async append(chunk) {
      const track = tracks[chunk.channel];
      const offset = Math.round(chunk.offsetMs * SAMPLE_RATE / 1000);
      if (offset < track.samples - 16 || offset - track.samples > 2 * SAMPLE_RATE || offset + chunk.samples.length > MAX_SECONDS * SAMPLE_RATE) {
        throw new Error("Invalid audio timeline or recording exceeds the 4-hour limit");
      }
      if (!track.file) await openTrack(track);
      const bytes = Buffer.alloc(chunk.samples.length * 2);
      chunk.samples.forEach((v, i) => bytes.writeInt16LE(v, i * 2));
      let written = 0;
      while (written < bytes.length) {
        const result = await track.file!.write(bytes, written, bytes.length - written, 44 + offset * 2 + written);
        if (!result.bytesWritten) throw new Error("Could not save temporary recording");
        written += result.bytesWritten;
      }
      track.samples = offset + chunk.samples.length;
      // Keep valid WAVs even if the Gateway exits before normal finalization.
      await track.file!.write(wavHeader(track.samples), 0, 44, 0);
      if (chunk.channel === "mic") {
        const part = { start: offset, end: track.samples, sequence: chunk.sequence, offsetMs: chunk.offsetMs };
        await appendFile(join(path, "mic-chunks.jsonl"), `${JSON.stringify(part)}\n`);
        micChunks.push(part);
      }
    },
    async finalize(transcribe, progress) {
      await closeAudio();
      const turns = tracks.tab.samples < SAMPLE_RATE / 5 ? []
        : await options.diarize(tracks.tab.path, tracks.tab.samples / SAMPLE_RATE);
      const intervals = speechIntervals(turns).flatMap((turn) => {
        const result = [];
        // Bound each ASR request; do not load the entire meeting into the Gateway heap.
        for (let start = turn.start; start < turn.end; start += 30) result.push({ ...turn, start, end: Math.min(turn.end, start + 30) });
        return result;
      }).filter((turn) => turn.end - turn.start >= 0.2);
      const requests = [
        ...intervals.map((turn, sequence) => ({ channel: "tab" as const, sequence,
          start: Math.round(turn.start * SAMPLE_RATE), end: Math.round(turn.end * SAMPLE_RATE),
          offsetMs: Math.round(turn.start * 1000), speakers: turn.speakers })),
        ...micChunks.map((part) => ({ ...part, channel: "mic" as const, speakers: [] as number[] })),
      ];
      const final: CapturedLine[] = [];
      progress(0, requests.length);
      // Each channel is opened at most once, including microphone-only recordings.
      for (const channel of ["tab", "mic"] as const) {
        const parts = requests.map((part, index) => ({ ...part, index })).filter((part) => part.channel === channel);
        if (!parts.length) continue;
        const input = await open(tracks[channel].path, "r");
        try {
          for (const part of parts) {
            const data = Buffer.alloc((part.end - part.start) * 2);
            let read = 0;
            while (read < data.length) {
              const { bytesRead } = await input.read(data, read, data.length - read, 44 + part.start * 2 + read);
              if (!bytesRead) throw new Error("Incomplete temporary recording");
              read += bytesRead;
            }
            const pcm = new Int16Array(part.end - part.start);
            pcm.forEach((_, i) => { pcm[i] = data.readInt16LE(i * 2); });
            const text = channel === "mic" && !hasAudio(pcm) ? ""
              : (await transcribe({ channel, sequence: part.sequence, offsetMs: part.offsetMs, samples: pcm }, options.language)).trim();
            if (text) final.push({
              speakerId: channel === "mic" ? "mic" : `tab:${part.speakers.join("+")}`,
              speaker: channel === "mic" ? "Микрофон" : part.speakers.length === 1 ? `Участник ${part.speakers[0]}`
                : `Одновременно: ${part.speakers.map((id) => `Участник ${id}`).join(", ")}`,
              text, offsetMs: part.offsetMs, durationMs: Math.round((part.end - part.start) / SAMPLE_RATE * 1000),
            });
            progress(part.index + 1, requests.length);
          }
        } finally { await input.close(); }
      }
      if (intervals.length && !final.some((line) => line.speakerId.startsWith("tab:"))) throw new Error("Final transcription returned no tab speech");
      final.sort((a, b) => a.offsetMs - b.offsetMs);
      await writeFile(join(path, "final.json"), JSON.stringify(final), { mode: 0o600 });
      return final;
    },
    async dispose() { await closeAudio(); await rm(path, { recursive: true, force: true }); },
  };
}
