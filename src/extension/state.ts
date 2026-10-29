import { DEFAULT_URL } from "../shared/protocol.ts";
import type { AudioRecording, Channel, Line } from "../shared/protocol.ts";

export type Settings = { url: string; token: string; microphone: string; language: string; showText: boolean; diarization: boolean; saveAudio: boolean; theme: "dark" | "light"; lastMicrophone: string };
export const defaults: Settings = { url: DEFAULT_URL, token: "", microphone: "default", language: "ru", showText: true, diarization: false, saveAudio: false, theme: "dark", lastMicrophone: "default" };
export type Tab = { id: number; title: string; url: string };
export type State = {
  status: "idle" | "starting" | "recording" | "stopping" | "done" | "error";
  tab?: Tab; startedAt?: number; endedAt?: number; sessionId?: string; error?: string;
  diarization?: boolean; saveAudio?: boolean; fullRecording?: boolean; microphone?: string; audio?: AudioRecording; warning?: string; progress?: string;
  levels: Record<Channel, number>; lines: Line[];
};
export const idle = (): State => ({ status: "idle", levels: { tab: 0, mic: 0 }, lines: [] });
export async function settings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get<{ settings?: Partial<Settings> }>("settings")).settings;
  return { ...defaults, ...stored };
}
