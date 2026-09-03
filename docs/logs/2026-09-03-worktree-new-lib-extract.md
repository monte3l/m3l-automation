# Work log — `worktree-new-lib-extract` (2026-09-03)

This log covers `/auditing` a topic prompt ("expand `pnpm worktree:new`'s
mintable branch prefixes beyond `feat`/`fix`"), the resulting plan, and PR1 of
its two-PR sequence: `refactor: extract worktree-new.mjs argument parsing into
bin/lib` (PR #932, merged). PR2 — the `feat:` widening `BRANCH_KINDS`/
`SESSION_KINDS` and adding a `--kind` flag — is the next task, starting from a
fresh `starting-work` pass per the confirmed sequence; it is not covered here.

## Summary

- Ran `/auditing` via the `audit-fanout` workflow across 5 facets (CLI surface,
  branch-prefix history census, branch-policy contract sites, downstream
  prefix consumers, tests/gates coverage). All 5 finders returned;
  `missingFacets` was empty. The workflow's Verify phase failed wholesale (all
  10 `audit-refuter` dispatches hit an Anthropic session-capacity limit), so
  every finding landed as `unverified` except 5 the workflow managed to
  confirm before the limit hit. The hub personally re-verified every
  load-bearing claim by reading the cited files directly before drafting
  clarifying questions.
- Key finding: `BRANCH_KINDS` (`bin/lib/session-name.mjs:21`) must stay a
  subset of `SESSION_KINDS`, or `worktree-new.mjs`'s own advertised
  `pnpm session:launch` throws on the branch it just created — the real
  constraint governing how far the prefix set can widen, not just the
  `--fix` ternary itself.
- Asked 4 batched `AskUserQuestion` rounds (prefix set, CLI shape, test scope,
  docs/PR-split), landed on: `docs`/`chore`/`refactor`/`ci` added to
  `BRANCH_KINDS`, a `--kind <k>` flag with `--fix` kept as an alias, full
  extraction + subset-invariant test, two PRs (refactor then feat) with
  primary docs only in PR2 (skill/hook advisory prose deferred).
- Wrote the plan to `~/.claude/plans/the-pnpm-worktree-new-script-snazzy-neumann.md`,
  approved via `ExitPlanMode`.
- PR1 executed: `bin/lib/worktree-new.mjs` (new, `parseWorktreeNewArgs`/
  `worktreeDirName`, pattern-parallel with `bin/lib/worktree-prune.mjs`),
  `bin/worktree-new.mjs` reduced to a thin shell, `bin/tests/worktree-new.test.ts`
  (12 tests, dispatched to `test-author` — the hub cannot write `**/tests/**`
  directly under `guard-hub-src-writes.mjs`). `pnpm verify`: 58/58 passed, 10
  skipped (push-only/CI-only). `vitest.bin.config.ts` explicitly: 3218/3218
  passed. `code-reviewer` spoke: PASS, 0 Must-fix, 2 optional nits (not acted
  on — both explicitly deferred to PR2 or a future extraction). Pushed,
  opened PR #932, merged.
- Skills used: `auditing`, `starting-work`, `writing-commits`, `creating-prs`,
  `syncing-docs`, `finishing-work`, `writing-work-logs`.
- Spoke incidents: none (no `tmp/session-incidents.jsonl` entries; no writer
  or reviewer spoke truncated). The audit-fanout refuter failures above are a
  separate, workflow-level (not spoke-truncation) failure mode — an external
  session-capacity limit, not a truncated turn.
- Compaction events: none.

## What went as planned

- The audit's 5 finders converged cleanly despite the verify-phase outage —
  `missingFacets` was empty, and every claim the hub independently
  re-verified held (one line-number citation off by 3 lines, otherwise
  exact).
- `test-author`'s first dispatch delivered 12/12 passing tests, clean eslint,
  clean `pnpm typecheck` (including the separate `tsc -p bin/tsconfig.json`
  invocation that actually type-checks `bin/tests/**`), no re-dispatch needed.
- `code-reviewer`'s first pass returned PASS with zero Must-fix — confirmed
  the extraction preserved every error string, the flag/branch precedence
  order, and the `feat`/`fix` default exactly, by diffing against
  `git show origin/main:bin/worktree-new.mjs`.
- The rebase onto `origin/main` (2 commits behind) was conflict-free; the
  `post-rewrite` merge-driver regen step reported nothing to reconcile.
- `pnpm sync:docs` was fully idempotent — no working-tree diff — since PR1
  touched no exports, no docs, no submodule.
- `finishing-work`'s close-out (worktree removal, branch deletion, ref
  pruning) completed without any "kept" branch or manual-fallback case.

## What didn't go as planned, and why

### 1. All 10 `audit-refuter` dispatches failed on an Anthropic session limit

The `audit-fanout` workflow's Verify phase is supposed to adversarially
refute each GAP/INCONSISTENCY finding one refuter at a time. Every dispatch
in this run failed with `"You've hit your session limit · resets 4:40am
(Europe/Rome)"`, so 0 findings were refuted and the overwhelming majority
landed as `unverified` (36 of 41). Per the `auditing` skill's own contract,
the hub is the backstop for exactly this case — it read every cited file
directly (`bin/worktree-new.mjs`, `bin/lib/session-name.mjs`,
`bin/claude-launch.mjs`, `bin/lib/mcp-tools.mjs`, ADR-0014, ADR-0087,
`commitlint.config.js`, plus a fresh 1209-commit type census) before treating
any finding as real.

