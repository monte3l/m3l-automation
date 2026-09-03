# 0090. Native `subagentStatusLine` supersedes the JSONL spoke-lifecycle tracker

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** repo maintainer

## Context and problem statement

`track-inflight-spokes.mjs` (`SubagentStart`/`SubagentStop`) and the
`tmp/spoke-lifecycle.jsonl` file it appends to were built 2026-09-02
(`docs/plans/archive/2026-09-02-status-reporting-for-long-running-tasks.md`)
to close a real gap: review-spoke fan-outs had stalled 30–60+ minutes with
zero user-visible progress on four recorded occasions
(`docs/logs/2026-07-18-aws-athena.md`, `2026-07-18-aws-s3.md`,
`2026-07-19-subagent-stall-integration.md`, `2026-08-21-core-procedure.md`).
The fix was a bespoke, passive readout: two hooks appending `start`/`stop`
records to a hand-rolled JSONL file, reduced by
`statusline-context-pressure.mjs`'s `resolveInflightSpokes` into "N spokes ·
oldest NNm," color-escalating past 15/30 minutes elapsed.

That readout shipped, but into the main statusline's own five-row budget
(`~/.claude/plans/the-recently-developed-statusline-cheeky-seal.md`, session-local,
not committed to `docs/plans/` — PR 1 —
`docs/logs/2026-09-03-statusline-redesign.md`) — and PR 1 deliberately left
`resolveInflightSpokes`/`formatInflightSpokesSegment` wired-but-uncalled,
sequencing this migration into its own PR rather than resolving it inline.

Claude Code's own `subagentStatusLine` setting (added to the documented
surface after the tracker was built) renders a **custom row per subagent**,
directly in the agent panel below the prompt — not a rolled-up count on the
hub's own status line. Per `code.claude.com/docs/en/statusline`, it receives
a `columns` field plus a `tasks[]` array carrying `id`, `name`, `type`,
`status`, `description`, `label`, `startTime`, `model`, `effort`,
`contextWindowSize`, `tokenCount`, `tokenSamples`, and `cwd` for every
currently-visible subagent — a strict superset of what the JSONL file could
ever reconstruct (which only ever knew `agentId`, `agentType`, and a start
timestamp). `effort` requires Claude Code v2.1.214+, `model`/
`contextWindowSize` require v2.1.205+; `.claude-code-version` pins 2.1.251,
so both are available unconditionally.

## Decision drivers

- **No bespoke on-disk state where a first-class surface now exists.** A
  hand-rolled JSONL file, two lifecycle hooks, and a `SessionStart` rotation
  step are all state and wiring the harness itself now provides for free.
- **Richer signal, not just a count.** A native per-task row can show live
  `tokenCount`/`contextWindowSize` and `effort` per spoke — data the tracker
  never captured — instead of a single rolled-up "N spokes · oldest NNm" line
  competing for space in the five-row budget PR 1 just fitted to 80 columns.
- **No subprocess, no network** (ADR-0080) carries over unchanged —
  `subagentStatusLine`'s command runs the same way `statusLine`'s does, and
  the new script does neither.
- **Keep the elapsed-time stall-detection thresholds** (15 min warn, 30 min
  high) the retired segment encoded — the four recorded stalls that motivated
  the original tracker are still the reason this visibility exists at all.
- **ADR-0072: land as an independently reviewable PR**, per the 3-PR sequence
  this redesign was split into.

## Considered options

1. **Keep the tracker, also add `subagentStatusLine`.** Rejected: two
   competing sources of the same fact (spoke elapsed time) is exactly the
   duplication ADR-0072/`refactoring.md` warn against, and the JSONL file's
   rotation/lifecycle-hook machinery has no payoff left once a richer native
   source exists.
2. **Drop spoke visibility entirely, keep neither.** Rejected: the four
   recorded stalls this feature exists to catch are still a live risk: this
   session's own `docs/logs/2026-09-02-spoke-inflight-status.md` and
   `docs/contributing/subagent-context-management.md` both document why
   review spokes specifically (read-only, no on-disk journal to resume from)
   need _some_ passive elapsed-time signal.
