# Fix PR #112 CI failure (knip unused-exports)

**Status: shipped** (PR #112, commit `c5b1f39`)

## Context

PR #112 (branch `feat/model-config-enforcement`), which shipped the
Anthropic model-config enforcement work, failed both the CI `verify` job's
`knip` step and the mandatory Claude PR Review gate on the same root cause:
`bin/lib/claude-models.mjs`'s `AGENT_MODEL_ALIASES`, `WORKFLOW_MODEL_ALIASES`,
and `EFFORT_LEVELS` were exported but never imported anywhere outside the
file — only the `isValidAgentModel`/`isValidWorkflowModel`/`isValidEffort`
helpers (which close over the arrays internally) were consumed by
`bin/check-agents.mjs`.

## Approach / Decisions

- Trivial, single-file, unambiguous fix already independently confirmed by
  both `/triaging-ci` and the review bot's comment — no design alternatives
  to weigh.
- Dropped the `export` keyword from the three constant declarations,
  landing as `445b794` ("fix: make model/effort allowlist constants
  module-private"), making them module-private while leaving the three
  exported `isValid*` functions and their TSDoc `{@link}` references
  untouched (`{@link}` doesn't require the target to be exported).

## Outcome

`pnpm knip` passed clean, `pnpm check:agents` continued to pass unchanged,
and the Claude PR Review verdict flipped to PASS on re-run, unblocking
PR #112's merge.
