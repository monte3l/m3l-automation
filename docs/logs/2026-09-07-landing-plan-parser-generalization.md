# Work log — landing-plan-parser-generalization (2026-09-07)

This log covers PR 1 of a 3-PR sequence closing issue #998 (ROADMAP H5 — a
durable slice-sequence record for non-submodule multi-PR work): generalizing
ADR-0072's shared `## Landing plan` table parser
(`parseLandingPlanProgress` in `.claude/hooks/statusline-context-pressure.mjs`)
so the same mechanism a submodule uses can be reused for a plan-doc-sited
landing plan in a later PR of this sequence, without inventing a second
mechanism. Records what shipped, two rounds of `claude-pr-review` findings and
how they were resolved, and a reproducible local-environment artifact worth
recording for future sessions.

Plan of record: `~/.claude/plans/solve-issue-998-temporal-scott.md` (outside
the repo — the harness's own plan-mode file, per its own naming convention;
not archived into `docs/plans/` since this task is still mid-sequence).

## Summary

- Merged as PR #1121 (squash commit `b23c8ee4` on `main`), branch
  `refactor/landing-plan-parser`.
- **The bug fixed:** `isTerminalLandingPlanStatus` (formerly an exact-match
  `Set` lookup) now matches a Status cell's leading word instead of the whole
  cell, so `Landed (PR #580)` and `Shipped — #941` count as terminal. Confirmed
  live against the real `docs/reference/core/procedure.md` table: all seven
  rows read `Landed (PR #NNN)`-shaped cells and previously parsed as "1 of 7,
  in flight" despite being fully shipped — a genuine latent bug, not a
  synthetic case.
- **The feature added:** an optional `Branch` column, read for the current row
  via a new `normalizeBranchCell` — strips backticks, rejects placeholders
  (`-`, `—`, `n/a`, `tbd`), requires a conservative ref-name shape with no
  `..`/trailing `/`/trailing `.lock`, and (added during the second review
  round) suppresses to `null` whenever the table is fully landed, since the
  "current row" at that point is the last row and its branch has already
  shipped. This is the field a later PR's `finishing-work` hand-off will read
  instead of asking the user to derive a slug.
- **Return shape:** widened from `{ current, total, label, allLanded }` to
  `{ current, total, label, branch, allLanded }`; every call site
  (`resolveSliceProgress`'s two modes, `formatSliceSegment`'s JSDoc,
  `bin/check-scaffold-seam.mjs`, `bin/slice-progress.mjs`) checked and updated
  or confirmed unaffected (the latter two only null-check the return value).
- Test count: `bin/tests/statusline-context-pressure.test.ts` grew from 208 to
  216 tests across the two review rounds; full monorepo suite
  (460+108+26+7 test files, 21,174 tests) green on every gate run.
- CI: all required checks green (`Dependency Review`, `CodeQL`, `verify`,
  `review`) plus the non-required `should-fix-ack` and `Run skill evals`.
- Skills used: `starting-work`, `writing-commits` (implicit, via manual
  commits following its conventions), `syncing-docs`, `creating-prs`,
  `resolving-pr-comments`, `finishing-work`, `writing-work-logs`.
- Spoke incidents: 1 truncation (the `test-author` spoke doing the first test
  update hit its 40-turn limit mid-task; resumed via `SendMessage` and
  completed cleanly) / 0 stalls / 4 resumes (the truncation resume, plus a
  mid-task `SendMessage` to the same spoke to fold in a branch-validation
  change discovered after it was already dispatched, plus two clean
  resumes for follow-up test additions after each review round).
- Compaction events: none.

## What went as planned

- **The parser change itself was correct on the first pass.** Live-running it
  against the real repo (`docs/reference/core/procedure.md`,
  `docs/reference/core/cli-contract.md`) plus hand-built negative controls
  before writing any test caught the exact behavior needed, per
  `harness-artifacts.md`'s "run a new check/hook against known-good input
  before wiring it" rule — no back-and-forth was needed to get the regex
  logic right.
- **The hub-and-spoke boundary held cleanly.** Every edit to
  `.claude/hooks/statusline-context-pressure.mjs` (not a guarded path) was
  made directly; every edit to `bin/tests/statusline-context-pressure.test.ts`
  (a guarded `**/tests/**` path) was dispatched to `test-author`, exactly as
  `guard-hub-src-writes.mjs` enforces — confirmed by the hook actually firing
  once on a premature direct-write attempt.
- **Both `claude-pr-review` rounds landed at PASS**, with only Should-fix
  findings (no Must-fix) each time — the parser logic itself was never
  flagged as wrong, only two real completeness gaps (bold-status matching,
  an untested rejection branch) and one real contract gap (the `allLanded`
  leak).
- **`pnpm sync:docs` was a clean no-op** on both runs except for routine
  ADR-provenance blob-SHA re-stamps — no doc drift was introduced by this
  change.

## What didn't go as planned, and why

