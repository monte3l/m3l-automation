# 0003. Why `SessionEnd`, `Notification`, and `PostCompact` stay unwired

- **Date:** 2026-09-07
- **Decider:** repo maintainer

Issue #999 (ROADMAP H6) asked why these three documented hook events remain
unwired here, since `docs/contributing/hooks-reference.md`'s "full documented
event set" section listed them with "no repo-recorded reason for the gap." A
reason already existed for each — just scattered across a hook comment, a
research tracker, and a settings key none of which the doc pointed at:

- **`PostCompact`** — closed as not-actionable during the 2026-09-06 harness
  sweep (`docs/research/harness-refresh.md:78-88`). Its documented output
  schema is only `hookSpecificOutput.{hookEventName, systemMessage?,
terminalSequence?}` — no `additionalContext` field — so it cannot carry a
  handoff re-injection, the one thing a hook at that lifecycle point would be
  for here. The `SessionStart` + `matcher: "compact"` route it would have
  replaced is empirically verified working instead (49 fires, 14 successful
  injections, same sweep).
- **`SessionEnd`** — `.claude/hooks/reinject-compact-handoff.mjs:13-15`
  already records this: Anthropic's docs give `SessionEnd` no guaranteed
  abnormal-termination signal, so handoff recovery after a crash/OOM/Ctrl-C
  was deliberately put on the **read** side (`SessionStart` with
  `compact|resume|startup`) instead of a write-side `SessionEnd` hook that
  might never fire for the case it exists to handle.
- **`Notification`** — already settled by
  `.claude/settings.json:107`'s `preferredNotifChannel: "terminal_bell"`
  (PR #890), a first-class setting rather than a hook. PR #1007 separately
  found its matcher enum unverifiable — four independent doc fetches across
  two sweeps returned four different value lists — which is why
  `check-hooks.mjs`'s `KNOWN_MATCHERS` deliberately leaves it unencoded
  rather than risk a false-positive rejection.

The reusable criterion these three share, so a future lifecycle sweep does not
re-file the same row: an event stays unwired here when its **output schema
cannot carry what the hook would need** (`PostCompact`), when its **delivery
isn't guaranteed for the failure mode the hook would exist to handle**
(`SessionEnd`), or when **an existing first-class setting already does the
job** (`Notification`). "Documented but unused" is not by itself a gap.

Considered and rejected: wiring `SessionEnd` to rotate
`tmp/session-incidents.jsonl` or clear a consumed compact-handoff file. This
repeats the exact failure `.claude/rules/harness-artifacts.md:86-103` already
records from PR #878 (`docs/logs/2026-09-02-session-incidents-counter.md`) — a
state-deleting hook wired to too broad or the wrong lifecycle edge destroyed a
still-in-progress session's own just-recorded data. `SessionEnd`'s uncertain
firing guarantee makes this class of hook riskier here, not safer.

## Links

- Related: issue #999, ADR-0078 (the write/read handoff pair this note's
  `PostCompact`/`SessionEnd` findings both concern), ADR-0080 (scan-cost
  discipline the `SessionEnd`-rotation alternative would have had to respect),
  ADR-0095 (this tier), PR #890, PR #1007,
  `docs/research/harness-refresh.md`, `docs/contributing/hooks-reference.md`,
  `.claude/hooks/reinject-compact-handoff.mjs`,
  `.claude/rules/harness-artifacts.md`
