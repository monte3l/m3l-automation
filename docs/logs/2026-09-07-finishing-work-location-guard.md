# Work log — finishing-work-location-guard (2026-09-07)

Resolves issue #1004 (ROADMAP row H11): `finishing-work` Step 3 previously
picked between `pnpm worktree:remove` and `pnpm branch:cleanup` by the
executor's own situational awareness rather than a scripted check. This log
covers the guard that fixes it, a Should-fix follow-up caught by
`claude-pr-review`'s new `should-fix-ack` gate, and the tracker close-out.

Plan of record: [`docs/plans/archive/2026-09-07-finishing-work-location-guard.md`](../plans/archive/2026-09-07-finishing-work-location-guard.md)

## Summary

- New `bin/lib/checkout-location.mjs` — an injected-git-seam helper (shaped
  like `bin/lib/claude-home.mjs`) classifying main-checkout-vs-linked-worktree
  and the sibling-worktree slug a directory name encodes, deduping the
  `dirname(--git-common-dir)` idiom previously inline in `worktree-new.mjs`
  and `worktree-remove.mjs`.
- New `validateWorktreeSafe()` in `bin/lib/branch-cleanup.mjs`: `pnpm
branch:cleanup` now refuses (exit 1) a delete that would strand a linked
  worktree — the branch checked out in a _different_ worktree ("attached"),
  or cwd being the worktree named for the branch's own slug even after it's
  been switched off it ("standing-in"). Deliberately two narrow conditions,
  not a blanket "cwd is a linked worktree" refusal, so `check:staleness`'s
  existing `pnpm branch:cleanup <branch>` advice for an already-unattached
  branch keeps working.
- `worktree:remove`'s previously combined, remedy-free refusal split into two
  actionable messages.
- `.claude/skills/finishing-work/SKILL.md` Step 3 gained the same mechanical
  `git rev-parse --git-common-dir`/`--git-dir` discriminator `starting-work`
  Step 1 already used, replacing the prose-only location guess.
- Documented `branch:cleanup`'s worktree section in
  `docs/contributing/contributing.md` (previously undocumented) and updated
  its `bin/lib/command-catalog.mjs` description.
- Landed as PR #1094 (6 commits: lib, dedupe refactor, message split, the
  guard + tests, docs, plan archive), then a 7th commit fixing a
  `claude-pr-review` Should-fix, then PR #1098 (tracker flip to `Done`,
  auto-merged).
- `pnpm verify` passed clean (66 steps, 10 appropriately skipped) after every
  push. Full bin suite: 103 files / 3757 tests passing after the final fix.

Skills used: starting-work, creating-prs, syncing-docs, finishing-work,
writing-work-logs (plan mode was used for the initial design instead of
`auditing`).

Spoke incidents: 1 truncation recorded in `tmp/session-incidents.jsonl`
(agent id not matching any dispatch made by this session's own hub turns;
the entry sits in the main checkout's `tmp/`, which a concurrent peer session
sharing this host could also have written to — none of this session's own
dispatches showed truncation symptoms, returned a mid-thought fragment, or
needed a `SendMessage` resume) / 0 stalls / 0 resumes.

Compaction events: none.

## What went as planned

- **The pre-verify-in-scratchpad → dispatch-to-`test-author` pattern worked
  cleanly, twice.** `bin/tests/**` is guarded against hub writes
  (`guard-hub-src-writes.mjs`); both the initial `checkout-location.test.ts`
  - extended `branch-cleanup.test.ts`, and the later single-test fix for the
    Should-fix, were written and run against the real source in the scratchpad
    first (a throwaway `vitest.config.ts`), then handed to `test-author`
    verbatim for placement. Both dispatches placed the content byte-for-byte
    and reported the full suite green, no back-and-forth needed.
- **Mutation testing caught what it was supposed to, every time.** Deleting
  the "attached" condition, the "standing-in" condition, and loosening the
  standing-in slug comparison to match any worktree location each
  independently broke a distinct test in the initial guard; reverting the
  Should-fix's main-checkout exclusion broke its new test with exactly the
  predicted misreported result. No surviving mutants.
- **`docs-consistency-reviewer`'s pre-push review found nothing** — all 10
  focused checks (SKILL.md/contributing.md/command-catalog accuracy, JSDoc
  correctness, plan-doc accuracy, ADR provenance diff sanity) passed clean,
  confirming the design pass's earlier corrections (narrowing the guard to
  two conditions, catching the `check:staleness` compatibility requirement)
  had already closed the gaps a reviewer would otherwise flag.
- **The design pass corrected the brief in three material ways before any
  code was written** — narrowing "cwd is a linked worktree" to two specific
  conditions, ruling out `worktree:setup`/`guard-worktree-ready.mjs` from the
  dedupe, and settling on a hard refusal with no new flag — all three held
  through implementation and review without revision.

## What didn't go as planned, and why

### 1. `claude-pr-review`'s `should-fix-ack` gate caught a real edge case both the design pass and mutation testing missed

