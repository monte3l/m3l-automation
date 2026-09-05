# Work log — `work-log-scope` (2026-09-05)

Reconciled the four-way drift over which merges get a `docs/logs/` work log
(GitHub issue #996, ROADMAP row H3). Re-derived the issue's own premise
before acting on it, found it inverted, broadened the canonical source
(`docs/logs/README.md`) to match actual practice, and pointed the other
three drifted sites at it instead of independently correcting each.

Plan of record: [`docs/plans/archive/2026-09-05-work-log-scope.md`](../plans/archive/2026-09-05-work-log-scope.md)

## Summary

Issue #996 reported `docs/logs/README.md` as pipeline-scoped
("chore/docs/CI PRs deliberately do not" get a log) contradicting
`finishing-work` Step 6's unfiltered prompt. Measuring `git log
--diff-filter=A` across `docs/logs/*.md` found 82 of 150 logs were added by
non-pipeline commits (78 `docs:`, 3 `chore:`, 1 `ci:`) — the README was the
stale side, not `finishing-work`. Two more sites carried their own,
third/fourth framings (`skill-routing.md`: "a significant task";
`agent-operating-model.md`: "per-submodule work logs").

Files changed (PR #1045, squash-merged as `734c2764`):

- `docs/logs/README.md` — pipeline-scoped rule replaced with a substance
  test (a real narrative vs. a mechanical change)
- `.claude/skills/finishing-work/SKILL.md` — Step 6 cites the README and
  skips silently on a mechanical merge; Step 9's report line gained
  `n/a (out of scope)`
- `.claude/skills/writing-work-logs/SKILL.md` — one-line pointer to the
  same source of truth
- `docs/contributing/skill-routing.md`, `docs/contributing/agent-operating-model.md`
  — both now link to `docs/logs/README.md` instead of restating a criterion
- `docs/plans/archive/2026-09-05-work-log-scope.md` + `docs/plans/README.md`
  — archived plan-mode narrative (two `.claude/skills` files changed, clears
  the archival bar)
- `docs/ROADMAP.md` — H3 flipped to `Done`, `pnpm sync:hub -- --apply` run

No `src/`, test, or `exports`-map changes; zero semver impact. `pnpm verify`
passed (59 steps, 10 skipped push-only). `pnpm sync:docs` produced no
working-tree changes (no exports/scripts touched).

Skills used: starting-work, writing-commits, creating-prs, syncing-docs
(via creating-prs Step 5), finishing-work, writing-work-logs.

Spoke incidents: none — one `Explore` agent (initial doc discovery) and one
`docs-consistency-reviewer` dispatch, both converged cleanly on first pass.

Compaction events: none.

## What went as planned

- **Re-deriving the premise caught an inverted issue before any wrong fix
  shipped.** The issue's literal ask ("add a filter to `finishing-work`")
  would have retroactively put ~82 existing logs out of policy and
  suppressed exactly the governance-work logs the backlog keeps producing.
  Measuring `git log --diff-filter=A` against `docs/logs/*.md` before
  touching anything surfaced this in one command.
- **Confirming direction with the user before writing code.** Four
  `AskUserQuestion` decisions (which side gives, where the criterion lives,
  whether to fix all four sites, whether to backfill the stale index) were
  settled in plan mode, so the actual edit pass had no open questions.
- **`pnpm verify` and the full `creating-prs` gate sequence passed clean on
  the first run** — no lint/format/typecheck fixups needed after the five
  content edits.
- **`docs-consistency-reviewer` returned zero findings** — the link-back
  pattern (one canonical statement, three pointers) left no drifted wording
  for it to catch.
- **Auto-merge was the correct call for this PR.** It took the
  `docs-consistency-reviewer` path (no `src/**`), matching the exact case
  `creating-prs` Step 15 names as safe for `--auto --squash`, and merged
  without a race.

## What didn't go as planned, and why

### 1. `Edit`'s exact-match failed on two markdown table rows despite visually identical text

Editing `docs/plans/README.md` (Step 6 archival row) and initially
`docs/ROADMAP.md` (H3 tracker flip) with the `Edit` tool reported "String to
replace not found in file" against `old_string` values that were byte-for-byte
copies of a prior `Read`'s output. Re-reading and re-copying didn't help.
Falling back to a small Python script (read file, locate a short unique
anchor substring, splice the replacement text in directly) worked immediately
in both cases.

**Why it happened:** Unclear — no non-ASCII discrepancy was found on
inspection (`od -c`, `repr()` comparisons showed the anchor line matching).
The most likely explanation is a stale in-context copy of the file (from an
earlier `Read` several tool calls back) that no longer matched the current
on-disk bytes after an intervening `prettier --write` reformatted the table,
even though the diff `git diff` showed looked cosmetically identical.

**Fix for future:** When `Edit` reports a non-match against text that looks
identical to a recent `Read`, don't retry the same `old_string` — re-`Read`
the file immediately before the next attempt, or fall back directly to a
Python/sed splice keyed on a short, unique anchor substring rather than the
full line. This avoided a second wasted round-trip on the ROADMAP.md edit.

## Lessons learned

- **Re-derive an issue's premise before implementing its literal ask.**
  `CLAUDE.md`'s Task Workflow rule ("re-derive any authored claim you're
  about to act on") caught a case where the issue's own diagnosis was
  backwards — a single `git log --diff-filter=A` measurement against the
  affected directory was enough to invert the fix direction before any code
  changed.
- **Fix drift by removing the second copy, not reconciling every copy.**
  Four independently-worded scope statements existed because there were four
  places a scope statement _could_ be restated. Pointing three of them at
  the fourth (rather than editing all four to matching prose) removes the
  drift surface itself — the same shape as PR #1020's commit-timing fix.
- **A stale in-context file copy can survive several tool calls without any
  visible sign.** After a `prettier --write` reformats a file this session
  already `Read`, a later `Edit` against that earlier-read content can fail
  silently-looking (`Edit`'s error gives no diff), even when the two strings
  look identical on screen. Re-`Read` before retrying, don't just re-paste.
