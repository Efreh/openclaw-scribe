# Repository conventions

- Work on this project without subagents.
- This repository contains a TypeScript browser extension and a native OpenClaw
  plugin, with shared protocol/types. Do not introduce an additional backend.
- Keep project code and its future package/build configuration under `src/`.
  Use `src/extension/`, `src/plugin/`, and `src/shared/` for the respective parts.
- Keep tests under `src/spec/unit/` and `src/spec/integration/`; put reusable test
  helpers in `src/spec/support/`. Do not add placeholder tests.
- Keep GitHub Actions workflows under `.github/workflows/` and repository-level
  documentation, licensing, and contributor instructions at the root.
- Prefer maintained, current stable tooling compatible with the target browsers
  and OpenClaw. Add tooling only when implementing the corresponding capability.
- Document limitations honestly. Verify packages, not only source checkouts;
  never change the user's live Gateway config as part of automated tests.
- Speaker diarization must use a maintained ready-made local engine, without
  registration, accounts, or cloud audio upload. Keep the configured Whisper for
  ASR; add only the necessary diarization model/runtime, not another ASR stack.
- Use the official NeMo-Speech.cpp CLI and Nemotron 3 Diarization model. Do not
  invent per-chunk voice matching or install exploratory engines as dependencies.
