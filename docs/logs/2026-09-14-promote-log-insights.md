# Work log — `promote-log-insights` (2026-09-14)

Periodic `/promoting-work-log-insights` sweep of the 60-log backlog
(2026-09-06 → 2026-09-13) that had accumulated since the last sweep
(`last-swept=2026-09-06 logs-considered=155`), twelve times the 5-log
cadence `check:retrospective` warns at. This log covers both PRs: the
promotions themselves (#1257) and the retrospective ledger recording every
log read (#1262).

Plan of record: [`docs/plans/archive/2026-09-14-promote-log-insights.md`](../plans/archive/2026-09-14-promote-log-insights.md)

## Summary

Read all 60 logs in full, plus the auto-memory store and
`pnpm telemetry:sessions`. Seven themes recurred across ≥2 logs (or a log
plus a memory) and were absent from `.claude/rules`, `.claude/agents`, and
`.claude/skills`; each was promoted and its source logs stamped
`_(promoted → <path>)_`. One theme routed to a new PreToolUse/`Bash` hook
rather than prose — `.claude/hooks/guard-double-background.mjs` blocks a
command combining `run_in_background: true` with a shell-level detach
(`nohup`/`disown`/trailing `&`), a pattern 9 logs hit independently, twice
producing duplicate concurrent `git push`es from a false "completed" report.
The other six landed as prose in `starting-work`, `creating-prs`,
`resolving-pr-comments`, `code-reviewer.md`, `refactoring.md`, and
`code-implementer.md` (the last sourced from telemetry, not a log bullet).

PR #1257 shipped as `feat: promote recurring work-log insights into rules,
skills & a hook` (squash-merged `82c039e6`), with 23 source logs stamped.
PR #1262 shipped as `docs: record the 60-log promoting-work-log-insights
sweep in the ledger` (squash-merged, PR #1262), landing
`docs/research/retrospective.md` at `last-swept=2026-09-14
logs-considered=215` — 156 promoted, 46 no-durable-insight, 13 deferred, 0
not-yet-swept.

`pnpm verify` passed on both branches before push (73 steps passed, 10
skipped, 0 failed each time).

## What went as planned

- The three-evidence-source model (logs, auto-memory, telemetry) worked as
  designed: the eighth candidate (`code-implementer`'s outlier token share)
  came from telemetry alone, with two logs in the window corroborating the
  symptom (a writer spoke hitting its 40-turn limit) without either log
  itself proposing the decomposition fix.
- The docs-vs-code PR split (ADR-0072) kept PR #1257 reviewable — the ledger
  update alone would have added ~400 lines of pure data to an already
  substantial diff.
- Both pre-push review fan-outs (code-reviewer + docs-consistency-reviewer
  for PR #1257's `bin/**`/`.claude/hooks/**` diff, per this same sweep's own
  P3 promotion exercised on itself; docs-consistency-reviewer alone for
  PR #1262's docs-only diff) found real, fixable issues before push.

## What didn't go as planned, and why

### 1. The new hook's detect-a-detach regex needed two live-driven fixes

The first version's bare-`&` detector excluded only `&` preceded by `>`
(covering `2>&1`), not `&` followed by `>` (bash's `&>`/`&>>` combined-
redirect shorthand) — a pre-push `code-reviewer` catch, reproduced live
(`hasShellDetach("pnpm build &> build.log")` returned `true`) before fixing.
The second version's `nohup`/`disown`/bare-`&` detection was quoting-unaware,
matching ordinary argument text: `grep -n nohup docs/logs/*.md` (a command
this repo's own sweeps run constantly) and `gh api "...&page=2"` (a URL
query-string `&`) both fail-closed. This was `claude-pr-review`'s post-push
Should-fix on PR #1257, also verified live before fixing.

**Why it happened:** the regex was designed against the failure cases the
logs cited, not against a systematic sweep of legitimate `&`/`nohup`
occurrences already common in this repo's own commands.

**Fix for future:** before wiring a new detection regex, grep the repo's own
commands (or, as done here later, 15+ real transcript payloads) for
legitimate uses of the construct being detected, not only the failure shapes
that motivated the rule.

### 2. `EnterWorktree`/`ExitWorktree` ownership tracking didn't survive compaction, twice

Both PR #1257's and PR #1262's `finishing-work` close-out hit
`ExitWorktree({action: "remove"})` refusing with "session is not the owner."
This is the documented, expected fallback path (`finishing-work/SKILL.md`
Step 3): `ExitWorktree({action: "keep"})`, then `git checkout main && git
pull` and `pnpm worktree:remove <slug>` from the shared checkout. Both times
recovered cleanly with no data loss.

**Why it happened:** this session ran long enough (two full PR cycles, each
involving multi-minute `pnpm verify`/push waits) that at least one
mid-session compaction happened between `EnterWorktree` and the
corresponding close-out.

**Fix for future:** none needed — the documented recovery path worked both
times, exactly as written.

### 3. The retrospective ledger's row-by-row classification found gaps the promotion pass missed

Writing PR #1262 required re-reading all 60 logs' Insights/Lessons sections
individually (not just the seven themes' cited evidence) to classify the 21
logs PR #1257 never stamped. Two of those 21 turned out to independently
exhibit the same "a finding naming one file is a sample of a class" pattern
P5 already promoted (`2026-09-10-skill-eval-flaky-negative-routing.md`,
`2026-09-13-u13-registry-scripts-specifier-migration.md`) — recorded as
`no-durable-insight` citing the same-sweep promotion rather than re-promoted,
since the rule already exists.

**Why it happened:** Step 2's recurrence filter only needs ≥2 _citations_ to
promote a theme; it doesn't require finding every log exhibiting the
pattern before promoting. A theme can be promoted correctly from a subset of
its true occurrences, leaving the rest to surface on the next sweep's
full re-read (or, as here, the same sweep's own ledger pass).

**Fix for future:** none needed — this is the ledger doing its job. The
`no-durable-insight` outcome with a same-sweep cross-reference is the
correct disposition, not a sign the earlier promotion pass was incomplete.

## Insights

- **A new detection regex needs a live sweep of the repo's own legitimate
  usage, not just the failure cases that motivated it.** Both of the new
  hook's review-driven fixes were false positives against ordinary,
  already-common commands — the failure mode a synthetic test suite
  (written against only the cited log evidence) can't catch, but a grep
  across the repo's own commands or real transcripts can. Single-log so
  far — not promoted this round; a candidate for the next sweep if it
  recurs.
- **A telemetry-derived promotion's corroborating logs don't automatically
  get stamped** — if the log's own prescribed fix isn't the promoted text
  (here: two logs proposed journaling/verification fixes for a symptom whose
  actual promoted fix, spoke decomposition, came from telemetry), record the
  log by its own insights' merits rather than force a stamp that would
  misrepresent what the log itself said.
