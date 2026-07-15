# 0029. Consumer scripts depend only on @m3l-automation/m3l-common

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Enrico Lionello

## Context and problem statement

ADR-0027 hardened the AWS SDK boundary: scripts never import `@aws-sdk/*`,
and the library grows a typed operation wrapper the first time a consumer
needs one. But its context section also recorded — and thereby left standing
as accepted — a wider precedent: script-local, AWS-adjacent external
dependencies for future fleet entries (`eks-ops` → `@kubernetes/client-node`,
`apigw-client` → `@smithy/signature-v4`, `data-query` → `pg`/`mongodb`),
"each gated by own PR review" per `docs/ROADMAP.md`.

The 2026-07-15 fleet-governance audit surfaced the contradiction: the
project's operating constraint is that scripts rely **only** on the
m3l-common library, with no external dependencies at all — a rule stated in
two 2026-07-13 work logs and implied by ADR-0022 §7, yet machine-enforced
only for the `@aws-sdk/*` subset (`eslint.config.js` override) and
contradicted outright by the ratified passage above. All four shipped
scripts (`json-etl`, `sqs-etl`, `dynamo-crud`, `logs-insights`) already
comply: their `package.json` dependencies are exactly
`{"@m3l-automation/m3l-common": "workspace:*"}` with no devDependencies.

## Decision drivers

- One mediation seam for every external capability a script touches: uniform
  `M3LError` taxonomy, trivially mockable step tests, AWS-shape (and any
  other SDK-shape) knowledge lives in the library once — the same drivers
  that decided ADR-0027, applied past the `@aws-sdk/*` boundary.
- Supply-chain surface: with scripts dependency-free, the library's
  `package.json` is the single audit point for every runtime dependency in
  the monorepo (`check:deps`, Dependabot, `pnpm audit` all converge there).
- A rule with exceptions "gated by PR review" is not a rule a scaffold or a
  check script can enforce; a hard boundary is.

## Considered options

1. **Keep the ADR-0027-era exception** — the hard ban stays scoped to
   `@aws-sdk/*`; future script-local deps remain ratified, gated by PR
   review.
2. **Hard boundary, no exceptions** — scripts declare exactly one runtime
   dependency, `@m3l-automation/m3l-common` (`workspace:*`), and no
   devDependencies (tooling lives at the workspace root); every future
   capability need is met by growing a typed library wrapper.
3. **Exception-per-ADR gate** — default is m3l-common-only; any script-local
   dependency requires its own dedicated ADR before scaffolding.

## Decision

We chose **option 2: a hard dependency boundary with no exceptions.**

Consumer scripts under `scripts/*` declare exactly one runtime dependency —
`@m3l-automation/m3l-common` via `workspace:*` — and no devDependencies.
ADR-0027's per-consumer-need wrapper pattern is unchanged and reaffirmed; it
is now the **only** path to new capability, not the preferred one.

This **supersedes in part ADR-0027**: the context passage recording
script-local, AWS-adjacent dependencies as "an accepted, ratified pattern"
(`eks-ops` → `@kubernetes/client-node`, `apigw-client` →
`@smithy/signature-v4`, `data-query` → `pg`/`mongodb`) no longer holds.
ADR-0027's actual decision — typed wrappers per consumer need, the
`@aws-sdk/*` ESLint ban — stands in full.

Consequences for the planned W4 fleet entries (rows updated in
`docs/ROADMAP.md`):

- `data-query` → **`athena-query`**: Athena-only via the library
  (`@aws-sdk/client-athena` is already an m3l-common dependency); the
  `pg`/`mongodb` targets are dropped from fleet scope.
- **`eks-ops`**: rescoped to EKS control-plane operations via
  `@aws-sdk/client-eks`; kubectl-level workload operations are out of scope
  (no `@kubernetes/client-node`).
- `apigw-client` → **`api-gateway-client`** (rename per ADR-0028): SigV4
  request signing is provided by a future library wrapper (e.g. an
  `aws/signing` submodule owning `@smithy/signature-v4` as a _library_
  dependency — AWS SDK family), never script-local.

Enforcement today covers only the `@aws-sdk/*` subset
(`eslint.config.js` override banning `@aws-sdk/*` under `scripts/*/src/**`);
`bin/check-deps.mjs` governs the library package only. Closing the gap is
follow-up T6 in `docs/ROADMAP.md`: a check asserting every
`scripts/*/package.json` dependencies block is exactly the library, plus an
optional ESLint hardening banning all bare imports in `scripts/*/src` except
`@m3l-automation/m3l-common` and `node:` builtins.

## Consequences

- **Positive:** the constraint the fleet already lives by is now written and
  supersedes its own contradiction; scripts stay SDK-free and mock-friendly;
  one `package.json` to audit; scaffold and CI can enforce a hard rule (T6).
- **Negative / trade-offs:** capabilities whose natural client is not an AWS
  SDK (Kubernetes workloads, Postgres, MongoDB) are out of fleet scope until
  a deliberate library-level decision admits a wrapper for them — a real
  narrowing of W4 ambitions, accepted knowingly.
- **Semver impact:** none from this ADR (documentation). Future wrappers it
  forces into the library land as additive `./aws` barrel exports — minor,
  per ADR-0027's established pattern.

## Links

- Supersedes / superseded by: **supersedes in part
  [ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md)** (the script-local
  dependency passage only; its decision stands).
- Related: [ADR-0028](./0028-aws-service-naming-convention.md) (companion
  governance decision from the same audit);
  [ADR-0022](./0022-reintroduce-scripts-workspace.md) §7 (the `aws.profile`
  seam this boundary builds on); [ADR-0017](./0017-dependency-loading-standard.md)
  (dependency declaration standard for the library side);
  `docs/ROADMAP.md` Governance follow-ups T6 (enforcement) and the W4 row
  redesign; `.claude/rules/scripts.md` (agent-facing extract of this rule).
