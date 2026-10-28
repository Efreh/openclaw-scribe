# Verification: local speaker diarization, v0.2.0

Verified on 2026-10-28 with OpenClaw 2026.10.7 and Node.js 26.12.1.

## Engine and model

- Official [NVIDIA NeMo-Speech.cpp v0.2.0](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.2.0), not a custom diarization algorithm.
- Linux x86_64 CUDA archive SHA-256: `aef573fcc6c2c759401d2ed03e5ca9e401ed23b0e38cb852d917080c1e2d4515`.
- Model: `nvidia/Nemotron-3-Diarization`, revision `f667ed73aee57d40cc39428eb768b4fd87a0a29e`.
- Native indexed artifact: `Nemotron-3-Diarization.q8_0.gguf`, 107,012,128 bytes, SHA-256 `08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1`.
- The vendor's `pull nemotron-diar` downloaded and verified that single model without an account or token. No NeMo ASR model, Python, PyTorch, or speech server was installed.
- Inference uses the local model path and `--preset v3-offline`: a stateful chunked pass, not memory-unbounded full attention.

## Reference speaker identity

The native integration test downloads public audio, checks its checksum, and checks speaker identities at fixed interior points. It does **not** supply the number of speakers or tune thresholds for a recording.

| Reference | Expected distinct voices | Checks |
| --- | --- | --- |
| sherpa-onnx public four-speaker example, 56.861 s | 4 | Arrival-order labels 1, 2, 2, 3, 1, 4, 4, 3, 1 at the annotated turns; returning voices retain their label |
| pyannote public two-speaker telephone sample, 30 s | 2 | Alternating voices and returning labels 1/2, including the same person after multiple intervening turns |

Both checks passed on CPU and CUDA. These are integration/reference checks, not an aggregate accuracy benchmark or a guarantee for arbitrary meetings. The published limit is eight voices in the tab; microphone audio remains a separate source.

## Installed package proof

`test:native` installed the TGZ into a fresh isolated OpenClaw profile, ran `scribe setup --diarization`, started a separate Gateway on temporary ports, submitted the public two-speaker recording, and waited for finalization.

- Three input audio frames produced a live draft.
- Final transcript: 13 utterances labeled `Участник 1`, `Участник 2`, or explicitly overlapping speech.
- The configured host Whisper CLI performed transcription; no replacement ASR was installed.
- The native transcript export contains both participants, without duplicate draft rows.
- The native meeting was stopped and its summary was stored.
- The user's live Gateway and its configuration were not modified by this test.

## Failure and browser checks

- A failed diarizer saves the source-labeled draft with an explicit warning and retains a private recoverable WAV/journal.
- Success removes staged audio only after final utterances and native completion are delivered.
- Native capture remains occupied during final processing.
- Overlapping model turns are partitioned once, not transcribed twice as independent clean voices.
- The final pass can recover speech missed by live ASR; invalid large timeline jumps cannot create huge sparse files.
- Real MV3 browser capture survives closing the popup and changing tabs, drains both sources, and displays the final participant labels.
- The setting persists, is locked during recording, and is off by default for backward compatibility.
- An unconfigured backend rejects a requested diarization mode explicitly; it never silently claims that source labels are speaker diarization.

See `npm test`, `npm run test:diarization`, `npm run test:browser`, and the opt-in `npm run test:native` in the README.
