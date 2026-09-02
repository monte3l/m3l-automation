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

| Mitigation                                                      | What it does                                                                                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earlyoom`                                                      | Kills a runaway process on memory pressure, tuned `--avoid 'sshd\|systemd\|tmux\|sudo\|dbus-daemon'` `--prefer 'node\|claude\|vitest\|tsc\|esbuild'`                                                                                                               | Neither `earlyoom` nor `systemd-oomd` is installed/active by default on a plain Ubuntu box, and `vm.panic_on_oom=0` — without a daemon, memory pressure livelocks the box _before_ the kernel OOM killer would ever fire. The `--avoid`/`--prefer` targeting matters on a host also running `sshd`/`fail2ban`/other services: a coarse kill choice is nearly as bad as the freeze it replaces. |
| zram swap (zstd, ~50% of RAM)                                   | An extra, fast, compressed swap tier                                                                                                                                                                                                                               | The cheapest headroom win on a 16 GB box; a `zstd`-compressed RAM-backed swap absorbs bursts (the pre-push heavy lanes) without the latency cliff of disk swap.                                                                                                                                                                                                                                |
| `vm.swappiness=10`                                              | Lowers the kernel's eagerness to swap                                                                                                                                                                                                                              | The stock Ubuntu default (60) swaps proactively even with free RAM available, which fights the zram tier's purpose; 10 keeps swap as a burst buffer rather than steady-state usage.                                                                                                                                                                                                            |
| `user-.slice` `MemoryMax`/`MemoryHigh`                          | A cgroup ceiling on the TOTAL memory available to all of this user's login sessions combined, sized from `totalmem()` minus a fixed OS reserve — deliberately independent of `--sessions=N`, since `user-.slice` is one shared cgroup per UID, not one per session | Without it, `user-.slice` reports `MemoryMax=infinity` — one runaway session (not even two) can consume all host memory. Per-session budgeting is `CLAUDE_CODE_TOOL_MEMORY_LIMIT`'s job (next row); dividing this ceiling by session count too would shrink the whole-user cap as `--sessions` grows, inverting its intent.                                                                    |
| `claude-rc.service` `MemoryMax`+`OOMPolicy=kill`                | Bounds this host's remote-control unit specifically, if present                                                                                                                                                                                                    | `claude-rc-run` restarts in an infinite loop with no memory ceiling of its own today — a runaway session there currently takes the whole box down instead of just that unit. No-op on a host without this unit.                                                                                                                                                                                |
| `CLAUDE_CODE_TOOL_MEMORY_LIMIT` (`.claude/settings.local.json`) | Anthropic's own memory cgroup over a session's Bash-tool subprocesses                                                                                                                                                                                              | The purpose-built official fix (v2.1.233+, Linux/WSL only) — "so one runaway build can't take the memory the rest of the session needs." Written to `settings.local.json` (gitignored), never the repo-tracked `settings.json`, because the recommended value is derived from _this host's_ RAM and would be wrong for every other contributor's machine.                                      |
| `CLAUDE_CODE_NO_FLICKER=1` (`.claude/settings.json`)            | Keeps the client's render tree — and memory — flat over a long session                                                                                                                                                                                             | Safe for every host (no per-machine tradeoff), so it's set once in the shared, repo-tracked settings.                                                                                                                                                                                                                                                                                          |
| `lefthook-local.yml` `pre-push: parallel: false`                | Forces the entire `pre-push` run serial when total RAM is under 20 GiB                                                                                                                                                                                             | `test`/`typecheck`/`build-exports` each cap their own internal fan-out (turbo/vitest, both 50%, see below), but three already-capped heavy processes can still stack on a small box. Lefthook's own documented [local-override mechanism](https://lefthook.dev/examples/lefthook-local) — gitignored, never edits the shared `lefthook.yml`.                                                   |

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
