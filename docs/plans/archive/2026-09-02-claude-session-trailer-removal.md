# Strip `Claude-Session` from history and ban it going forward (2026-09-02)

**Status: shipped** (PR #909, PR #910, the direct PR-body sweep, and PR #911)

## Context

Commits in this repo carried an undocumented trailer after `Co-Authored-By:`
— `Claude-Session: https://claude.ai/code/session_…` — injected per-session
by the Claude Code harness itself, not by anything in this repo: the string
appeared in zero tracked files, was documented nowhere, validated by
nothing, and read by no gate (`bin/gen-commit-stats.mjs` keys strictly on
`Co-Authored-By`). Session IDs mapped to contiguous blocks of commits,
confirming per-session injection rather than repo config. Investigated via
direct git/gh archaeology at the user's request; the user then asked for it
"gone from commit history, PR bodies, merge history, anywhere. It's
something that should have never been written and added in the first
place."

An earlier design pass for the history-rewrite mechanics was flagged with a
harness SECURITY WARNING ("blocked by classifier"). Investigation found no
actual repo/GitHub mutation from that pass — but every one of its specific
factual claims was then independently re-verified from scratch before being
trusted for the plan, per `subagent-dispatch.md`'s existing rule. The
re-verification also caught that the plan's own earlier fact-finding had
drifted and was partly wrong (see Outcome).

## Approach / Decisions

- **Three parts, in order:** prevention first (cheap, reversible, stops the
  problem growing while the rest is staged), then the history rewrite
  (destructive, gated on manual GitHub protection changes), then a
  GitHub-side sweep (PR bodies).
- **History:** full rewrite of `main` + force push, rather than accepting
  the trailer in perpetuity or filing a GitHub Support ticket alone.
- **Sequencing:** land the two already-in-flight PRs (#906, #908) first, so
  the rewrite ran against a quiet tree.
- **Enforcement:** auto-strip at `commit-msg`, plus a hard reject if a
  `Claude-*` trailer survives, plus a `pre-push` backstop for `--no-verify`
  — three independent layers rather than one.
- **Ban width:** any `/^Claude-[A-Za-z-]+:/i` trailer, not just
  `Claude-Session:` — future-proof against a new harness-injected key.
- **Committer identity:** rewritten to the real committer
  (`Enrico Lionello <enri3l@monte3l.com>`), not left as GitHub's
  squash-merge bot — required for the re-signed commits to show _Verified_
  on GitHub (the signing key's UID must match the committer email).
- **PR bodies:** stripped the `Claude-Session:` line from every merged PR
  that carried one via direct `gh pr edit`, rather than leaving old PRs
  as-is.
- **GitHub Support GC ticket** for the still-cached old commit objects
  (reachable by direct permalink independent of the rewrite): skipped —
  accepted residual exposure, since nothing links to those SHAs anymore
  after the sweep, and filing it needs the user's own account verification.

## Outcome

- **PR #909** — `FORBIDDEN_TRAILER_PATTERN`, `bin/strip-claude-trailers.mjs`,
  `lint-commit.mjs`'s `validateForbiddenTrailers`, and the
  `bin/check-commit-trailers.mjs` / `bin/lib/commit-trailers.mjs` pre-push
  backstop. 26 new tests, `pnpm verify` clean.
- **The rewrite** — `git filter-branch` over 357 commits (base
  `8296342e..main`, confirmed fully linear — the earlier plan-mode figure of
  353 commits and 158 in-range merges was wrong on both counts: a stale
  local `main` and a whole-repo-vs-in-range merge-count conflation,
  respectively, caught only by re-measuring immediately before executing).
  All seven verification checks passed on the first attempt: zero trailers,
  `Co-Authored-By` byte-stable, all 357 messages match the filter's output
  exactly, all re-signed and GitHub-`verified: true` (sampled), committer
  identity uniformly fixed, tree/topology byte-identical, counts correct.
  Force-pushed after manually disabling, then re-arming, both GitHub
  protection layers — which took two rounds, since disabling
  `non_fast_forward` alone left the push blocked by "require PR" and
  "require status checks" on both layers.
- **PR #910** — remapped the 62 dangling SHA references across 31 files via
  an exact tree-SHA join (357/357 trees in the rewritten range are
  distinct, cross-checked against `filter-branch`'s own
  `--state-branch` map), plus the one live file
  (`docs/logs/2026-09-02-notification-floor.md`) with a real session URL in
  its own content.
- **The PR-body sweep** — 39 merged PRs (38 found in the plan's original
  count, plus PR #909's own body, discovered only when the count was
  re-derived fresh rather than trusted) each had the session URL as the
  literal last line with one blank line before it; stripped mechanically,
  verified 0 remaining across all 676 PRs, comments, and issues.
- **PR #911** — closed the gap the 39-vs-38 discrepancy revealed:
  `creating-prs/SKILL.md` now explicitly forbids a session-link footer in a
  PR body, mirroring the existing `writing-commits/SKILL.md` fix.
- A local-only `git tag` safety net was silently deleted by a routine
  `git pull` mid-close-out (`fetch.pruneTags=true` prunes any local tag
  absent from the remote, pushed or not) — the independently-created
  `git bundle` was unaffected and remained the durable backup.

Full narrative, spoke-incident counts, and the complete "what diverged"
detail: [`docs/logs/2026-09-02-claude-session-trailer-removal.md`](../../logs/2026-09-02-claude-session-trailer-removal.md).
