# Intel Mac support: host-profile fixes + real macOS host-resource tooling

**Status: shipped** — two PRs: `fix/darwin-host-profile` (PR #1196) and
`feat/macos-host-resources` (this PR).

## Context

This repo had only ever been developed on WSL2/Linux boxes. Running it live
on an Intel Mac (darwin x64, i9-9980HK, 8 physical/16 logical cores, 64 GiB
RAM) surfaced that `bin/lib/host-profile.mjs`'s Darwin collector — the
module every `build`/`typecheck`/`lint:*:fast`/vitest concurrency budget
derives from — carried a doc comment admitting it was "unproven on real
hardware (no Mac available to this project yet)." It wasn't: running it
reproduced four distinct defects live, not hypothetically. Separately,
`bin/check-host-resources.mjs`/`bin/setup-host-resources.mjs` (ADR-0080)
were Linux-only, reporting a single generic "nothing to do" line on any
other platform, including a step (the lane-budget-derived
`lefthook-local.yml` override) that has no Linux dependency at all and was
unreachable purely due to a blanket platform gate.

## Approach / Decisions

- **PR 1** (`fix/darwin-host-profile`): fixed all four host-profile.mjs
  defects, each confirmed live before and after: `ps -eo comm --no-headers`
  (GNU-only, BSD `ps` rejects it) → the portable `ps -eo comm=` form;
  `hw.perflevel0.logicalcpu` reporting all 16 logical cores as "performance
  cores" on a non-hybrid CPU (macOS 12+ exposes the sysctl uniformly) →
  gated on `hw.nperflevels > 1`; `parseDarwinSwapUsage` breaking under a
  comma-decimal locale (`LC_NUMERIC=it_IT`) → `DEFAULT_IO.run` now forces
  `LC_ALL=C`; and `detectHostProfile` reading `process.platform` directly
  with no injection seam, so 2 existing Linux-fixture tests silently took
  the Darwin branch on this machine → added an optional `platform`
  override. Also fixed two previously-deferred approximations
  (`availableMemGiB` defaulting to total memory, `smt` hardcoded `false`)
  now that real hardware was available to validate against. Folded in an
  unrelated pending `pnpm-workspace.yaml` fix (`better-sqlite3` build-skip —
  it ships prebuilt binaries per platform/arch) at the user's request. A
  `claude-pr-review` Should-fix caught a real follow-on bug in the same
  area: `if (!vmStat)` is falsy for the legitimate value `0`, so a
  genuinely-zero-available-memory host got a false "detection failed"
  warning — fixed to `if (vmStat === null)`, with a mutation-tested
  regression test.
- **PR 2** (this PR): replaced both scripts' blanket non-Linux skip with
  real platform-specific behavior. `evaluateDarwinHostResources` reports
  what IS observable on macOS (jetsam memory pressure, swap usage,
  `vm_stat`-derived available memory) and names the macOS analogue of each
  Linux-only mitigation by name — an advisory check that explains why it
  has nothing to configure beats one that silently skips
  (`.claude/rules/harness-artifacts.md`). `platformStepSkips(platform)`
  replaces `setup-host-resources.mjs`'s single blanket gate with per-step
  applicability, so the genuinely platform-agnostic step
  (`lefthook-local.yml`) now actually runs on macOS. A test-author
  mutation-testing pass caught a second real bug during this PR:
  `parseDarwinMemoryPressureLevel("")` returned `0` instead of the
  documented `null`, because `Number("")` is `0` in JS, not `NaN` — fixed
  with an explicit empty-string guard.
- **Deliberately not written on macOS**: `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is
  documented Linux/WSL-only (enforced via a Linux cgroup) — `setup` skips
  it there rather than claim a mitigation the CLI cannot apply, and `check`
  reports it informationally, never as a warning, so as not to nag about a
  setting the CLI itself ignores on this platform.
- Every source change was run live on the real Intel Mac before its test
  suite was written, per `.claude/rules/harness-artifacts.md`'s "run before
  writing tests" rule — including `--sessions=8 --apply` to force
  `setup-host-resources.mjs`'s one genuinely-writable step down its actual
  write path and confirm the re-run is a clean idempotent no-op.

## Outcome

Both PRs' `pnpm verify` passed clean (73 passed / 10 skipped each). PR 1's
suite grew from 70/72 (2 failing on this Mac) to 82/82; PR 2 added 104
passing tests across both host-resources test files. `docs/contributing/host-resources.md`
gained a macOS analogue table; ADR-0080 gained a 2026-09-11 Update stating
plainly that its headline mitigation has no macOS equivalent. No macOS CI
runner was added — both scripts remain local-developer tooling with no CI
equivalent by design, so this stays a Mac-local concern with no CI-side
validation.
