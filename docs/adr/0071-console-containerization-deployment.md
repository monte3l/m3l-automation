# 0071. Console containerization and local-first deployment

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The console must be packaged, bound, and authenticated somewhere. The
audit confirmed the repo has zero containerization prior art and a
recorded stance to reconcile: [ADR-0034](./0034-sonar-act-podman-reassessment.md)
describes the repo as "deliberately container-free" (declining Act+Podman
for local CI), and [ADR-0015](./0015-code-scanning-tooling-evaluation.md)
states "this project ships no images". Meanwhile the maintainer's lean is
containerized deployment, and the console is used by exactly one operator
on their own machine against their own AWS estate today.

## Decision drivers

- **Containerized, per the maintainer's lean** — with the stance
  reconciliation made explicit, not silent.
- **Honest threat model**: build the auth that matches actual use
  (single operator, localhost) while making multi-user a provider swap,
  not a retrofit.
- **Credentials never in images**: the existing host SSO chain remains
  the only credential path (the `aws.profile` seam philosophy).
- **Identity-complete audit** (ADR-0070 requires an operator identity in
  every record).

## Considered options

1. **Authenticated multi-user from day one (OIDC).** Rejected: an
   identity-provider dependency for a single-operator local tool; the
   posture belongs in the gated remote ADR where it has real
   requirements.
2. **Cloud-deployed from day one.** Rejected: the heaviest infra and
   security posture before the first button exists.
3. **Bare-process local (no containers).** Rejected: abandons the
   decoupling/containerization lean and the clean two-artifact shape for
   no gain over compose.
4. **Local-first containers with an identity/auth seam.** Chosen.

## Decision

We chose **option 4**.

- **Packaging**: two container images — `m3l-console-server` and
  `m3l-console-web` (static assets behind a minimal web server) — with a
  **docker/podman compose** definition as the canonical way to run the
  console. Interim single-deployable packaging (server statically
  serving the web build) is permitted during X-phases; the two-container
  shape is the ratified end state.
- **Binding**: localhost only. No listener binds beyond loopback in this
  posture; remote exposure is the X14 gate.
- **Identity**: a **declared operator profile** (name at minimum) is
  required to use the console and lands in every ADR-0070 audit record.
  The HTTP layer carries a real **auth/session middleware seam** whose
  only shipped provider is the single-operator local one — multi-user
  (OIDC) later means writing a provider and the X14 ADR, not
  retrofitting auth into an unauthenticated API.
- **Credentials**: AWS credentials are **volume-passed from the host**
  (the SSO/config chain the whole fleet already uses) — never baked into
  images, never stored by the console. The store file and artifact
  directories live on a mounted volume (`data/`), so containers stay
  disposable.
- **Lifecycle**: images run as non-root; compose wires the ADR-0065
  health/readiness endpoints and stop-signal → graceful-drain path.
- **Stance reconciliation**: ADR-0034 receives a dated Update — its
  "container-free" description covered the _toolchain_; the Act/Podman
  local-CI decline **stands unchanged**; the console introduces
  application containers as a new artifact class under this ADR.
  ADR-0015's "ships no images" sentence becomes false only when X12
  ships the first image — **its Update is deferred to X12's PR**, and
  the same PR reassesses image scanning (whether the existing scanning
  stance extends to container images); this ADR records that trigger.
- **Gates recorded**: **X14** — remote/multi-user deployment behind a
  dedicated future ADR (exposure surface, OIDC posture, multi-operator
  identity, TLS); nothing here may preclude it, nothing opens it.

## Consequences

- **Positive:** `compose up` → open browser is the whole operational
  story; the audit trail is identity-complete from the first click;
  disposable containers + one volume make backup/reset trivial; the
  stance history stays coherent (no silent contradiction of 0034/0015).
- **Negative / trade-offs:** the repo takes on image builds and base-
  image update chores (a new Dependabot-adjacent surface, handled at
  X12); localhost-only means no access from other machines until X14;
  single-operator auth is deliberately not a security boundary against
  local processes — the threat model documents this honestly.
- **Semver impact:** none from this ADR (docs only). X12 produces infra
  artifacts (Dockerfiles, compose), not package API changes.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Server
  lifecycle: [ADR-0065](./0065-console-server-architecture.md). Identity
  consumer: [ADR-0070](./0070-console-audit-and-observability.md).
  Volume contents: [ADR-0069](./0069-console-embedded-persistence.md).
- Stance reconciliation: [ADR-0034](./0034-sonar-act-podman-reassessment.md)
  (dated Update points here; local-CI decline reaffirmed),
  [ADR-0015](./0015-code-scanning-tooling-evaluation.md) (Update
  deferred to X12's PR — trigger recorded above).
