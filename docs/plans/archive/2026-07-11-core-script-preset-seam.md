# `M3LScript` preset→config seam (F8)

**Status: shipped** (PR #106)

## Context

`docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` both ranked **Priority 0 —
Library hardening (F-series)** ahead of any further consumer scripts, since
this friction compounds across every later script. **F8** was the top item:
`M3LScriptPresetLoader` could already parse, merge, validate, and resolve
`extends` on a preset file, but nothing invoked it — `M3LScript` never wired
it in, and `M3LScriptConfigLoader` wired only CLI + env. A loaded preset
therefore couldn't actually drive a run's resolved configuration, blocking the
"presets + CLI overrides" design every fleet script assumes.

## Approach / Decisions

- Isolation: new linked worktree (`pnpm worktree:new script-preset-seam`),
  branch `feat/script-preset-seam`, landed via PR (guarded
  `packages/m3l-common/src/**` change).
- Reused existing primitives instead of building new ones:
  `M3LScriptPresetLoader` (parse/`extends`/validate) and
  `M3LPresetConfigProvider` (a `M3LConfigProvider` that screens dangerous
  keys) both already existed — contract-first review reframed the task from
  "build a seam" to "wire it in at the correct precedence slot."
- Added `preset?: string` to `M3LScriptOptions` (additive, semver-minor) plus
  a `--preset <path>` CLI flag.
- Inserted the preset provider at precedence level 6 (below CLI/env, above
  static defaults) via a distinct `presetProviders?` tail slot on
  `M3LScriptConfigLoader` — kept deliberately separate from the
  front-spread `extraProviders` (Lambda-event, highest priority) rather than
  reordering existing precedence.
- New private `M3LScript.buildPresetProviders()` helper constructs the loader
  against the already-built config schema and threads a
  `M3LPresetConfigProvider` through `loadConfig()`, preserving the
  `onBeforeConfigLoad`/`onAfterConfigLoad` bracket. No new error types — loader
  throws propagate unchanged.
- Spec-first: `docs/reference/core/script.md` gained a "Wiring a preset into
  config" subsection; `docs/reference/core/config.md` already documented the
  target precedence order and needed no change.

## Outcome

Landed as three commits (`aee8ae4` feat, `5caf1ef` docs/provenance reconcile,
`961d9d7` tracker flip). The script test suite grew from 124 to 138 tests; the
full gate (typecheck/lint/test/build/exports) was green. All five review
spokes (security, spec-conformance, type-design, silent-failure,
code-reviewer) returned no blocking issues beyond the anticipated
docs-provenance gap. `json-etl`'s own `--preset` re-enable followed as the
separate **F8-adopt** item — see
[`2026-07-12-json-etl-adopt-seams.md`](./2026-07-12-json-etl-adopt-seams.md).
Full narrative, including the truncated-spoke recovery and the over-broad
provenance re-stamp caught during this work: `docs/logs/2026-07-11-core-script-preset-seam.md`.
