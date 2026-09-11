# pnpm 12 bump + drift prevention

**Status: shipped** — three PRs across the sequence: `feat/pnpm-pin-gate`
(PR #1182 + work-log PR #1184), `feat/pnpm-12-bump` (PR #1185, same-day
Should-fix follow-up PR #1186, work-log PR #1188), and
`feat/pnpm-staleness-probe` (this PR). Narrative logs:
`docs/logs/2026-09-11-pnpm-pin-gate.md`, `docs/logs/2026-09-11-pnpm-12-bump.md`.

## Context

`package.json`'s `packageManager` field pinned `pnpm@11.9.0` and had never
changed since the initial commit, while upstream pnpm had moved to 12.x.
ADR-0001's 2026-08-31 Update already recorded the drift in passing but
nothing acted on it — Dependabot has no npm-ecosystem concept of the
`packageManager` field (dependabot-core#4830), and `bin/check-deps.mjs` never
read it. A second, independent problem: the version was pinned by hand in two
more places (`packages/m3l-console-web/Containerfile`,
`packages/m3l-console-server/Containerfile`), with nothing to catch the three
sites disagreeing.

Two distinct drift modes needed two different mechanisms: **consistency**
(the three pins disagreeing) closed by a blocking gate, **staleness** (the
pin falling behind upstream with no diligence) closed by an automated
warn-only probe.

## Approach / Decisions

- **PR order deliberate: gate first, then the bump, then the staleness
  probe.** The gate lands green against the still-current `11.9.0` pins,
  proving it's honest before it becomes load-bearing, so the bump PR is
  protected by a gate already known to work.
- **PR 1** (`bin/check-pnpm-version.mjs`): a same-shape sibling of
  `bin/check-claude-cli-version.mjs` (one gate per pin subject, not a
  toolchain mega-gate), deliberately offline. Asserts the `packageManager`
  field is an exact pnpm pin, both Containerfiles agree with it, and no
  `pnpm/action-setup` step overrides it with an explicit `version:` input. A
  design-review agent pushed back on two initially-settled decisions
  (freshness-tracker choice, PR ordering) with concrete reasoning during this
  PR; both were re-confirmed with the user and flipped rather than
  overridden silently.
- **PR 2** (the bump): `12.4.0` chosen over `12.4.1` — the latter was ~25h
  past publish, just inside the repo's own `minimumReleaseAge: 1440` cooldown
  (which governs resolved dependencies, not `packageManager`, but the choice
  respected its spirit). Added `cache-dependency-path` (`pnpm-lock.yaml` +
  `package.json`) to the shared composite setup action so the pnpm-major
  literal busts the `actions/setup-node` cache key on every future bump, not
  just this one. Appended an ADR-0001 `## Update 2026-09-11` section (Accepted
  ADRs are immutable except for an appended Update executing a declared
  revisit trigger — the stale `11.9.0` literal going false _was_ that
  trigger firing). Added a `package-manager-pin` claim to
  `bin/lib/adr-claims.mjs`'s `ADR_CLAIMS` table, asserting shape
  (`{manager: "pnpm", exact: true, major: 12}`) rather than the literal
  version, so a future patch/minor bump never forces an ADR Update. The
  resulting `pnpm-lock.yaml` diff was purely additive — pnpm 12's new
  self-management `packageManagerDependencies` metadata, `lockfileVersion`
  unchanged.
- **PR 2b** (same-day follow-up, `fix/pnpm-12-should-fix`): GitHub auto-merge
  fired on PR #1185 before its two `claude-pr-review` Should-fix findings
  (missing `cache-dependency-path` on two workflows calling
  `actions/setup-node` directly; a test-coverage gap for the pin probe's
  non-exact branch) could be folded in — `should-fix-ack` (ADR-0097) is a
  required-check-in-waiting, not yet in GitHub's actual enforced
  required-checks list. Recovered by branching a fresh `fix/pnpm-12-should-fix`
  off the just-updated `origin/main` from inside the now-stale worktree,
  carrying the uncommitted fixes forward, and opening a follow-up PR.
- **PR 3** (this PR): the staleness half. `findPnpmStaleness(pinnedMajor,
latestVersion)`, a pure helper added to `bin/check-deps.mjs` (already
  network-touching, already wired as a `conditional: true` verify step — no
  new wiring at all), compares the pinned pnpm major against `npm view pnpm
version`'s actual latest. Warn-only by design: erroring would deepen
  ADR-0079 hermeticity debt (a blocking gate failing on mutable remote
  state). Live-run against the repo first (`.claude/rules/harness-artifacts.md`)
  confirmed it correctly stayed silent when the pin (12.4.0) and upstream
  latest (12.4.1) share a major, then a synthetic call confirmed the warn
  path fires for a genuinely newer major.

## Outcome

All three consistency-gate residual risks the original plan flagged as
"empirical, verify by running the install" came back clean: no
`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`, no `ERR_PNPM_UNSUPPORTED_ENGINE`,
and the one lockfile change was exactly the benign, additive shape the plan's
"acceptable churn" criteria described. Two independent frozen-lockfile
installs and both Containerfile builds (`podman build`) verified the bump.
`pnpm verify` passed on all PRs; `bin/tests/adr-claims.test.ts` grew from 9 to
14 tests across PR 2/2b; `bin/tests/check-deps.test.ts` gained 6 tests for
`findPnpmStaleness`.

Deliberately out of scope, matching the original plan: comparing the pin
against upstream latest stays warn-only forever, not a future error — the
whole point is detecting staleness with no gate failing on remote state it
doesn't control. `should-fix-ack`'s gap between "documented in CLAUDE.md" and
"enforced in GitHub's branch-protection ruleset" was surfaced but not closed
by this sequence; closing it is a separate, undertaken-elsewhere concern.
