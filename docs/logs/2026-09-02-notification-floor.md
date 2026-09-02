# Work log — notification-floor (2026-09-02)

This log covers PR 1 of a two-PR plan to give long-running tasks a status
signal — an `/auditing` pass on "how the project reports status updates in
long-running tasks," followed by `/researching-anthropic-guidance` on the
same topic, a plan revised mid-flight to coordinate with unrelated in-flight
work, and the shipped config-only slice. It records what shipped, a mid-plan
coordination discovery that reshaped the PR split, a real instance of a
previously-documented lesson firing in practice, and a subagent hallucination
caught by re-verifying against the primary source.

Plan of record: [`how-the-project-reports-drifting-penguin.md`](https://claude.ai/code/session_01HkXA4EQADZq1GS4eumWYKx)
(session-local plan file, not checked into the repo — PR 2 of this plan is
still pending and will carry its own log)

## Summary

- **Audit** (3 parallel `Explore` agents, `/auditing`) found the harness has
  zero timer-driven mechanisms anywhere in `.claude/` — every hook is
  event-driven or user-invoked. Review-spoke fan-outs have stalled 30–60+ min
  with zero user-visible progress on four prior occasions
  (`docs/logs/2026-07-18-aws-athena.md`, `2026-07-18-aws-s3.md`,
  `2026-07-19-subagent-stall-integration.md`, and the `core-procedure` log).
- **Research** (4 parallel agents, `/researching-anthropic-guidance`, scoped
  to the official-sources allowlist) confirmed Claude Code has no
  timer-driven hook event at all (`code.claude.com/docs/en/hooks`), and that
  Anthropic's own guidance ("Building effective agents," the Claude Code
  best-practices page) recommends surfacing intermediate progress rather than
  withholding it until the end.
