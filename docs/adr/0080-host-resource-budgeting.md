# 0080. Host resource budgeting for concurrent Claude Code sessions

- **Status:** Accepted
- **Relations:** amends: 0013
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

## Update 2026-09-01 — `lefthook-local.yml` is provisioned into new worktrees

Decision 3's serial-`pre-push` fallback is delivered as a gitignored
`lefthook-local.yml` written by `bin/setup-host-resources.mjs --apply`. Because
it is gitignored, a worktree created by `pnpm worktree:new` did **not** receive
it — the new checkout silently inherited lefthook's parallel default, which is
exactly the configuration this ADR exists to prevent. It was not theoretical:
a worktree provisioned this way lost two pushes to an ESLint heap OOM (exit 134) before the missing file was noticed.

`lefthook-local.yml` therefore joins `.worktreeinclude`, whose literal entries
`bin/worktree-setup.mjs` already copies from the main checkout. Notes on that
choice:

- It is copied, not regenerated. Re-running `setup-host-resources.mjs --apply`
  per worktree would be more principled, but `--apply` shells out to `sudo` for
  its systemd and earlyoom steps — prompting for a password on every
  `worktree:new` is a worse failure mode than a copied file.
- On a host with ≥20 GiB RAM the file does not exist, so the copy is skipped
  silently and `check:worktree` emits the same benign "absent from the main
  checkout" warning it already emits for `.env` and `.env.local`.
- `.claude/hooks/guard-worktree-ready.mjs` warns at SessionStart when a
  `.worktreeinclude` literal present in main is missing locally, so a worktree
  created _before_ this change is flagged rather than left silently
  under-provisioned.

## Update 2026-09-08 — earlyoom's `--prefer` matched the wrong process names

Re-deriving this ADR's `earlyoom` config against a live host (rather than
trusting that "applied" means "working") found two defects in the tuning
decided above, both in `buildEarlyoomOverride()`
(`bin/setup-host-resources.mjs`):

1. **`--prefer`/`--avoid` match `/proc/PID/comm`, not argv** (`man earlyoom`:
   `EARLYOOM_NAME` is "Process name truncated to 16 bytes, as reported in
   /proc/PID/comm"). The original `--prefer '^(node|claude|vitest|tsc|esbuild)$'`
   was written as if it matched the command line. In fact Node's main thread
   always reports comm `MainThread` (a worker thread reports
   `node-MainThread`) regardless of the script it runs — confirmed live
   against eslint, vitest, tsc, and this repo's own `bin/mcp-server.mjs`, all
   presenting as `MainThread`. So the literal token `node` never matched any
   real Node process, and `vitest`/`tsc` never matched either. Meanwhile
   `claude` — the Claude Code CLI binary's own comm — DID match, which meant
   the guard was **inverted relative to its intent**: it boosted the
   interactive session's own OOM kill-priority (+300 `oom_score`) while
   leaving every actual toolchain process invisible to `--prefer`. Fixed to
   `^(MainThread|node-MainThread|esbuild)$` — `claude` removed, `node`/
   `vitest`/`tsc` replaced with the comm values Node actually presents.
   Removing `claude` from `--prefer` only returns it to neutral kill
   priority, though — a pre-merge review round correctly pointed out that
   _protecting_ the session means adding it to `EARLYOOM_AVOID`
   (`^(sshd|systemd|tmux|sudo|dbus-daemon|claude)$`) as well, which the
   final version of this fix does. `--prefer` remains coarse (a heavy
   toolchain process and a long-lived Node service like
   `bin/mcp-server.mjs` both present as `MainThread`, so it cannot
   distinguish them) — a cgroup-scoped guard would be the precise fix if
   this proves insufficient in practice.
2. **The `-s` (free-swap floor) argument was left at earlyoom's own default
   of 10**, uncalibrated against the swap this same script provisions in the
   same run (zram at ~50% of RAM). earlyoom only acts once **both** the
   memory and swap floors are breached (`man earlyoom`) — pairing `-s 10`
   with ~50%-of-RAM zram means roughly 90% of that provisioned swap must be
   exhausted, on top of memory already being critically low, before the
   guard is permitted to fire — well past the point a heavy fan-out has
   already made the host unresponsive, the exact livelock this ADR exists to
   prevent. Raised to `-s 50`, so the swap condition is satisfied once
   roughly half the provisioned cushion is spent, without loosening the `-m
5` memory floor.

Both defects were reliability regressions in an already-shipped safety net,
not new tuning — the fix ships alone, ahead of any further concurrency work
against this host, since raising concurrency on top of a broken OOM guard
compounds the wrong risk first.

## Update 2026-09-08 — `lint:workspace` crashes on ARM64 (different mechanism, discovered alongside the above)

While verifying the earlyoom fix, `pnpm verify` failed at `lint:workspace`
with `FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript
heap out of memory` (exit 134) — reproducible alone on an otherwise idle box
(19 GB of 23 GB free, zero memory PSI), so not the contention this ADR
addresses. This is a **different mechanism** from everything above: it is
Node's own **per-process V8 heap ceiling**, not host memory pressure. This
ADR's original measurements already recorded "Node default heap 4192 MB per
process, uncapped" as a fact about the host, but framed it only as a
livelock contributor (many uncapped processes competing for real RAM); it
did not anticipate a **single** process crashing against its own default
ceiling independent of how much system RAM sits idle. Measured directly on
this host: `require("v8").getHeapStatistics().heap_size_limit` = 4288 MB,
regardless of `totalmem()` = 23.4 GB — the default does not scale with
system memory the way this ADR's other mitigations (percentages of
`availableParallelism()`/`totalmem()`) do.

CI's identical `lint-workspace` job runs on `ubuntu-latest` (x86_64) and had
not hit this, which is why it shipped unnoticed until run on ARM64 — whether
that is a smaller true memory footprint on x86_64 or a difference in that
platform's default ceiling was not investigated; either way, raising the
ceiling has no downside on a passing host, since it only removes headroom
that wasn't in use.

Fixed narrowly: `lint:workspace`'s script gained
`NODE_OPTIONS=--max-old-space-size=8192` (`package.json`). `lint:library`
(the `packages/m3l-common`-only pass) was confirmed **not** to cross the
default ceiling on its own and was left unchanged — the fix is scoped to
the demonstrated failure, not applied blanket.

**Known limitation, flagged by review rather than resolved here:** the
`8192` figure is a fixed constant, the same category of problem this ADR's
own `50%` concurrency caps already are. Measured peak RSS at that ceiling
is ~5.7 GiB — on the documented 16 GiB/`--sessions=2` floor,
`recommendToolMemoryLimitGiB` derives a 6 GiB `CLAUDE_CODE_TOOL_MEMORY_LIMIT`,
leaving thin margin before a local run risks a silent cgroup kill instead of
the loud crash this fix replaces. Deriving `NODE_OPTIONS` from the same
per-host budget is exactly what this wave's remaining slices (see
`docs/plans/2026-09-08-adaptive-host-budgeting.md`) intend to generalize,
rather than special-casing this one script now.
