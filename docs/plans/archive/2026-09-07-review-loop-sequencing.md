# Sequence pre-push and post-push review loops (issue #1003, H10)

**Status: shipped**

## Context

`docs/ROADMAP.md`'s H10 governance row (synced to GitHub issue #1003)
reported that `creating-prs` Step 7's pre-push review loop and
`resolving-pr-comments`'s post-push bot-finding loop are temporally
unambiguous in practice — a post-push loop cannot run before the PR it reads
exists — but neither skill states this explicitly, so a reader comparing the
two in isolation can read them as competing rather than sequential.

Re-deriving the premise before acting on it confirmed the gap exactly as
filed: `grep resolving-pr-comments .claude/skills/creating-prs/SKILL.md` and
`grep creating-prs .claude/skills/resolving-pr-comments/SKILL.md` both
returned zero matches — no cross-reference existed in either direction.
`docs/contributing/skill-routing.md`'s "Successor chains" section compounded
it: both documented chains end `… → creating-prs → finishing-work`, with
`resolving-pr-comments` appearing only as a standalone row in a different
table, never as a link in either chain.

## Approach / Decisions

- **Both skills name each other, plus the routing doc** — the user confirmed
  all three sites rather than the narrower two-skill-only scope, since
  `skill-routing.md` is the one document a maintainer reads in isolation to
  compare the two loops.
- **`creating-prs` Step 7 gained a closing paragraph**, not a rewrite of its
  existing auto-merge rationale — that paragraph is a single self-contained
  argument, and folding a scope statement into it would blunt both. The new
  paragraph closes an escape hatch a reader could otherwise infer ("the bot
  will catch it") by pointing an outstanding Must-fix at Step 15's hand-back
  outcome, already written.
- **`resolving-pr-comments` gained a final `## Boundary rules` bullet**, not
  a step-body sentence — that section sits between the intro and `## Steps`,
  read before Step 1, which is where a reader comparing skills in isolation
  actually looks; a step-body sentence is found only by someone already
  executing the skill.
- **Cross-file references use the step's title, not its number.**
  `creating-prs` has renumbered before (`docs/plans/README.md`'s own archive
  records "confirm mergeability" as a formerly-terminal step), so a hard
  step number in a _different_ file is the drift-prone form. Numbers stay
  only where they're intra-file (renumber together) or make the point being
  made (`skill-routing.md`'s Step 15-owns-the-merge line).
- **`skill-routing.md`'s Successor chains gained a third, explicitly
  conditional line** — `creating-prs Step 15 → resolving-pr-comments →
creating-prs Step 15 → finishing-work`, annotated "only when
  `claude-pr-review.yml`'s verdict is FAIL; repeats until it PASSes" — rather
  than drawing `resolving-pr-comments` as an unconditional link, since it
  only ever fires on a FAIL verdict and always returns control to Step 15.
- **No frontmatter touched.** `check:context-budget` enforces a hard
  aggregate skill-listing ceiling with roughly 128 characters of headroom
  across 22 skills' `description:` fields; SKILL.md _bodies_ are explicitly
  "not ratcheted — visibility only," so the fix stayed entirely in body
  prose and the routing doc.
- **Drift risk accepted, not gated.** The three passages now assert
  overlapping facts (the spoke roster, the `claude-pr-review.yml` mechanism,
  "Step 15 owns the merge") with no single source and no gate that would
  catch a stale cross-reference — the same accepted state as every other
  cross-skill hand-off in this repo (`creating-prs` → `finishing-work`,
  `triaging-scan-alerts` → `resolving-pr-comments`). A dedicated
  `check:skill-crossrefs` gate was considered and rejected: it would guard a
  defect class with zero recorded occurrences.

## Outcome

Four files changed: `.claude/skills/creating-prs/SKILL.md`,
`.claude/skills/resolving-pr-comments/SKILL.md`,
`docs/contributing/skill-routing.md`, `docs/ROADMAP.md` (H10 row). A rebase
onto `origin/main` mid-flow hit a same-table, different-row conflict in
`docs/ROADMAP.md` (upstream H4/H6/H9 flips plus a new H14 row landed while
this branch was open) — a pure column-width reflow cascade from prettier's
table formatter, not a real same-row collision; resolved by taking `main`'s
table and re-applying the single H10 line, via `/resolving-merge-conflicts`.
`docs/adr/provenance.json` mechanically re-stamped by `pnpm sync:docs`
afterward. Docs/`.claude`-only, zero semver impact — no `src/`, test, or
`exports`-map change. `pnpm verify` passed in full post-rebase (66 steps, 10
skipped push-only/e2e; `test:coverage`'s four configs — 588 test files,
20,746 tests — needed a reduced-parallelism re-run under sustained host
contention from several other concurrent sessions, ADR-0080). `docs/ROADMAP.md`'s
H10 row flips to `Done` and issue #1003 closes on the post-merge
`pnpm sync:hub -- --apply` run (`finishing-work` Step 5).
