export const VERSION = 1;
export const SAMPLE_RATE = 16_000;
export const CHUNK_SECONDS = 10;
export const MAX_AUDIO_BYTES = SAMPLE_RATE * 20 * 2 + 10;
export const DEFAULT_URL = "ws://127.0.0.1:19789";
export type Channel = "tab" | "mic";
export type AudioChunk = { channel: Channel; sequence: number; offsetMs: number; samples: Int16Array };
export type Hello = { type: "start"; version: 1; token: string; title: string; url: string; language: string };
export type Line = { speaker: string; text: string; offsetMs: number };
export type ServerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "ack"; channel: Channel; sequence: number }
  | { type: "line"; line: Line }
  | { type: "stopped"; sessionId: string }
  | { type: "error"; message: string };

export function parseHello(raw: unknown): Hello {
  const v = raw as Partial<Hello> | null;
  if (!v || v.type !== "start" || v.version !== VERSION || typeof v.token !== "string"
    || v.token.length > 256 || typeof v.title !== "string" || v.title.length > 300
    || typeof v.url !== "string" || v.url.length > 4096
    || typeof v.language !== "string" || !/^[a-z]{2,3}$/.test(v.language)) {
    throw new Error("Invalid start message");
  }
  return v as Hello;
}

export function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Используйте ws://127.0.0.1:порт (или localhost)");
  }
  return url.href;
}

export function encodeAudio(chunk: AudioChunk): ArrayBuffer {
  const buffer = new ArrayBuffer(10 + chunk.samples.length * 2);
  const view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, chunk.channel === "tab" ? 0 : 1);
  view.setUint32(2, chunk.sequence, true);
  view.setUint32(6, chunk.offsetMs, true);
  chunk.samples.forEach((sample, i) => view.setInt16(10 + i * 2, sample, true));
  return buffer;
}

export function decodeAudio(bytes: Uint8Array): AudioChunk {
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_AUDIO_BYTES || bytes.byteLength % 2) {
    throw new Error("Invalid audio frame size");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== VERSION || view.getUint8(1) > 1) throw new Error("Invalid audio frame header");
  const samples = new Int16Array((bytes.byteLength - 10) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(10 + i * 2, true);
  return {
    channel: view.getUint8(1) === 0 ? "tab" : "mic",
    sequence: view.getUint32(2, true), offsetMs: view.getUint32(6, true), samples,
  };
}

export function wav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}
