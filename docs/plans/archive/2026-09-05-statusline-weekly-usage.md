# Per-model weekly-usage statusline widgets

**Status: shipped** — PR 1 [#1030](https://github.com/monte3l/m3l-automation/pull/1030)
(worktree icon), PR 2 `feat/statusline-weekly-usage` (this PR, per-model
weekly-usage widgets).

## Context

Issue #879 broadened `statusline-context-pressure.mjs` to cover every
`ccstatusline` widget reproducible from the statusLine stdin payload, and
deliberately deferred two: a Sonnet/Opus weekly-usage split and a Fable
weekly-usage figure. Both need data the payload does not carry —
`rate_limits.seven_day` is a single aggregate with no per-model breakdown —
and the only place that breakdown exists is Anthropic's undocumented
`/api/oauth/usage` endpoint, which ADR-0080's "no subprocess, no network"
statusline invariant forbids calling on the render path. Issue #889 tracked
designing that.

A second, unrelated request arrived mid-design: the session row's worktree
segment still rendered `wt "name"` while the adjacent branch segment already
used an icon (`🌿 name`) — inconsistent idiom on the same row.

## Approach / Decisions

Three findings changed the issue as filed, each re-derived from source
rather than taken on faith: the "line 2" framing was stale (the statusline
had since become a fixed five-row layout); a gate
(`bin/check-hooks.mjs`'s `FORBIDDEN_STATUSLINE_PATTERNS`) already blocks the
obvious implementation, but only for the two settings-wired statusline
scripts — a separate writer and hook are free to use `fetch`/`spawn`; and the
data source is genuinely undocumented, with no local file or CLI exposing a
per-model split.

**Placement was settled by measurement, not preference.** The user asked
whether putting the widget on the `model` row would hit the same
narrow-terminal bars-dropping problem already observed on the `quota` row.
Simulating `fitRow` against the real row-building functions at 80/100/120/160
columns, with full and lean payloads, showed the `model` row's realistic
floor (`model · effort` ≈ 27 cols, since `thinking`/`fast mode`/`output
style`/`vim` are usually absent) is far more forgiving than `quota`'s
near-constant ~81-col floor (5h/7d/spend windows are almost always all
present) — at 80 columns the new segments fit entirely on `model` while
several already dropped from `quota` at the same width.

**Delivery split into two PRs (ADR-0072):** the cosmetic worktree-icon change
landed first and independently
([#1030](https://github.com/monte3l/m3l-automation/pull/1030)), keeping the
riskier network-dependent design out of a trivial change's review.

**PR 2's design** (full record: `docs/adr/0092-out-of-band-usage-cache.md`)
mirrors the `resolveSliceProgress`/`tmp/slice-progress.json` precedent: a new
`bin/usage-cache.mjs` CLI is the only file that touches the network,
resolving a credential from `CLAUDE_CODE_OAUTH_TOKEN` or
`~/.claude/.credentials.json` (never a CLI flag — ADR-0085's argv-leak
lesson applies even without a spawn boundary) and writing a normalized
snapshot to `tmp/usage-weekly.json`. A new `Stop` hook
(`refresh-usage-cache.mjs`) TTL-gates (15 min) and spawns it detached,
never awaiting the network since `Stop` blocks the UI. The statusline itself
gained `resolveWeeklyUsage`/`formatWeeklyModelSegments` — a bounded
`readFileSync`, nothing more — keeping ADR-0080's invariant intact. The
design is deliberately model-agnostic (renders whatever models the response
reports, sorted by usage) rather than two hard-coded widgets, since that is
also the most durable answer to an undocumented, evolving response shape.

**A live authenticated call during implementation overturned the
pre-verification schema guess.** The real `/api/oauth/usage` response has no
flat top-level `models` array; per-model weekly data lives in a top-level
`limits[]` array shared with session/aggregate entries, identified by
`group === "weekly"` and a non-null `scope.model` object (the `weekly_all`
aggregate shares the same `group` but has `scope: null` and must not be
double-counted as a fake model). `scope.model.id` was observed `null` for a
real model (Fable) even though `display_name` was present, so the normalizer
falls back to a slugified display name. The implementation and ADR-0092 were
corrected to the confirmed shape before the PR was reviewed, rather than
shipping the guess — see the ADR's Decision section for the verified example
payload.

## Outcome

PR 1 (merged, `11dd8712`): `formatWorktreeSegment` renders `🌳 <name>` (blue,
no quotes, minWidth 8→6), matching the branch segment's idiom.

PR 2 (this PR): `bin/usage-cache.mjs` (new, + `bin/tests/usage-cache.test.ts`),
`.claude/hooks/refresh-usage-cache.mjs` (new), `resolveWeeklyUsage`/
`formatWeeklyModelSegments`/`buildModelRow` env-threading in
`statusline-context-pressure.mjs` (+ `bin/tests/statusline-weekly-usage.test.ts`),
`pnpm usage:refresh`, a `Stop`-hook row in `.claude/settings.json`,
`docs/adr/0092-out-of-band-usage-cache.md`, `docs/contributing/hooks-reference.md`
updates (Stop table row, `model` row bullet, colour-legend amendment, a new
out-of-band-cache subsection), and new `bin/statusline-preview.mjs` fixtures.
`pnpm verify` passed clean before push.
