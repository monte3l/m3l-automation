# 0034. Sonar/Act-Podman re-assessment: OSS complexity/duplication gates, Act/Podman declined

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** Enrico Lionello

## Context and problem statement

A request to assess integrating **Sonar tooling** (SonarQube/SonarCloud/SonarLint)
and **Act** (`nektos/act`, backed by Podman, for running GitHub Actions locally)
into the dev workflow prompted a fresh audit of both against the toolchain as it
stands today.

[ADR-0015](./0015-code-scanning-tooling-evaluation.md) already evaluated and
rejected the SonarQube/SonarCloud _platform_ as redundant with ESLint's
`complexity` rule, the 80% per-file coverage gate, and CodeQL SAST. That decision
still holds — nothing in the current audit found ESLint, coverage, or CodeQL
weaker than ADR-0015 described. But the audit also confirmed two capabilities
ADR-0015 named as Sonar's residual value are genuinely absent from this repo:
**cognitive complexity** (distinct from the cyclomatic complexity ESLint already
gates) and **copy-paste duplication density** (knip's `duplicates` detects
duplicate _exports_, not duplicated code blocks — a near-miss, not coverage).
Both are obtainable as open-source ESLint/CLI rules without adopting the Sonar
platform.

Separately, the audit assessed whether `act` + Podman would give this repo a
useful "run CI locally" affordance. It found the repo deliberately container-free
(ADR-0015: "this project ships no images"; ADR-0001/0009: minimal runtime/dev
dependencies, prefer platform-native features) and that only one of five
workflows (`ci.yml`) is structurally act-runnable — the other four need
GitHub-hosted context (`claude-pr-review`/`claude-assistant` need PR/API context,
`scorecard` uploads SARIF, and CodeQL runs via GitHub "default setup" with no
workflow file to feed `act` at all).

## Decision drivers

- Avoid redundant tooling (ADR-0015's standing principle) — a new gate must cover
  something not already covered.
- Minimal runtime/dev dependencies; prefer OSS rules over a new external platform
  when both fill the same gap (this repo's "minimal deps" constraint,
  ADR-0001/0009).
- Findings should be able to block a merge, not merely be advisory (ADR-0015).
- Contributor prerequisites stay minimal — today: corepack, pnpm, Node 24.

## Considered options

1. Adopt the Sonar platform (SonarQube/SonarCloud) and reopen ADR-0015.
2. Add nothing; re-affirm ADR-0015 as-is.
3. Fill the two named gaps (cognitive complexity, duplication density) with
   open-source ESLint/CLI rules, without adopting the Sonar platform; separately
   assess and decline Act/Podman.
4. Adopt `act` + Podman as a documented local-CI path.

## Decision

We chose **option 3**. Concretely:

- **Add `eslint-plugin-sonarjs`**, enabling only `sonarjs/cognitive-complexity`
  (default threshold 15) — not the plugin's full `recommended` preset — in the
  same source-only design block in `eslint.config.js` that already holds
  `complexity`, `max-depth`, and `max-lines-per-function`
  (`packages/*/src/**/*.ts`, `scripts/*/src/**/*.ts`).
- **Add `jscpd`** as `pnpm check:dup`, wired into `ci.yml` (CI-only, not
  pre-push, to keep that lane's wall-clock unchanged). `.jscpd.json` scans
  `packages/*/src` and `scripts/*/src`; threshold set to **4%** duplicated lines,
  just above the measured baseline (3.80% duplicated lines / 1437 of 37,858,
  across 238 files, 70 clones) so the gate catches regressions without an
  immediate false-red.
- **Reject the Sonar platform** — ADR-0015's rejection stands; a platform
  scanner would still overlap ESLint/coverage/CodeQL for everything except the
  two now-filled gaps, and would additionally require an `lcov` coverage
  reporter (not configured; vitest emits `text`/`html`/`json` only), a
  `sonar-project.properties`, and reconciling a second, divergent complexity
  model (Sonar's cognitive-complexity-only gate vs. this repo's existing
  cyclomatic gate) — none of which buys anything the OSS rules above don't
  already cover.
- **Reject Act + Podman** — only `ci.yml` is act-runnable, and its steps are
  `pnpm <script>` calls a contributor already runs directly; the pre-push
  lefthook stage already gates format/lint/typecheck/test/build/exports/agents
  locally before push. Podman would be a brand-new contributor prerequisite
  (nothing in the toolchain currently touches a container engine) for marginal
  value over what pre-push already provides. The other four workflows cannot run
  under `act` regardless of engine (GitHub API/OIDC/SARIF context, or no
  workflow file at all for CodeQL).

### Accepted debt from the cognitive-complexity rollout

Two pre-existing functions exceed the default cognitive-complexity threshold of
15 and carry a narrowly-scoped `eslint-disable-next-line` with a rationale
comment rather than a rule-wide exemption:

- `packages/m3l-common/src/aws/credentials/manager.ts` —
  `retryWithRelogin` (20 vs. 15). Security-sensitive SSO credential
  retry/relogin control flow.
- `packages/m3l-common/src/core/polling/M3LRetryRunner.ts` — `run` (17 vs. 15).
  Retry-classification control flow with load-bearing branch ordering
  (documented inline).

Both need a dedicated test-safety-net-first refactor pass (the repo's
`.claude/rules/refactoring.md` standard) to bring under threshold safely — out
of scope for a CI-tooling change. Any future refactor of either function should
also remove its suppression.

## Consequences

- **Positive:** cognitive complexity and duplication density are now gated
  (CI-blocking for duplication; lint-blocking, including pre-push, for cognitive
  complexity), closing the two gaps ADR-0015 identified as genuinely additive —
  without a new external platform, account, or dashboard. Contributor
  prerequisites are unchanged.
- **Negative / trade-offs:** two pre-existing functions carry documented
  suppressions until refactored; the jscpd threshold (4%) is calibrated to
  today's baseline and will need re-baselining if the codebase's duplication
  profile shifts substantially (e.g. a new script package copying patterns from
  an existing one).
- **Semver impact:** none — CI/tooling/governance only; no change to the
  package's public surface or runtime.

## Links

- Related: [ADR-0015](./0015-code-scanning-tooling-evaluation.md) (the original
  code-scanning tooling evaluation; this ADR extends it, does not supersede it),
  [ADR-0020](./0020-drop-release-automation.md) (package is internal/unpublished
  — corrects `scorecard.yml`'s stale "published package" wording, fixed
  alongside this ADR), [ADR-0001](./0001-toolchain-choices.md) /
  [ADR-0009](./0009-dependency-direction-guard.md) (minimal runtime/dev
  dependencies, platform-native preference — the driver behind declining Act/Podman).
- Related: `eslint.config.js`, `.jscpd.json`, `.github/workflows/ci.yml`.
