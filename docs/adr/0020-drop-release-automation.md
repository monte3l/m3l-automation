# 0020. Drop release automation

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Enrico Lionello

## Context and problem statement

[ADR-0011](0011-release-and-publishing-workflow.md) stood up a full
semantic-release pipeline (`.releaserc.json`, `release.yml`, npm publish with
provenance, GitHub releases, changelog generation, a Monte3L Release Bot App to
sign changelog commits, and a `RELEASE_ENABLED` repo-variable gate). That
pipeline was never taken live: the package was never published to npm.

`@m3l-automation/m3l-common` is consumed only as an internal workspace
dependency by automation scripts — it does not need to be published to a public
registry. Maintaining an unused publish pipeline is pure carrying cost: extra
devDependencies, a workflow and repo secrets to keep current, doc surface to
keep accurate, and Claude skills that teach a process we never run.

## Decision drivers

- The package is internal; nothing consumes it from npm.
- Remove unused machinery and its maintenance/security surface (release-bot
  secrets, `NPM_TOKEN`, provenance wiring).
- Keep the hygiene layers that stand on their own merit, independent of
  publishing.
- No breaking change to the public `exports` map — internal consumers still
  import the package by its subpath exports.

## Considered options

1. **Drop release automation entirely; treat the package as internal.** Delete
   `.releaserc.json`, `release.yml`, the semantic-release devDependencies, the
   release skills, and scrub all references. Manage `version` by hand.
2. **Keep the pipeline dry-run-gated (status quo, ADR-0011).** Continue paying
   the maintenance cost for a pipeline that is never taken live.
3. **Keep the pipeline but disable the workflow.** Leaves dead config and deps
   in the tree and silent drift risk.

## Decision

We chose **option 1**. Release automation is removed and the package is treated
as internal / never-published.

**Removed:** `.releaserc.json`; `.github/workflows/release.yml`; the
`semantic-release`, `@semantic-release/changelog`, and
`@semantic-release-extras/verified-git-commit` devDependencies; the empty
generated `CHANGELOG.md`; the `previewing-releases` and `semantic-release-config`
Claude skills; the `version`-field write guard (version is now hand-managed).
The `RELEASE_ENABLED` repo variable and the `NPM_TOKEN` / release-bot App
secrets are removed from GitHub repository settings (a manual, out-of-repo step).

**Kept, deliberately — these are not release-coupled:**

- **The exports-map contract** (`publint`, `attw`, `check:exports`,
  `check:api`). It validates ESM / type resolution that internal workspace
  consumers rely on; it is not a publish-only gate.
- **Signed-commit enforcement** (all three layers of
  [ADR-0016](0016-signed-commits-and-decision-gate.md)). It is a standalone
  security policy; only the release-bot exception was removed.
- **Conventional Commits linting** (`bin/lint-commit.mjs`, `commitlint.config.js`,
  the lefthook `commit-msg` hook). Retained for readable, consistent history —
  no longer to drive a semver computation.

## Consequences

- **Positive:** Smaller dependency tree (−200+ transitive packages), no unused
  workflow or release secrets to maintain, and documentation that matches
  reality.
- **Positive:** The commit convention and signed-commit policy survive on their
  own merit, decoupled from a publish pipeline.
- **Negative / trade-offs:** Publishing to npm later would require rebuilding a
  release pipeline. `version` in `package.json` is now hand-managed with no
  automation guarding it.
- **Semver impact:** None — this change affects tooling and docs only; the
  public `exports` map and every exported type are unchanged.

## Links

- Supersedes: [ADR-0011](0011-release-and-publishing-workflow.md)
- Related: [ADR-0016](0016-signed-commits-and-decision-gate.md) — signed commits
  survive as standalone policy; [ADR-0008](0008-commitlint-cli-replacement.md) —
  commit linting retained for hygiene.
