# Work log — `core/script` F8 preset seam (2026-07-11)

This log covers the **F8 preset-seam** change: wiring an already-existing preset
loader into a script run's resolved configuration. It ran through the
`implementing-submodules` hub-and-spoke pipeline (contract → RED → GREEN →
5-reviewer fan-out) on branch `feat/script-preset-seam` in a sibling worktree. It
records what shipped, what matched the plan, the four divergences (a truncated
test spoke, an over-broad provenance re-stamp, a pre-existing precedence quirk,
and the declined rename nit), and the durable lessons — two promoted into the
rules in this same change set.

Plan of record: `~/.claude/plans/docs-roadmap-md-docs-plans-implementati-cheeky-marble.md`
(pre-work plan; not a `docs/plans/` file).

## Summary

**Shipped** — a loaded preset can now drive a script run's configuration at the
correct precedence:

- **Public surface (semver-minor):** one additive optional field
  `M3LScriptOptions.preset?: string` (a YAML/JSON preset file path). No
  `exports`-map change; surfaced through the existing `./core` barrel.
- **Internal wiring:** a distinct `presetProviders?: readonly M3LConfigProvider[]`
  tail slot on `M3LScriptConfigLoader` (appended **after** CLI+env, i.e.
  precedence level 6 — below CLI/env, above static defaults), kept separate from
  the front-spread `extraProviders`. A new `M3LScript.buildPresetProviders()`
  private helper loads the preset via `M3LScriptPresetLoader` (schema-validated
  against `config.params`), wraps it in `M3LPresetConfigProvider`, and threads it
  through `loadConfig()`. No new error types — loader throws propagate unchanged.
- **Docs:** a new "Wiring a preset into config" subsection in
  `docs/reference/core/script.md`; `config.md` already ranked the preset provider
  at level 6, so it needed no change.

**Commits:** `aee8ae4` (feat), `5caf1ef` (docs/provenance reconcile), `961d9d7`
(tracker flip to in-review).

**Tests:** script suite `124 → 138` (13 F8 tests + 1 lock-in test). Full gate
green — `2500` tests across 46 files, `tsc -b` / `eslint` / `build` clean,
`check:doc-*` / `check:index` / `check:impl-counts` / `check:test-counts` all ✓.

**Review (5 spokes):**

- `security-reviewer` — **clean** (prototype-pollution screening preserved and
  in fact doubled; no secret leak; path within trust boundary).
- `spec-conformance-reviewer` — **conformant** (preset at level-6 tail slot; only
  new public symbol is `preset?: string`); also produced the exact `script.md`
  wording.
- `type-design-analyzer` — **sound, ship it** (`string` is convention-consistent;
  no branded-path type exists in `src/`).
- `silent-failure-hunter` — **clean** (no try/catch swallow; cause chain intact).
- `code-reviewer` — sound implementation; **1 Must-fix** (docs missing →
  `check:doc-provenance` fails; expected, was the planned docs step) + **1
  Should-fix** (preset-without-`config` foot-gun → closed with a test + TSDoc) +
  3 nits (2 accepted, 1 declined).

## What went as planned

- **Contract-first paid off immediately.** The `spec-conformance-reviewer` in
  contract mode discovered up front that every primitive already existed
  (`M3LScriptPresetLoader` → `Record`, `M3LPresetConfigProvider` consumes a
  `Record`, `M3LScriptConfigLoader.load` already had a provider seam). That
  reframed F8 from "build a seam" to "wire + pick the correct precedence slot,"
  and no new primitive was written.
- **RED failed for the right reason.** The new tests failed on the missing
  `preset`/`presetProviders` symbols (13 `tsc` `TS2339`/`TS2353` + 4 runtime
  preset-path failures), not on unrelated logic.
- **GREEN was clean on first pass.** The `code-implementer` delivered
  lint/typecheck-clean wiring that took the script suite to 138/138 without a
  re-dispatch, then the review-fix pass (helper extraction + TSDoc) stayed green.
- **Four of five reviewers returned no Must-fix items;** the only Must-fix was
  the anticipated docs gap.

## What didn't go as planned, and why

### 1. The `test-author` spoke truncated at its output limit after spending its whole budget exploring

The first `test-author` dispatch burned 42 tool calls (~105k tokens) reading the
suite's helpers and patterns, then hit its turn/output limit having written only
**two import lines** — no test bodies. Its final message was a mid-thought
("Let me look at where CLI/env config resolution tests are…"), not a completion
report. It was recovered by **resuming the same spoke via `SendMessage`** with a
"stop exploring, write the tests now" directive; with its exploration context
still loaded, it then produced all 12 tests and confirmed RED.

**Why it happened:** the suite is large and the spoke front-loaded exhaustive
exploration before writing anything, so the write phase fell off the end of the
turn. Unlike the `code-implementer` dispatch, the hub did **not** hand the
`test-author` an explicit journal path, so there was no durable trace of where it
stopped (its own agent prompt tells it to journal, but with no path it never
created one on the truncated run).

