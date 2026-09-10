# Host resources for concurrent Claude Code sessions

Rationale, measurements, and the decision record live in
[ADR-0080](../adr/0080-host-resource-budgeting.md). This page is the operator
runbook — what to run, and what each mitigation does.

## Why this exists

Running 2+ Claude Code sessions against this repo on a memory-constrained
Linux box (16 GB is the documented floor below) can exhaust memory faster than
the kernel's own OOM killer reacts, presenting as a full host freeze rather
than a clean process kill. `git push` alone fans out to 13 parallel
`lefthook` lanes — `test:coverage`, `turbo run typecheck`/`build` across 19
workspace packages, and 8 further `check:*` gates — plausibly 30+ Node
processes in one session, none of them heap-capped by default.

## Quick start

```bash
pnpm check:host-resources          # see what's missing (never mutates anything)
node bin/setup-host-resources.mjs  # dry-run: prints exactly what would change
node bin/setup-host-resources.mjs --apply   # apply (uses sudo; review the dry-run first)
```

`bin/setup-host-resources.mjs` is idempotent — safe to re-run after a fresh
`apt` upgrade or on a new machine. It never weakens a stricter setting it
finds already in place. A SessionStart hook (`warn-host-resources.mjs`) runs
`check:host-resources` automatically once per session and prints any gaps to
the transcript.

## What gets set up

| Mitigation                                                      | What it does                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earlyoom`                                                      | Kills a runaway process on memory pressure, tuned `-m 5 -s 50 --avoid '^(sshd\|systemd\|tmux\|sudo\|dbus-daemon\|claude)$'` `--prefer '^(MainThread\|node-MainThread\|esbuild)$'`                                                                                                                               | Neither `earlyoom` nor `systemd-oomd` is installed/active by default on a plain Ubuntu box, and `vm.panic_on_oom=0` — without a daemon, memory pressure livelocks the box _before_ the kernel OOM killer would ever fire. `--avoid`/`--prefer` match `/proc/PID/comm`, not argv (`man earlyoom`) — Node's main thread always reports `MainThread` regardless of script, so `node`/`vitest`/`tsc` never matched anything, while `claude` (the Claude Code binary's own comm) DID match `--prefer`, inadvertently boosting the interactive session's own kill-priority instead of the toolchain fan-out; it now sits in `--avoid` instead, so the session is actually protected rather than merely no-longer-preferred. `-s 50` (vs. earlyoom's own default of 10) matters because earlyoom needs BOTH the memory and swap floors breached before it acts, and step 2 provisions ~50%-of-RAM zram swap — a low `-s` would mean nearly all of that swap has to be exhausted first, past the point the host is already unresponsive. |
| zram swap (zstd, ~50% of RAM)                                   | An extra, fast, compressed swap tier                                                                                                                                                                                                                                                                            | The cheapest headroom win on a 16 GB box; a `zstd`-compressed RAM-backed swap absorbs bursts (the pre-push heavy lanes) without the latency cliff of disk swap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `vm.swappiness=10`                                              | Lowers the kernel's eagerness to swap                                                                                                                                                                                                                                                                           | The stock Ubuntu default (60) swaps proactively even with free RAM available, which fights the zram tier's purpose; 10 keeps swap as a burst buffer rather than steady-state usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `user-.slice` `MemoryMax`/`MemoryHigh`                          | A cgroup ceiling on the TOTAL memory available to all of this user's login sessions combined, sized from `totalmem()` minus a fixed OS reserve — deliberately independent of `--sessions=N`, since `user-.slice` is one shared cgroup per UID, not one per session                                              | Without it, `user-.slice` reports `MemoryMax=infinity` — one runaway session (not even two) can consume all host memory. Per-session budgeting is `CLAUDE_CODE_TOOL_MEMORY_LIMIT`'s job (next row); dividing this ceiling by session count too would shrink the whole-user cap as `--sessions` grows, inverting its intent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `claude-rc.service` `MemoryMax`+`OOMPolicy=kill`                | Bounds this host's remote-control unit specifically, if present                                                                                                                                                                                                                                                 | `claude-rc-run` restarts in an infinite loop with no memory ceiling of its own today — a runaway session there currently takes the whole box down instead of just that unit. No-op on a host without this unit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CLAUDE_CODE_TOOL_MEMORY_LIMIT` (`.claude/settings.local.json`) | Anthropic's own memory cgroup over a session's Bash-tool subprocesses                                                                                                                                                                                                                                           | The purpose-built official fix (v2.1.233+, Linux/WSL only) — "so one runaway build can't take the memory the rest of the session needs." Written to `settings.local.json` (gitignored), never the repo-tracked `settings.json`, because the recommended value is derived from _this host's_ RAM and would be wrong for every other contributor's machine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CLAUDE_CODE_NO_FLICKER=1` (`.claude/settings.json`)            | Keeps the client's render tree — and memory — flat over a long session                                                                                                                                                                                                                                          | Safe for every host (no per-machine tradeoff), so it's set once in the shared, repo-tracked settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lefthook-local.yml` `pre-push: parallel: false`                | Forces the entire `pre-push` run serial when the derived host budget (`deriveBudget(detectHostProfile()).concurrentLaneWorkers`, `bin/lib/host-profile.mjs`) comes out to 1 concurrent lane worker — cores, memory, _and_ concurrently running Claude sessions, not RAM alone (P3.5 of adaptive-host-budgeting) | `test`/`typecheck`/`build-exports` each cap their own internal fan-out (turbo/vitest, both 50%, see below), but three already-capped heavy processes can still stack on a small or contended box. Lefthook's own documented [local-override mechanism](https://lefthook.dev/examples/lefthook-local) — gitignored, never edits the shared `lefthook.yml`. The same signal `pnpm verify --isolated` names explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Known caveat: silent kills

