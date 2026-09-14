# Promote work-log insights — sweep of the 60-log backlog

**Status: shipped** — two PRs: #1257 (promotions + hook + provenance stamps)
and #1262 (the `docs/research/retrospective.md` ledger update). `.claude/skills`,
`.claude/agents`, `.claude/rules`, and a new `.claude/hooks` guard all changed,
so this plan clears the archival bar even though no ADR is ratified.

## Context

`check:retrospective` warned at 60 unswept logs (215 in `docs/logs`, 155
recorded) — twelve times the 5-log cadence. `/writing-work-logs` Step 4 only
ever promotes an insight from the single log in front of it, so anything that
looked "too specific" at write time and then recurred had been sitting in the
corpus unpromoted. This run read the whole backlog (2026-09-06 → 2026-09-13)
plus the auto-memory store and `pnpm telemetry:sessions`, promoted what
recurred, stamped the source logs, and recorded an outcome row for every log
read — the rejects included, since a missing row is indistinguishable from an
unread log.

## Approach / Decisions

Four decisions were confirmed with the user before implementation: the new
double-backgrounding guard lands as a PreToolUse hook (not a rules-only fix);
the telemetry-derived spoke-decomposition finding lands in `code-implementer.md`;
all seven filtered candidates are promoted, not a subset; and the work splits
into two PRs — promotions first, the tracker ledger second — per ADR-0072's
docs-vs-code split.

**PR #1257** landed seven themes: a new PreToolUse/`Bash` hook
(`.claude/hooks/guard-double-background.mjs`, blocking `run_in_background:
true` paired with a shell-level detach — 9 logs hit this independently, twice
producing duplicate concurrent `git push`es); `starting-work/SKILL.md`'s
`--fix` flag guidance for `pnpm worktree:new`; `creating-prs/SKILL.md` Step 7
dispatching `code-reviewer` alongside `docs-consistency-reviewer` for a
`bin/**`/`.claude/hooks/**`/`.claude/workflows/**` diff with no `src/**`;
`resolving-pr-comments/SKILL.md` gaining a merge-mid-fix-pass recovery
procedure and "a finding naming one file is a sample of a class" guidance;
`code-reviewer.md` flagging prose restating a constant/cardinality/census as
drift-prone; `refactoring.md` gaining "moving code out from under a test can
leave it vacuous"; and `code-implementer.md` citing 2026-09-14 telemetry
(4.58M tokens/call vs. every sibling spoke's <3M, 5 of 10 >100k-token
prompt-cache breaks in the window) as evidence to decompose a dispatch before,
not during.

The new hook went through two review-driven fixes: a pre-push `code-reviewer`
catch (`&>`/`&>>` combined-redirect shorthand misread as a detach construct)
and a post-push `claude-pr-review` Should-fix (quoting-unaware `nohup`/
`disown`/bare-`&` detection false-positiving on ordinary argument text like
`grep -n nohup docs/logs/*.md` or a URL's `&page=2`). Both were verified live
before fixing, per `subagent-dispatch.md`'s "the executor wins" rule, and both
grew the test suite (24 → 28 → 33 tests).

**PR #1262** recorded the outcome of all 60 logs read: 39 promoted (23 stamped
directly by PR #1257, the rest pre-existing single-log promotions this
tracker had never recorded), 16 no-durable-insight, 5 deferred — several
carrying their own in-log rationale (a fix that belongs in a different
issue's resolution, a candidate held back only for `subagent-dispatch.md`'s
remaining context-budget headroom, an eval-coverage floor needing new content
rather than an edit this pass). Two logs narrating the same 40-turn-limit
symptom the telemetry-derived `code-implementer.md` promotion cites as
corroboration were recorded by their own insights' merits rather than
stamped, since neither log's own prescribed fix is the promoted text. A
pre-push `docs-consistency-reviewer` Should-fix (the Outcomes table's
`promoted` definition not naming `.claude/hooks/` as a valid target) was
applied before push.

## Outcome

- **Header:** `docs/research/retrospective.md` now reads
  `last-swept=2026-09-14 logs-considered=215`; totals 156 promoted, 46
  no-durable-insight, 13 deferred, 0 not-yet-swept.
- **New enforced behavior:** `.claude/hooks/guard-double-background.mjs`,
  33 tests, wired into the PreToolUse/`Bash` chain; `docs/contributing/hooks-reference.md`
  gained its row and corrected its self-describing hook/row counts.
- **23 source logs** stamped `_(promoted → <path>)_` for the seven PR #1257
  themes.
- **Not fixed here:** `pnpm telemetry:sessions`'s session-naming compliance
  sub-scan reports zero agent-name/ai-title records across 6 transcripts in
  30 days — filed as a GitHub issue rather than fixed in this change set.
- Narrative: `docs/logs/2026-09-14-promote-log-insights.md`.
