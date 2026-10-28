import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defaultDiarizationCommand, diarizeFile, prepareDiarization } from "../../plugin/diarization.ts";

const run = promisify(execFile);

test("official native model detects and consistently labels public 2- and 4-speaker references", { timeout: 240_000 }, async () => {
  const command = process.env.NEMO_SPEECH_BIN ?? await defaultDiarizationCommand();
  const config = { ...await prepareDiarization(command), device: process.env.NEMO_DEVICE ?? "cpu" };
  const dir = await mkdtemp(join(tmpdir(), "scribe-diar-native-"));
  const samples = [
    { name: "four-speakers.wav", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav",
      hash: "bedf036caed208386c67b4ef4b11f83d74dd0d420b102163a1c33cd09cde7010", duration: 56.861,
      probes: [3, 8, 12, 15, 23, 29, 35, 49, 53], expected: [1, 2, 2, 3, 1, 4, 4, 3, 1] },
    { name: "meeting.wav", url: "https://raw.githubusercontent.com/pyannote/pyannote-audio/b5794f46d16f85de1551a7080658b6de7d62046f/tutorials/assets/sample.wav",
      hash: "c319b4abca767b124e41432d364fd7df006cb26bb79d09326c487d606a134e6e", duration: 30.003,
      probes: [6.9, 7.8, 9, 12, 15.5, 19.5, 24, 29], expected: [1, 2, 1, 1, 2, 1, 2, 1] },
  ];
  try {
    for (const sample of samples) {
      const path = join(dir, sample.name);
      await run("curl", ["--fail", "--location", "--silent", "--show-error", "--max-time", "90", sample.url, "--output", path], { timeout: 100_000 });
      assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), sample.hash);
      const turns = await diarizeFile(config, path, sample.duration);
      assert.equal(new Set(turns.map((turn) => turn.speaker)).size, new Set(sample.expected).size, sample.name);
      assert.deepEqual(sample.probes.map((time) => turns.filter((turn) => turn.start <= time && turn.end > time).map((turn) => turn.speaker)),
        sample.expected.map((speaker) => [speaker]), `${sample.name}: each returning voice must keep its label`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
