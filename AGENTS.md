# Repository conventions

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
- The current scaffold is not runnable. Do not describe unimplemented build,
  recording, transcription, tests, or CI as working features.