3. **Migrate to `subagentStatusLine`, retire the tracker in the same
   change** (chosen). Strictly more capability (per-task detail, not a rolled-
   up count), less state (no JSONL file, no rotation step), and lands as its
   own PR per the plan.

## Decision

We chose **option 3**. `.claude/hooks/subagent-statusline.mjs` renders one row
per visible subagent — name, `effort` (when present), a `tokenCount`/
`contextWindowSize` fraction (when both are present), and an elapsed-time
readout colored green under 15 minutes, yellow at 15–30, red past 30 —
matching the retired segment's own thresholds
(`ELAPSED_WARN_THRESHOLD_SEC`/`ELAPSED_HIGH_THRESHOLD_SEC`, formerly
`SPOKE_WARN_THRESHOLD_SEC`/`SPOKE_HIGH_THRESHOLD_SEC` on
`statusline-context-pressure.mjs`). A task missing an `id` or `name` is left
with Claude Code's own default row rendering (`{"id": ..., "content": ...}`
omitted for that task) rather than guessed at.

Retired in the same change: `.claude/hooks/track-inflight-spokes.mjs`,
`tmp/spoke-lifecycle.jsonl` (no longer written or read by anything), the
`SubagentStart`/`SubagentStop` wirings in `.claude/settings.json` that fed it,
`resolveInflightSpokes`/`formatInflightSpokesSegment`/
`SPOKE_WARN_THRESHOLD_SEC`/`SPOKE_HIGH_THRESHOLD_SEC`/`MAX_INFLIGHT_AGE_SEC`/
the `InflightSpoke` typedef on `statusline-context-pressure.mjs` (all
wired-but-uncalled since PR 1, per that PR's own header comment), and the
`spoke-lifecycle.jsonl` rotation step in `rotate-session-incidents.mjs` (the
new surface has no on-disk state of its own to rotate).

`bin/check-hooks.mjs` gained `subagentStatusLine.command` resolution
(mirroring its existing `statusLine.command` handling) in this same change —
not deferred to PR 3 — because a newly-wired-but-unrecognized settings key
would immediately false-positive as a "dead hook?" warning the moment this PR
lands; the two other PR-3-scoped `check:hooks` hardenings (asserting
`type`/`refreshInterval` validity, and asserting neither statusline script
imports a subprocess/network primitive) are unaffected by this PR and remain
PR 3's job.

## Consequences

- **Positive:** per-subagent visibility now shows live token/context pressure
  and effort, not just an elapsed-time count; the main five-row statusline
  drops a row of complexity it had already stopped rendering; no JSONL file,
  rotation step, or lifecycle-hook pair to maintain going forward.
- **Negative / trade-offs:** `subagentStatusLine` renders in the agent panel,
  not the main statusline row — a user relying on the old single-glance "N
  spokes · oldest NNm" summary on the main line now reads it per-row instead.
  The elapsed-time-only fallback for a task whose `startTime` doesn't parse
  (or is absent) silently omits that segment rather than showing a stale
  count, mirroring every other `format*Segment` function's fail-soft
  discipline in this codebase.
- **Semver impact:** none — `.claude/`, `bin/`, and `tmp/` are harness
  tooling, not the published package's public API.

## Links

- Related: [ADR-0080](./0080-host-resource-budgeting.md) (no subprocess, no
  network), [ADR-0072](./0072-reviewable-slice-discipline.md) (the 3-PR
  sequence this migration is PR 2 of)
- Supersedes: the tracker built in
  `docs/plans/archive/2026-09-02-status-reporting-for-long-running-tasks.md`
- Plan of record:
  `~/.claude/plans/the-recently-developed-statusline-cheeky-seal.md`
  (session-local, not committed — Sections 5–6)
- Prior PR: [#916](https://github.com/monte3l/m3l-automation/pull/916) (PR 1,
  the five-row layout rewrite), `docs/logs/2026-09-03-statusline-redesign.md`
