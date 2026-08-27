# 0080. Host resource budgeting for concurrent Claude Code sessions

- **Status:** Accepted
- **Date:** 2026-08-27
- **Deciders:** Enrico Lionello

## Context and problem statement

Running 2+ Claude Code sessions against this repo on a 16 GB Linux machine
reliably took the whole box down, presenting as an unrecoverable freeze
("kernel panic"). An audit (`/auditing`) measured the actual footprint:

| Source                                                                   | Cost                          | Per session?  |
| ------------------------------------------------------------------------ | ----------------------------- | ------------- |
| `claude` process (idle, 1M context, 10 plugins)                          | ~776 MB RSS                   | yes           |
| `m3l` stdio MCP server                                                   | ~86 MB                        | yes           |
| `statusLine` = `npx -y ccstatusline@latest`                              | ~130 MB, respawned every 10 s | yes           |
| One `Edit`/`Write` → 7 PreToolUse + 7 PostToolUse hooks, run in parallel | 14 × ~47 MB ≈ 650 MB burst    | yes           |
| `git push` → `lefthook` `pre-push` (`parallel: true`)                    | 13 concurrent lanes           | yes           |
| Node default heap ceiling, uncapped                                      | 4192 MB _per process_         | every process |

`pre-push` was the peak: `test:coverage` (3 sequential Vitest runs) +
`typecheck` (turbo default concurrency 10 across 19 packages) + `build-exports`
(another 19-package turbo run) + 8 further `check:*` gates — plausibly 30+ Node
processes, each permitted a 4 GB heap, in one session.

Two host facts turned this into a livelock rather than a clean failure:

- **No OOM daemon.** `earlyoom` and `systemd-oomd` were both inactive; swap
  was a 4 GB file at `swappiness=60`, no zram. `vm.panic_on_oom=0` and
  `kernel.panic=0`, so the kernel does not panic on OOM — the box thrashes in
  memory reclaim and stops responding _before_ the OOM killer fires.
- **No memory ceiling anywhere.** No `NODE_OPTIONS`, `ulimit`, or cgroup;
  `user@<uid>.slice` reported `MemoryMax=infinity`.

`docs/logs/2026-08-19-check-test-counts-contention.md` had already named
memory exhaustion as the leading hypothesis for an unrelated flake
("~42 worker processes… memory exhaustion remains the leading hypothesis"),
and `pnpm lint` was already hand-throttled to `--concurrency=2` — neither
observation had been generalised into a documented limit or an active
mitigation.

### What Anthropic's own guidance says

Researched via `/researching-anthropic-guidance` against official
`code.claude.com`/`anthropic.com` sources only:

- `CLAUDE_CODE_TOOL_MEMORY_LIMIT` (Linux/WSL, v2.1.233+) is the
  purpose-built fix: a memory cgroup over a session's Bash-tool subprocesses,
  documented so "one runaway build can't take the memory the rest of the
  session needs." It is latched at first tool use and, on breach, kills the
  offending command with no cap-attribution in the result.
- Hooks matching the same event **run in parallel** (hooks reference,
  verbatim) — confirming the 14-hook burst above is simultaneous, not
  sequential.
- The statusLine docs explicitly warn to "cache slow operations" since the
  script "runs frequently during active sessions" — `refreshInterval` is
  additive to event-driven runs, not a rate limit on them.
- **Anthropic's parallel-session guidance carries no resource caveat.** The
  Claude Code best-practices page and the worktrees guide both recommend
  running multiple sessions in parallel with zero mention of RAM, CPU, or
  machine load; every documented fan-out caveat concerns context window,
  tokens, rate limits, or human review bandwidth. The only stated hardware
  floor anywhere is "4 GB+ RAM" (setup docs) — this repo's own pre-push
  invalidates that floor by itself. **This is a genuine gap in official
  guidance**, so the limits below are derived from measurement on this repo,
  not cited from Anthropic.
- `NODE_OPTIONS=--max-old-space-size` is not officially supported for the
  `claude` binary itself (it is native and does not invoke Node); unresolved
  `anthropics/claude-code` OOM issues confirm this is a known, unfixed gap
  with no maintainer-endorsed client-side memory tuning knob. It remains
  valid, and is used, for this repo's _own_ Node gate subprocesses.

This amends **ADR-0013**, which designed for "multiple `implement-submodule`
pipelines concurrently" with no resource bound — that design goal is real, but
it needs an explicit ceiling: the practical limit on a 16 GB box is
substantially less than ADR-0013 assumed.

