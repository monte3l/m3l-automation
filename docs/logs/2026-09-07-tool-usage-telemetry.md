# Work log — `tool-usage-telemetry` (2026-09-07)

This log covers the design and implementation of harness tool-usage
metrics — tracking how often each tool (Claude Code built-in, project MCP
tool, skill, agent) actually runs. The task began as an `/auditing`
invocation, ran through `/researching-anthropic-guidance`, an
`audit-fanout` workflow pass over the live repo, plan mode, implementation,
a two-spoke review round, and shipped as PR #1079.

Plan of record: `partitioned-inventing-pinwheel` (session plan-mode file,
outside this repo — not linkable from here).

## Summary

Shipped: `bin/session-telemetry.mjs` extended with a third in-repo scan
(`classifyToolUse`, `isSubagentTranscript`, `listAllTranscripts`,
`countToolUseInTranscript`, `computeToolUsage`, plus a shared `isWithinDir`
anti-traversal helper factored out of the existing `listRecentTranscripts`),
wired into `runTelemetry` as a new advisory `toolUsage` field
(`{ files_scanned, unreadable, events_scanned, by_tool, by_tool_origin }`).
`docs/decision-notes/0002-per-tool-usage-scan-scope.md` (new),
`docs/contributing/skills-catalog.md` and `.claude/rules/subagent-dispatch.md`
updated to point at the new output. 5 new exports, 154/154 tests passing in
`bin/tests/session-telemetry.test.ts` (42 new), `pnpm verify` green (66
passed / 10 skipped) on both pre-fix and post-fix commits. No `src/` or
`exports`-map change — zero semver impact on `@m3l-automation/m3l-common`.
Landed via PR #1079 (three commits, squash-merged as `3f9fa37c`); CI:
`review` (claude-pr-review.yml) PASS, no Must-fix, all 17 checks green.

Skills used: `auditing`, `researching-anthropic-guidance`, `starting-work`,
`writing-commits`, `syncing-docs`, `creating-prs`, `resolving-pr-comments`,
`finishing-work`, `writing-work-logs`.

Spoke incidents: none (`tmp/session-incidents.jsonl` absent — zero
truncations recorded).

Compaction events: none observed in this session.

## What went as planned

- **The audit-fanout workflow's verify phase caught its own finder's
  mistakes before they reached the plan.** Of 15 findings that survived to
  verification, 6 were refuted — including a finder incorrectly claiming
  "no gap" fixes existed when they'd already been rejected on record in
  ADR-0084, and a finder claiming no code parses `tool_use`/`tool_result`
  blocks when two harness scripts already do (for narrower purposes than a
  usage metric).
- **The live-run-before-writing-tests discipline
  (`.claude/rules/harness-artifacts.md`) paid off immediately.** Running
  `computeToolUsage` against this project's real transcript store, and then
  against a directory with a genuine nested subagent tree, surfaced the
  76%-undercount finding and confirmed the hub/subagent origin split summed
  correctly — before a single test was written.
- **`test-author` delivered clean, typecheck-clean, lint-clean test code on
  first dispatch**, matching the existing `computeNamingCompliance` suite's
  style closely enough that no structural rework was needed, in both the
  initial dispatch and the follow-up rename/coverage-addition dispatch.
- **The review round converged cleanly.** `code-reviewer` and
  `silent-failure-hunter`, dispatched in parallel, returned zero Must-fix
  and non-overlapping Should-fix findings on the first pass; the one
  overlapping finding (the `isFile()` gap) converged across three
  independent reviewers total (mine, silent-failure-hunter, and later
  `claude-pr-review.yml`) without anyone needing to re-litigate it.
- **`resolving-pr-comments`'s PASS-verdict stop was honored, not
  overridden**, even though there was a live temptation to keep polishing a
  convergent finding — see divergence 2 below.

## What didn't go as planned, and why

### 1. An audit finding of a "live ADR violation" was a misread of transient uncommitted state

