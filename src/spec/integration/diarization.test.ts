import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDiarizationSession } from "../../plugin/diarization.ts";

test("final diarization can recover speech missed by the live ASR and rejects sparse-file abuse", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "scribe-draft-miss-"));
  const session = await createDiarizationSession({ workDir, sessionId: "draft-miss", language: "ru",
    diarize: async () => [{ start: 0, end: 1, speaker: 1 }],
  });
  try {
    await assert.rejects(session.append({ channel: "tab", sequence: 0, offsetMs: 14_400_001, samples: new Int16Array(1) }));
    assert.equal((await stat(join(session.path, "tab.wav"))).size, 44);
    await session.append({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(16_000).fill(1000) });
    const lines = await session.finalize(async () => "Восстановленная реплика", () => {});
    assert.equal(lines[0]?.speaker, "Участник 1");
    assert.equal(lines[0]?.text, "Восстановленная реплика");
  } finally { await session.dispose(); await rm(workDir, { recursive: true, force: true }); }
});
