# m3l-cli build-out — ADR-0042 activation, phases 8b–8g

**Status: shipped** — PRs #406, #407, #415, #416, #417, #418, #419, plus the
final 8g/closeout PR of the series. Work log:
[`docs/logs/2026-08-14-m3l-cli-build-out.md`](../../logs/2026-08-14-m3l-cli-build-out.md).

## Context

Issue #333 tracked ADR-0042's deferred zero-dependency `packages/m3l-cli`
(discovery/introspection over the `configParameters` seam, `run`/`doctor`/
wizard). The maintainer's request to start the work was itself the ADR's
revisit trigger 1, but the instruction was explicit: do **not** treat the
issue or the ADR as authoritative — re-assess first. A three-way Explore
fan-out (the recorded design; the live repo; web research on zero-dependency
Node 24 CLIs) confirmed every repo assumption still held and surfaced one
correction: `scripts/json-etl/src/config.ts` imports `./lib/field-spec.js`,
which Node's native type-stripping cannot resolve from source — forcing a
**dist-first** discovery loader with a type-stripped `src` fallback.

## Approach / Decisions

- **Full 8b–8g scope confirmed** at the starting-work gate (shared checkout;
  stacked `feat/m3l-cli-*` branches; PR per phase; the library
  `secret`-flag prerequisite as its own parallel PR off `main`).
- **One PR per phase**, each a full TDD loop (RED test-author → GREEN
  code-implementer → phase-matched reviewer fan-out, Must-fix fixed
  same-PR): 8b scaffold + governance + `list`/`inspect`; 8c `run`; 8d
  dynamic subcommands (+ the deferred table/cached-load dedup refactors);
  8e `doctor`; 8f presets + history (+ secret threading, mandatory
  security review); 8g wizard.
- **Zero-dependency held throughout** — `node:util` parseArgs with
  hand-rolled first-positional dispatch, `util.styleText` behind a
  TTY/NO_COLOR/FORCE_COLOR-aware output layer, `Core.M3LPrompt` for the
  wizard, `M3LUnknownParameterDetector` for suggestions — enforced by an
  ESLint import boundary plus `check:zones` predicates.
- **Security posture**: the `secret` flag masks defaults at both the
  library help formatter and the CLI descriptor source (env-sourced
  defaults proven to leak otherwise); preset writer fail-closed; history
  entries structurally value-free; preset errors render content-free
  categories; wizard summary/prefill sanitized against terminal controls
  and bidi overrides.
- **Governance**: reserved CLI command names (nine by 8g) live in the
  scaffold manifest with a doctor drift-guard; the m3l-cli build-out
  tracker section got its own hub-sync extractor so `sync:hub` mints
  per-phase issues.

## Outcome

The CLI shipped whole: `pnpm m3l list | inspect | run | <script> |
doctor | presets | history | wizard`, 380 package tests (7,189
workspace-wide), every source file over the per-file coverage gate, and a
living contract at [`docs/reference/cli.md`](../../docs/reference/cli.md)
(path relative to repo root: `docs/reference/cli.md`). ADR-0042 carries the
activation and shipped updates; `docs/plans/IMPLEMENTATION.md`'s build-out
section and the ROADMAP row are Done. Post-merge maintenance:
`pnpm sync:hub -- --apply` to close the per-phase hub issues and #333.