**Why it happened:** an external Anthropic account/session capacity limit,
unrelated to the workflow's own logic or the findings' content.

**Fix for future:** when `audit-fanout`'s result shows a `confirmed` count
near 0 with a high `unverified` count and failure log lines mentioning a
session/usage limit, budget for a full hub-side manual-verification pass
before drafting clarifying questions — don't assume the refuter's silence
means the findings are weak.

### 2. `git diff main...HEAD` silently over-scoped inside the PR1 worktree

`creating-prs` Step 7's literal command showed 9 unrelated files (from 3
commits that had landed on `origin/main` during the session) alongside the 3
files PR1 actually changed. Diffing against `origin/main` instead (after
`git fetch origin main`) showed exactly the 3 intended files.

**Why it happened:** `pnpm worktree:new` branches a linked worktree directly
from `origin/main` at creation time; the shared local `main` ref is a
separate pointer that nothing fast-forwards afterward. If other PRs merge to
`origin/main` while the worktree is in flight, local `main` and `origin/main`
diverge silently — `git diff main...HEAD` still runs without error, it just
scopes wrong.

**Fix for future:** promoted into `.claude/skills/creating-prs/SKILL.md`
Step 7 directly (see Lessons learned).

### 3. Two `AskUserQuestion` calls failed tool validation before landing

The first batch of Step-4 clarifying questions (5 questions) failed with
`"array to have <=4 items"`; a later `starting-work` confirmation batch
included a single-option "branch name" question and failed with `"array to
have >=2 items"`. The same single-option mistake recurred a second time
during this same task's follow-up commit-and-PR request.

**Why it happened:** drafted question batches without checking
`AskUserQuestion`'s hard limits (max 4 questions per call, min 2 options per
question) up front, and the lesson didn't stick across the session gap
between the two occurrences.

**Fix for future:** cap batches at 4 questions before drafting; when only one
sane choice exists for a dimension (e.g. a derived branch name), state it
directly in prose instead of submitting a degenerate one-option question —
every time, not just after the first failure.

### 4. `ScheduleWakeup` misapplied to an in-flight background subagent

Called `ScheduleWakeup` to set a "heartbeat" while waiting on the
`test-author` dispatch; it rejected the call (`prompt` required) since the
tool is scoped to `/loop` dynamic-mode pacing, not general async-agent
waiting.

**Why it happened:** treated a completion-notification-driven wait (the
`Agent` tool already notifies automatically) as if it needed manual polling
infrastructure.

**Fix for future:** never call `ScheduleWakeup` outside a `/loop` session;
a backgrounded `Agent`/`Bash(run_in_background)` call delivers its own
`task-notification` on completion with no polling required.

### 5. The work log and a rule promotion were written to the shared checkout, not a worktree

After PR1 merged and `finishing-work` removed the PR1 worktree, this log and
the `creating-prs` SKILL.md edit were written directly into the shared
checkout (`/home/enri3l/workspaces/monte3l/m3l-automation`) rather than a new
worktree — contradicting the user's standing preference (shared checkout is
their own working copy; branch/commit only in a linked worktree). Caught when
the user asked to commit and open a PR: a fresh `starting-work` pass created
a new worktree, but the uncommitted files were still sitting in the shared
checkout and had to be reverted there (`git checkout --` for the tracked
SKILL.md edit, `rm` for the untracked log) and rewritten inside the new
worktree before committing.

**Why it happened:** after a worktree is removed via `finishing-work`, the
session's cwd reverts to the shared checkout, and no explicit "which
location am I in" check ran before the next set of file writes — the location
decision from PR1's `starting-work` pass was treated as still in effect
across the intervening close-out, when it no longer was.

**Fix for future:** after any `finishing-work` close-out that removes a
worktree, treat the next write as needing a fresh location decision — don't
assume the prior worktree/location choice carries forward once that worktree
is gone.

## Lessons learned

- **`audit-fanout`'s hub-verification backstop earns its keep even on a
  total verify-phase outage.** The skill's Step 3 already designates the hub
  as the fallback verifier; this run exercised the worst case (0 refuters
  succeeded) and the backstop still produced a plan with zero factual
  corrections needed beyond one line-number citation.
- **Diff a linked worktree against `origin/main`, not local `main`, once
  other work may have landed on the base during the session.**
  _(promoted → .claude/skills/creating-prs/SKILL.md)_
- **`AskUserQuestion` batches are hard-capped at 4 questions, and every
  question needs ≥2 real options.** Plan the question count before drafting;
  fold a single-recommendation decision into prose instead of a
  one-option question — this recurred twice in one session, so it's worth
  treating as a checklist item before every `AskUserQuestion` call, not just
  a one-off correction.
- **`ScheduleWakeup` is `/loop`-only.** A backgrounded subagent or shell
  command already delivers a completion notification — never use
  `ScheduleWakeup` to poll for one outside a `/loop` session.
- **The refactor-then-feat PR split paid off exactly as designed.** PR1's
  dedicated test file (`bin/tests/worktree-new.test.ts`) gives PR2 a
  behavior-locked safety net before the prefix set actually widens, keeping
  the behavior-preserving change and the behavior change in separately
  reviewable commits per `.claude/rules/refactoring.md`.
- **A `finishing-work` close-out resets the location decision, not just the
  branch.** Removing a worktree returns the session to the shared checkout;
  the next file write needs its own fresh location call (worktree vs. shared
  checkout), not an assumption that the prior task's location choice still
  applies. _(promoted → `.claude/skills/starting-work/SKILL.md`)_
