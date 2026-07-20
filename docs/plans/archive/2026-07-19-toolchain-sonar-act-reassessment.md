# Non-Claude toolchain: Sonar / Act+Podman re-assessment (2026-07-19)

**Status: shipped** (commit fbe0143, branch `feat/toolchain-complexity-duplication`)

## Context

The maintainer asked for an assessment of integrating Sonar tooling
(SonarQube/SonarCloud/SonarLint) and `act` (running GitHub Actions locally,
backed by Podman) into the dev workflow. A five-facet parallel-agent audit
(CI workflows/act feasibility, quality-gate overlap, security/supply-chain
overlap, local dev hooks, container-engine landscape) found the decisive
prior art immediately: [ADR-0015](../../adr/0015-code-scanning-tooling-evaluation.md)
had already formally evaluated and rejected the SonarQube/SonarCloud
_platform_ as redundant with ESLint's `complexity` rule, the 80% per-file
coverage gate, and CodeQL SAST. The audit confirmed that rejection still
held, but also surfaced two capabilities ADR-0015 explicitly named as
Sonar's residual value that remained genuinely unfilled: cognitive
complexity and copy-paste duplication density.

## Approach / Decisions

The audit's aggregated findings were put to the user across four questions:
which Sonar direction to take (platform vs. OSS-equivalent rules vs.
IDE-only vs. nothing), what to do about Act/Podman, what form the
deliverable should take, and whether to fold in three incidental
doc-drift findings. The user chose the narrowest sufficient path: **OSS
equivalents, no platform**; **skip Act/Podman with a documented decision**;
**ADR + accepted changes** (not assessment-only); **fold in the drift
fixes**.

Implementation (worktree `toolchain-complexity-duplication`, per
`/starting-work`) added `eslint-plugin-sonarjs` with only
`sonarjs/cognitive-complexity` enabled (not the plugin's full
`recommended` preset) in the existing source-only ESLint design block, and
`jscpd` as a new `pnpm check:dup` script wired CI-only into `ci.yml`
(threshold 4% duplicated lines, calibrated just above the measured 3.80%
baseline across `packages/*/src` + `scripts/*/src`, 238 files). Two
pre-existing functions — `M3LAWSCredentialsManager.retryWithRelogin`
(security-sensitive SSO retry/relogin) and `M3LRetryRunner.run`
(retry-classification with load-bearing branch ordering) — exceeded the
cognitive-complexity default and were given narrow, rationale-commented
`eslint-disable-next-line` suppressions rather than a blanket rule
exemption or an unreviewed inline refactor of security/reliability-critical
control flow. `docs/adr/0034-sonar-act-podman-reassessment.md` records both
the acceptance (extending, not superseding, ADR-0015) and the Act/Podman
rejection (only `ci.yml` is structurally act-runnable; its steps are
`pnpm` scripts a contributor already runs directly and pre-push already
gates; Podman would be a net-new contributor prerequisite against the
repo's minimal-deps posture, ADR-0001/ADR-0009). The three doc-drift fixes
— `scorecard.yml`'s stale "published package" wording (ADR-0020: the
package is internal/unpublished), a dead
`.github/workflows/dependabot.yml` ignore pattern in `claude-pr-review.yml`
(no such file exists; only `.github/dependabot.yml` does), and a missing
`timeout-minutes` on `ci.yml`'s `verify` job — landed alongside.

## Outcome

`docs/adr/0034-sonar-act-podman-reassessment.md` is Accepted. `eslint.config.js`
gates cognitive complexity (pre-push, via `pnpm lint`); `pnpm check:dup`
gates duplication (CI-only). No `exports`-map or public-API change — the two
`src/` edits are comment-only suppressions. Full gate sweep passed
(`lint`, `typecheck`, `test:coverage` — 3865 tests, `build`, `check:exports`,
`knip`, `check:agents`, `check:workflows-doc`, `check:cadence`, and the full
`/syncing-docs` reconciliation). PR pending.
