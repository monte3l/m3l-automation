# 0103. Rename the publish scope to `@monte3l` and stage U13's first release to `m3l-common` alone

- **Status:** Accepted
- **Relations:** partially-supersedes: 0057 (clauses: the registry namespace `@m3l-automation` → `@monte3l`; the CI credential from a long-lived publish-scoped token to the ephemeral per-job `GITHUB_TOKEN`; the publish set from the whole fleet in lockstep to `m3l-common` alone for the first release, with the fleet publish deferred)
- **Date:** 2026-09-12
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

[ADR-0057](./0057-private-registry-distribution.md) chose GitHub Packages as
U13's registry, publishing `@m3l-automation/m3l-cli` +
`@m3l-automation/m3l-common` + every `scripts/*` package in lockstep, behind
a publish-scoped CI credential. Attempting to execute that decision surfaces
a constraint ADR-0057 never recorded: the GitHub Packages npm registry
requires the npm scope to equal the owning account. GitHub's own docs define
`NAMESPACE` in a scoped package name as "the name of the user or
organization account to which the package will be scoped"
(<https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry>).
This repo's packages are scoped `@m3l-automation/*`; the owning GitHub
organization is `monte3l`. Publishing `@m3l-automation/m3l-common` under
`monte3l` is rejected outright (`owner not found`) — the mismatch is not a
configuration detail to work around, it is disqualifying as stated.

A second constraint compounds the first: as of September 2026, the GitHub
Packages npm registry still authenticates publishes with a **classic**
personal access token only — "GitHub Packages only supports authentication
using a personal access token (classic)"
(same URL) — with no fine-grained-PAT or GitHub App equivalent, and no
changelog entry adding one. A classic PAT is scoped to the whole user
account, not to one package or repository, so it is not the "publish-scoped
credential" ADR-0057 described; it is a durable, broad secret. The one
credential that both is scoped to a single workflow run and matches the
package's own namespace is the ephemeral, per-job `GITHUB_TOKEN` — but that
token can only publish packages owned by the workflow's own repository
owner (<https://docs.github.com/en/actions/concepts/security/github_token>),
which requires the scope to already equal `monte3l`.

The two constraints resolve together: renaming the scope to `@monte3l`
removes the credential problem at the same time as the namespace problem,
because it makes `GITHUB_TOKEN` sufficient.

## Decision drivers

- **Execute what was actually decided, not a variant of it:** ADR-0057's
  intent (private GitHub Packages, hand-managed lockstep versions, a
  manually-dispatched release workflow) stands; only the namespace,
  credential, and first publish set need correcting against reality.
- **No durable publish secret if one can be avoided at all** — stronger than
  ADR-0057's own bar ("CI has no publish credentials" as a deliberate,
  scoped exception), achievable here specifically because the namespace fix
  and the credential fix are the same fix.
- **Smallest reversible first step:** prove the publish mechanics on one
  package before committing to lockstep versioning across the whole fleet.
- **Keep the public option open:** the maintainer may want external/public
  consumers later; the chosen scope must not foreclose that.

## Considered options

1. **Publish as-is under `@m3l-automation/*`.** Rejected: disqualified by
   the scope==owner rule above; not executable.
2. **Create a new GitHub organization named `m3l-automation`** and publish
   there, keeping the scope. Rejected as the primary path: the workflow
   repository (`monte3l/m3l-automation`) and the package-owning organization
   would differ, so the ephemeral `GITHUB_TOKEN` cannot publish across that
   boundary — only a classic PAT belonging to a user who is a member of both
   organizations would work, reintroducing the durable-credential problem
   this ADR is trying to avoid. Cross-organization repository-linking
   behavior is also undocumented. Transferring the repository itself into
   the new organization would resolve both, but moves the repository's home
   for a naming preference alone — out of proportion to the problem.
