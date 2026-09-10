# Adaptive host budgeting — implementation plan (2026-09-08)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0080](../adr/0080-host-resource-budgeting.md) (amended
  twice by this wave already — the 2026-09-08 earlyoom-targeting update and
  the same-day `lint:workspace` heap update — and slated for a further
  amendment or supersession once Slice 4 below replaces its fixed
  concurrency caps with a derived budget).
- **Why this plan exists:** `setup:host-resources` had already been applied
  to a 4-core/24 GB ARM64 host and the memory crisis ADR-0080 was written
  against was gone (PSI all zero, swap untouched) — but re-deriving the
  ADR's own claims against the live host, rather than trusting "applied"
  means "working", surfaced concrete defects instead: earlyoom's
  `--prefer`/`--avoid` regex matched the wrong process names (fixed in
  Slice 1), and separately a V8 heap ceiling crash in `lint:workspace`
  specific to this architecture. Beyond fixing what's broken, the host's
  binding constraint has genuinely moved from memory to CPU/architecture —
  `50%`-of-cores caps and RAM-only thresholds are fixed constants that
  cannot be correct on more than one host (a 4-core ARM64 box, an x86_64 CI
  runner with SMT, an Apple-Silicon P/E-core Mac). This plan replaces those
  constants with a detected host profile → derived budget, gated on a new
  benchmark harness rather than more inference.

## Scope and sequencing

| Stage | Contents                                                                                                                                            | Shape                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **0** | Fix the two earlyoom defects + the `lint:workspace` heap crash                                                                                      | Correctness fixes to an already-shipped safety net; ships alone, first                |
| **1** | `bin/lib/host-profile.mjs` (detect + derive) and `bin/bench-gates.mjs` (measure)                                                                    | No behavior change yet — new tooling, no consumers switched over                      |
| **2** | Switch `vitest.*.config.ts`, `turbo.json`, `package.json` gate scripts, `lefthook.yml` over to the derived budget; retire the fixed `50%` constants | The CI- and behavior-affecting slice; needs Stage 1's baseline numbers to justify     |
| **3** | Phase-2 tuning candidates (prettier/tsc/eslint caching, `verify-all.mjs` parallelism, lane re-scheduling, `/tmp` tmpfs)                             | Each gated on its own before/after from the Stage-1 harness; smallest independent PRs |

Full design detail (the exact `detectHostProfile`/`deriveBudget` shape, the
OS/Darwin collector seam, the harness's metrics and flags, the ranked Phase-2
candidate table with hypotheses) lives in the plan-mode transcript this wave
started from — re-derive it fresh at Slice 2's start rather than trusting a
paraphrase to still be accurate, per this repo's own standing instruction to
re-verify an authored claim before acting on it.

## Landing plan

ADR-0072's durable slice record for this non-submodule multi-PR wave — the
same `## Landing plan` heading and `| Slice | Branch | Scope | Status |`
table a submodule's reference page carries, gated by
`pnpm check:landing-plans`.

| Slice | Branch                          | Scope                                                                                                  | Status            |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| P0    | `fix/earlyoom-process-matching` | Fix earlyoom `--prefer`/`--avoid` targeting + swap threshold + `lint:workspace` heap ceiling (Stage 0) | Done              |
| P1    | `feat/host-profile`             | `bin/lib/host-profile.mjs` + `bin/bench-gates.mjs` (Stage 1)                                           | Done              |
| P2    | `refactor/adaptive-concurrency` | Switch consumers to the derived budget; retire fixed caps (Stage 2)                                    | Done              |
| P3.1  | `feat/prettier-cache`           | Phase 2 #1: Prettier `--cache --cache-strategy content` on `format`/`format:check` (Stage 3)           | Landed (PR #1145) |
| P3.2  | `feat/tsc-incremental`          | Phase 2 #2: `incremental`/`tsBuildInfoFile` on the tooling tsconfigs + `bin/tsconfig.json` (Stage 3)   | Landed (PR #1156) |
| P3.3  | —                               | Phase 2 #3: ESLint `--cache --cache-strategy content`, local-only via `lint:fast` (Stage 3)            | To Do             |
| P3.4  | —                               | Phase 2 #4: `--jobs N` for `bin/verify-all.mjs` (Stage 3)                                              | To Do             |
| P3.5  | —                               | Phase 2 #5: lane scheduling (`--concurrent` vs `--isolated`, lefthook seam) (Stage 3)                  | To Do             |
| P3.6  | —                               | Phase 2 #6: ESLint `--concurrency` > 1, after P3.3/P3.5 (Stage 3)                                      | To Do             |
| P3.7  | —                               | Phase 2 #7: `/tmp` → tmpfs (Stage 3)                                                                   | To Do             |
| P3.8  | —                               | Phase 2 #8: parallelise the 29-gate `checks` chain (Stage 3)                                           | To Do             |
