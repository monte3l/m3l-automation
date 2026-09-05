# 0092. Out-of-band usage cache for the statusline's first network dependency

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** repo maintainer

## Context and problem statement

Issue #879 broadened `statusline-context-pressure.mjs` to cover every
`ccstatusline` widget reproducible from the statusLine stdin payload, and
deliberately deferred two: a per-model (Sonnet/Opus) weekly-usage split and a
Fable weekly-usage figure. Both need data the payload does not carry —
`rate_limits.seven_day` is a single aggregate percentage with no per-model
breakdown — and the only place that breakdown exists is Anthropic's
undocumented `/api/oauth/usage` endpoint (the same one `ccstatusline` itself
reads, with an `anthropic-beta: oauth-2025-04-20` header and the account's
OAuth token). Issue #889 tracked designing that.

ADR-0080 fixed a hard invariant on the statusline script itself: **no
subprocess, no network** — it runs on every new assistant message (debounced
300ms), so a network call or child-process spawn on that path would add
latency to the harness's single most frequent hook trigger and risks
reintroducing the resource-pressure incident ADR-0080 records.
`bin/check-hooks.mjs`'s `FORBIDDEN_STATUSLINE_PATTERNS` scan enforces this by
grepping the wired `statusLine`/`subagentStatusLine` scripts for
`fetch(`/`spawn(`/`exec*(`/`node:child_process`/`node:http(s)` — but that scan
is scoped to exactly those two settings keys (`STATUSLINE_SETTINGS_KEYS`), not
every file in `.claude/hooks/`. A separate writer script and a separate
lifecycle hook are free to use all of them.