## Decision drivers

- Stop the crash without changing TDD semantics — same suites, same gates,
  same order; only _how many run at once_ and _how much heap each may take_
  changes.
- Prefer official Claude Code mechanisms (`CLAUDE_CODE_TOOL_MEMORY_LIMIT`,
  `if:` hook conditions) over ad hoc process wrapping wherever one exists.
- Caps must be **adaptive** (derived from `os.totalmem()`/
  `availableParallelism()`), not a single number baked in for one machine —
  this repo runs on both 24 GB dev boxes and 16 GB target boxes.
- Host-level mitigations (OOM daemon, zram, cgroup ceilings) live outside a
  TypeScript library's normal surface; ship them as an idempotent, opt-in
  script plus a warn-only preflight gate, never as something that silently
  mutates a shared machine.
- Land as several small PRs (ADR-0072), not one large diff.

## Considered options

1. **Do nothing** — rely on developers noticing and manually tuning their own
   machines. Rejected: the failure mode is a full box freeze, discovered only
   after losing unsaved session state; nothing in the repo signals the risk.
2. **Cap the repo's own tooling only** (turbo/vitest concurrency, lefthook
   lane grouping) and leave the host unmanaged. Rejected alone: still leaves
   the host with no OOM daemon and no memory ceiling — a single runaway
   session (not even a second one) can still livelock the box.
3. **Host guardrail + official env caps + repo tooling caps + per-session
   overhead cuts + hook narrowing** (chosen) — every layer identified by the
   audit, each independently landable and independently verifiable.

## Decision

We chose **option 3**, split across five PRs:

1. Host guardrail (earlyoom, zram, sysctl, systemd `MemoryMax`) via an
   idempotent `bin/setup-host-resources.mjs` (dry-run by default) plus a
   warn-only `pnpm check:host-resources` / SessionStart advisory, and
   `CLAUDE_CODE_TOOL_MEMORY_LIMIT` set per-host in `.claude/settings.local.json`
   (gitignored — the value is derived from that host's own RAM and must never
   be committed as one machine's number for every contributor).
   `CLAUDE_CODE_NO_FLICKER=1` is set in the shared, repo-tracked
   `.claude/settings.json` since it has no per-host tradeoff.
2. Repo tooling caps: `turbo.json` concurrency, `vitest` `poolOptions.maxForks`,
   all derived from `availableParallelism()` rather than a hardcoded number.
3. Pre-push restructuring (group cheap `check:*` gates into one lane; the
   three heavy lanes — `test`, `typecheck`, `build-exports` — degrade to
   serial when the host lacks headroom) plus fixing the statusLine's
   `npx -y ...@latest` respawn.
4. `if:` conditions on the 14 `Write|Edit` hooks so each only spawns on the
   file types its own documented scope covers.
5. This ADR, a `CLAUDE.md` gotcha, a `contributing.md` hardware floor, and a
   work log.

We chose **earlyoom** over `systemd-oomd` as the OOM daemon: its
`--avoid`/`--prefer` regex targeting matters on a headless box running
`sshd`/`fail2ban`/`oracle-cloud-agent` alongside Claude Code — a coarse
kill choice is nearly as bad as the freeze it replaces.

## Consequences

- **Positive:** two concurrent sessions on a 16 GB box now degrade (a single
  command killed, reported) instead of livelocking the entire host; the
  practical session ceiling becomes a known, documented number instead of an
  emergent crash.
- **Negative / trade-offs:** `pre-push` wall-clock rises on a resource-constrained
  host when the three heavy lanes fall back to serial; `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
  gives no attribution when it kills a command, so a mysteriously-killed test run
  must be checked against it first (documented in `docs/contributing/host-resources.md`).
- **Semver impact:** none — this is tooling/CI/host configuration, not a
  change to the published package's public API.

## Links

- Related: ADR-0013 (git worktrees for task isolation — amended by this ADR's
  resource ceiling), ADR-0072 (small independently-reviewable PRs), ADR-0078
  (context-budget gate, same "measure, then gate" pattern applied to a
  different resource).
- `docs/contributing/host-resources.md` — the operator runbook.
- `docs/logs/2026-08-27-parallel-session-oom.md` — the audit measurements.
- `docs/logs/2026-08-19-check-test-counts-contention.md` — the earlier,
  unresolved memory-exhaustion hypothesis this ADR confirms.
