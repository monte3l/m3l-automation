# Weekly-usage cache moved account-scoped, ADR-0092 claim corrected

**Status: shipped** — PR 1 `fix/weekly-usage-cache` (this PR). PR 2 of the
2-PR follow-up fixes `feat/slice-progress-tracking`'s never-rendering slice
segment (a separate, unrelated defect in a different shipped feature).

## Context

The user reported that what shipped with #1025 (slice-progress) and #1035
(per-model weekly usage) "doesn't get reliably shown": the weekly-usage
segment disappeared and reappeared unpredictably, and rendered `Fable` only,
never Sonnet or Opus. This PR is the weekly-usage half of the investigation.

Two independent, confirmed causes:

1. **Cache-anchor mismatch.** The `Stop` hook (`refresh-usage-cache.mjs`)
   resolved `tmp/usage-weekly.json` against `CLAUDE_PROJECT_DIR`; the
   statusline reader (`resolveWeeklyUsage`) resolved the same relative path
   against `payload.workspace.current_dir`, with no upward walk. The two
   diverge the moment a session enters a worktree in-session
   (`EnterWorktree`, ADR-0013/0014) or `cd`s into a subdirectory —
   `CLAUDE_PROJECT_DIR` stays pinned to the original checkout. Live evidence:
   only the main checkout had a `tmp/usage-weekly.json`; none of six linked
   worktrees did, though sessions had run in them since #1035 merged.
2. **No Sonnet/Opus split exists in the data.** A fresh authenticated
   `GET /api/oauth/usage` returned `seven_day_opus: null`,
   `seven_day_sonnet: null`, and exactly one `weekly`-grouped,
   model-scoped `limits[]` entry — a Fable premium-model cap. ADR-0092's
   Context section claimed the endpoint carries a per-model breakdown; its
   own Decision section already contradicted that, and the live call
   settled it. The widget was faithfully rendering an endpoint that does not
   carry what issue #889 asked for on this account.

## Approach / Decisions

- **Move the cache account-wide, not repo-relative.** Weekly usage is
  account-global, not project data, so it has no business living under any
  repo's `tmp/`. Both the writer (`bin/usage-cache.mjs`) and the reader
  (`statusline-context-pressure.mjs`) now resolve one absolute path —
  `resolveUsageCachePath(homeDir)` → `~/.claude/m3l-usage-weekly.json` —
  duplicated between the two files rather than imported, matching the
  existing `sanitizeDisplayText` no-bin-dependency convention. Verified live:
  rendering from an arbitrary `/tmp` subdirectory and from an unrelated
  linked worktree both now show the cached widget correctly.
- **Wire the dormant integration point rather than hard-coding "no split."**
  `extractModelCandidates` now also reads `seven_day_opus`/`seven_day_sonnet`
  — the fields that would carry a real split, matching `five_hour`/
  `seven_day`'s own shape. Both are `null` today, so no visible behavior
  changes, but the split renders automatically the moment either field
  becomes non-null upstream, with zero further code change here.
- **Correct the ADR rather than silently reshape it.** Amended ADR-0092 with
  the confirmed 2026-09-05 response and an explicit statement that a
  Sonnet/Opus split is not available on this account today — issue #889's
  original framing is unsatisfiable as written until that changes upstream.
- **Two-PR split, per ADR-0072.** The weekly-usage fix and the
  slice-progress fix are independent defects in independent shipped
  features; each lands and reviews on its own.

## Outcome

`bin/lib/staleness-scan.mjs`'s `LIVE_TMP_FILES` allowlist and
`finishing-work`'s live-state list both drop the now-obsolete
`tmp/usage-weekly.json` entry. New test coverage: `resolveUsageCachePath` in
both files, the `seven_day_opus`/`seven_day_sonnet` integration point
(composed against the live `limits[]` shape), and a regression test proving
`resolveWeeklyUsage` makes no residual workspace-relative assumption. No
`src/`, test-fixture, or exports-map changes to the published package; zero
semver impact. `pnpm verify`: 62 steps passed, 10 skipped.
