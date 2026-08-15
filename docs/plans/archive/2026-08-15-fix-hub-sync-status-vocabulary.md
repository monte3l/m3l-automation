# Make off-vocabulary tracker Status cells loud (issue #429)

**Status: shipped** — commit range on `fix/hub-sync-status-vocabulary`.

## Context

Retiring the D4 `aws/rds-data` gate (#428) surfaced a gap: `classifyStatus`
(`bin/lib/project-hub.mjs`) matched six keywords plus four legacy emoji and
silently returned `"todo"` for anything else. The `aws/rds-data` row's Status
cell had used `In review` — a token from the GitHub Projects board's own
three-value Status field (Pending/In review/Done), not the tracker's
six-value vocabulary ADR-0032 documents (Done/To Do/In Progress/Deferred/
Blocked/Rejected) — and the silent fallthrough left issue #204 open, board
status "Pending", for weeks after the work it tracked had already shipped.
#428 filed the gap as a new gated row (`docs/plans/IMPLEMENTATION.md:247`)
rather than fixing it in the same change, framing it as a choice between two
fixes: alias `In review` into `classifyStatus`, or reject unrecognized cells
loudly. This plan resolves that gate.

## Approach / Decisions

Per the user's choices during `/starting-work`:

1. **Reject unrecognized cells loudly, not alias `In review`.** ADR-0032
   deliberately keeps the tracker's six-value vocabulary and the board's
   three-value one as separate namespaces with an explicit mapping between
   them (`PROJECT_STATUS_OPTIONS`, `bin/lib/hub-sync.mjs`). A tracker cell
   holding a board-side token is an authoring mistake, not a synonym —
   aliasing the one observed token would have left the next leak (`Pending`,
   a typo, a backticked `` `In review` ``) exactly as silent as this one was.
2. **A new hard CI gate**, `pnpm check:tracker-status`
   (`bin/check-tracker-status.mjs`), sibling to the existing
   `check:tracker-coverage` — the precedent for "a check whose job is to stop
   a silent tracker-parsing gap from going unnoticed for weeks." It fails the
   build the moment an off-vocabulary Status cell exists in either
   `docs/ROADMAP.md` or `docs/plans/IMPLEMENTATION.md`, `## `- and
   `### `-level tables alike, reporting the exact `path:line` and cell text.
3. **A warning channel alongside the hard gate, not instead of it.**
   `bin/lib/hub-sync.mjs`'s `actionableItems` gained `resolveStatus`,
   mirroring the existing `resolvePriority` — every tracker row's Status cell
   now warns into the same `warnings` array a bad Priority cell already did.
   The warning alone was insufficient (a warning in a dry-run log is the
   channel that let the original leak sit unnoticed), so the hard gate is
   the actual enforcement; the warning is the diagnostic when `sync:hub`
   runs interactively.
4. **Close the backtick hole found along the way.** `classifyStatus`'s
   markdown-strip regex handled `**bold**` but not `` `code` `` or
   `_italic_`, so a `` `In review` `` cell would have fallen through the
   vocabulary check for an unrelated reason. Widened to match what
   `stripMarkdown` (`bin/lib/hub-sync.mjs`) already does elsewhere.
5. **`PROJECT_STATUS_OPTIONS`'s silent `?? .todo` fallback now throws.**
   With `resolveStatus`/`check:tracker-status` both in place, a `status`
   value reaching `projectStatusOption` is provably always one of the six
   kinds `classifyStatusCell` produces — a miss there is a programming error
   (e.g. a new badge kind added without updating the map), not tracker data,
   so it should fail loudly rather than silently default to Pending.

## Outcome

`classifyStatus` split into `classifyStatusCell(cell) -> { kind, recognized }`
(a thin `classifyStatus` wrapper keeps the dashboard renderer unchanged);
`findOffVocabularyStatusCells` added alongside the existing
`findUncoveredStatusHeadings` for line-accurate scanning (a plain line walk,
since `parseMarkdownTable` carries no line numbers and only returns the first
table per `## ` heading — insufficient for the `### `-level wave tables
`docs/ROADMAP.md` also carries Status columns in). `bin/check-tracker-status.mjs`
wired into `package.json`, `bin/lib/command-catalog.mjs`,
`bin/lib/verify-steps.mjs`, and `.github/workflows/ci.yml`, alongside the
existing `check:tracker-coverage` entries. `docs/plans/IMPLEMENTATION.md:247`
flipped from `Deferred` to `Done`; ADR-0032 gained a 2026-08-15 Update
recording the decision. No live tracker row was off-vocabulary when this
landed (#428 had already flipped the offending cell), so `check:tracker-status`
starts green. No `src/`, `exports`-map, or public-API change; zero semver
impact — this is `bin/`-tooling and docs only.