3. **Rename the publish scope to `@monte3l/*`.** Chosen. Namespace now
   matches the existing organization; `GITHUB_TOKEN` becomes sufficient;
   `@monte3l` is unclaimed on both GitHub and npmjs.org, so the rename does
   not collide with anything and keeps a later public-npm option open.
4. **Publish the whole fleet in lockstep, per ADR-0057, in the same change
   as the namespace fix.** Rejected for the first release: conflates two
   independent risks (a scope rename that touches ~1,100 files, and a
   19-package lockstep release with no prior publish experience). Deferred;
   see Decision.

## Decision

We chose **option 3** for the namespace, plus a staged publish set narrower
than ADR-0057's.

### Namespace

Only `packages/m3l-common` is renamed, from `@m3l-automation/m3l-common` to
`@monte3l/m3l-common`. No other package in the workspace is being published
in this release train (see below), so no other package needs to change
name. The rename is executed behind a pnpm workspace dependency alias
(`"@m3l-automation/m3l-common": "workspace:@monte3l/m3l-common@*"`), which
pnpm rewrites to `"npm:@monte3l/m3l-common@<version>"` at pack time — every
existing `@m3l-automation/m3l-common` import specifier across the 20
in-repo consumers keeps resolving unchanged. Migrating those specifiers to
the new name directly is optional follow-up hygiene, not a precondition for
publishing.

### Credential

The release workflow authenticates with the workflow's own ephemeral
`GITHUB_TOKEN` (`permissions: packages: write`, `workflow_dispatch` only),
not a stored personal access token. No durable publish secret is added to
this repository. This is a stronger position than ADR-0057 anticipated
("a publish-scoped token is added to GitHub Actions") and survives only
because of the namespace fix above.

### Publish set — staged

The first release publishes **`@monte3l/m3l-common` alone.** `m3l-cli` and
the 17 `scripts/*` packages remain unpublished and `private: true`,
deferred to a follow-up (tracked on issue #537 or a successor). This is
narrower than ADR-0057's "the fleet moves together," accepted as a
deliberate first step: it proves the registry, the workflow, and the
version-immutability handling on one already publish-shaped package
(non-private, real `files`/`exports`/`prepack`) before extending the same
mechanism to nineteen packages that currently are not publish-shaped at
all (all `private: true`, most at `version: 0.0.0`).

### What survives of ADR-0057

GitHub Packages as the registry; private by default; hand-managed versions
(no semantic-release); Conventional Commits and signed-commit enforcement;
the exports-map contract gates (`publint`/`attw`/`check:exports`/
`check:api`); the manually-dispatched, never-PR-triggered release workflow
shape; Phase C (the Node SEA binary, U14) remains gated behind its own
future ADR and is untouched by this decision.

## Consequences

- **Positive:** the publish is actually executable; no durable secret is
  introduced; the `@monte3l` scope stays available for a future public
  release; the first release's blast radius is one package, not nineteen.
- **Negative / trade-offs:** the workspace briefly carries two names for one
  package (the real name and the `@m3l-automation/m3l-common` alias) until
  the optional specifier-migration follow-up lands; the fleet publish
  ADR-0057 described is now a distinct, not-yet-scheduled follow-on rather
  than part of this release; a maintainer relying on ADR-0057's "install the
  whole fleet from the registry" framing will not get that from this release
  alone.
- **Semver impact:** none from this ADR (docs only). The `m3l-common` rename
  and first publish are tracked as their own changes with their own semver
  reasoning.

## Links

- Partially supersedes: [ADR-0057](./0057-private-registry-distribution.md)
  (enumeration above).
- Landing plan for this wave:
  [docs/plans/2026-09-12-u13-registry-publish.md](../plans/2026-09-12-u13-registry-publish.md).
- Tracking issue: [#537](https://github.com/monte3l/m3l-automation/issues/537).
- Evidence for the scope==owner and classic-PAT-only claims:
  <https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry>,
  <https://docs.github.com/en/actions/concepts/security/github_token>.