`CLAUDE_CODE_TOOL_MEMORY_LIMIT` gives **no attribution** when it kills a
command — "the kernel kills a command, and nothing in its result names the
cap" (Anthropic's own docs, verbatim). If a test run or build step dies with
no useful error, **check this cap first** (`echo $CLAUDE_CODE_TOOL_MEMORY_LIMIT`,
or re-run with a higher `--sessions=1` budget) before assuming a real
regression. The cap also **latches at first tool use** — relaunch the session
after changing it.

## Sizing for your machine

`--sessions=N` (default 2) tells the setup script how many concurrent Claude
Code sessions to budget for; it derives every number (`MemoryMax`,
`CLAUDE_CODE_TOOL_MEMORY_LIMIT`) from `totalmem() / N`, reserving headroom for
the OS and each session's own ~1 GiB non-tool overhead (client + stdio MCP
server + hook/statusLine burst). Nothing here is a single hardcoded number for
all machines — re-run the script (dry-run first) after a RAM upgrade or a
change in how many sessions you actually run at once.

## Repo-side mitigations (no setup script needed — already in the tracked config)

These land as part of the checked-in repo, not the per-host setup script:

- **`turbo.json`'s `concurrency: "50%"`** — `build`/`typecheck` defaulted to 10
  concurrent tasks across 19 workspace packages with no `concurrency` key set,
  2.5x oversubscribing a 4-core host. A percentage scales with whatever host
  runs it.
- **`vitest.config.ts` / `vitest.bin.config.ts` / `vitest.integration.config.ts`'s
  `maxWorkers: "50%"`** — each config previously relied on Vitest's own default
  (`availableParallelism() - 1`, i.e. nearly every core).
- **`lefthook.yml`'s merged `checks` lane** — the eight sub-second `check:*`
  gates (`verify-signed-range`, `check:control-chars`, `check:file-budget`,
  `check:agents`, `check:script-docs`, `check:cli-docs`, `check:review-size`,
  `check:context-budget`) run as one chained lane instead of eight separate
  concurrent lefthook processes — 13 pre-push lanes down to 6, at no wall-clock
  cost (none of the eight was ever on the critical path).
