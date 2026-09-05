# Work log — podman-migration-stance (2026-09-03)

This log covers the docs-first PR (`docs/podman-migration-stance`) that bans
Docker and Dockerfiles from the project and decides Podman + Containerfiles +
a `podman kube play` pod manifest as the replacement, following on from X12
(issue #560, container images shipped 2026-09-03 via PRs #929/#936/#956). It
records the full historical recap (ADR lineage, build history, runtime
contract) three parallel Explore agents produced, the resulting decision
(new ADR-0091, dated Updates to ADR-0071/0015/0034/0069, and
`docs/contributing/ci-cd.md`), and a throwaway local spike that built and ran
both container images for the first time since X12 merged — finding and
fixing four real defects along the way, two of which were latent in the
original Docker setup and had nothing to do with the engine change.

Plan of record: a session-local plan file outside this repo
(`~/.claude/plans/on-issue-560-parsed-raccoon.md`), not a `docs/plans/`
tracker entry — the plan itself is recapped in full in this PR's ADRs.

## Summary

Files created/modified this PR: `docs/adr/0091-podman-replaces-docker.md`
(new), `docs/adr/README.md` (index row), `docs/adr/0071-console-containerization-deployment.md`
(dated Update), `docs/adr/0015-code-scanning-tooling-evaluation.md` (dated
Update), `docs/adr/0034-sonar-act-podman-reassessment.md` (third amendment +
Links), `docs/adr/0069-console-embedded-persistence.md` (dated Update +
Links), `docs/contributing/ci-cd.md` (§ Containers rewritten). No `src/` or
`tests/` paths touched — this PR is docs-only, per ADR-0072's docs-first
sequencing.

Research: three Explore agents ran in parallel (ADR lineage across
0001/0007/0015/0034/0064/0065/0069/0071 and their amendments; the X12 build
history via `git`/`gh` — timeline, defects, verification debt, ongoing
obligations; the runtime contract derived directly from
`packages/m3l-console-server/src/**`), followed by three more in parallel
(a full repo census of every Docker reference; the repo's forbidden-pattern
enforcement machinery, for the later gate PR; external Podman/alternatives
research with citations). A fourth wave (this session) re-confirmed the ADR
lineage against the raw files directly, since two of the parallel agents'
reports disagreed about whether ADR-0034 carries a later amendment (it does —
verified by reading the file).

Verification: a throwaway Step 0 spike (see below) actually built both
Containerfiles and ran a hand-written pod manifest with rootless Podman 6.1.0
on this host, executing — for the first time ever — the acceptance test X12's
own PR #956 declared and never performed. `pnpm verify` is expected to pass
clean on this docs-only PR (no code/test paths changed); markdown/format
gates apply to every new/changed file.

Skills used: `starting-work`, `writing-work-logs`.

Spoke incidents: none (no `tmp/session-incidents.jsonl` present this
session; none observed by recollection either).

Compaction events: none.

## What went as planned

- **The three-Explore-agent research pattern scaled cleanly.** Splitting
  "ADR lineage," "build history," and "runtime contract" into independent
  read-only investigations let each agent go deep without competing for the
  same files, and their outputs composed directly into the plan's Part 1
  recap with almost no reconciliation needed.
- **The decision matrix held up under spike evidence.** Every alternative
  rejected on paper (podman-compose, Docker-Compose-over-socket, Buildah
  alone, Quadlet, nerdctl, Devcontainers, Nix, dropping containers) stayed
  rejected after the spike — nothing the spike found changed the choice of
  Podman + Containerfile + pod manifest, only its exact implementation
  details (probe type, network backend, userns flag).
- **The graceful-drain acceptance test passed on the first real attempt.**
  `M3L_CONSOLE_READINESS_GRACE_MS`'s 503-during-drain behavior — designed,
  unit-tested, and shipped in X12's PR2, but never observed against a running
  container in any form — worked exactly as designed the first time it was
  actually exercised: `SIGTERM` → `/ready` returned
  `503 {"status":"draining"}` for the full grace window → clean exit 0.
- **The rootless-Podman-on-WSL2 healthcheck risk, flagged as the plan's
  single biggest open risk, did not materialize.** This host already has a
  working systemd user session, cgroup v2, and a functioning
  `podman healthcheck run` — the actual obstacle (below) was unrelated.

## What didn't go as planned, and why

### 1. `pnpm --prod deploy` fails outright on the exact pnpm version X12 pinned — under Docker too

The spike's first `podman build` of the server image failed at the
`pnpm --filter … --prod deploy /deploy` step with
`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`. Adding `--legacy` (as pnpm's own
error message suggested) got further but hit a second failure: `pnpm deploy`
is a distinct command from the parent `pnpm install --ignore-scripts` and
does not inherit that flag, so it reran install scripts for the deploy
target — and `better-sqlite3`'s install script fell through to
`node-gyp rebuild`, which failed with no Python in the image.

**Why it happened:** X12's PR3 (#956) merged this exact `pnpm --prod deploy`
line, and — per its own PR test-plan checkbox — `docker compose up --build`
was never run because no Docker daemon was available in that session. The
step had never once succeeded, under either engine; the defect was latent,
not introduced by this migration.

**Fix for future:** `pnpm --filter <pkg> --prod deploy /deploy --legacy --ignore-scripts`
— confirmed working. When a build step cannot be verified in the authoring
environment, say so explicitly (X12 did) and treat the unverified step as a
standing to-do for the very next opportunity to run it for real, rather than
letting time pass and the defect calcify as "shipped."

### 2. Podman requires fully-qualified image references

Both Containerfiles reference `node:24-slim@sha…` and
`nginxinc/nginx-unprivileged:…` — short names Docker resolves against its
configured default registry. Podman's first build attempt failed outright:
"short-name … did not resolve to an alias and no containers-registries.conf
was found."

**Why it happened:** Docker and Podman differ on short-name resolution by
design — Docker assumes `docker.io` when nothing else is configured; Podman
refuses to guess unless `unqualified-search-registries` is explicitly set,
precisely to avoid a short name silently resolving to an unexpected registry.

**Fix for future:** fully-qualify (`docker.io/library/node:24-slim@…`,
`docker.io/nginxinc/nginx-unprivileged:…@…`) rather than relying on host
registry configuration — portable across any Podman install, not just this
one once it's been configured (see item 4).

### 3. `HEALTHCHECK` is silently ignored under Podman's default build format

Both Containerfile builds emitted `HEALTHCHECK is not supported for OCI image
format and will be ignored. Must use \`docker\` format` — a warning, not a
failure, easy to miss in build output.

**Why it happened:** `podman build` defaults to the OCI image format;
`HEALTHCHECK` is a Docker-format-specific instruction with no OCI
equivalent. This is a genuine format difference, not a bug.

**Fix for future:** don't rely on a Containerfile's own `HEALTHCHECK` under
Podman — use the pod manifest's `livenessProbe`/`startupProbe` instead
(confirmed working independently, see item 4), and either drop the
now-inert `HEALTHCHECK` instruction or keep it explicitly documented as
inert-but-informative for someone running the image with plain `podman run`.

### 4. `podman kube play`'s `httpGet` probe runs `curl` inside the container, not from outside

With a `livenessProbe.httpGet` in the pod manifest, `podman ps` reported the
web container `(healthy)` but the server container `(unhealthy)` — even
though `/health` returned 200 correctly when queried directly. Inspecting the
generated container config
(`podman inspect … --format '{{json .Config.Healthcheck}}'`) showed Podman
had translated the Kubernetes-spec `httpGet` probe into
`["CMD-SHELL", "curl", "-f", "http://localhost:8787/health", "||", "exit", "1"]`
— a command executed **inside** the target container via exec, not an
external HTTP request the way a real Kubernetes kubelet performs it.
`node:24-slim` has no `curl` (the exact fact that made X12's own
`HEALTHCHECK` instruction use `node -e fetch(...)` in the first place), so
the probe failed for a reason unrelated to server health. The nginx-alpine
web image happened to have `curl` already, which is why only the server
showed unhealthy.

**Why it happened:** `podman kube play`'s Kubernetes-YAML compatibility is a
compatibility _layer_, not a literal reimplementation of kubelet probing
semantics — an assumption ("Kubernetes-spec YAML behaves like real
Kubernetes") that held for volumes, ports, and `terminationGracePeriodSeconds`
but not for `httpGet` probes specifically.

**Fix for future:** use `livenessProbe.exec` with the same command already
proven in the Containerfile's own (now-inert, see item 3) `HEALTHCHECK`
instruction — `["node", "-e", "fetch('http://127.0.0.1:8787/health')..."]` —
rather than `httpGet`, for any container whose base image cannot be assumed
to carry `curl`.

### 5. Rootless Podman's default network backend needs a binary this host didn't have

`podman kube play` failed on both containers with
`netavark: nftables error: unable to execute "nft": No such file or
directory`.

**Why it happened:** this host's Podman (installed via linuxbrew) defaults
to the `netavark` network backend, which shells out to `nft` for firewall
rules; `nftables` was not installed, and installing it needed interactive
`sudo` unavailable in this environment.

**Fix for future:** `podman kube play --network pasta` — Podman's rootless
user-mode networking backend, present on this host, needing no privileged
firewall tooling at all. Bake this into any wrapper script rather than
relying on `nft` being present; a distro-packaged Podman with `nftables`
preinstalled would not need it, but it is a safe default either way.

### 6. Rootless Podman does not map a container's uid to the host's matching uid by default

Even after fixing item 5, the server container failed at boot: "failed to
ensure the console store's parent directory exists" — despite the host
`./data` directory being correctly owned by the invoking host user (who
happens to be uid 1000, matching the container's `node` user).

**Why it happened:** rootless Podman maps container uid 0 to the invoking
host user, but higher container uids (like `node`'s uid 1000) map through a
_subordinate_ uid range (`/etc/subuid`) by default, not directly to the
matching host uid — a materially different model than Docker's default,
where the mapping is typically direct. The X12-era `compose.yaml` comment's
"uid-1000 ownership hazard" assumed the Docker model (a simple `chown`
fixes it); under rootless Podman a `chown` alone does not, because the
container process is never actually running as host uid 1000 without an
extra flag.

**Fix for future:** `podman kube play --userns keep-id` maps the invoking
host user's uid directly into the container, restoring the "just `chown`
the host directory" mental model X12's Docker-era documentation assumed.
Bake this into the run script unconditionally — the failure mode gives no
hint that a namespace flag, rather than a permissions fix, is the actual
cause.

## Lessons learned

- **A build step that "shipped" but was never executed carries real,
  undiscovered defects, independent of engine.** X12's PR3 shipped a
  `pnpm --prod deploy` line that had never once succeeded, under any engine —
  discovered only because this migration's spike finally ran it. When a PR's
  own test plan discloses an unexecuted verification step, treat it as
  unverified code, not shipped code, and prioritize actually running it at
  the very next opportunity rather than letting the gap age.
- **Podman's Kubernetes-YAML compatibility is a compatibility layer, not a
  literal reimplementation — verify each field's actual semantics, don't
  assume parity.** `httpGet` probes translate to an in-container `curl` exec
  rather than kubelet's external HTTP check; `terminationGracePeriodSeconds`,
  volumes, and ports behaved as expected. Test each Kubernetes-spec field a
  migration relies on individually rather than trusting the whole spec is
  faithfully implemented.
- **Rootless container uid mapping is a different model from Docker's, not
  just a rootless inconvenience — plan for it explicitly.** `--userns
keep-id` is not an optional nicety; without it, a correctly-`chown`ed host
  bind mount is still unwritable, with a failure message that gives no hint
  a namespace flag is the fix. Any host-mount-writing container under
  rootless Podman needs this decided up front, not discovered at boot
  failure.
- **A throwaway, no-commit spike before the real migration PR is worth its
  cost even when the design itself doesn't change.** Every architectural
  choice made on paper (Podman, Containerfile, pod manifest over compose)
  survived the spike unchanged — its value was entirely in surfacing
  implementation-level facts (probe type, network backend, userns flag, the
  latent `pnpm deploy` defect) that no amount of documentation research would
  have found, and that would otherwise have surfaced as a failed PR2 instead
  of a fixed one.
- **When two parallel research agents disagree on a factual claim, re-read
  the primary source yourself before writing it down.** One agent reported
  ADR-0034 has no later amendment; another reported it does. The file itself
  settled it in under a minute (it has a 2026-08-20 amendment scoping
  "container-free" to the toolchain) — cheaper than either agent's original
  research pass, and the disagreement would have propagated a real error
  into the ADR content if left unchecked. _(promoted →
  .claude/rules/subagent-dispatch.md, as one instance of "the executor
  wins" over an unexecuted claim)_

The remaining lessons from this log are Podman-specific operational facts,
not durable rules — this is the first Podman-specific task in the repo, so
it isn't yet clear which of them generalizes beyond "the first
container-engine migration always finds implementation-level surprises
documentation can't." Worth revisiting if a second such migration or a
Podman-adjacent task in this repo hits a similar class of issue.