`worktreeForBranch()` matched against every record from `git worktree list
--porcelain`, including the main checkout's own record (`parseWorktreeList`
always includes it as the first entry). A branch checked out in the MAIN
checkout — not a linked worktree — was misreported as `kind: "attached"`
with the message calling the main checkout "the linked worktree" and a
`slug: null` remedy suggesting `git worktree remove <main checkout>`, which
git rejects outright (there's no worktree there to remove). The review
verdict was PASS with one Should-fix, not a Must-fix, but this repo's new
`should-fix-ack` job (added in PR #1082, days before this task) hard-fails
the PR unless a commit carries an `Acknowledged-Should-Fix:` footer — so the
finding had to be resolved (or explicitly disputed) before merge regardless
of its severity tier. Fixed by filtering `location.mainCheckout` out of the
search before matching, pre-verified and mutation-tested the same way as the
original guard, then pushed as a follow-up commit with the required footer.

**Why it happened:** every test fixture built for the guard modeled a
worktree layout with two linked worktrees and a detached one — none modeled
a branch checked out in the main checkout itself, so neither the original
design review nor mutation testing against those fixtures could expose a
path that fixture space never reached.

**Fix for future:** when writing fixtures for any git-worktree-aware logic,
explicitly enumerate every _kind_ of `git worktree list --porcelain` record,
including the main checkout's own record (always first, per
`bin/lib/worktree-prune.mjs`), not just the linked-worktree ones. A test
suite that never puts the branch under test in the main checkout has a
structural blind spot no amount of additional linked-worktree fixtures can
close.

### 2. A rebase during the fix round hit a real conflict requiring ADR-0024's take-ours-then-regenerate resolution

Between opening PR #1094 and merging it, another PR landed on `main` that
also touched `docs/adr/provenance.json`. Rebasing the branch conflicted on
that one file (the auto-merge driver's `merge=m3l-generated` `.gitattributes`
tag did not resolve it during this rebase — the conflict still surfaced as a
normal git conflict marker). Resolved per `resolving-merge-conflicts`'s
documented pattern for a derived artifact: `git checkout --ours`, continue
the rebase, then `pnpm gen:adr-provenance` to regenerate correctly against
the final rebased tree, folded into the last commit via `--amend`.

**Why it happened:** the sidecar's blob-hash entries are content-addressed
per file; two branches touching overlapping ADR-cited files in the same
window will conflict on the raw JSON even though the _correct_ end state is
always "regenerate from whichever tree wins," which is exactly what the
generator does deterministically.

**Fix for future:** no code change needed — this confirms
`resolving-merge-conflicts`'s existing guidance is sufficient. Worth noting
in case a future session is tempted to hand-merge the JSON instead of
taking either side and regenerating.

### 3. A direct-to-`main` push for the tracker-flip commit was rejected by branch protection, despite being a pure docs/metadata change

After merging PR #1094, `finishing-work` Step 5 asked to flip the ROADMAP
H11 row to `Done`. The commit was made directly on `main` (following
`starting-work`'s framing that "for docs/config-only changes... a PR may be
optional") and the push was rejected: `GH013: Repository rule violations...
Changes must be made through a pull request` — branch protection on this
repo requires a PR for every change to `main`, with no docs-only exemption.
Recovered by moving the commit to a new branch (`git branch` + `git reset
--hard HEAD~1`, since the working tree was clean) and opening PR #1098 with
`--auto --squash` (the docs-only opt-in path from `creating-prs` Step 15),
which merged cleanly a few minutes later.

**Why it happened:** `starting-work`'s "a PR may be optional" language for
docs/config-only work describes a _recommendation_ this skill makes to the
user, not an actual bypass of the repository's branch protection rules — the
two are easy to conflate when reading the skill text as permission to skip
the PR step outright.

**Fix for future:** treat "a PR may be optional" in `starting-work` as
non-binding on branch protection specifically — always branch and PR any
change to `main` in this repo, including a single-line tracker-status flip,
and let `creating-prs` Step 15's auto-merge opt-in be the actual fast path
for a docs-only change rather than skipping the PR machinery entirely.

## Lessons learned

- **Enumerate every worktree-record shape when testing git-worktree-aware
  logic, not just the linked-worktree ones.** The main checkout's own
  `git worktree list --porcelain` record is always present
  (`bin/lib/worktree-prune.mjs`'s first entry) and needs its own fixture
  case — a test suite covering only linked and detached worktrees has a
  structural blind spot a reviewer, human or automated, may or may not catch.
- **`should-fix-ack` changes what a Should-fix finding costs.** Before PR
  #1082, a Should-fix was optional guidance a session could defer with a
  clear conscience; now it hard-blocks merge until acknowledged one way or
  another. Budget time for at least one fix-and-repush round on any PR that
  gets a non-empty Should-fix section, even when the review verdict is PASS.
- **A direct push to `main` is never actually optional in this repo,
  regardless of how trivial the change.** Branch protection requires a PR
  for everything; treat every tracker flip, doc fix, or config tweak the
  same way as a code change — branch, push, open a PR (auto-merge is fine
  for the genuinely trivial ones).
- **`docs/adr/provenance.json` conflicts during a rebase are routine, not
  alarming.** Two branches touching overlapping ADR-cited files in the same
  window will conflict on the raw JSON; `git checkout --ours` +
  `pnpm gen:adr-provenance` + amend is the correct, low-effort resolution
  every time — no need to hand-merge the sidecar's contents.
- **Host resource contention from concurrent Claude Code sessions can turn a
  normally-fast pre-push lane into a multi-minute wait, twice in the same
  task.** `lint:workspace` alone took over 2 minutes under a load average of
  ~10 and briefly 222Mi free memory, versus seconds when run standalone
  earlier in the same session. Not a defect — matches the documented
  ADR-0080 gotcha — but worth budgeting for when multiple sessions are
  active on the same host, including across two separate pushes for the
  same PR.