- **`lint:workspace`'s `NODE_OPTIONS=--max-old-space-size=8192`** — Node's
  default V8 old-space ceiling on a 4-core ARM64 host measured at ~4.3 GB
  (`require("v8").getHeapStatistics().heap_size_limit`), regardless of the
  23 GB of system RAM actually available — it is a fixed V8 default, not a
  fraction of `totalmem()`. The full-workspace typed-lint program (every
  package except `packages/m3l-common`, which gets its own smaller
  `lint:library` pass) crosses that ceiling and crashes with `FATAL ERROR:
... JavaScript heap out of memory` (exit 134) — reproducible alone on an
  otherwise idle box, so it is not resource contention. CI's identical job
  runs on `ubuntu-latest` (x86_64) and had not hit this, which is why it went
  unnoticed until run on this architecture. `lint:library` alone does not
  cross the ceiling and is left unchanged.

  **Known tension with `CLAUDE_CODE_TOOL_MEMORY_LIMIT` on a small host.**
  Measured peak RSS for `lint:workspace` under the 8 GiB ceiling: ~5.7 GiB
  (`/usr/bin/time -v`'s `Maximum resident set size`). On the documented
  16 GiB floor with `--sessions=2`, `recommendToolMemoryLimitGiB(16, 2)`
  (`bin/check-host-resources.mjs`) derives a 6 GiB
  `CLAUDE_CODE_TOOL_MEMORY_LIMIT` — leaving only ~300 MB of margin before a
  local `pnpm lint`/`pnpm verify` run (a Bash-tool subprocess tree, and
  therefore inside that cgroup) risks a **silent** cgroup kill instead of
  the loud V8 `FATAL ERROR` this fix replaces. `8192` is not derived from
  the per-host budget the way `CLAUDE_CODE_TOOL_MEMORY_LIMIT` itself is —
  raising it fixed the immediate crash on this host but does not resolve
  that tension on a smaller one. Deriving `NODE_OPTIONS` from the same
  per-host budget calculation is exactly what
  [the adaptive-host-budgeting wave's landing plan](/docs/plans/2026-09-08-adaptive-host-budgeting.md#landing-plan)
  (Slices P1-P2) intends to fix generally, rather than special-casing this
  one script ahead of that work.

- **`lint:library:fast`/`lint:workspace:fast`'s derived `--concurrency`**
  (P3.6 of adaptive-host-budgeting) — `bin/print-eslint-concurrency.mjs
<target>` derives each target's `--concurrency` from
  `deriveBudget(detectHostProfile(), { perWorkerGiB })`, using that target's
  own measured single-worker peak (`library`: ~3.1 GiB, `workspace`: ~3.8 GiB
  — the same numbers documented in `.github/workflows/ci.yml`'s
  `lint-library`/`lint-workspace` job comment) instead of `deriveBudget`'s
  1 GiB default, since typescript-eslint's `projectService` duplicates the
  entire typed-lint TS program per worker. Local-only, on purpose: the plain
  `lint:library`/`lint:workspace` scripts (used by both pre-push and CI's
  split jobs) stay pinned at `--concurrency=1` — CI's job split exists
  specifically to avoid the OOM a prior unsplit `--concurrency=2` caused on a
  fixed 4-vCPU/16GB runner (issue #734), and a fixed runner spec can't stand
  in for a live host's actual available memory the way this host's own
  `os.freemem()` reading can for a local `*:fast` run.
- **Pinned `statusLine`** — `npx -y ccstatusline@latest` (user-level
  `~/.claude/settings.json`, not repo-tracked) re-resolves the npm registry and
  spawns a fresh `npm exec` supervisor on every render; pin it to a real
  install instead: `npm install -g ccstatusline@<version>` then
  `"command": "$(which ccstatusline)"` (or the resolved absolute path) in
  `statusLine`. This is a per-operator fix, not something `setup-host-resources.mjs`
  can apply — it lives outside the repo entirely.
- **Project `statusLine`'s `refreshInterval: 30`** — the repo-tracked
  `statusline-context-pressure.mjs` (#879) re-runs on a 30-second timer, in
  addition to its normal event-driven triggers, so rate-limit reset countdowns
  and the free-memory reading stay live while a session is idle. Each run is a
  plain local `node` invocation (no subprocess, no network) — nowhere near the
  `npx`-resolved cost above — but it is a small, repo-mandated addition to the
  per-session idle floor; unlike the `ccstatusline` pin, there is nothing to
  configure per-operator here.

## Recommended hardware floor

Given the measurements in ADR-0080, treat **16 GB RAM** as the practical floor
for one Claude Code session doing normal TDD work (edit → `post-edit-verify`
→ `git push` → full pre-push) in this repo, and prefer running only **one**
session at a time below that; two concurrent sessions need these mitigations
in place first. This is a repo-measured number, not an Anthropic-documented
requirement — the only official hardware floor is "4 GB+ RAM"
(`code.claude.com/docs/en/setup`), which this repo's own tooling comfortably
exceeds.
