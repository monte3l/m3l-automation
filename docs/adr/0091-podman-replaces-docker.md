# 0091. Podman and Containerfiles replace Docker for the console's app containers

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

X12 ([ADR-0071](./0071-console-containerization-deployment.md), issue #560)
shipped the repo's first containerization on 2026-09-03: two digest-pinned
non-root Docker images, a `compose.yaml`, a scheduled Trivy scan, and two
Dependabot `docker` blocks. The maintainer has since required that Docker and
Dockerfiles be banned from the project outright, on three drivers: standards
purity (`Dockerfile`/Compose are vendor formats; Containerfile and the Kube
YAML spec are the open ones), licensing/vendor independence from Docker Inc.,
and the daemonless/rootless security model Docker's architecture lacks.

The ban is a constraint, not a question. This ADR answers what replaces
Docker, and records what a from-scratch build and run of the X12 artifacts —
never actually executed before this ADR — found.

## Decision drivers

- The three drivers above: standards purity, vendor independence, rootless/
  daemonless security.
- Preserve every standing commitment X12 made that does not depend on the
  engine: the two-image shape ([ADR-0064](./0064-m3l-console-programme.md)),
  volume-passed credentials, non-root lifecycle, and the loopback posture
  ([ADR-0071](./0071-console-containerization-deployment.md)).
- Minimal new contributor/operator prerequisite, consistent with
  [ADR-0001](./0001-toolchain-choices.md)'s platform-native preference and
  [ADR-0034](./0034-sonar-act-podman-reassessment.md)'s reason for declining
  Podman as a _local-CI_ affordance.
- Do not re-litigate ADR-0071's rejection of "bare-process local (no
  containers)" without new evidence — image builds having never run is new
  evidence; it is investigated, not assumed away.

## Considered options

