# Parallel Claude Code session OOM/livelock — audit and host-guardrail fix

## Summary

Investigated a recurring failure: running 2+ Claude Code sessions against this
repo on a 16 GB Linux box reliably takes the whole box down, presenting as an
unrecoverable freeze ("kernel panic"). An `/auditing` fan-out plus
`/researching-anthropic-guidance` validation measured the actual per-session
and per-tooling-invocation memory footprint, confirmed the mechanism is
memory-pressure livelock (not a real kernel panic — `vm.panic_on_oom=0`), and
produced a 5-PR fix plan recorded as [ADR-0080](../adr/0080-host-resource-budgeting.md).

This session lands all 5 PRs of the ADR-0080 rollout — PR 1 (this PR, #712):
the host guardrail and official env caps, the slice that stops the crash on
its own, independent of the other four.

- **Measured (audit box: 4 cores, 24 GB, Ubuntu, kernel 6.17, `claude` 2.1.247):**
  idle `claude` client 776 MB RSS; stdio MCP server 86 MB; `statusLine`
  (`npx -y ccstatusline@latest`) respawning ~130 MB every 10 s; one
  `Edit`/`Write` firing 14 hooks (7 PreToolUse + 7 PostToolUse, confirmed
  parallel by Anthropic's own hooks reference) for a ~650 MB burst; `git push`
  fanning `lefthook`'s `pre-push` (`parallel: true`) out to 13 concurrent
  lanes; Node's default per-process heap ceiling on this host, uncapped,
  4192 MB.
- **Shipped this session:** `bin/check-host-resources.mjs` (warn-only
  preflight, `pnpm check:host-resources`), `bin/setup-host-resources.mjs`
  (idempotent, dry-run-by-default host setup: earlyoom, zram, sysctl
  swappiness, `user-.slice` `MemoryMax`, `claude-rc.service` drop-in,
  `CLAUDE_CODE_TOOL_MEMORY_LIMIT`), `.claude/hooks/warn-host-resources.mjs`
  (SessionStart advisory), `.claude/settings.json` `env.CLAUDE_CODE_NO_FLICKER`,
  `docs/contributing/host-resources.md` (operator runbook), and
  `docs/adr/0080-host-resource-budgeting.md`.
- **Also shipped, as three follow-on PRs from this same session:**
  PR 2 (#713) — `turbo.json`/`vitest` concurrency caps (`concurrency: "50%"`,
  `maxWorkers: "50%"`; caught and fixed a deprecated `poolOptions.forks.maxForks`
  shape from Vitest 4's migration mid-authoring). PR 3 (#714) — `lefthook.yml`'s
  eight sub-second `check:*` gates chained into one lane (13 pre-push lanes
  down to 6, zero `CLAUDE.md` change needed), an adaptive `lefthook-local.yml`
  serial fallback under 20 GiB RAM (`bin/setup-host-resources.mjs` step 7),
  and the statusLine `npx -y ccstatusline@latest` respawn fixed via a pinned
  `npm install -g`. PR 4 (#715) — `if:` conditions scoping 9 of the 14
  `Write|Edit` hooks to their own internal path logic, with 3 safety-critical
  guards (`guard-branch-isolation`, `guard-hub-src-writes`, `guard-secret-writes`)
  deliberately left unscoped (no stated backstop, or inherently unscopeable).
- **Skills used:** `auditing` (3-facet fan-out: tooling memory profile,
  per-session process footprint, documented parallelism stance),
  `researching-anthropic-guidance` (3-facet fan-out: memory/system
  requirements, hooks/statusLine cost, parallel-session/worktree guidance),
  `starting-work`.
- **Spoke incidents:** none — all 6 audit/research Explore agents returned
  clean digests on their first pass; no truncations, no stalls, no resumes.

## What went as planned

- **The audit's own half-known hypothesis held up.** `docs/logs/2026-08-19-check-test-counts-contention.md`
  had already named memory exhaustion as the leading hypothesis for an
  unrelated flake ("~42 worker processes… memory exhaustion remains the
  leading hypothesis"). This investigation independently arrived at the same
  mechanism from a different symptom (host-level livelock rather than a
  single flaky gate) and confirms it — see ADR-0080's Links section.
- **Anthropic shipped the exact fix needed, recently.** `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
  (v2.1.233+) is a memory cgroup over a session's Bash-tool subprocesses,
  documented verbatim as being "so one runaway build can't take the memory
  the rest of the session needs" — this repo is on 2.1.247, so it was
  available and just unused.
- **The research pass caught a real gap in official guidance rather than
  forcing a citation.** Anthropic's parallel-session advice (best-practices,
  worktrees docs) carries zero RAM/CPU caveat anywhere; the task explicitly
  asked to "validate solutions via `/researching-anthropic-guidance`," and
  the honest answer is that Anthropic's own guidance doesn't cover this — so
  the fix is built from measurement, with that gap stated plainly in
  ADR-0080 rather than papered over with a loosely-related citation.
- **`pnpm typecheck`/`lint`/`bin/check-hooks.mjs` all passed clean on first
  pass** for the three new bin/hook scripts — no lint or type errors needed
  fixing after initial authoring.

## What didn't go as planned, and why

### 1. The setup script's first draft would have written a host-derived value into a repo-tracked file

While writing `bin/setup-host-resources.mjs`, the first draft wrote the
recommended `CLAUDE_CODE_TOOL_MEMORY_LIMIT` into the shared, git-tracked
`.claude/settings.json`. Caught before landing: that value is derived from
_this_ host's total RAM (`os.totalmem()`), so committing it would silently
apply one machine's number to every other contributor's differently-sized
box — and to CI, which has no relationship to a developer's local memory
budget at all.

**Why it happened:** the plan's own PR-1 description said "add
`CLAUDE_CODE_TOOL_MEMORY_LIMIT`… to `.claude/settings.json`'s `env` block"
without distinguishing host-specific values from universally-safe ones
(`CLAUDE_CODE_NO_FLICKER` has no such problem).

**Fix for future:** the corrected split — `CLAUDE_CODE_NO_FLICKER` in the
tracked `settings.json` (safe for every host), `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
in the gitignored `settings.local.json` (host-derived) — is recorded in
ADR-0080's Decision section and both docstrings, so a future contributor
extending this script has the rule stated, not just implied by the code.

### 2. `poolOptions.forks.maxForks` is a deprecated Vitest shape under this repo's Vitest 4

The first draft of PR 2's vitest config changes used
`test.poolOptions.forks.maxForks`. It worked but printed
`DEPRECATED 'test.poolOptions' was removed in Vitest 4. All previous
'poolOptions' are now top-level options.` on every run.

**Why it happened:** the config option's shape changed between Vitest major
versions and the older shape still silently functions (with a warning)
rather than erroring, so it wasn't caught by a type error.

**Fix for future:** re-ran `pnpm test:coverage` after every vitest.config.ts
edit and grepped its own output for `DEPRECATED` before treating the change
as done — caught here before commit. Corrected to the top-level
`maxWorkers: "50%"` (a percentage string, same convention as `turbo.json`'s
`concurrency`).

### 3. Two "killed" background `git push` attempts for PR 4, resolved by running in the foreground

PR 4's push was attempted twice via a backgrounded `Bash` call and both were
reported `status: killed` with no error text, after roughly 5-minute
`ScheduleWakeup` waits. Re-running the identical `git push` in the
foreground with an explicit 300s timeout succeeded on the first attempt, full
`pre-push` verify green.

**Why it happened:** unclear from available evidence — no error surfaced on
either killed attempt, and the identical command succeeded immediately after
in the foreground. Possibly an environment-level constraint on how long a
backgrounded task may run before the next `ScheduleWakeup` cycle reaps it,
rather than anything about the push itself.

**Fix for future:** when a backgrounded long-running command (`pre-push`
takes minutes) is reported `killed` with no error rather than a real
failure, retry it in the foreground with an explicit generous timeout before
assuming a real problem — don't keep re-backgrounding the same command
indefinitely, and tell the user what's happening rather than silently
retrying more than once.

## Lessons learned

- **A "kernel panic" symptom deserves a kernel-config check before being
  taken literally.** `vm.panic_on_oom=0` and `kernel.panic=0` on the audit
  box show the kernel was never configured to panic on OOM — the real
  mechanism was reclaim livelock, which looks identical to a panic from the
  user's seat (unresponsive host, forced power-cycle) but has a different
  fix (an OOM daemon that intervenes _before_ reclaim thrash, not a
  kernel-panic policy change).
- **Measure the per-process default before proposing a cap.** `node -e
'console.log(require("v8").getHeapStatistics().heap_size_limit)'` on the
  audit box returned 4192 MB — a number that made "13 parallel lanes, no
  caps" concretely dangerous rather than abstractly risky, and anchored the
  adaptive-sizing formulas in both `bin/check-host-resources.mjs` and
  `bin/setup-host-resources.mjs`.
- **A host-mutating script should default to inert.** `bin/setup-host-resources.mjs`
  requires an explicit `--apply` flag and defaults to a dry-run that touches
  nothing; every step is written idempotent-by-construction (read current
  state, compare to target, skip if already met, never weaken a stricter
  existing setting). This matters more than usual here because several steps
  use `sudo` and touch systemd/sysctl state that outlives the repo and can
  affect other services (`sshd`, `fail2ban`) on a shared box.
- **Adaptive beats hardcoded for any cap derived from host facts.** Every
  numeric cap introduced this session (`recommendToolMemoryLimitGiB`,
  `buildUserSliceOverride`) takes `totalMemGiB`/`availableParallelism()` as
  input rather than a literal — the same repo runs on the 24 GB audit box and
  the 16 GB machines the bug reports came from, and a single hardcoded number
  would have been wrong for one of them by construction.
- **Verify an undocumented-in-practice glob/config semantic empirically before
  writing 30+ real config entries against it.** Before scoping any of PR 4's
  hooks, a throwaway canary hook + scratch file (removed before commit)
  confirmed live in this session: `if` has no `&&`/`||`/brace/`@()`-extglob
  syntax (each fails silently — no error, the handler just never fires), a
  bare extension glob like `*.ts` matches at any depth for both tools, and an
  exact relative path with no wildcard matches literally. Getting any of
  these wrong would have silently disabled a guard with no error signal —
  cheaper to spend a few minutes proving the mechanism than to ship a
  plausible-looking config that quietly does nothing.
- **A regex-based (non-YAML) config parser breaks on any multi-line scalar.**
  `bin/check-cadence-doc.mjs` only reads text on the same physical line as
  `run:` — it does not parse YAML block (`|`) or folded (`>`) scalars at all.
  Discovered by writing `lefthook.yml`'s merged `checks` lane as a `run: |`
  block with inline comments, which `check:cadence` immediately flagged as
  8 missing checks. Before extending or duplicating logic in a script like
  this, check whether it does real parsing or line-based pattern matching —
  the two have very different multi-line-input failure modes.

## Links

- [ADR-0080: Host resource budgeting for concurrent Claude Code sessions](../adr/0080-host-resource-budgeting.md)
- [docs/contributing/host-resources.md](../contributing/host-resources.md) —
  operator runbook
- [docs/logs/2026-08-19-check-test-counts-contention.md](./2026-08-19-check-test-counts-contention.md) —
  the earlier, unresolved memory-exhaustion hypothesis this investigation
  confirms
- PRs: #712 (host guardrail), #713 (turbo/vitest caps), #714 (lefthook regroup
  - statusLine), #715 (hook `if:` narrowing)
