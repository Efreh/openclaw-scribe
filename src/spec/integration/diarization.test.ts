import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDiarizationSession } from "../../plugin/diarization.ts";

test("final diarization works without any live ASR and rejects sparse-file abuse on both channels", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-draft-miss-"));
  const session = await createDiarizationSession({ workDir, sessionId: "draft-miss", language: "ru",
    diarize: async () => [{ start: 0, end: 1, speaker: 1 }],
  });
  try {
    for (const channel of ["tab", "mic"] as const) {
      await assert.rejects(session.append({ channel, sequence: 0, offsetMs: 14_400_001, samples: new Int16Array(1) }));
    }
    assert.equal((await stat(join(session.path, "tab.wav"))).size, 44);
    await session.append({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) });
    const lines = await session.finalize(async () => "Восстановленная реплика", () => {});
    assert.equal(lines[0]?.speaker, "Участник 1");
    assert.equal(lines[0]?.text, "Восстановленная реплика");
  } finally { await session.dispose(); await rm(workDir, { recursive: true, force: true }); }
});

for (const silent of [false, true]) test(`microphone-only finalization preserves offsets and skips silence=${silent}`, async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-mic-only-"));
  const session = await createDiarizationSession({ workDir, sessionId: "mic-only", language: "ru",
    diarize: async () => { throw new Error("No tab audio should reach the diarizer"); },
  });
  let calls = 0;
  try {
    await session.append({ channel: "mic", sequence: 0, offsetMs: 500, samples: new Int16Array(16_000).fill(silent ? 0 : 1000) });
    const lines = await session.finalize(async (chunk) => {
      calls++; assert.equal(chunk.channel, "mic"); assert.equal(chunk.offsetMs, 500);
      assert.equal(chunk.samples.length, 16_000); assert.equal(chunk.samples[0], 1000);
      return "final microphone";
    }, () => {});
    assert.equal(calls, silent ? 0 : 1);
    assert.deepEqual(lines.map((line) => [line.speakerId, line.text, line.offsetMs]), silent ? [] : [["mic", "final microphone", 500]]);
  } finally { await session.dispose(); await rm(workDir, { recursive: true, force: true }); }
});
