# X12 — containerization + compose (issue #560)

**Status: shipped** — three sequenced PRs: #929 (docs-first stance), #936
(loopback-predicate refactor + readiness grace period), and this PR
(Dockerfiles, compose, image scanning), closing issue #560 and ADR-0071's
deferred containerization work. Process narrative for PRs 1–2 is in
[`docs/logs/2026-09-03-x12-container-stance-and-loopback-refactor.md`](../../logs/2026-09-03-x12-container-stance-and-loopback-refactor.md).

## Context

Two dependency issues (X2/#550, X9/#557) blocked X12; both were closed
before this work started. The repo had zero containerization prior art —
no `Dockerfile`, `.dockerignore`, or compose file anywhere, and no workflow
built or scanned an image.

`packages/m3l-console-server` encoded ADR-0071's loopback-only posture in
one predicate, `isLoopbackHost`, used at three call sites asking three
different questions: may we _request_ this bind address (`config/env.ts`),
did we _actually_ bind somewhere safe (`lifecycle/http-server.ts`), and does
an inbound request _name_ us acceptably (`http/origin-guard.ts`). Those
three questions coincide on a host, but a naive "bind wide, publish to host
loopback" container shape would have needed punching a hole through a
single shared, security-load-bearing predicate to answer them differently.

## Approach / Decisions

- **Shared network namespace, not a widened bind.** `web` joins `server`'s
  network namespace (`network_mode: "service:server"`), so the server keeps
  binding `127.0.0.1` literally — all three call sites stay correct
  unchanged, and no security-relevant code moves. Only `web`'s port (8080)
  is published; 8787 never is, which is strictly less exposed than the
  naive shape.
- **`nginx-unprivileged:1-alpine` for the web image**, despite the
  minimal-runtime-dependency stance, because it is the only published port
  and therefore an SSE reverse proxy (the run-stream live-tail feature) —
  not merely a static file server. Reconciled in ADR-0071's Update as build
  infrastructure, not a runtime dependency of the published package, the
  same category as `vite`/`playwright`.
- **Trivy adopted in the scheduled `security-audit.yml` workflow**, not
  per-PR — the repo builds images but publishes none, so a scheduled scan
  was judged sufficient (ADR-0015's 2026-09-03 Update reassessing its
  original Trivy rejection).
- **Three independently-landable PRs** (ADR-0072): docs stance → code
  refactor → images, so the first two land with zero/near-zero reviewable
  diff and unblock the rest without waiting on the riskiest piece.
- **PR1 (#929)** — ADR-0015 and ADR-0071 dated Updates plus a new `ci-cd.md`
  Containers section, written in future tense (fixed in a review round
  after `docs-consistency-reviewer` caught an initial past-tense
  overclaim of not-yet-written work).
- **PR2 (#936)** — `net/loopback.ts` split into three named,
  independently-tested predicates (`isPermittedBindHost`,
  `isVerifiedBoundAddress`, `isAcceptedRequestHostname`) delegating to the
  unchanged `isLoopbackHost`; a new `M3L_CONSOLE_READINESS_GRACE_MS`
  setting and a conditional delay in `lifecycle/shutdown.ts`'s
  `runShutdownSequence`, so a compose healthcheck can observe `/ready`'s
  503 during a drain instead of a bare connection reset. `main.ts` was
  measured against the 25,000-char file-budget ceiling before editing and
  needed no extraction (23,266 chars after).
- **PR3 (this PR)** — `packages/m3l-console-{server,web}/Dockerfile`
  (multi-stage, `pnpm deploy` for a symlink-free runtime dependency tree,
  forced `M3L_DEPLOYMENT_MODE=standalone`/`M3L_DATA_DIR=/data` since
  `M3LPaths`' MONOREPO walk-up never finds `pnpm-workspace.yaml` inside an
  image), `docker/default.conf` (SSE-correct nginx reverse proxy:
  unbuffered, uncached, 1h read timeout), `compose.yaml` (the shared
  namespace, a 3s readiness grace period, a 30s `stop_grace_period`), a new
  `container-scan` job in `security-audit.yml` (Trivy, HIGH/CRITICAL
  fixable-only, SARIF to the Security tab), and two `docker`-ecosystem
  Dependabot entries. Deliberately did **not** add a
  `bin/lib/changed-paths.mjs` predicate for Dockerfile/compose paths —
  PR1's own `ci-cd.md` text already documents relying on the existing
  fail-open `forceAll` behavior as the accepted cost tradeoff for these
  rarely-touched paths, so adding a scoped predicate would have narrowed CI
  coverage against already-reviewed, merged documentation.

## Outcome

`docker compose up --build` runs the console as two non-root containers,
reachable only on host loopback, with health-gated startup and a graceful,
now-observable drain on stop. Docker was not available in the sandbox this
PR was authored in, so the compose topology is verified by code reading
(matching Node/nginx/Docker documented behavior) rather than a live
`docker compose up` run — the plan's own Open Risks section had already
flagged shared-namespace ergonomics as unverified; a first real run of
`docker compose up` remains the practical acceptance test for this PR.
