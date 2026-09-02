# 0072. Reviewable-slice discipline for PRs and submodule landings

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (post-mortem synthesis)

## Context and problem statement

PR #523 (`core/procedure`, tracker item B2, issue #474) was abandoned after
five review rounds: 15,544 changed lines across 44 files, **501,454 reviewable
chars** against the `MAX_REVIEWABLE_BYTES` gate's 300,000-char limit
(`.github/workflows/claude-pr-review.yml`) — 3.5x the largest reviewable patch
in the measured window (142,557 chars, `b5eeb8c`). Cost: three
`error_max_turns` runs producing no verdict (~$8.15) plus two completed rounds
($2.18 + $2.42), ~$12.75 of gate spend; ~16 spoke invocations across one
six-spoke review, two RED, three GREEN, three reviewers and two audits; two
spokes truncated mid-task, one a reviewer returning nothing after 13 minutes
and 183k tokens; and a merged-then-reverted weakening of the size gate itself
(PR #568, reverted by PR #570). The branch was deleted, 26 commits discarded,
`core/procedure` not delivered, issue #474 still open. The work is fully
recoverable — `origin/feat/core-procedure-engine` (`1684192`) still exists as
a local remote-tracking ref.

**The failure was non-convergence, not size per se.** R1 (six spokes) found 13
must-fixes. R2 found the `loop` + `continueOnFailure` / `jumpsTo` defect. R3
found `build()` never validated step `execute` or case `action`, so a
malformed declaration escaped the public boundary as a bare `TypeError`. R4
found that the fix for R3 **reintroduced a validate-then-re-read hazard**
`f875c52` had already removed on this same module
(`.claude/rules/library-src.md`'s "never validate a caller value and then let
something else re-read it" rule). R5 found unbounded recursion over caller
`run()` parameters yielding a bare `RangeError`. A follow-up audit then found
**three further sites of the same unguarded-caller-read class**. Five rounds,
still finding new instances of one defect class.

**Retrofitting a split after the fact was structurally impossible.** Per-file
v8 coverage thresholds (`vitest.config.ts`, `perFile: true`) bind
`M3LProcedure.ts` (63,988 bytes) to _both_ test files exercising it
(`procedure.test.ts` + `procedure-guards.test.ts`, 137,106 bytes combined —
dropping either leaves cancellation/ceiling/tracing uncovered), and both
import `createProcedureBuilder`, pulling in the whole build/validation path —
an irreducible ~375,000 chars, 1.25x the limit before the rest of the module
is counted. The "land `internal/` first" escape is closed: all four test
files on that branch import only the public barrel, so an internal-only slice
would ship ~121,000 chars of `src/` with zero coverage. **Every slice must
expose a coherent, independently testable public subset.** A usable seam
existed and went unused: `procedure-conditions.test.ts` imported only
`evaluateProcedureCondition` plus two constants — exactly the shape a slice
needs, discovered too late to act on.

This is one instance of a broader gap: `MAX_REVIEWABLE_BYTES` is a **rejection
ceiling**, calibrated to catch a review-breaking outlier, not an authoring
target. Nothing in the repo states a preferred PR size for ordinary change
work, so "how big should this PR be" is answered ad hoc, discovered only when
a branch is already too large to review well.

## Decision drivers

- The five-round failure was a defect class recurring across authoring
  boundaries, not a byte-count problem — the fix has to make each slice
  independently reviewable and coverable, not just numerically smaller.
- `docs/contributing/subagent-context-management.md`'s "Efficacy watch"
  already concludes prevention (as opposed to recovery) is the harder,
  unproven half of the truncation problem; two truncations on one module is
  evidence that brief-bounding alone is not sufficient at this scale.
- Existing per-file v8 `perFile` coverage thresholds are a hard constraint on
  any split, not a detail — a slice's tests must import only that slice's
  public symbols, or coverage cannot bind within the slice.
- Minimal machinery: prefer expressing the constraint through repeatable
  authoring practice and cheap local gates over inventing new tracker
  vocabulary (a fifth status emoji, a fractional "N of M") that would ripple
  into `bin/lib/count-sites.mjs`, `check:test-counts`, and the status legend.
- A gate must not block something that already merges cleanly today — of the
  PRs with recorded reviewable sizes, several land between 76,817 and 142,557
  chars and were never a problem; only a hard, unmissable outlier is the
  actual risk.

## Considered options

1. **Do nothing beyond the existing 300,000-char rejection gate.** Rejected —
   it fires only after a branch is already unreviewable; #523 was rejected by
   it three times and still cost $8.15 before that discovery landed.
2. **Lower `MAX_REVIEWABLE_BYTES`.** Rejected — the 300,000 ceiling is
   calibrated against real merged history (2.1x the largest reviewable patch
   measured, rejects none of the 14 PRs merged before it shipped); lowering it
   risks false positives on legitimate work with no evidence it prevents the
   next #523, since the failure was non-convergence, not raw size.
3. **A hard hierarchy of hierarchical tracker states expressing fractional
   submodule progress.** Rejected — every gate that reads
   `docs/implementation-status.md`'s Status column (`check:impl-counts`,
   `check:test-counts`) is binary by construction
   (`bin/lib/count-sites.mjs:168-170`, `status === "✅"`); the change would
   ripple into `buildIndex`'s `catalog.json` status column and the legend for
   a benefit already available for free — see Decision, "Reading progress."
4. **A soft authoring target plus explicit pre-RED seam planning for
   submodules, with the reviewable-size calculation exposed locally before
   push.** Chosen.

## Decision

We adopt a two-part discipline: a general PR-granularity norm for all change
work, and a submodule-specific seam-planning practice as its hardest case.

### Part A — PR granularity, all change work

- **300,000 chars stays the hard rejection ceiling** (unchanged,
  `claude-pr-review.yml`). **75,000 reviewable chars is the soft authoring
  target.** Above it, split the PR or record in its body why not; above the
  ceiling, splitting is not optional. The target is chosen from the same
  measured history as the ceiling: several merged PRs land between 76,817 and
  142,557 chars — real, unproblematic work — so 75,000 is deliberately a
  nudge, not a line that would have blocked history.
- **Split axes, in preference order:**
  1. **Docs vs. code.** `claude-pr-review.yml`'s `is_ignored` predicate
     (`*.md`, `docs/**`, `.github/dependabot.yml`) already excludes these from
     the reviewable count — a docs-only PR measures ~0 reviewable chars and
     Gate 0 short-circuits its review entirely. This is the cheapest split
     available and should be the default whenever a change mixes docs and
     code.
  2. **Path cluster.** One subsystem per PR.
  3. **Commit boundary.** A branch whose commits are already coherent splits
     cleanly along them.
  4. **Public-surface subset** (library work specifically) — see Part B.
- **`pnpm check:review-size`** (new, `bin/check-review-size.mjs`) computes the
  same reviewable-byte measurement the CI gate uses, locally, against
  `origin/main...HEAD`, before a PR is opened — reading
  `MAX_REVIEWABLE_BYTES` out of the workflow file at runtime rather than
  duplicating the constant. It mirrors `is_ignored` exactly and measures a
  **unified** diff, never a per-commit series (`gh pr diff --patch` inflated
  #523 by 39% — fixed in PR #569, `d8e8348` — by counting the same file once
  per commit that touched it instead of once). Under the soft target it
  passes quietly; over it, it warns and names the top contributing files and
  a suggested split axis; over the ceiling, it fails.
- The norm is wired into two workflow entry points: `creating-prs` runs the
  check before opening a PR and requires a split or a recorded reason above
  the soft target; `starting-work` recommends a PR sequence up front, as a
  fifth decision, whenever the inferred scope already spans several
  independently-landable units.

### Part B — submodule landing (the hardest case)

**Seam planning is a required step before RED**, not an ad hoc note inside
Phase 4 as it was. `implementing-submodules` gains a step between Contract and
RED that enumerates the contract's public surface into independently
testable subsets — each subset's tests import _only_ the symbols that subset
ships, so `perFile` coverage binds within the slice rather than across the
whole module — and records the intended sequence on the contract page.

**Landing as several additive minors is already mechanically expressible
today, under two rules, with zero gate changes** — established by reading
each `bin/*.mjs`'s actual decision logic rather than the surrounding prose:

| Gate                | Blocks partial landing?                     | Why                                                                                                                                                                     |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check:api`         | No                                          | Only diffs `pkg.exports`; barrel growth never touches it                                                                                                                |
| `check:doc-exports` | No                                          | One-directional exports→docs; unshipped-symbol prose in the doc is free                                                                                                 |
| `check:doc-counts`  | No, but forces PR-1 atomicity               | The denominator is a filesystem scan of `docs/reference/**/*.md`; `LIST_ASSERTION_SITES` requires both barrel TSDoc lists to name the module the moment its page exists |
| `check:impl-counts` | No — cannot express fractional progress     | Numerator is strictly `status === "✅"`; binary by construction                                                                                                         |
| `check:test-counts` | No                                          | `status.includes("✅")` skips non-done rows entirely                                                                                                                    |
| `knip`              | **Yes, if code lands before wiring**        | An `src/**/*.ts` unreachable from `src/index.ts` is an unused file                                                                                                      |
| `check:provenance`  | **Yes, if the sidecar is written up front** | `source file not found` / `"X" not exported from Y` are hard errors                                                                                                     |
| `check:index`       | No                                          | `status` / `wired` / `symbols` are already orthogonal per module                                                                                                        |

1. **Every PR wires the files it adds** into `<mod>/index.ts` before merging —
   slice by symbol-cluster-plus-its-files, never by "code now, wiring later."
2. **The reference `.md` lands complete in PR 1; its `.provenance.json` grows
   one section per PR**, re-stamped with `check-doc-provenance.mjs --update`
   in each landing PR.

**Reading progress.** `check:impl-counts`'s "N of M" badge is correctly
binary and stays that way — a submodule sits at `🧪`/`🟢` (contributing 0)
across every landing PR but the last, which flips it to `✅`. Fractional
progress is read from `docs/reference/catalog.json`'s per-module `symbols`
array (already populated by `bin/gen-reference-index.mjs`, already orthogonal
to `status`), not from a new status vocabulary — inventing one would ripple
into `buildIndex`, `check:test-counts`'s `status.includes("✅")` filter, and
the status legend for no gain over the field that already exists.

**PR-1 atomicity is a feature, not friction.** The moment a submodule's
`docs/reference/<ns>/<mod>.md` page exists, the denominator flips
(`gen:counts`) and both barrel TSDoc lists (`src/core/index.ts`,
`src/aws/index.ts`) must name the module in the same PR — that page's TSDoc
phrase reads "surfaced here as they are implemented," which the check asserts
against _documented_, not implemented, names; the wording should say
"documented" (a prose fix, tracked alongside this ADR, not a logic change).

**"Land `internal/` first" is not an escape** from the size constraint —
tests import only the public barrel, so an internal-only slice ships `src/`
with zero coverage and trips `perFile` regardless of its byte count.

**A per-file size ratchet**, not a flat cap: nine existing `src/` files
already exceed 30,000 chars (`M3LScript.ts` at 67,684) and thirteen test
files exceed 60,000 (`script.test.ts` at 264,145), so a flat ceiling would
fail on day one. `pnpm check:file-budget` (new) enforces `src` ≤ 25,000 chars
and test file ≤ 60,000 chars for any file not in a committed baseline
snapshot; baselined files may not grow. New submodules are held to the real
limit immediately; existing debt is frozen, not forced into an unplanned
refactor.

**`check:test-counts` undercounts sibling test files.** It keys on
`path.basename(...).replace(/\.test\.ts$/, "")` and its comparison iterates
only the _recorded_ rows in `docs/implementation-status.md`'s Notes column
— a collected file with no matching row (14 exist today:
`diagnostics-run-report`, `polling-no-progress`, `script-cancellation`, …) is
silently discarded, and this basename keying is also what let B2's guards
figure drift unnoticed had the module shipped. Fixed to key on the path
relative to `TESTS_SCOPE` and to report unmatched collected files as a
warning, without forcing a Notes-convention migration across the 14 existing
files.

**Boundary validation, generalized.** The R3/R4/audit sequence found four
sites of one defect class: a caller-supplied value crossing the public
boundary, validated once, then re-read or recursed over without the same
guarantee holding downstream. `.claude/rules/library-src.md`'s
validate-then-re-read rule is broadened from its single named hazard to the
general class: every caller-supplied value crossing the public boundary is
validated once, at the boundary, including depth/recursion bounds, and a bare
`TypeError`/`RangeError` escaping past that boundary is itself the defect —
not merely a missing message.

## Consequences

- **Positive:** an oversized or non-convergent submodule is caught by its own
  author before RED, not discovered by CI after five rounds; the reviewable
  size calculation an author sees locally is the exact one CI enforces, so
  there is no surprise at push time; partial landing is documented as
  already-working machinery instead of requiring new gates; existing
  oversized files are frozen rather than blocking unrelated work with a
  forced refactor.
- **Negative / trade-offs:** two new local gates (`check:review-size`,
  `check:file-budget`) to maintain, each needing to stay in lockstep with a
  duplicated `is_ignored` predicate (now three copies: the workflow's guard
  step, its `awk` filter, and this gate) or a moving coverage baseline; the
  soft target is advisory and can be ignored with a recorded reason, so it
  constrains authoring discipline, not merge eligibility, by design; seam
  planning adds one step to `implementing-submodules` for every future
  submodule, including small ones where it is a formality.
- **Semver impact:** none. Tooling and process only; no `packages/m3l-common`
  public surface changes.

## Amendment (2026-08-25)

Issue #579 (F26), filed from the F23 field test
(`docs/logs/2026-08-21-f23-field-test-b2.md`): `pnpm check:file-budget` only
scanned the working tree via `node:fs` — auditing a branch's file sizes
without checking it out required falling back to a raw
`git worktree add --detach`, the same class of friction F25 (`worktree:new
--from <ref>`, this ADR's sibling amendment on ADR-0014) already closed for
worktree creation. The issue was filed as an open design question rather
than a bug — `check:file-budget` is an absolute per-file ratchet against a
committed baseline, not a diff range, so it wasn't obvious a `--base`/`--head`
pair (`check:review-size`'s shape) was even the right fix. The maintainer's
call: add `--ref <ref>` instead — there is no "base" here, only "which tree
state to read."

- **`--ref <ref>` reads via `git` plumbing, not `node:fs`.** `git ls-tree -r
--name-only <ref> -- packages/` lists every path in the ref's `packages/`
  subtree in one call; `git cat-file -s <ref>:<path>` reports a blob's byte
  size directly, with no need to materialize file content. The baseline read
  follows the same substitution: `git cat-file -e <ref>:bin/file-budget-baseline.json`
  stands in for the working-tree path's `existsSync` gate, and `git show
<ref>:bin/file-budget-baseline.json` stands in for `readFileSync` — no
  checkout or worktree required.
- **Mutually exclusive with `--update`.** There is no committed blob to write
  a regenerated baseline into at an arbitrary ref, so `--ref` combined with
  `--update` fails fast with a clear error rather than doing partial work.
- **No new gate wiring.** Like `check:review-size`'s `--base`/`--head`, `--ref`
  is invoked manually (ad hoc auditing), not from `package.json` or
  `lefthook.yml` — `pnpm check:cadence`/`pnpm verify` are unaffected.

## Links

- Supersedes / superseded by: none.
- Related: [ADR-0016 (signed-commit enforcement and the pre-work decision
  gate)](./0016-signed-commits-and-decision-gate.md),
  [ADR-0046 (the codified-procedure engine this post-mortem is about)](./0046-codified-procedure-engine.md),
  [ADR-0014 (symmetric worktree tooling, whose 2026-08-25 amendment closed the
  sibling F25 friction item)](./0014-symmetric-worktree-tooling.md).
- Evidence: `docs/research/pr-review-action-tuning.md` §§ Addendum
  (2026-08-20), (2026-08-20b), Outcome (2026-08-20c);
  `docs/plans/archive/2026-08-20-pr-review-turn-budget.md`;
  `docs/plans/IMPLEMENTATION.md` F23 row; `docs/logs/2026-08-21-f23-field-test-b2.md`.
- Gate: `.github/workflows/claude-pr-review.yml` (`MAX_REVIEWABLE_BYTES`);
  `bin/check-file-budget.mjs`.
- Issues: closes #571 (F23) and #579 (F26); #474 (B2, `core/procedure`)
  remains open and is the first intended consumer of this discipline.
