# Work log — review-loop-sequencing (2026-09-07)

Resolves GitHub issue #1003 (ROADMAP H10): `creating-prs` Step 7's pre-push
review loop and `resolving-pr-comments`'s post-push bot-finding loop never
named each other, so a reader comparing the two skills in isolation could
read them as competing rather than sequential phases of one review
lifecycle. This log records what shipped, a self-introduced formatting bug
and its fix, three separate merge-conflict rounds against a fast-moving
`main`, and the host-contention workarounds needed to get a clean
`test:coverage` run on a heavily shared box.

Plan of record: [`docs/plans/archive/2026-09-07-review-loop-sequencing.md`](../plans/archive/2026-09-07-review-loop-sequencing.md)

## Summary

Four hand-authored files changed: `.claude/skills/creating-prs/SKILL.md`
(a closing paragraph on Step 7 naming `/resolving-pr-comments` as its
post-push half), `.claude/skills/resolving-pr-comments/SKILL.md` (a final
`## Boundary rules` bullet naming the pre-push step as its counterpart),
`docs/contributing/skill-routing.md` (a third, explicitly conditional
Successor-chains line), and `docs/ROADMAP.md` (H10 row flipped `To Do` →
`Done`). Landed as PR #1103, squash-merged to `main` at `db50a610`. GitHub
auto-closed issue #1003 on merge via the PR body's `Closes #1003`
reference; `pnpm sync:hub -- --apply` archived its now-redundant board
item.

No frontmatter touched (confirmed via `check:context-budget`'s unchanged
skill-listing total — 7,870 chars / ~1,968 tokens both before and after).
Zero semver impact — docs/`.claude`-only, no `src/`, test, or `exports`-map
change. `pnpm verify` passed in full on the final pushed tree (66 steps, 10
skipped push-only/e2e); the PR's own pre-push hook lanes (`typecheck`,
`build-exports`, `checks`, `format`, `lint`, `test`) all passed on every
push that actually reached GitHub. `claude-pr-review.yml` returned PASS.
`docs-consistency-reviewer` (Step 7's dispatch, since the diff was
docs-only) found zero findings.

Skills used: starting-work, writing-commits, creating-prs,
resolving-merge-conflicts (invoked three times), syncing-docs (invoked
internally by creating-prs' Step 5, run standalone twice more after each
rebase), finishing-work, writing-work-logs.

Spoke incidents: none (no `tmp/session-incidents.jsonl` present this
session; the one dispatched review spoke — `docs-consistency-reviewer` —
completed normally on its first call).

Compaction events: none.

## What went as planned

- **The core edit was clean on the first pass.** All three cross-reference
  passages (creating-prs, resolving-pr-comments, skill-routing.md) were
  internally consistent from the first draft — `docs-consistency-reviewer`
  found zero findings, including cross-checking step numbers, spoke names,
  and file references against the actual skill bodies.
- **The frontmatter-headroom constraint was caught before writing, not
  after.** A dedicated Explore agent found `check:context-budget`'s
  ~128-char aggregate skill-listing headroom up front, which correctly
  steered every edit into SKILL.md bodies only — no rework needed later.
