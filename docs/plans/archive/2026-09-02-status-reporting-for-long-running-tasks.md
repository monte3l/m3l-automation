# Status reporting for long-running tasks (2026-09-02)

**Status: shipped** (PR #890, commit 203cafd7; PR #893, commit a7cca9a7; and
the PR carrying this file)

## Context

An `/auditing` pass on "how the project reports status updates in
long-running tasks" (three parallel `Explore` agents) found the harness has
zero timer-driven mechanisms anywhere in `.claude/` — every hook is
event-driven or user-invoked — and that review-spoke fan-outs had stalled
30–60+ minutes with zero user-visible progress on four recorded occasions
(`docs/logs/2026-07-18-aws-athena.md`, `2026-07-18-aws-s3.md`,
`2026-07-19-subagent-stall-integration.md`, `2026-08-21-core-procedure.md`).
A follow-on `/researching-anthropic-guidance` pass (four agents against the
official-sources allowlist) confirmed Claude Code has no timer-driven hook
event at all, and that Anthropic's own guidance recommends surfacing
intermediate progress to the user rather than withholding it until the end.

Mid-plan-mode, a parallel Claude Code session was found rewriting the exact
statusline hook this plan targeted (`feat/statusline-widgets`, issue #879,
landed as PR #892 mid-session) — the plan was revised in place to build
additively on that work rather than compete with it.

## Approach / Decisions

- **PR #890** — the configuration-only floor, independent of #879:
  `preferredNotifChannel: "terminal_bell"` (built-in desktop notifications
  fire by default only in Ghostty/Kitty/iTerm2, silent on this WSL host) and
  moving `.claude/scheduled_tasks.lock` from a local-only
  `.git/info/exclude` entry into the committed `.gitignore`.
- **PR #893** — an unplanned but directly-related fix discovered while
  closing out #890: `creating-prs` Step 4's hand-composed quality-gate
  command ran `test:coverage` before `pnpm build`, so a scaffold-checker
  test failed on a fresh worktree (`packages/m3l-cli/dist` didn't exist
  yet) — `pnpm verify` already ordered this correctly via a dedicated
  `build-cli-for-gates` step. Propagated the fix to two more live copies of
  the same buggy sequence the review pass found
  (`.github/pull_request_template.md`,
  `.claude/skills/resolving-merge-conflicts/SKILL.md`) — the bug had
  already bitten once before, in `docs/logs/2026-08-28-x9-console-web-skeleton.md`.
- **This PR** — the in-flight-spoke statusline segment, rebased on #892's
  shipped multi-widget dashboard rather than the WIP version originally
  inspected: `track-inflight-spokes.mjs` (`SubagentStart`/`SubagentStop`)
  appends lifecycle records to `tmp/spoke-lifecycle.jsonl`, rotated
  alongside `tmp/session-incidents.jsonl` by the existing
  `rotate-session-incidents.mjs`; `statusline-context-pressure.mjs` gained
  `resolveInflightSpokes`/`formatInflightSpokesSegment`, wired into
  `buildLine3` between the agent and origin-repo segments, color-escalating
  at 15/30 minutes elapsed to match the documented stall pattern. The
  pre-push lane-marker half of the original plan (`lefthook.yml` changes to
  show which of the six parallel gates is still running) was dropped as
  too risky for a shared, high-blast-radius CI-gating file relative to its
  marginal value — spoke stalls are unbounded and the audit's actual worst
  pain point; `pre-push` is already bounded at a documented 2–4 minutes.

## Outcome

The user can now see, at a glance and without asking, how many spokes are
in flight and for how long (an honest elapsed-time readout, not a
watchdog/alarm — matching the Anthropic-guidance research's preference for
passive surfaces over polling), and gets a terminal-bell signal on
permission prompts and idle waits this WSL host was silently missing. Two
pieces of stale doc drift were closed along the way:
`docs/research/harness-refresh.md`'s Outstanding drift #10 (still claiming
`statusLine` "entirely unconfigured" after it had been wired, broadened, and
timer-driven across three PRs) and `docs/contributing/hooks-reference.md`'s
hook-count prose (26-vs-actual, reconciled to 27 hook files / 28 table rows,
with the 28th file, `statusline-context-pressure.mjs`, correctly excluded as
a `statusLine` script rather than a lifecycle hook).

Deliberately out of scope, left open: a stall watchdog (`asyncRewake`-based
alarm) — rejected in favor of the passive segment per the same
push-over-poll guidance; and the pre-push lane-marker segment, which would
need a carefully exit-code-preserving wrapper around all six `lefthook.yml`
`pre-push` commands before it's worth the risk to that shared file.
