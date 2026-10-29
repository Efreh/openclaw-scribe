import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function launchDirectory(directory: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  await run(command, process.platform === "darwin" ? ["--", directory] : [directory], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
}

// The browser supplies an opaque recording ID, never a path or shell command.
export async function openRecordingDirectory(options: {
  workDir: string; recordingsDir: string; id: string; recovery: boolean;
  launch?: (directory: string) => Promise<void>;
}) {
  if (!/^recording-[A-Za-z0-9_-]{6,80}$/.test(options.id)) throw new Error("Некорректный идентификатор записи");
  const root = await realpath(options.recovery ? options.workDir : options.recordingsDir);
  const directory = join(root, options.id);
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error("Папка записи недоступна");
  let audio = false;
  for (const channel of ["tab", "mic"]) {
    try {
      const file = await lstat(join(directory, channel + ".wav"));
      if (file.isFile() && file.size > 44) audio = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!audio) throw new Error("Аудиофайлы записи больше не существуют");
  await (options.launch ?? launchDirectory)(directory);
}
