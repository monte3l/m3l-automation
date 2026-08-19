# CI performance — job split, path scoping, and turbo caching

**Status: shipped** (PRs 1–3); PR 4 (ARM64 trial) mechanism shipped, adopt/revert
decision pending sufficient run data. PR1 `feat/ci-cheap-wins` (#493), PR2
`feat/ci-parallel-lanes` (#494), PR3 `feat/ci-path-scoping` (#495), PR4
`feat/ci-arm64-trial` (commit `9119c7f`).

## Context

CI feedback on this repo was slow: merge-blocking latency on a PR was
**~5m34s**, almost all of it one workflow running one ~45-step serial job with
0% parallelism and no cross-run caching beyond the pnpm store. An `/auditing`
pass (80 recent runs via the Actions API, per-step timings, every workflow
file plus `turbo.json`/`lefthook.yml`/both Vitest configs/`eslint.config.js`)
found five steps accounted for 80% of that job's runtime, an Actions cache
budget already over its 10 GB limit and thrashing (CodeQL overlay-base
databases alone were 73% of it), and no `paths:`/`paths-ignore:` anywhere —
a docs-only PR paid the full 334s.

Full findings and the ranked-by-impact plan are in the audit's own record;
see `git log --all --grep 'ci-perf' --oneline` and the four PR bodies for the
line-by-line detail. This note is the condensed outcome.

## Approach / Decisions

1. **PR1 — cheap, independent wins.** Killed the duplicate `bin/tests/**`
   Vitest run (excluded from the main config; already covered by
   `vitest.bin.config.ts`), pinned `eslint . --concurrency=2` (verified
   byte-identical findings vs. serial, ~15% faster — `--concurrency=auto`
   crashed the local WSL2 dev VM outright at 24 cores, so a fixed low count
   was used instead of the audit's original `auto` recommendation, on any
   runner regardless of core count), added `concurrency`/`cancel-in-progress`
   to the four workflows missing it, and added a cache-pruning job to the
   existing weekly `security-audit.yml` cron.
2. **PR2 — parallel job lanes.** Split the single `verify` job into `changes`
   (new path classifier, `bin/ci-changed-paths.mjs` + `bin/lib/changed-paths.mjs`),
   `secrets`/`deps`/`lint`/`format`/`build`/`test`/`gates`, and a `verify`
   aggregator that keeps the exact required-check name. `bin/lib/verify-steps.mjs`
   rewritten to union step names across every job. Hit and fixed two real bugs
   before merge: a local composite action can't bootstrap its own checkout
   (moved `actions/checkout` into each calling lane), and the `test` lane
   needed its own `pnpm build` (package.json `exports` resolves only to
   `./dist/*`, no source fallback) — diagnosed via `/triaging-ci` after CI
   failed unexpectedly, user chose the turbo-cache-backed rebuild option over
   four alternatives presented.
3. **PR3 — path scoping and turbo caching.** Gated every lane/step on the
   `changes` classifier's category outputs (`ts`/`deps`/`scripts`/`claude`/
   `workflows`/`docs`/`md`), added a `.turbo` `actions/cache` step with a
   `restore-keys` fallback ladder, and scoped `turbo.json`'s task `inputs`.
   Went through **six rounds** of `claude-pr-review` findings, all real,
   independently verified before each fix: rounds 1–2 patched individual
   mis-scoped gates and closed the classifier's own fail-open gap
   (an unmatched path now forces every category true, same treatment as
   `bin/**`); rounds 3–4 found two more individual mis-scoped gates
   (`check:index`, `check:script-scaffold`, `check:doc-counts`). Round 5
   (posted against round-4's fix, before the round-6 structural change below
   had landed) found the same class again in the `gates` lane, at which point
   the pattern itself — not any single instance — became the problem: the
   `gates` lane's ~24 checks read from `CLAUDE.md`, `docs/`, `scripts/`,
   `.claude/`, and `src/` in combinations that shift as each check evolves,
   making an exhaustive per-check category audit an intractable target to
   keep correct forever. Round 6 (structural fix) removed step-level category
   gating from the entire `gates` lane — its own baseline measured at ~20s
   combined across ~36 steps, negligible next to the lint/build/test/deps
   lanes the real path scoping targets — so all ~24 checks there now run
   unconditionally. One further round found one last job-level gap (the
   `test` lane's `ts`-only gate missing `.claude/hooks/**` coverage via 8
   `bin/tests/*.test.ts` files that import hooks directly) and closed it the
   same way as the earlier `lint`-lane fix. Confirmed in production on the
   PR3 merge push: `verify` passed in ~167s wall-clock (a large multi-PR
   merge commit, so every lane ran — still roughly half the 334s serial
   baseline).
4. **PR4 — ARM64 runner trial.** `ubuntu-24.04-arm` is a standard, free
   runner at the same 4 vCPU / 16 GB as `ubuntu-latest` for public repos — not
   a core-count lever, a per-core-silicon bet that has to be measured, not
   assumed. Added a `runs-on: ${{ matrix.runner }}` matrix to `build`/`test`
   (the two lanes that dominate wall clock) with `fail-fast: false`, and
   `continue-on-error` scoped to the `arm` leg only so `verify` — which reads
   `needs.build.result`/`needs.test.result` — is gated on each lane's
   `ubuntu-latest` leg alone; an ARM-specific failure can never block a merge
   during the trial. `scorecard.yml` (x64-only Docker action) and CodeQL
   default setup (x64 only, no workflow file) were deliberately left
   unmigrated. The turbo cache key intentionally stays arch-agnostic —
   cached output is portable JS/`.d.ts`/`.tsbuildinfo`, not native binaries.
   **Decision deferred**: adopt ARM only once ≥10 runs per arch are compared
   (median lane duration via `gh run view --json jobs`), watching specifically
   for `unrs-resolver` (`allowBuilds: false`, no source-build fallback) and
   `better-sqlite3` (must hit a `prebuild-install`, not `node-gyp rebuild`) —
   to be recorded in a follow-up work log once enough data exists, per the
   plan's built-in "either outcome is valid" framing.

**Two corrections the audit itself forced before implementation**:
`pnpm install --ignore-scripts` was dropped as unsafe (`better-sqlite3` is a
runtime `dependencies` entry of `m3l-common`, not dev-only, and needs its
install script); and hardware was rejected as the lever for the two biggest
serial steps (lint, format) since both are single-threaded on any runner —
`eslint . --concurrency=2` buys more than any runner change, for free.
Larger paid runners were declined outright: they're billed even on public
repos, while six free parallel standard-runner jobs (24 vCPU total) strictly
dominate one paid 8-core runner at $0.

## Outcome

- Merge-blocking latency floor is now the `claude-pr-review` bot's own
  ~215s (`claude-opus-5`, an explicit out-of-scope decision from the plan's
  clarifying-questions round), not `ci.yml`.
- `ci.yml` measured in production at ~167s on a large multi-PR merge (every
  lane ran); expected ~40s on a docs-only push and ~90–120s on a source push
  once enough scoped runs accumulate to confirm the estimate directly.
- `pnpm check:verify-parity` (42 steps), `pnpm check:cadence`,
  `pnpm check:command-catalog`, and the full `pnpm lint && pnpm typecheck &&
pnpm test:coverage && pnpm build` gate all pass at every PR in the series.
- `gh api repos/{owner}/{repo}/actions/cache/usage` back under the 10 GB
  limit after PR1's pruning job landed.
- PR4's ARM64 matrix is live and gathering data; this doc will not be amended
  when the adopt/revert call lands — that goes in its own work log per the
  plan's "either outcome is a valid result" framing.