Mid-audit, a probe of `.claude/settings.json` in the shared checkout showed
the `remember` plugin key `true` and `.remember/` freshly recreated on disk
— read in the moment as a live violation of ADR-0084's explicit decision to
retire that plugin. A follow-up check of `git diff` showed the shared
checkout had an **uncommitted, in-progress** edit (the user manually
uninstalling `remember`, `frontend-design`, and `commit-commands`), and
`HEAD`'s committed `enabledPlugins` block already had `remember: false`
correctly in place. The finding was corrected in the same turn, before it
reached the plan, and the plan's "restore `remember: false`" action item
was dropped entirely once the worktree's own (freshly-cloned-from-`origin/main`)
copy of `settings.json` showed the committed state was already correct.

**Why it happened:** `git log -S` for the string `"remember@claude-plugins-official": true` found only the commits that _added_ the line, not a later commit that flipped it — and the working-tree read happened to land mid-edit on someone else's uncommitted change.

**Fix for future:** When a settings/config file shows something that
contradicts a specific, cited ADR decision, check `git status`/`git diff`
for uncommitted changes in that exact file _before_ concluding the ADR was
violated — a live audit reads the working tree, and the working tree can be
mid-edit.

### 2. Two Should-fix findings from `claude-pr-review.yml` were correctly left unaddressed

After merge-readiness, `resolving-pr-comments` was invoked to process the
bot's verdict. The verdict was PASS with two Should-fix items (an
`isFile()`-equivalent gap in `listAllTranscripts`, and partial-format-drift
invisibility in `countToolUseInTranscript`'s line-parsing loop) — both
real, both actionable. The skill's own Step 3 branch for a PASS verdict
says "nothing blocks merge by definition... stop — do not proceed to
Step 4," and that instruction was followed rather than fixing the findings
anyway on independent judgment.

**Why it happened:** Not a mistake — a deliberate design choice in
`resolving-pr-comments` to prevent unbounded review-fix churn on an
already-passing PR, encountered here for the first time in this session.

**Fix for future:** None needed — this is working as designed. Worth
naming explicitly in a log so a future session invoking the same skill on a
PASS verdict doesn't second-guess the stop and start fixing anyway.

## Lessons learned

- **A repo-specific ADR can override what general research recommends, and
  the audit step is what catches this before it reaches the plan.**
  `/researching-anthropic-guidance` alone would have pointed at OpenTelemetry
  or the Analytics API — both real, Anthropic-documented features. Only the
  repo audit surfaced ADR-0084's prior, explicit rejection of both as a
  scale mismatch for a single-maintainer repo. Always audit the repo's own
  decision record before designing from external guidance alone, even when
  the external guidance is authoritative.
- **Measure the actual data shape before designing the scan, not just the
  data source.** Every existing scan in `bin/session-telemetry.mjs` read
  top-level transcripts only; nothing in the docs or ADRs signaled that
  subagent transcripts even existed as a separate, nested tree. A five-minute
  live probe against real data, before writing a single line of production
  code, found the undercount that shaped the entire design (recursive vs.
  top-level scan).
- **A convergent finding across independent reviewers is confirmed, not
  redundant — fix it once, don't wait for a third opinion.**
  `.claude/rules/subagent-dispatch.md` already states this rule; this task
  is a clean example of it working end-to-end across three separate
  reviewers (two spokes, one CI bot) landing on the same `isFile()` gap.
- **Honor a sanctioned skill's own stop condition even when the instinct is
  to keep polishing.** `resolving-pr-comments`'s PASS-verdict early-stop
  exists specifically to bound review-fix churn; overriding it on a single
  session's judgment call would defeat the reason it was built that way.
- **A worktree-entering session's own transcript can migrate storage
  location mid-session — this broke an assumption in existing, unrelated
  code, discovered only by verifying a live run, not by reading the
  source.** `bin/lib/claude-home.mjs`'s `resolveClaudeProjectDir` assumes
  one project directory is "the one store every worktree shares," resolved
  via `--git-common-dir` — correct for a worktree created and used by a
  _different_ session, but not for a session that calls `EnterWorktree` on
  _itself_: its own transcript relocated to a worktree-specific
  `~/.claude/projects/<cwd-slug>/` partway through, orphaning it from the
  slug `resolveClaudeProjectDir` computes. Left unfixed and recorded in
  `docs/decision-notes/0002` as a separate decision — not folded into this
  PR's scope, since it affects both existing ADR-0084 consumers identically
  and predates this change.
