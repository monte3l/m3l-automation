# Model-selection matrix reconciliation against git history

**Status: shipped** (commit `5dabf63`; `9488562` same-day follow-up)

## Context

The whole git commit/merge history (984 commits total, 578 on `main`) was
traced against `docs/contributing/model-selection.md`'s task-category →
model matrix to check whether the documented trailer/enforcement system
actually matched reality. Traceability turned out to be structurally sound —
every trailer string resolved through `bin/lib/claude-models.mjs`'s
canonical/alias list, and every agent `model:` frontmatter and workflow
`--model` pin matched the `MODEL-MATRIX` enforcement block exactly. What had
drifted was the doc's own prose: a too-narrow Sonnet 4.6 legacy window, an
overstated "always auditable" trailer claim, a missing footnote for the
`Opus 4.8 (1M context)` variant, and vague (rather than real) examples in
the task matrix's columns 2–3.

## Approach / Decisions

- Pure documentation-reconciliation pass — no source, test, or config file
  changes, so `guard-branch-isolation.mjs`/`/starting-work` didn't apply.
- Extended the Sonnet 4.6 legacy-note window to include a 07-09 straggler
  commit instead of implying a clean cutoff.
- Softened the "always auditable" trailer claim to match
  `lint-commit.mjs`'s actual (deliberately optional) enforcement.
- Added a footnote clarifying `Opus 4.8 (1M context)` is the same `opus`
  alias's long-context variant, not a separate task category.
- Tagged every task-matrix row with its workflow shape (coordinator /
  subagent / single unit of work) and replaced column 3 with verified
  `<sha> <subject> (<date>)` examples pulled from `git log`, including an
  over-provisioning observation on row 7 (mechanical doc work spot-checked
  at ~38% run on `opus` when a cheaper tier would do).
- No new tracker rows in `ROADMAP.md`/`IMPLEMENTATION.md` — none of the
  fixes had a call-site or unblock condition to track (per ADR-0024
  row-locality).

## Outcome

The substance of the reground table and prose fixes landed in
`5dabf63` ("docs: reground model-selection matrix in real commit history");
this record's landing commit, `9488562`, is a same-day follow-up that
corrected row 11's model listing (stale "haiku or inherit" wording, caught
by `docs-consistency-reviewer` during a later PR's prep) to reflect
`Explore.md`'s actual `model: haiku` pin. See
[`docs/contributing/model-selection.md`](../../contributing/model-selection.md)
for the current matrix.