The `resolveSliceProgress`/`tmp/slice-progress.json` mechanism
(ADR-0072's 2026-09-04 amendment) already established the pattern this ADR
reuses: a small CLI writes a JSON snapshot to `tmp/`, and the statusline reads
it with a bounded, injected `readFileSync` — no network, no subprocess, on the
render path itself.

## Decision drivers

- **ADR-0080's invariant is non-negotiable on the render path.** Any design
  that puts a `fetch` or `spawn` inside `statusline-context-pressure.mjs`
  itself is out, full stop.
- **The endpoint is undocumented.** No published contract for `/api/oauth/usage`
  exists, and even a shape confirmed by one live call today carries no
  guarantee against tomorrow — the normalizer must degrade to "segment
  absent" rather than "hook crashes" the moment reality disagrees with what
  was last observed.
- **Model-agnostic, not two hard-coded widgets.** #889 names Sonnet/Opus and
  Fable specifically, but hard-coding those names is also the least durable
  answer to an undocumented, evolving response — rendering whatever models the
  response actually reports (sorted by usage) survives a new model appearing
  with zero code change.
- **ADR-0085's secrets-via-argv lesson applies even without a spawn
  boundary.** A token living in process argv is readable from any local
  account via `/proc/<pid>/cmdline` for the process's lifetime regardless of
  who reads it — so the credential must come from an env var or a file, never
  a CLI flag, even though this script isn't itself a spawned child receiving
  secrets from a parent.
- **Fail-soft, not fail-loud, at every stage.** A missing credential, a
  non-200 response, a timeout, or an unparseable body must each leave the
  system exactly as if the feature didn't exist — a missing widget, never a
  broken statusline or a blocking session-end hook.

## Considered options

1. **Call the endpoint synchronously from the statusline script.** Rejected
   outright — violates ADR-0080's invariant on the harness's hottest render
   path.
2. **Call it from a different, already-existing hook (e.g. `PreToolUse`).**
   Rejected: none of the existing hook trigger points are appropriately rare —
   `PreToolUse`/`PostToolUse` fire per tool call, far more often than a
   15-minute-scale refresh needs, and coupling an unrelated hook's purpose to
   this fetch obscures both.
3. **A dedicated `bin/usage-cache.mjs` writer, refreshed by a TTL-gated `Stop`
   hook, read by the statusline via a bounded local file read** (chosen).
   Mirrors the `slice-progress` precedent exactly: the network/subprocess
   surface lives entirely outside the statusline script, `Stop` fires once per
   turn (a natural, infrequent cadence) rather than per tool call, and the
   statusline's own contract — pure `readFileSync`, no I/O side effects —
   stays unchanged in kind, only in which `tmp/*.json` file it reads.

## Decision

We chose **option 3**. Three pieces:

- **`bin/usage-cache.mjs`** (`pnpm usage:refresh`) — the only file in this
  design that touches the network. Resolves a credential from
  `CLAUDE_CODE_OAUTH_TOKEN` or `~/.claude/.credentials.json`
  (`claudeAiOauth.accessToken`), fetches `/api/oauth/usage`, and normalizes
  the response into `tmp/usage-weekly.json`:
  `{ fetched_at: <epoch seconds>, models: [{ id, display_name,
used_percentage, resets_at }, ...] }`.

  The real response shape was confirmed with a live authenticated call during
  this PR's implementation (2026-09-05), and it does **not** match the
  reasonable pre-verification guess this design started from (a flat
  top-level `models` array). The actual per-model weekly data lives inside a
  top-level `limits[]` array shared with session/aggregate entries:

  ```json
  "limits": [
    { "kind": "session", "group": "session", "percent": 64, "scope": null, ... },
    { "kind": "weekly_all", "group": "weekly", "percent": 7, "scope": null, ... },
    { "kind": "weekly_scoped", "group": "weekly", "percent": 0,
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
      "resets_at": null, ... }
  ]
  ```

  A per-model entry is a `limits[]` element with `group === "weekly"` **and**
  a non-null `scope.model` object — this is what distinguishes it from the
  `weekly_all` aggregate (same `group`, `scope: null`), which must not be
  double-counted as a fake model. `scope.model.id` was observed `null` for a
  real model (Fable) even though `display_name` was present, so `id` falls
  back to a slugified `display_name` when no id-shaped field exists.
  `normalizeModelEntry` keeps its field-spelling flexibility
  (`percent`/`used_percentage`/`utilization` for the usage figure, several
  id/name-shaped fallbacks) as defensive slack for a future response
  revision, not because today's fields are themselves ambiguous — today's
  shape is now known, not guessed. No credential, a non-200 response, a
  timeout, or an unparseable body all leave any existing cache file
  untouched. The credential is never accepted as a CLI flag.

- **`.claude/hooks/refresh-usage-cache.mjs`** (`Stop` hook) — one `statSync`
  on the cache file; if younger than a 15-minute TTL, exits immediately
  (~20ms). Otherwise spawns `bin/usage-cache.mjs` **detached**
  (`stdio: "ignore"`, `unref()`) and exits without waiting — `Stop` blocks the
  UI, so this hook must never await the network. Free to use
  `node:child_process`: `FORBIDDEN_STATUSLINE_PATTERNS` never scans this file.
- **`statusline-context-pressure.mjs`** — `resolveWeeklyUsage(readFile,
startDir, now)`, modeled directly on `resolveSliceProgress`: reads
  `tmp/usage-weekly.json` via the injected reader, `JSON.parse` in try/catch
  → null. A cache older than 24 hours is treated as absent (a day-old weekly
  figure misleads more than a missing one); 2–24 hours old is kept but
  flagged `stale`, which `formatWeeklyModelSegments` renders as a trailing dim
  `(<age> old)` segment. The segments land on the `model` row, not `quota` —
  measured, not assumed: at 80 columns the `model` row's realistic floor
  (`model · effort` ≈ 27 columns, since `thinking`/`fast mode`/`output
style`/`vim` are usually absent) leaves far more room than `quota`'s
  near-constant ~81-column floor (5h/7d/spend windows are almost always all
  present), and simulating `fitRow` confirmed every new segment fits on
  `model` at 80 columns while several already drop on `quota` at the same
  width.

## Consequences

- **Positive:** the two widgets #879 deferred now render, without weakening
  ADR-0080's invariant — the statusline script itself still does zero network
  I/O and zero subprocess spawning. The model-agnostic design means a new
  model appearing in the response needs no code change. Every failure mode
  (no credential, network down, malformed/stale/absent cache, a future
  response-shape change) degrades to "segment(s) absent," never a broken
  statusline or a blocked session end.
- **Negative / trade-offs:** this is the harness's first network dependency,
  against an endpoint with no published contract — it can change shape or
  disappear without notice at any point after this ADR, even though the
  shape it targets today was confirmed by a live call during implementation
  (see the Decision section) rather than left as an untested guess. A future
  drift is expected to surface as empty segments, per the fail-soft design,
  not a crash. A per-model weekly figure can be up to 15
  minutes plus the fetch's own latency stale relative to the account's actual
  usage. Rollback is a single-line revert: delete the `Stop`-hook entry in
  `.claude/settings.json`; the statusline's `resolveWeeklyUsage` then always
  reads an aging, eventually-absent cache and the segments self-disable with
  no further code change.
- **Semver impact:** none — `.claude/`, `bin/`, and `tmp/` are harness
  tooling, not the published package's public API.

## Links

- Related: [ADR-0080](./0080-host-resource-budgeting.md) (no subprocess, no
  network — the invariant this design preserves rather than weakens),
  [ADR-0085](./0085-cli-secret-delivery-via-spawn-env.md) (argv is not a safe
  place for a credential), [ADR-0072](./0072-reviewable-slice-discipline.md)
  (`resolveSliceProgress`/`tmp/slice-progress.json`, the precedent this design
  mirrors; also the 2-PR split issue #889 landed under — PR 1 was the
  session-row worktree icon, cosmetic and unrelated to this network-touching
  design)
- Originating issue: [#889](https://github.com/monte3l/m3l-automation/issues/889),
  deferred from [#879](https://github.com/monte3l/m3l-automation/issues/879)
