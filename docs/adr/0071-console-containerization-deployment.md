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

## Update (2026-08-27) — the posture as implemented

X2c (issue #550) shipped the loopback binding and the required operator
profile as enforced code rather than convention. Four points where the
implementation refines or corrects what this ADR recorded.

**"No listener binds beyond loopback" is now asserted after the bind, not
before it.** `listen()`'s host argument is a _request_; Node resolves it
independently, and the resolution is not what you would guess. Measured
against a real listener on Node v26.7.0: `localhost` binds to `::1`, **not**
`127.0.0.1`; omitting the host binds `::` — every interface. So
`lifecycle/http-server.ts` re-derives the bound address from
`server.address()` once `listening` fires and rejects any non-loopback
`AddressInfo`, a `null` address, or a UNIX socket path, closing the socket
before it throws. This holds for a programmatic caller who never went
through `loadConsoleConfig`, which a config-time check alone would not
cover.

**Loopback binding is not by itself a defence against a browser, so a
Host/Origin guard was added.** This ADR's threat model says single-operator
localhost, and treats binding as the boundary. It is not: any web page can
issue requests to `127.0.0.1`, and — measured — Node serves a request
bearing `Host: evil.example` with a 200. `http/origin-guard.ts` is
therefore the only control refusing a DNS-rebinding request. It compares the
`Host` hostname and deliberately **not** the port: under rebinding the
browser sends the attacker's hostname, so the hostname is the entire
defence, while comparing the port would reject every legitimate request
behind a compose published-port remap (`9000:8787`) — a deployment this ADR
explicitly ships. `Origin: null`, the sandboxed/`file://` origin, is
rejected explicitly; it arrives as a literal string, not a nullish value.

**The identity seam is wired, with one shipped provider, as recorded.**
`createSingleOperatorProvider` resolves every request to the profile
declared at boot; `http/auth-middleware.ts` enforces it per route and fails
closed when a route's auth mode is unknown. Health and readiness are
`auth: "exempt"` — a liveness probe must work before a session exists.
Multi-user (OIDC) remains a provider swap behind the X14 gate.

**A readiness grace period is deferred to X12.** `/ready` answers 503 once
draining, but with the shipped shutdown ordering — `drain()` then
`server.close()`, back to back — a client normally observes a connection
error instead, because `close()` destroys idle sockets at call time.
An orchestrator reads that as not-ready too, so the operational outcome is
unchanged; making the 503 itself observable needs a grace period between
drain-start and listener-close, which belongs with this ADR's compose health
wiring at X12.

Unchanged by this Update: the two-image packaging, the volume-passed
credential path, the non-root lifecycle, the ADR-0034/0015 stance
reconciliation, and the X14 remote/multi-user gate.

## Update (2026-09-03) — X12's networking and image choices

X12 (issue #560) chose a compose topology deliberately shaped to leave the
loopback invariant above **untouched** rather than amended, plus the web
image's base.

**Networking: `web` joins `server`'s network namespace
(`network_mode: "service:server"`), not a bridge network with a widened
bind.** `packages/m3l-console-server` encodes this ADR's loopback posture in
one predicate (`net/loopback.ts`'s `isLoopbackHost`) used at three
conceptually different points: whether a requested bind host is permitted
(`config/env.ts`), whether the bound address actually resolved loopback
(`lifecycle/http-server.ts`), and whether an inbound request's `Host`/`Origin`
names us acceptably (`http/origin-guard.ts`). Binding the server wide
(`0.0.0.0`) and republishing to host loopback would have required relaxing
that shared predicate for the first two call sites while leaving the third
untouched — a real distinction with no existing name in the code. Instead,
`server` keeps binding `127.0.0.1` exactly as this ADR requires; `web`'s
nginx reaches it over `127.0.0.1:8787` inside the shared namespace, so the
origin guard's `Host` check passes with no header rewrite and no code change
anywhere in `packages/m3l-console-server`. Only `web`'s port (8080) is
published to the host; 8787 is never published at all. This is stricter
than the "server binds wide, host publishes to loopback" shape it replaces,
not looser.

A companion refactor split `isLoopbackHost`'s three call sites into three
named predicates (`isPermittedBindHost`, `isVerifiedBoundAddress`,
`isAcceptedRequestHostname`) that still delegate to the same classifier —
behaviour-preserving, landed ahead of the container work so the distinction
this Update describes has a name in the code, not just in this prose.

**Web image: `nginxinc/nginx-unprivileged:1-alpine`**, not a hand-rolled
`node:http` static server. Because only `web`'s port is published, `web` is
not merely serving static assets — it is the reverse proxy for every
`/api`, `/health`, and `/ready` request, including the SSE run-stream
(`http/routes/run-stream.ts`), the console's live-tail feature. An
SSE-correct proxy (unbuffered, immediate per-event flush, abort propagation
on client disconnect) is materially riskier to own than a small, well-known
nginx config. This is judged consistent with CLAUDE.md's minimal-runtime-
dependency stance rather than an exception to it: that stance protects the
**published package's** dependency graph, and a container base image is
build/deployment infrastructure, not a runtime dependency of
`@m3l-automation/m3l-common` — the same category as the already-accepted
`vite` and `playwright`. `nginx-unprivileged` runs as uid 101 by default,
satisfying this ADR's non-root requirement with no custom `USER`.

**The X12 readiness grace period landed as planned**: a configurable delay
between `drain()` and `server.close()` in `lifecycle/shutdown.ts`, gated by
`M3L_CONSOLE_READINESS_GRACE_MS`, making the `/ready` 503 this ADR's prior
Update described actually observable by a compose healthcheck.

**Base-image update chores**, flagged as a new Dependabot-adjacent surface
in this ADR's Consequences, are handled by a `docker` ecosystem block added
to `.github/dependabot.yml`, tracking both the `node` and
`nginx-unprivileged` base images.

Unchanged by this Update: the two-image packaging, the volume-passed
credential path, the non-root lifecycle, and the X14 remote/multi-user gate.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Server
  lifecycle: [ADR-0065](./0065-console-server-architecture.md). Identity
  consumer: [ADR-0070](./0070-console-audit-and-observability.md).
  Volume contents: [ADR-0069](./0069-console-embedded-persistence.md).
- Stance reconciliation: [ADR-0034](./0034-sonar-act-podman-reassessment.md)
  (dated Update points here; local-CI decline reaffirmed),
  [ADR-0015](./0015-code-scanning-tooling-evaluation.md) (Update landed
  2026-09-03 alongside this one — Trivy adopted in the scheduled workflow).
