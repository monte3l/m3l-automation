# Slice-progress statusline widget

**Status: shipped** — `feat/slice-progress-widget` (this PR).

## Context

The custom statusline's session row carried a `PR #N` segment sourced from
Claude Code's own `pr` statusLine field. That field's documentation states it
"mirrors the PR badge in the footer" — the segment duplicated information the
harness already surfaces, and it disappeared the moment a PR merged.
Meanwhile nothing showed **slice position** ambiently: `creating-prs`
computes a `PR N of M` line from a submodule's `## Landing plan` table
(ADR-0072) at PR-authoring time, but that number is never displayed again
once the PR is open, and a non-submodule multi-PR wave (`V9`/`X8`-style) has
no equivalent record at all.

## Approach / Decisions

Removed `formatPrSegment` from `.claude/hooks/statusline-context-pressure.mjs`
and replaced it with a slice-progress segment (`V6 2/4`, dimmed once all rows
have landed), sourced from a new gitignored `tmp/slice-progress.json`
(the `tmp/` convention `write-compact-handoff.mjs` established) and written
by a new `bin/slice-progress.mjs` CLI (`pnpm slice:set`/`pnpm slice:clear`),
invoked from `starting-work`/`finishing-work` as a slice sequence advances.

Two modes, chosen after finding only two of the four pages carrying a
`## Landing plan` heading use a parseable `| Slice | Scope | Status |` table
(`core/agent.md`, `core/cli-contract.md`) — `aws/bedrock-runtime.md` is a
numbered prose list instead:

- **Derived** (`{ page }`): the statusline re-parses that reference page's
  table on every render, so `N`/`M` can never drift from the committed
  table — CLAUDE.md's re-derive-an-authored-claim discipline applied to a
  live, ambient display rather than a one-time check. A page whose landing
  plan isn't a table parses to no table and the segment simply doesn't
  render — not an error.
- **Literal** (`{ wave, current, total, label }`): an explicit, ephemeral
  escape hatch for a non-submodule wave. It does not revisit the prior
  `finishing-work` amendment's scope limit — it invents no second _durable_
  record; the entry lives only in gitignored `tmp/` and carries no authority
  over `finishing-work`'s own terminal behavior for that case.

The entry is branch-stamped by the CLI itself from live git state — never
accepted as a caller-supplied flag — and the statusline renders it only when
that stamp matches the currently resolved branch, mirroring how
`starting-work` treats a `tmp/compact-handoff.json` naming a different branch
as not a signal.

`starting-work` initially confirmed a two-PR sequence (state seam, then
widget) per ADR-0072 discipline. Once both were implemented and verified
together, `pnpm check:review-size` measured the combined diff at 46,284
chars — well under the 75,000 soft target — so the sequence was collapsed to
one PR rather than manufacturing an artificial split with no real
reviewability gain.

Full decision record: `docs/adr/0072-reviewable-slice-discipline.md`'s
2026-09-04 "slice-progress statusline segment" amendment.

## Outcome

Shipped as a single PR: `bin/slice-progress.mjs` (new CLI + tests),
`formatSliceSegment`/`parseLandingPlanProgress`/`resolveSliceProgress` in the
statusline hook (replacing `formatPrSegment`), updated preview fixtures,
`bin/lib/command-catalog.mjs` rows for `slice:set`/`slice:clear`, and the
`starting-work`/`finishing-work` skill wiring. `pnpm verify` passed clean
(59 steps, 10 appropriately skipped) before push.