1. **Podman + Containerfile + a `podman kube play` pod manifest.** Chosen.
2. **Podman + `podman-compose`.** Rejected — `podman-compose` handles
   `network_mode: "service:x"` worse than any of its other features
   (containers/podman-compose#407, #413, #522, #1186), which is precisely the
   shape X12 chose.
3. **Docker Compose v2 pointed at the Podman socket.** Rejected — keeps
   `compose.yaml` working, but it is a Docker-authored binary speaking a
   Docker API. A ban satisfied this way is cosmetic.
4. **Buildah alone.** Rejected — build-only, still needs a run story.
5. **Quadlet `.pod`/`.container` units.** Rejected for now, revisit at X14 —
   the best declarative run story on real Linux, but no Dependabot ecosystem
   exists for it (dependabot/dependabot-core#13066, open) and it needs a
   systemd user session, which is not guaranteed on every contributor's
   machine the way this repo's WSL2 reference environment happens to have one.
6. **nerdctl + containerd.** Rejected — best Compose fidelity of the
   alternatives, but absent from GitHub's hosted runners, needs a daemon, and
   rootless setup exceeds Podman's. No payoff over option 1.
7. **Devcontainers.** Rejected — solves editor environments, not "run two
   processes on a loopback port," and needs Docker or Podman underneath
   regardless.
8. **Nix.** Rejected — genuinely strong technically (reproducible,
   daemonless, no rootless story needed at all), but a wholly new toolchain
   for a single-maintainer project, no Dependabot ecosystem, and it would
   abandon the two-image shape ADR-0064/0071 ratified.
9. **Drop containers entirely; run both processes natively.** Rejected — the
   close call; see Consequences.

## Decision

We chose **option 1**: Podman, Containerfiles, and a `podman kube play` pod
manifest.

**Why Podman.** Containerfile is byte-identical Dockerfile syntax
(`podman-build(1)`: "A Containerfile uses the same syntax as a Dockerfile
internally"). It is rootless and daemonless by default. Dependabot's
`docker` ecosystem already resolves `Containerfile`
(`/dockerfile|containerfile/i`, dependabot-core#11141, merged 2024-12-17) —
the base-image update chores X12 stood up are not lost. Podman 6.1.x is
current; 5.8.4 is preinstalled on `ubuntu-latest`, so CI needs no new
toolchain install for the container-scan job.

**Why a pod manifest, not a ported `compose.yaml`.**
`network_mode: "service:server"` was already emulating a pod — a Podman pod
provides that shared network namespace natively, plus
`terminationGracePeriodSeconds`, `readOnly` volume mounts, and a
`livenessProbe` as first-class Kubernetes-spec fields, and it fixes the
inverted `ports:` placement X12's `compose.yaml` needed as a workaround for
`network_mode:`/`ports:` being mutually exclusive on the same service.
Accepted costs: no `depends_on: condition: service_healthy` (harmless here —
`nginx` proxies the literal IP `127.0.0.1:8787`, not a service hostname, so it
needs no startup DNS resolution and simply returns 502 until the server
answers) and no `readinessProbe` in `podman kube play` (liveness/startup
only — see the Probe design subsection below).

**Rootless-Podman realities, confirmed by actually building and running both
images for the first time** (recorded in full in
`docs/logs/2026-09-03-podman-migration-stance-and-spike.md`):

- Podman requires fully-qualified image references. `node:24-slim@sha…` and
  `nginxinc/nginx-unprivileged:…` are short names Podman refuses to guess a
  registry for; both Containerfiles now read `docker.io/library/node:24-slim@…`
  and `docker.io/nginxinc/nginx-unprivileged:…`. This is a scoped exception,
  not an inconsistency: `docker.io` here names a registry **hostname**, an
  external fact this project does not control, in the same category as "the
  GitHub Actions runner ships Docker regardless of this ADR." No
  equally-official mirror exists for either image outside Docker Hub;
  Chainguard's free tier only offers `:latest` (incompatible with digest
  pinning + Dependabot) and Red Hat UBI changes the base OS and the whole
  build. Both are out of scope here — one variable at a time.
- **`HEALTHCHECK` is silently ignored under Podman's default OCI build
  format** (`podman build` without `--format docker`) — confirmed via a build
  warning on both images. This does not weaken the design: the pod manifest's
  probes are the actual, working health mechanism (confirmed operational
  below); `HEALTHCHECK` was already redundant with them and is dropped from
  both Containerfiles rather than kept as inert documentation.
- **Probe design: `exec`, not `httpGet`.** `podman kube play` translates a
  Kubernetes `livenessProbe.httpGet` into a `curl` command run _inside_ the
  target container — unlike real Kubernetes, which probes from outside the
  pod. `node:24-slim` ships no `curl` (the same fact that made X12's original
  `HEALTHCHECK` instruction use `node -e fetch(...)` instead), so an `httpGet`
  probe against the server reports `unhealthy` for a reason unrelated to the
  application. Both containers' probes use `livenessProbe.exec` instead,
  running the same `node -e fetch(...)` / `wget --spider` commands the
  original `HEALTHCHECK` instructions already proved out.
- **`--userns keep-id` is required for the `./data` mount to be writable.**
  Rootless Podman does not map a container's uid 1000 to the invoking host
  user's uid by default — it maps through a subordinate uid range instead.
  Without `--userns keep-id`, the server failed to boot ("failed to ensure
  the console store's parent directory exists") even though the host
  directory was correctly owned — a different, more opaque failure mode than
  the `chown`-shaped "uid-1000 ownership hazard" X12's `compose.yaml`
  documented for Docker. `pnpm console:up` passes this flag unconditionally;
  it is not optional operator knowledge.
- **This host's rootless network backend (netavark) needs the `nft` binary**,
  which is not installed by every Podman packaging (this environment's
  linuxbrew install did not bring it, and installing it needs interactive
  sudo this environment does not have). `--network pasta` — Podman's
  user-mode networking backend — works without it and is what
  `pnpm console:up` uses. A distro-packaged Podman with `nftables` already
  present would not need this; the flag is a safe default regardless.
- **This host's Podman install shipped no `policy.json`/`registries.conf`** —
  a distro package normally provides both. A first-run local setup note
  documents provisioning `~/.config/containers/{policy.json,registries.conf}`
  once; this is host setup, not something the repo can carry.

**Confirmed working, end to end, for the first time** — this is the
acceptance test X12 declared ("a first real run of `docker compose up`
remains the practical acceptance test for this PR") and never performed:
`/health` and `/ready` both return 200 through the nginx proxy; the server's
port 8787 is unreachable from the host; both containers run non-root (`node`
uid 1000, `nginx` uid 101); the SQLite store persists correctly under the
host-mounted `./data`; `/api` proxying preserves the `Host` header the origin
guard requires; and a real `SIGTERM` produced `/ready` returning
`503 {"status":"draining"}` for the entire `M3L_CONSOLE_READINESS_GRACE_MS`
grace window, then a clean exit code 0 — the exact behavior that setting was
built for, verified operationally for the first time since it shipped.
`podman save` produces a valid tar for Trivy's `--input` mode; `trivy` itself
was not available to run locally and is verified in CI instead, where it
already runs.

**What the ban cannot achieve, stated plainly.** `ubuntu-latest` ships Docker
28.0.4, Compose 2.38.2, and Buildx 0.36.1 regardless of anything in this repo
or this ADR. This is a source-and-workflow-level ban — no repo file names
`Dockerfile`/`docker-compose.yml` and no script or workflow invokes `docker`
— not an environment guarantee, and it would be false to claim otherwise.

## Consequences

- **Positive:** all three drivers satisfied (open format, no vendor lock,
  rootless/daemonless) at near-zero migration cost — Containerfile syntax is
  unchanged from the Dockerfiles it replaces; Dependabot's base-image
  coverage carries over unmodified; the pod manifest is a better substrate
  than compose for a possible future Quadlet/Kubernetes deployment at X14;
  and, as a side effect of actually running the setup for the first time,
  two real defects that would have broken `docker build` identically
  (`pnpm --prod deploy` failing outright, then failing again on a
  `better-sqlite3` native-build attempt) are fixed rather than inherited.
- **Negative / trade-offs:** no `depends_on: condition: service_healthy` and
  no `readinessProbe` in `podman kube play` — both judged harmless per the
  Decision section above, but real losses relative to Compose's feature set;
  `M3L_CONSOLE_READINESS_GRACE_MS`'s originally-recorded justification ("so
  the `server` service's healthcheck observes the 503 during
  `docker compose stop`," ADR-0071's 2026-09-03 Update) no longer describes
  the mechanism — the setting is unchanged code, its rationale is restated in
  ADR-0071's paired Update; operators on a Podman install without `nft` or
  without pre-seeded `containers.conf` files hit two host-setup steps X12's
  Docker path never required, documented as first-run troubleshooting;
  Dependabot's Containerfile support is verified from `dependabot-core`'s
  source, not from GitHub's own ecosystems documentation page — confirmed
  empirically on this migration's branch rather than assumed.
  On **option 9 (drop containers)**, seriously weighed and rejected: it would
  satisfy all three drivers even more completely and delete every ongoing
  container obligation, but it requires reversing three already-accepted
  decisions in one motion — ADR-0071's explicit rejection of "bare-process
  local (no containers)," ADR-0064's chosen two-container shape over its own
  documented single-deployable alternative, and ADR-0015's already-reversed
  Trivy adoption premise — while stranding X14 (recorded as depending on
  X12). ADR-0071 also pre-empts the minimal-dependency argument specifically:
  a container base image is classified there as "build/deployment
  infrastructure, not a runtime dependency… the same category as the
  already-accepted `vite` and `playwright`," so dropping containers would not
  even recover that argument. Podman satisfies the stated drivers without
  spending any of this.
- **Semver impact:** none — infra/tooling only; no change to
  `@m3l-automation/m3l-common`'s public surface or runtime.

## Links

- Supersedes the Docker-specific parts of [ADR-0071](./0071-console-containerization-deployment.md)
  (paired dated Update records the engine change; the two-image shape,
  credential path, non-root lifecycle, and X14 gate are unchanged).
- Amends [ADR-0034](./0034-sonar-act-podman-reassessment.md) a third time —
  distinguishes Podman as the console's app-container engine (this ADR) from
  Act-via-Podman as a declined local-CI affordance (unchanged by this ADR).
- Amends [ADR-0015](./0015-code-scanning-tooling-evaluation.md) — Trivy now
  scans via `podman save` + `trivy image --input`, still scheduled-only.
- Related: [ADR-0064](./0064-m3l-console-programme.md),
  [ADR-0069](./0069-console-embedded-persistence.md) (`hostPath`, not
  Docker's "volume-mounted"), [ADR-0001](./0001-toolchain-choices.md).
- Evidence: `docs/logs/2026-09-03-podman-migration-stance-and-spike.md`
  (the from-scratch build/run this ADR's findings are drawn from).
