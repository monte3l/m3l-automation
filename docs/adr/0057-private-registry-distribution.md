# 0057. Distribute the CLI and its fleet via a private GitHub Packages registry

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

[ADR-0020](./0020-drop-release-automation.md) removed the never-used
semantic-release pipeline and declared the library internal /
never-published. That stance predates the CLI-first programme (ADR-0053):
a product CLI that can only run from a checked-out monorepo is not a
distributable product, and the maintainer has decided distribution is part
of the end state.

Distribution collides with today's architecture in one specific place:
`m3l-cli` discovers scripts by scanning the workspace and spawns their
`dist/main.js`. Outside the monorepo there is nothing to scan and nothing
built to spawn. ADR-0054's restructure (scripts as real dependencies of the
CLI, with an in-process seam) is therefore the prerequisite that makes any
distribution mechanism workable — which is why distribution is phased after
it.

## Decision drivers

- **Smallest viable revision of ADR-0020:** end the unpublished stance;
  keep everything of 0020 that stands on its own merit.
- **Keep the toolchain stance intact:** ADR-0001/0002 (tsc-only, no bundler,
  ESM-only) must not be violated by the chosen mechanism.
- **Security posture changes must be deliberate and scoped:** CI currently
  holds no publish credentials at all — a repo security rule, not an
  accident.
- **Private by default:** nothing here needs public npm.

## Considered options

1. **Stay workspace-internal forever.** Rejected by the programme decision
   (ADR-0053): it forecloses the distributable-product pillar.
2. **Public npm.** Rejected: no external consumers; needless exposure.
3. **Single-file binary first (Node SEA).** Rejected as the first step: SEA
   needs a bundled entry, which contradicts ADR-0001/0002's no-bundler /
   ESM-only stance; it forces the most invasive execution-model change
   (nothing to spawn on the host at all); and it adds a cross-platform build
   matrix — all before any distribution value is proven.
4. **Phased: private GitHub Packages npm registry first; SEA later, gated.**
   Chosen.

## Decision

We chose **option 4**.

### Phase B — private npm registry (U13, after ADR-0054's restructure)

- **Registry:** GitHub Packages, private to the owner — the repo's existing
  auth domain, no new vendor.
- **Publish set — the fleet moves together:** `@m3l-automation/m3l-cli`,
  `@m3l-automation/m3l-common` (the CLI depends on it `workspace:*`; pnpm
  rewrites `workspace:*` to the real version at pack time), and every
  `scripts/*` package the CLI declares as a dependency (ADR-0054's
  workspace-plugins model). Publishing the fleet as real packages was chosen
  over `bundledDependencies` (opaque tarball-in-tarball, defeats per-package
  auditability) and over a bespoke packaging step (new machinery ADR-0020
  existed to avoid).
- **Versioning:** versions remain **hand-managed** (ADR-0020's surviving
  rule) and move in lockstep across the published set per release — one
  version number per release train, matching the "fleet released with the
  CLI" trade-off accepted in ADR-0054.
- **Credentials:** a publish-scoped token is added to GitHub Actions
  **for the release workflow only** — a deliberate, recorded change to the
  "CI has no publish credentials" rule. The token must not be readable by
  PR-triggered workflows; the release workflow is manually dispatched by the
  maintainer. `docs/contributing/` security prose and CLAUDE.md's security
  section are updated when U13 ships, not before.

### What survives of ADR-0020 (partial supersession, enumerated)

- **Superseded:** "internal / never-published"; the absence of any release
  workflow.
- **Survives:** hand-managed `version` (no semantic-release, no version
  computation from commits); no changelog automation; Conventional Commits
  and signed-commit enforcement on their own merit; the exports-map contract
  gates (`publint`/`attw`/`check:exports`/`check:api`) — which now guard a
  genuinely published artifact.

### Phase C — single-file binary (recorded, not opened)

A Node SEA (or equivalent) binary remains a **gated future step**: its
unblock condition is a dedicated ADR granting a scoped bundler exception to
ADR-0001/0002 and defining the build matrix. Tracked as U14, filed
Deferred. This ADR deliberately does not open that gate.

## Consequences

- **Positive:** the CLI becomes installable outside the monorepo
  (`npm install` from the private registry) with the smallest possible
  change to standing decisions; every published artifact passes the
  already-existing exports gates; the security-posture change is scoped to
  one manually-dispatched workflow.
- **Negative / trade-offs:** release becomes a real recurring chore
  (hand-managed lockstep versions across ~16 packages); a publish-scoped
  credential exists in CI at all; consumers need GitHub Packages auth
  configured to install.
- **Semver impact:** none from this ADR (docs only). U13 is a publish event,
  not an API change; from first publication onward, strict semver applies to
  published versions.

## Links

- Partially supersedes: [ADR-0020](./0020-drop-release-automation.md)
  (enumeration above).
- Programme: [ADR-0053](./0053-cli-first-evolution-programme.md).
  Prerequisite restructure:
  [ADR-0054](./0054-command-module-contract-and-hybrid-execution.md).
- Related: [ADR-0001](./0001-toolchain-choices.md) /
  [ADR-0002](./0002-esm-only-output.md) (the stance Phase C would need an
  exception to), [ADR-0004](./0004-exports-map-contract.md) (the contract
  the publish gates guard).
