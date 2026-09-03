# Ban Docker; adopt Podman + Containerfiles + a pod manifest (issue #560 follow-up)

**Status: shipped** — three sequenced PRs: #978 (docs-first ADR-0091 stance,
plus dated Updates to ADR-0071/ADR-0015/ADR-0034/ADR-0069), #983 (the
migration: Containerfile renames, `console-pod.yaml`, `console:up`/
`console:down`, Podman-based image scanning), and this PR (the `check:no-docker`
enforcement gate). Closes the maintainer's stated requirement that Docker and
Dockerfiles be banned from the project outright, on standards-purity,
licensing/vendor-independence, and rootless/daemonless security grounds.
Process narrative: `docs/logs/2026-09-03-podman-migration-stance-and-spike.md`
(PR1) and `docs/logs/2026-09-03-podman-containerfiles-migration.md` (PR2).

## Context

X12 (issue #560, shipped 2026-09-03 as #929/#936/#956/#969/#970) had already
shipped the repo's first containerization: two digest-pinned non-root images,
`compose.yaml`, a scheduled Trivy job, and two Dependabot `docker` blocks —
but **`docker compose up` was never once run** by anyone before this follow-up
started. The maintainer then required Docker be banned project-wide, making
what replaces it the actual decision this plan had to make, on top of a full
re-reading of every container decision X12 and its ancestor ADRs (0001, 0007,
0015, 0034, 0064, 0065, 0069, 0071) had already made.

## Approach / Decisions

- **Podman + Containerfile + a `podman kube play` pod manifest**, not
  `podman-compose` (handles `network_mode: "service:x"` — X12's exact shape —
  worst of all its features), not a Docker-socket shim (cosmetic ban
  compliance), not Quadlet (no Dependabot ecosystem yet, needs a systemd user
  session WSL2 doesn't reliably provide), and not dropping containers
  entirely (would reverse three already-accepted ADR decisions and strand
  X14, which depends on X12).
- **A pod manifest instead of a compose rewrite**, because `compose.yaml`'s
  `network_mode: "service:server"` was already emulating a pod — the Kube
  spec gives `terminationGracePeriodSeconds`, `livenessProbe`, `hostPath`,
  and pod-level `ports` as first-class fields natively, and fixes the
  inverted-`ports:` wart `network_mode:`/`ports:` mutual exclusion had
  forced on X12.
- **A scoped `docker.io/` exception**: Podman requires fully-qualified image
  names, and `node:24-slim`/`nginxinc/nginx-unprivileged` have no equally-
  official mirror outside Docker Hub. Treated as an external registry-hostname
  fact, not a re-admission of the banned tool — the enforcement gate (PR3)
  allowlists it explicitly rather than pretending otherwise.
- **A throwaway spike (Step 0, before PR1) that actually built and ran both
  images for the first time since X12 shipped** — the decisive move of this
  plan. It found four real defects (a broken `pnpm --prod deploy` that would
  have failed under Docker too, unqualified image names, a Podman-ignored
  `HEALTHCHECK` instruction, `podman kube play`'s `httpGet`→in-container-`curl`
  translation) and two host-environment realities (`--network pasta`,
  `--userns keep-id`), all folded into PR2 with zero re-discovery needed.
- **Three independently-landable PRs** (ADR-0072): docs stance → migration →
  gate, so the stance is on the record before artifacts move, and the gate
  cannot fail on artifacts mid-rename.
- **PR1 (#978)** — new ADR-0091, dated Updates to ADR-0071 (canonical run path,
  rewritten `READINESS_GRACE_MS` rationale), ADR-0015 (Trivy via `podman save`
  → `trivy image --input`), ADR-0034 (third amendment: operators now need
  Podman, not Docker), and ADR-0069 (`hostPath`, not "volume-mounted").
- **PR2 (#983)** — the actual `git mv` renames (`Dockerfile`→`Containerfile`,
  `.dockerignore`→`.containerignore`, `compose.yaml`→`console-pod.yaml`,
  `docker/default.conf`→`container/default.conf`), `bin/console-up.mjs`/
  `console-down.mjs`, `security-audit.yml`'s `podman save`-based scan, and the
  full acceptance test the plan required — including the one gap the spike
  left open, a live SSE run-stream test, which surfaced (and self-corrected)
  a test-harness bug rather than a real defect. Two mistakes were self-caught
  in-flight: an unrequested `CMD` line, and — more seriously — an unverified
  plan claim that `pnpm-workspace.yaml`'s `allowBuilds.better-sqlite3` entry
  was vestigial, which would have broken every plain `pnpm install` had it
  shipped.
- **PR3 (this PR)** — `bin/check-no-docker.mjs` + `bin/lib/docker-ban-scan.mjs`
  (modeled on `bin/check-control-chars.mjs`), wired into `lefthook.yml`'s
  pre-push chained lane and `ci.yml`'s `gates` job, plus this archival and a
  fix to X12's now-stale `IMPLEMENTATION.md` row prose (still described
  `compose.yaml`/`docker` after PR2's renames).

## Outcome

The console runs as two OCI images under rootless Podman, built by
Containerfiles and run by a Kubernetes-style pod manifest, with zero
Docker-named artifacts or `docker` invocations left in the repo and an
enforced gate preventing their return. Unlike X12, this migration was
actually run end-to-end: `/health`/`/ready` through nginx, non-root uids, a
real `SIGTERM` drain observed at `/ready` 503 for the full grace window, data
persistence with correct rootless-uid ownership, and a live SSE run-stream
with working `last-event-id` resume were all verified against the real
committed files, not spike copies. Dependabot's `docker` ecosystem block was
empirically confirmed (post-PR2-merge) to already resolve `Containerfile`
paths — two live digest-bump PRs were open within the same session. The one
item this plan could not verify locally — a real `trivy image --input` scan
of a `podman save` tarball — is deferred to CI, where Trivy actually runs, the
same class of residual gap X12 itself left in digest-pinning-via-`WebFetch`.