**Fix for future:** the hub should hand the `test-author` a scratchpad **journal
path** in the RED dispatch, exactly as it does for the `code-implementer` in
GREEN — and verify the spoke's actual state (git diff) rather than trusting a
final report that looks truncated. Resume-in-place beats re-dispatching fresh.

### 2. `check-doc-provenance.mjs --update` re-stamped all 22 sidecars, not just the changed one

Running the bare `node bin/check-doc-provenance.mjs --update` from the
`/syncing-docs` step-2 instruction rewrote **every** provenance sidecar's
`commit` to the F8 HEAD and `retrieved` to today — 22 files in the diff, 21 of
them unrelated to F8 (e.g. `errors.provenance.json` had its `commit` bumped from
its real verification commit to `aee8ae4`, falsely claiming an F8-time
re-verification). Caught by inspecting the diff; reverted with
`git checkout -- docs/reference/` and re-stamped scoped with
`node bin/check-doc-provenance.mjs --update --affected packages/m3l-common/src/core/script/M3LScript.ts`,
leaving only `script.provenance.json` modified.

**Why it happened:** the unscoped `--update` is global by design (it restamps
every validated sidecar). `/syncing-docs` step 2 documents the bare form; the
scoped `--update --affected <file>` form is mentioned only later (step 8's
context), so following step 2 literally produces a repo-wide restamp.

**Fix for future:** for a change that touches only some modules, always scope the
re-stamp: `--update --affected <changed-source-file>`. Inspect
`git status -- docs/reference/` after; if sidecars for untouched modules changed,
the restamp was too broad — revert and re-scope.

### 3. Pre-existing `extraProviders`-above-CLI precedence inversion (out of scope, flagged)

The `spec-conformance-reviewer` noted that `M3LScriptConfigLoader` spreads
`extraProviders` at the **front** of the providers array (highest priority),
placing the Lambda-event slot **above** CLI — whereas `config.md` ranks CLI at
level 1 and the Lambda event at level 5. This inversion **predates F8** (the diff
only reworded that field's TSDoc) and is the script loader's own arrangement, not
the canonical `M3LConfigReader` order.

**Why it happened:** it is an existing arrangement in `M3LScriptConfigLoader`,
unrelated to the preset tail slot F8 added; F8 deliberately did **not** reorder
CLI/env-vs-`extraProviders`, since that would be a separate, unrequested
behavior change.

**Fix for future:** file it as its own small follow-up (a config-precedence
reconciliation) rather than smuggling a behavior change into an unrelated PR —
recorded here so it isn't lost. Not filed as an F-item yet; candidate for the
next F-series triage.

### 4. Nit to rename `preset` → `presetPath` was declined

The `code-reviewer` suggested `presetPath` self-documents better than `preset`
(which could read as a named identifier like `"prod"` rather than a file path).
Declined after weighing it against the `type-design-analyzer`, which
independently confirmed plain `string` is the idiomatic path type here (the only
brand in `src/` is `M3LConfidence`; `M3LFileCopier` also uses bare `string`
paths).

**Why it happened:** two reviewers reached different-but-compatible conclusions;
the hub adjudicated on consistency grounds.

**Fix for future:** kept `preset` to match the `--preset` CLI flag convention and
the json-etl call-site that re-enables `--preset` on land. Recording the
rejected-with-rationale decision so it isn't re-litigated.

## Lessons learned

- **Hand every writer spoke a journal path** — the hub already gives the
  `code-implementer` a scratchpad journal in GREEN; do the same for the
  `test-author` in RED so a truncated turn leaves a resumable trace. Then verify
  the spoke's real state via `git diff`, not its (possibly truncated) final
  report, and resume-in-place via `SendMessage`. _(promoted → .claude/skills/implementing-submodules/SKILL.md)_

- **Scope the provenance re-stamp** — `check-doc-provenance.mjs --update` is
  repo-wide; for a change touching only some modules, use
  `--update --affected <changed-source-file>` and diff-check
  `docs/reference/` afterward, or unrelated sidecars get a false HEAD stamp. _(promoted → .claude/skills/syncing-docs/SKILL.md)_

- **Contract-mode first can collapse the task** — running
  `spec-conformance-reviewer` in contract mode before any RED/GREEN revealed the
  primitives already existed, turning "build a seam" into "wire + pick the slot."
  For friction items especially, front-load the "what already exists" audit.

- **A field on a documented interface needs no new `sources[]` entry** — adding
  `preset` to the already-documented `M3LScriptOptions` export meant the
  reference index (`gen:index`) correctly produced no diff; a re-stamp sufficed.
  Only a genuinely new exported symbol requires a hand-added sidecar `sources[]`
  entry.

- **Don't smuggle unrelated fixes into a scoped PR** — the pre-existing
  `extraProviders`-above-CLI inversion was left untouched and filed as a
  follow-up rather than reordered inside the F8 diff; behavior-changing
  reconciliations get their own change.
