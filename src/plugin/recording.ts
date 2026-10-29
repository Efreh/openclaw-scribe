import { appendFile, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { hasAudio, SAMPLE_RATE, wavHeader } from "../shared/protocol.ts";
import type { AudioChunk, AudioRecording, Channel } from "../shared/protocol.ts";
import { speechIntervals } from "./diarization.ts";
import type { CapturedLine, Transcribe, Turn } from "./diarization.ts";

const MAX_SECONDS = 4 * 60 * 60;
export type RecordingSession = {
  readonly path: string;
  append: (chunk: AudioChunk) => Promise<void>;
  finalize: (transcribe: Transcribe, progress: (done: number, total: number) => void) => Promise<CapturedLine[]>;
  complete: () => Promise<AudioRecording | undefined>;
  recover: () => Promise<AudioRecording>;
  dispose: () => Promise<void>;
};

export async function createRecordingSession(options: {
  workDir: string; sessionId: string; language: string;
  diarize?: (path: string, duration: number) => Promise<Turn[]>;
  saveAudio?: boolean; recordingsDir?: string;
}): Promise<RecordingSession> {
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  if (options.saveAudio && !options.recordingsDir) throw new Error("Recording archive directory is required");
  let path = await mkdtemp(join(options.workDir, "recording-"));
  type Track = { path: string; file?: FileHandle; samples: number };
  const tracks: Record<Channel, Track> = {
    tab: { path: join(path, "tab.wav"), samples: 0 },
    mic: { path: join(path, "mic.wav"), samples: 0 },
  };
  const chunks: { channel: Channel; start: number; end: number; sequence: number; offsetMs: number }[] = [];

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
    await writeFile(join(path, "session.json"), JSON.stringify({ sessionId: options.sessionId, language: options.language, diarization: Boolean(options.diarize), saveAudio: Boolean(options.saveAudio) }), { mode: 0o600 });
    await writeFile(join(path, "chunks.jsonl"), "", { mode: 0o600 });
  } catch (error) { await closeAudio(); await rm(path, { recursive: true, force: true }); throw error; }

  function audioInfo(recovery: boolean): AudioRecording {
    return { id: basename(path), directory: path, files: (["tab", "mic"] as const).filter((channel) => tracks[channel].samples > 0), recovery };
  }
  return {
    get path() { return path; },
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
      const part = { channel: chunk.channel, start: offset, end: track.samples, sequence: chunk.sequence, offsetMs: chunk.offsetMs };
      await appendFile(join(path, "chunks.jsonl"), `${JSON.stringify(part)}\n`);
      chunks.push(part);
    },
    async finalize(transcribe, progress) {
      await closeAudio();
      const turns = !options.diarize || tracks.tab.samples < SAMPLE_RATE / 5 ? []
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
        ...chunks.filter((part) => part.channel === "mic" || !options.diarize).map((part) => ({ ...part, speakers: [] as number[] })),
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
            const text = !hasAudio(pcm) ? ""
              : (await transcribe({ channel, sequence: part.sequence, offsetMs: part.offsetMs, samples: pcm }, options.language)).trim();
            if (text) final.push({
              speakerId: channel === "mic" ? "mic" : !options.diarize ? "tab" : `tab:${part.speakers.join("+")}`,
              speaker: channel === "mic" ? "Микрофон" : !options.diarize ? "Вкладка" : part.speakers.length === 1 ? `Участник ${part.speakers[0]}`
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
    async complete() {
      await closeAudio();
      if (!options.saveAudio) { await rm(path, { recursive: true, force: true }); return undefined; }
      await mkdir(options.recordingsDir!, { recursive: true, mode: 0o700 });
      const destination = join(options.recordingsDir!, basename(path));
      await rename(path, destination);
      path = destination;
      return audioInfo(false);
    },
    async recover() { await closeAudio(); return audioInfo(true); },
    async dispose() { await closeAudio(); await rm(path, { recursive: true, force: true }); },
  };
}