- **Mid-plan-mode discovery**: a parallel Claude Code session in worktree
  `m3l-automation-statusline-widgets` (branch `feat/statusline-widgets`,
  issue #879, uncommitted at discovery time) was independently rewriting the
  exact same `.claude/hooks/statusline-context-pressure.mjs` file into a
  multi-line dashboard, including its own `refreshInterval` addition. This
  required substantially revising the plan mid-flight: PR 2 became additive
  to and rebased on that work instead of a competing design, and PR 1 was
  narrowed to only the files with zero overlap.
- **Shipped (PR #890, squash-merged)**: `preferredNotifChannel:
"terminal_bell"` in `.claude/settings.json`, plus moving
  `.claude/scheduled_tasks.lock` from a local-only `.git/info/exclude` entry
  into the committed `.gitignore`.
- **Gates**: `pnpm check:hooks`, `pnpm check:context-budget`, `pnpm verify`
  (57/57 applicable steps, 10 skipped push-only/e2e), `pnpm sync:docs`
  (13/13 steps, no working-tree diff), `docs-consistency-reviewer` (pass, no
  findings), all six `pre-push` lefthook lanes green on push.
- **Skills used:** auditing, researching-anthropic-guidance,
  claude-code-setup:claude-automation-recommender (loaded but superseded by
  the direct walkthrough the user asked for), starting-work, writing-commits,
  creating-prs, finishing-work, writing-work-logs.
- **Spoke incidents:** `tmp/session-incidents.jsonl` recorded 21 truncation
  entries total, but the file is not session-scoped and most predate this
  session's own dispatches (17 `workflow-subagent`-type entries from a
  `Workflow` tool run this session never invoked). Two `Explore`-type entries
  fall inside this session's own dispatch window, but both of that batch's
  agents (the repo audit and the `preferredNotifChannel` doc verification)
  returned complete, non-truncated-looking reports on inspection — likely
  heuristic false positives rather than genuine mid-thought cutoffs. Net:
  0 confirmed truncations / 0 stalls / 0 `SendMessage` resumes for this
  session's own dispatches.
- **Compaction events:** none.

## What went as planned

- The `/auditing` → `/researching-anthropic-guidance` →
  `claude-automation-recommender` sequence the user requested worked cleanly
  end to end, producing a plan with genuine repo evidence and genuine
  external-guidance citations rather than either alone.
- Plan-mode's `AskUserQuestion` round correctly surfaced the four-question
  cap (`AskUserQuestion` rejects a 5th question in one call) and the tool
  handled it gracefully — folding the remaining decisions into stated
  defaults rather than failing the whole turn.
- `pnpm worktree:new` and the subsequent gates (`check:hooks`,
  `check:context-budget`) all passed on the first try with no back-and-forth.
- The rebase onto `origin/main` (3 commits behind) was conflict-free —
  `post-integrate-regen`'s merge-driver reconciliation had "nothing to
  reconcile," confirming PR 1's file scope genuinely had zero overlap with
  what had landed on `main` in the meantime.
- `docs-consistency-reviewer`'s single pass returned a clean bill with no
  Must-fix or Should-fix findings, so no fix-and-reverify loop was needed.
- `pnpm push` (backgrounded) ran all six `pre-push` lanes green in ~228s
  wall-clock, matching the documented 2–4 min estimate.

## What didn't go as planned, and why

### 1. A hand-composed background gate run reported the wrong exit code

Running `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build` in
the background produced a `task-notification` claiming "completed (exit code
0)". The real sentinel appended to the log (`EXIT=$?`) showed `EXIT=1`:
`bin/tests/script-scaffold.test.ts` failed because `packages/m3l-cli` wasn't
built yet — `test:coverage` ran before `build` in the hand-composed sequence,
so the CLI's scaffold manifest didn't exist at test time. Re-running the
canonical `pnpm verify` (which orders build-before-test correctly) produced a
genuine `REAL_EXIT=0`.

**Why it happened:** the four gates were composed by hand in an order that
looked reasonable (lint → typecheck → test → build) but doesn't match the
repo's actual dependency order, where one test suite depends on a prior
build step. The harness's own background-task notification summarized the
outer `bash -c` invocation's exit code, not the real command chain's.

**Fix for future:** always reach for `pnpm verify` (or another named,
already-ordered script) instead of hand-composing a gate sequence — the
canonical script encodes step-ordering knowledge a hand-composed chain won't
have. This is also a second live confirmation of
`.claude/rules/subagent-dispatch.md`'s "a backgrounded or piped command
reports the wrong exit code" lesson — the fix (a real sentinel written to the
log, checked instead of the notification) worked exactly as documented.

### 2. A dispatched Explore agent hallucinated a documented value

While verifying the exact `preferredNotifChannel` key/value against official
docs (per the plan's own instruction to verify before writing), a dispatched
`Explore` agent reported the accepted values as `"bell"`/`"desktop"` (versus
`"terminal_bell"`), citing the settings-reference page — a value that page
does not actually contain. Fetching both pages directly
(`code.claude.com/docs/en/settings-reference` and `.../terminal-config`)
showed the settings-reference page only links to terminal-config for the
value list, and terminal-config's own working JSON example is exactly
`{"preferredNotifChannel": "terminal_bell"}` — confirming the value already
written was correct and the subagent's claim was fabricated.

**Why it happened:** the settings-reference page's table entry for this
field has a description but no enumerated value list in the fetched excerpt;
the agent appears to have filled the gap with a plausible-sounding but
invented pair of values rather than reporting the coverage gap honestly.

**Fix for future:** when a subagent's claim is about to change a shipped
config value (not just inform a decision), re-fetch the primary source
directly rather than trusting the subagent's paraphrase — especially when
the claim contradicts something already verified from another angle (the
first agent's own quote of the terminal-config page already showed
`"terminal_bell"`, which should have been the tell that the second claim was
suspect).

## Lessons learned

- **A `pnpm verify`-shaped canonical script beats a hand-composed gate
  chain.** Step ordering that looks obviously correct by convention (lint,
  typecheck, test, build) can still violate a real build dependency the repo
  encodes only in its own script — reach for the named script, not a
  hand-assembled equivalent. In this case the hand-composed chain was
  `creating-prs`'s own Step 4 instruction, so the fix landed directly in the
  skill rather than staying a one-off observation
  _(promoted → .claude/skills/creating-prs/SKILL.md)_.
- **Re-fetch the primary source before trusting a subagent's claim about a
  documented value, especially right before writing it.** This is a stronger
  bar than "trust but verify the summary" — when the claim would change a
  committed file and contradicts other evidence already in hand, a second
  direct fetch is cheap insurance against a hallucinated citation.
- **`session-incidents.jsonl` is not session-scoped in a shared checkout.**
  The file accumulates entries from every session that has run in the same
  checkout directory since the last `startup|clear` rotation, so a work log
  written mid-day in a long-lived checkout cannot assume every entry in the
  file belongs to the current session — cross-check entry timestamps against
  the session's own dispatch windows before attributing a count.
- **Discovering unrelated concurrent work mid-plan is best handled by
  revising the plan in place, not restarting it.** Finding a second session
  rewriting the same target file didn't require abandoning the audit/research
  already done — only the file-boundary and sequencing decisions needed
  revision, and the existing findings/citations stayed valid input to the
  narrower, additive plan.
- **A squash-merged branch is correctly kept, not silently deleted, by
  `pnpm worktree:remove`.** `git branch -d` cannot see squash-merge ancestry,
  so the "kept branch (not merged into its base)" message is expected
  behavior on every squash-merged PR, not a sign something went wrong —
  confirm via `gh pr view --json mergeCommit` (single parent, new SHA) before
  force-deleting.