### 1. The full-repo `pnpm lint` (workspace lint) OOM'd three separate times on this host

`eslint . --ignore-pattern 'packages/m3l-common/**' --concurrency=1` crashed
with `FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript
heap out of memory` (exit 134) three times across this session: once running
`pnpm lint` standalone, once inside `pnpm verify`, and once inside the
`pre-push` hook's parallel lane fan-out. Each crash hit the exact same ~4GB
ceiling. A fourth attempt of the identical command, with the host otherwise
idle, succeeded — and a fifth attempt with `NODE_OPTIONS=--max-old-space-size=8192`
passed cleanly every time. CI's own `Lint (workspace)` check passed on the
same code on both pushes.

**Why it happened:** `node -e "require('v8').getHeapStatistics().heap_size_limit"`
confirmed this host's default V8 old-space ceiling is 4288 MB. The workspace
lint's type-aware `projectService: true` program for this larger surface
(everything outside `packages/m3l-common`) sits close enough to that ceiling
that it OOMs intermittently rather than deterministically — a `free -h`
check before and after each failure showed 12+ GiB of system RAM free
throughout, so this is a per-process V8 heap artifact of this host's Node
default, not a real memory-availability constraint or a real lint finding.
This is a distinct failure mode from the pre-existing `--concurrency=auto`
VM-crash lesson (`[[eslint-concurrency-crashes-wsl]]`) — that one is a
multi-worker resource-exhaustion problem; this one reproduces at
`--concurrency=1`, single-process.

**Fix for future:** When `pnpm lint`/`pnpm verify` fails specifically at the
`Lint (workspace)` step with this exact `FATAL ERROR` signature, don't loop
retrying the full command blind. Instead: (a) confirm the actual changed
files are clean via a scoped `eslint <files> --concurrency=1` run, (b) retry
the full command once when `free -h` shows the host otherwise idle, and (c)
if it still fails, treat CI's own `Lint (workspace)` check as the
authoritative full-repo signal rather than blocking local progress on it —
CI runs on a different, unaffected environment. Raising
`NODE_OPTIONS=--max-old-space-size` for one diagnostic run is a fast way to
confirm the failure is heap-ceiling-shaped rather than a real finding, without
committing any config change. _(promoted → `[[eslint-concurrency-crashes-wsl]]` memory)_

### 2. Two review rounds were needed because a fix introduced during the first round was itself flagged in the second

The first `claude-pr-review` round's Should-fix (untested branch-rejection
edge cases, bold-status matching) were fixed and re-verified before the first
push. The second round then found a genuinely new gap in the code _added_
during that first fix pass: the `Branch` column read (a feature this PR
introduces, not present before) leaked a shipped row's branch once the table
was fully landed. This was not a miss on the first review — the first round's
Should-fix items were about the parser's terminal-status matching, not the
branch-reading logic, which only became reviewable once it existed in its
near-final form.

**Why it happened:** Each review round only sees the diff as pushed at that
point; a fix landing new logic (not just patching flagged logic) is fair game
for a fresh finding on that new logic in the next round. This is expected
behavior of the two-round loop, not a process gap.

**Fix for future:** No process change needed — this is exactly what
`resolving-pr-comments`' post-push review round is for. Budget for at least
one additional review-and-fix cycle whenever a Should-fix fix itself adds new
branching logic (as opposed to a pure line-level correction), since that new
logic is a fresh review surface.

## Lessons learned

- **A single-process, `--concurrency=1` type-aware lint can still OOM on a
  memory-constrained-by-V8-default host, independent of system RAM
  availability.** Distinguish this from the known `--concurrency=auto`
  multi-worker crash: check `free -h` (system memory) and
  `node -e "require('v8').getHeapStatistics().heap_size_limit"` (V8 ceiling)
  separately before assuming either cause. _(promoted →
  `[[eslint-concurrency-crashes-wsl]]` memory)_
- **Live-run a parser/hook change against real repo data and hand-built
  negative controls before writing its test suite.** This caught the exact
  correct behavior for the terminal-status prefix match and the branch-cell
  validation in one pass each, with zero back-and-forth — the pattern
  `harness-artifacts.md` already prescribes for a new gate, applied equally
  well to modifying an existing shared parser.
- **A field added specifically for a not-yet-built consumer (`finishing-work`'s
  future hand-off) still needs its edge cases reasoned through now, not
  deferred to when the consumer exists.** The `allLanded` leak would have been
  invisible until `finishing-work`'s Branch-reading logic was actually written
  and hit it in practice — catching it at the producer (the parser) during
  this PR is strictly cheaper than debugging it at the consumer, later, in a
  different PR.
- **Squash-merge branch cleanup always reports the local branch as "not
  merged into its base" — this is expected, not a signal to investigate.**
  Confirm the squash commit landed via `git log origin/main --oneline` naming
  the same title/PR number before force-deleting, rather than treating
  `worktree:remove`'s "kept branch" message as an anomaly.
