# Work log — seam-plan-handoff (2026-09-07)

This log covers resolving GitHub issue #1005 (ROADMAP row **H12**, "Seam-plan
→ PR-sequence handoff is prose-only"). It records what the row's premise got
right, what it got wrong about the size of the fix, and the concrete
documentation change that closed it — a docs-only edit across two skill files
plus the tracker close-out.

## Summary

Issue #1005 / ROADMAP row H12 claimed `starting-work`'s "Notes for callers"
described a handoff — `implementing-submodules` "feeds its own seam plan…
into the PR-sequence recommendation" — with "no concrete interface/field…
beyond same-conversation context." Re-deriving the claim against current repo
state (per `CLAUDE.md`'s Task Workflow) found the premise correct but the
framing wrong: a concrete, machine-parsed interface already existed — the
`## Landing plan` table `implementing-submodules` Step 5 writes onto a
module's `docs/reference/<ns>/<mod>.md` contract page, parsed by the single
shared `parseLandingPlanProgress` function
(`.claude/hooks/statusline-context-pressure.mjs`) and already consumed by
`bin/check-scaffold-seam.mjs`, `creating-prs` Step 12, and `finishing-work`
Step 8. `starting-work` was the one caller that talked about "the seam plan"
in the abstract without ever naming the file, heading, or table shape.

Files changed:

- `.claude/skills/starting-work/SKILL.md` — three sites rewritten to name the
  artifact: Step 2's scope-inference bullet, Step 3's PR-sequence-order
  bullet, and the "Notes for callers" section (now states the file path, the
  `| Slice | Scope | Status |` shape, the row-order/terminal-status read
  rule, the shared parser, the three other consumers, the empty/unparseable
  fallback, and the scope boundary against ROADMAP row H5's non-submodule
  gap).
- `.claude/skills/implementing-submodules/SKILL.md` Step 5 — corrected two
  adjacent drifts on the producer side found during exploration: the bullet
  never stated that a parseable table (not prose, not a numbered list) is
  required, and it said `check:scaffold-seam` "is being extended (ADR-0072)"
  to enforce this when `bin/check-scaffold-seam.mjs:209-221` already
  hard-fails on a missing page, missing heading, or unparseable table.
- `docs/ROADMAP.md` — H12 row flipped `To Do` → `Done`.
- `docs/logs/README.md` — index row for this log.

No `packages/*/src/**`, `scripts/*/src/**`, or `**/tests/**` change; zero
semver impact.

Skills used: starting-work, writing-work-logs (this log), creating-prs
(pending).

Spoke incidents: none — all exploration ran via three parallel `Explore`
agents (git-native `Agent` tool, not a workflow), no truncations.

Compaction events: none.

## What went as planned

- **The issue's premise survived re-derivation.** Three parallel `Explore`
  agents independently confirmed `starting-work`'s three sites really did
  talk about "the seam plan" with no artifact named, while
  `implementing-submodules` Step 5 really did produce a durable, gated file —
  exactly the gap #1005 described, not a stale claim.
- **The concrete interface was fully discoverable from already-shipped code.**
  `parseLandingPlanProgress`'s own doc comment
  (`.claude/hooks/statusline-context-pressure.mjs:416-429`) states the read
  rule precisely enough to quote into the skill text directly — no new
  behavior needed inventing, only documentation of what already runs.
- **`docs/reference/core/agent.md`'s live table was a ready worked example**
  for the new prose to point at, and its numbers were verified by manually
  tracing `parseLandingPlanProgress`'s logic against its four `Landed` rows
  before citing them.

## What didn't go as planned, and why

### 1. The plan initially proposed a `feat/` branch; `fix/` is correct but the worktree tool defaulted to `feat/`

`pnpm worktree:new seam-plan-handoff` (no flag) created branch
`feat/seam-plan-handoff`, not the `fix/seam-plan-handoff` the plan called for
(closing a recorded documentation gap). The worktree was torn down
(`pnpm worktree:remove`) and recreated with the `--fix` flag before any file
was edited, so no rework was lost.

**Why it happened:** `bin/worktree-new.mjs` defaults to the `feat/` prefix
unless `--fix` (or `--kind <kind>`) is passed explicitly; the plan's own
branch-name decision wasn't cross-checked against the CLI's default before
invoking it.

**Fix for future:** When `starting-work` Step 5 recommends a `fix/<slug>`
branch, pass `pnpm worktree:new <slug> --fix` on the first invocation rather
than the bare form — check `bin/worktree-new.mjs --help`'s flag list before
running it whenever the recommended prefix is `fix/` rather than the tool's
`feat/` default.

## Lessons learned

- **A tracker row's severity framing is not the same claim as its premise.**
  H12 called the gap "low severity… worth a clarifying note" — true of the
  effort required, but the actual fix also needed correcting two doc drifts
  on the _producer_ side (`implementing-submodules` Step 5) that the row
  never mentioned, because they only surface once you trace the interface
  the row named all the way to its machine-checked ground truth
  (`bin/check-scaffold-seam.mjs`, `parseLandingPlanProgress`). Re-deriving a
  tracker claim (CLAUDE.md's Task Workflow step 1) means tracing it to the
  code that enforces it, not just confirming the sentence is still true.
- **`pnpm worktree:new <slug>` defaults to `feat/`; pass `--fix` up front for
  a `fix/<slug>` branch.** Confirming the branch prefix before the first
  worktree-creation call avoids a teardown/recreate cycle.
- **A shared parser with a precise doc comment is quotable directly into
  skill prose.** `parseLandingPlanProgress`'s TSDoc already stated the exact
  read rule (row count = total, first non-terminal row = current, terminal
  Status vocabulary) — no need to re-derive it from the implementation body
  when the doc comment already carries the contract.

## Follow-ups filed

None. ROADMAP row **H5** ("No durable slice-sequence record for non-submodule
multi-PR work") already tracks the one gap this task's fallback text had to
route around — no new friction item needed.
