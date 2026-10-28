import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTurns, speechIntervals } from "../../plugin/diarization.ts";

test("diarization output is bounded to valid local speaker turns", () => {
  assert.deepEqual(parseTurns({ segments: [{ start: 1, end: 2.01, speaker: 2 }, { start: 0, end: 1, speaker: 1 }] }, 2),
    [{ start: 0, end: 1, speaker: 1 }, { start: 1, end: 2, speaker: 2 }]);
  for (const segments of [undefined, [{ start: -1, end: 2, speaker: 1 }], [{ start: 1, end: 0, speaker: 1 }],
    [{ start: 0, end: 3, speaker: 1 }], [{ start: 0, end: 1, speaker: 9 }], [{ start: 0, end: Infinity, speaker: 1 }]]) {
    assert.throws(() => parseTurns({ segments }, 2));
  }
});

test("overlapping speech is identified once, not duplicated as two clean voices", () => {
  assert.deepEqual(speechIntervals([
    { start: 0, end: 2, speaker: 1 }, { start: 1, end: 3, speaker: 2 }, { start: 4, end: 5, speaker: 1 },
  ]), [
    { start: 0, end: 1, speakers: [1] }, { start: 1, end: 2, speakers: [1, 2] },
    { start: 2, end: 3, speakers: [2] }, { start: 4, end: 5, speakers: [1] },
  ]);
});