- **`resolving-merge-conflicts`' classification step worked exactly as
  designed**, three separate times, for what turned out to be the same
  underlying pattern (see divergence #2) — each time correctly identifying
  the conflict as a false same-row collision rather than real content
  drift, by diffing whitespace-normalized before/after tables against the
  merge base.
- **`gh pr merge --squash` plus `finishing-work`'s worktree-removal path
  handled the squash/non-ancestor branch cleanly**, including the expected
  `ExitWorktree` ownership refusal after the long session (see divergence
  #4) and the expected "kept, not merged into its base" branch-cleanup
  outcome for a squash-merged branch.

## What didn't go as planned, and why

### 1. A piped `format:check` swallowed its real (failing) exit code

After hand-splicing the ROADMAP.md merge resolution, `pnpm format:check
2>&1 | tail -30` reported success (exit 0) because that exit code is
`tail`'s, not `format:check`'s — the hand-spliced H10 row was one padding
space short of the table's actual post-rebase column width, and the first
push's pre-push hook caught it for real (`checks` lane passed, `format`
lane failed).

**Why it happened:** Piping a command whose own exit status matters into
`tail` (or any downstream consumer) discards that status under a default
(non-`pipefail`) shell — the visible "exit code" belongs to the last stage
of the pipe, not the command being tested.

**Fix for future:** Never pipe a gate command whose exit code is the actual
signal being checked. Redirect to a file and inspect it separately
(`cmd > log 2>&1; echo $?`), or run it unpiped and read the tail after the
fact.

### 2. Three separate rebases hit the identical `docs/ROADMAP.md` (and once `docs/plans/README.md`) conflict pattern

Every rebase onto a moved `origin/main` during this session's ~2-hour span
conflicted in `docs/ROADMAP.md`, and once in `docs/plans/README.md`'s
Archive table — never because two branches touched the same row, but
because prettier's markdown table formatter re-pads **every** row's
trailing whitespace whenever any row's widest cell changes length. A
plain-text diff sees that as every row differing; only a whitespace-
normalized diff against the merge base reveals the true single-row change
on each side. `docs/plans/README.md`'s conflict was a true append-conflict
(two branches each added a new Archive row at the identical table
position, not a same-row edit). Both classes resolved the same way: take
one side's full table, splice in the other side's one true content change,
reformat with prettier, continue.

**Why it happened:** `docs/ROADMAP.md`'s Governance-follow-ups table (and
`docs/plans/README.md`'s Archive table) is a single large markdown table
that many independent, small, frequently-shipped PRs all touch — H4, H6,
H9, H11, H12, H14 all landed on `main` within this session's own working
window, each re-padding the whole table via its own `pnpm prettier --write`
pass.

**Fix for future:** When a rebase conflicts in one of these two
append-heavy tables, immediately whitespace-normalize both sides
(`diff <(sed 's/  */ /g' ours) <(sed 's/  */ /g' theirs)`) before assuming
a real collision — it is very likely a pure reflow or append conflict, both
of which resolve by taking one full side and splicing in only the other
side's true row(s), never by hand-merging padding.

### 3. Genuine host contention (5–7 concurrent Claude Code sessions) repeatedly killed background `pnpm verify`/`test:coverage` runs

Five separate attempts to run the full quality-gate sequence in the
background were killed mid-run with "the system is running low on memory"
before ever producing a pass/fail signal, coinciding with `ps aux` showing
3–4 sibling worktrees (`should-fix-ack-policy-docs`, `seam-plan-handoff`,
`instruction-authoring-policy`, `check-promotion-stamps`) each running
their own full-parallelism `vitest run --coverage` at the same time. A
manual run with `--maxWorkers=2` (well below the config's own `50%`
default) finally completed cleanly once host memory stabilized around
10–14 GiB available.

**Why it happened:** This is exactly the resource-contention class ADR-0080
already documents (`docs/logs/2026-08-27-parallel-session-oom.md`), playing
out live: multiple independent Claude Code sessions each pre-push-gating
concurrently on one shared, memory-constrained host, with no cross-session
coordination over CPU/RAM.

**Fix for future:** Run `pnpm check:host-resources` before a multi-minute
gate sequence when several sibling worktrees are visible in `ps aux`, and
be ready to retry with an explicit `--maxWorkers=N` override (a temporary,
local-only invocation — never a committed config change) rather than
repeatedly re-launching the default-parallelism command into the same
contention.

### 4. Two Bash tool misuses cost real wall-clock: double-backgrounding, and a bare `vitest` invocation

Passing a command that itself ends in `&` (or `nohup … & disown`) to a
`run_in_background: true` Bash call made the tool report false completion
within seconds — the wrapper shell backgrounds-and-exits immediately while
the real process keeps running, untracked, for many more minutes. Separately,
one manual `vitest run --coverage` retry used the bare `vitest` binary
(exit 127, not on `PATH`) instead of `pnpm exec vitest`.

**Why it happened:** `run_in_background: true` already handles backgrounding;
adding a shell-level `&`/`nohup … &` on top produces two independent
detach points, and the tool can only track the outer (immediately-exiting)
one. The bare `vitest` call assumed a global install that this repo does
not have.

**Fix for future:** Never combine a Bash tool's own `run_in_background: true`
with a command-level `&`/`nohup`/`disown` — pass the plain foreground
command and let the tool background it. Always invoke project-local
binaries via `pnpm exec <bin>` or the matching `pnpm <script>`, never bare.

### 5. `ExitWorktree({action: "remove"})` refused ownership after the long session

By the time `finishing-work` ran, the session no longer held tracked
ownership of the worktree it had entered via `EnterWorktree` at the very
start (a multi-hour session likely crossed an internal compaction/liveness
boundary). This is the exact documented failure mode — resolved by
`ExitWorktree({action: "keep"})` followed by the manual
`git checkout main && git pull` + `pnpm worktree:remove <slug>` sequence
`starting-work`/`finishing-work` both already describe for this case.

**Why it happened:** Ownership tracking for an `EnterWorktree`-entered
worktree does not survive an internal session-state boundary crossed
mid-task, per the skill's own documented caveat.

**Fix for future:** No new fix needed — the existing fallback path handled
it correctly and immediately, first try.

## Lessons learned

- **Never pipe a gate command whose own exit code is the pass/fail signal.**
  `cmd 2>&1 | tail -N` reports `tail`'s exit code, not `cmd`'s — this
  silently downgraded a real formatting failure to an apparent pass earlier
  in this same session.
- **A shared markdown table with frequent independent writers conflicts on
  reflow, not content, almost every time.** Whitespace-normalize both sides
  of a `docs/ROADMAP.md` or `docs/plans/README.md` conflict against the
  merge base before assuming a real same-row collision; it is very likely a
  padding cascade (edit) or a same-position append (two new rows), both
  mechanically resolved by taking one full side and splicing in the other's
  true change.
- **Never combine `run_in_background: true` with a command-level `&`/
  `nohup`/`disown`.** The tool's own backgrounding is sufficient; adding a
  second detach point makes it report false completion while the real
  process keeps running untracked.
- **On a visibly contended host, budget for a `--maxWorkers` override on
  `test:coverage`, not endless default-parallelism retries.** Five
  identically-shaped background kills before trying reduced parallelism
  wasted more wall-clock than the eventual successful run took.
- **`ExitWorktree`'s ownership-refusal fallback (`action: "keep"` +
  manual `git checkout main` + `pnpm worktree:remove`) works exactly as
  documented** for a long session that outlives its own worktree-ownership
  tracking — confirms the existing guidance rather than surfacing anything
  new.
