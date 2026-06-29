# 0011. Release and publishing workflow

- **Status:** Accepted
- **Date:** 2026-06-29
- **Deciders:** Enrico Lionello

## Context and problem statement

`@m3l-automation/m3l-common` has a nearly complete release pipeline
(`.releaserc.json`, `release.yml`, Conventional Commits enforced by
commitlint + lefthook), but the library scaffold is functionally near-empty:
only `core/errors` and `core/events` of 21 planned submodules are implemented.
`semantic-release` defaults the **first** release to `1.0.0`, so the next
releasable commit on `main` would publish `1.0.0` of an empty package to public
npm. The release machinery also lacks SLSA provenance attestation and uses the
implicit angular changelog preset rather than the explicitly-configured
`conventionalcommits` preset.

We need to:

1. Prevent a premature publish while keeping the pipeline continuously exercised.
2. Enable npm provenance attestation and satisfy its hard prerequisites.
3. Make the changelog preset explicit.
4. Make the automated CI + review gates truly blocking via branch protection.

## Decision drivers

- Publish nothing until the library is complete (all 21 submodules).
- Ship a single deliberate `1.0.0` when ready, not an incremental pre-release.
- SLSA provenance (`npm view` attestation) for supply-chain integrity.
- CI and Claude review as structural, non-bypassable merge gates.
- No new runtime dependencies; no lockfile churn for this change.

## Considered options

1. **Gate publish with a repo variable (`RELEASE_ENABLED`) — dry-run by
   default.** The workflow keeps running on every `main` merge but
   `semantic-release --dry-run` validates the full plugin chain without
   publishing. Flip the variable once all submodules land.
2. **Disable the `release.yml` workflow entirely until ready.** Simpler, but
   silent — plugin errors and mis-configurations are not caught until the
   go-live merge.
3. **Use a `next` pre-release channel.** Appropriate if incremental consumer
   feedback is needed; not appropriate here because nothing should appear on
   npm until `1.0.0`.

## Decision

We chose **option 1** (repo variable gate with dry-run default) because it
keeps the pipeline validated on every merge without publishing, requires a
single explicit action to go live (`gh variable set RELEASE_ENABLED --body
true`), and leaves no configuration to undo.

Additional choices made alongside this decision:

| Topic              | Decision                                                                     | Rationale                                                             |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Registry           | Public npm                                                                   | Matches `publishConfig.access: public`                                |
| First version      | `1.0.0`                                                                      | semantic-release default; no version-floor config needed              |
| Provenance         | Enabled (`NPM_CONFIG_PROVENANCE: "true"` + `publishConfig.provenance: true`) | Supply-chain integrity; requires `repository` field in `package.json` |
| Prerelease channel | None                                                                         | Nothing on npm until `1.0.0`                                          |
| Changelog preset   | `conventionalcommits` (explicit)                                             | Replaces implicit angular default; package already in the lockfile    |
| Branch protection  | Applied via `gh api`                                                         | Enforces `verify` + `review` as blocking required checks              |

## Consequences

- **Positive:** Every `main` merge exercises the full semantic-release plugin
  chain (verifyConditions, analyzeCommits, generateNotes, etc.) in dry-run mode.
  Mis-configurations surface in CI, not at go-live. When all 21 submodules land,
  a single `gh variable set RELEASE_ENABLED --body true` publishes an attested
  `1.0.0` with no further config changes.
- **Positive:** npm provenance produces a verifiable `dist.attestations` entry
  linking the published tarball to the specific GitHub Actions run and commit SHA.
- **Positive:** `conventionalcommits` preset is now explicit; any future config
  deviation (e.g. scopes, hidden commit types) is self-documenting in
  `.releaserc.json`.
- **Negative / trade-offs:** `verifyConditions` in dry-run still checks that
  `NPM_TOKEN` is set and valid. The secret must exist in the repository even
  during the build-out phase.
- **Semver impact:** None — this change affects release tooling only, not the
  public `exports` map or any exported type.

## Links

- Related: [branch-protection.md](../contributing/branch-protection.md) — the
  protection rule is now applied, not just intended.
- Related: [contributing.md](../contributing/contributing.md) — release section
  documents the `RELEASE_ENABLED` gate.
