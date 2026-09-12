# U13 — private-registry publishing: scope rename + staged first release (2026-09-12)

- **Status:** in progress — slices 1-2 of 4 landed (PR #1214, #1216), slice 3 in progress
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0103](../adr/0103-publish-scope-rename-and-staged-first-release.md)
  (partially supersedes [ADR-0057](../adr/0057-private-registry-distribution.md)
  — namespace, credential, and publish-set corrections).
- **Why this plan exists:** issue [#537](https://github.com/monte3l/m3l-automation/issues/537)
  (U13) asks to execute ADR-0057 as written, but the GitHub Packages npm
  registry requires the package scope to equal the owning GitHub account —
  `@m3l-automation/*` cannot be published under org `monte3l`. Investigating
  that blocker also surfaced that GitHub Packages' npm registry still
  authenticates with classic PATs only (no fine-grained PAT, no GitHub App
  token), so the "publish-scoped credential" ADR-0057 described does not
  exist as such. Renaming the scope to `@monte3l` resolves both at once: the
  namespace matches the org, which makes the ephemeral per-job
  `GITHUB_TOKEN` sufficient — no durable secret needed. This wave also stages
  the first release down to `m3l-common` alone; the 19-package fleet publish
  ADR-0057 described is deferred as its own follow-up.

## Scope and sequencing

| Stage | Contents                                                                                                  | Shape                                                                |
| ----- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **1** | ADR-0103 + this plan doc                                                                                  | Docs only; records the decision before any code changes              |
| **2** | Rename `packages/m3l-common` to `@monte3l/m3l-common` behind a pnpm workspace alias                       | Behavior-preserving; every existing import specifier keeps resolving |
| **3** | Publish plumbing: `publishConfig`, `release.yml` (`workflow_dispatch` only), `check:publish-version` gate | New CI surface; no secret stored, uses ephemeral `GITHUB_TOKEN`      |
| **4** | Optional: migrate `@m3l-automation/m3l-common` import specifiers to `@monte3l/m3l-common`, drop the alias | Hygiene only; not required for the publish to work; may be deferred  |

Full design detail (exact gate/config edits, verification commands, risks) lives
in the plan-mode transcript this wave started from — re-derive it fresh at each
slice's start rather than trusting a paraphrase to still be accurate.

## Landing plan

ADR-0072's durable slice record for this non-submodule multi-PR wave — the
same `## Landing plan` heading and `| Slice | Branch | Scope | Status |`
table a submodule's reference page carries, gated by
`pnpm check:landing-plans`.

| Slice | Branch                                | Scope                                                                                                                                                                                                                                | Status            |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| P1    | `feat/u13-registry-publish-adr`       | ADR-0103 amending ADR-0057 + this landing-plan doc (Stage 1)                                                                                                                                                                         | Landed (PR #1214) |
| P2    | `feat/u13-registry-rename`            | Rename `m3l-common` to `@monte3l/m3l-common` behind a workspace alias (Stage 2)                                                                                                                                                      | Landed (PR #1216) |
| P3    | `feat/u13-registry-release-workflow`  | `publishConfig`, `release.yml`, `check:publish-version`, consumer install docs, security-prose update (Stage 3)                                                                                                                      | In progress       |
| P4    | `feat/u13-registry-specifier-cleanup` | Migrate import specifiers to `@monte3l/m3l-common`, drop the alias; also fix ~671 stale `@m3l-automation/m3l-common` occurrences in `packages/m3l-common/src/**` TSDoc `@example` blocks (Stage 4, optional — PR #1216's Should-fix) | Not started       |
