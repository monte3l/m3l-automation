# syntax=docker/dockerfile:1.7
#
# Two-stage build for the console frontend (ADR-0071, X12/issue #560).
#
# Build from the repo root: `docker build -f packages/m3l-console-web/Dockerfile .`
# (also what compose.yaml's `web` service does, via `context: .`).
#
# Both base images are pinned by digest, not just tag: a tag alone is a
# moving target, and `.github/dependabot.yml`'s new `docker` ecosystem
# entries only have something to bump if the Dockerfile pins a digest for
# them to update. A stale/incorrect digest fails the pull loudly (Docker
# verifies it cryptographically) rather than silently resolving to the
# wrong image.

FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS builder
WORKDIR /repo

# ADR-0001: no Corepack in this repo. pnpm is installed directly, pinned to
# the exact `packageManager` version — the same version pnpm/action-setup
# resolves for CI, just without Corepack as the install mechanism.
RUN npm install --global pnpm@11.9.0

COPY . .
# `--ignore-scripts`: the root `prepare` script (`lefthook install && node
# bin/install-merge-drivers.mjs`) needs a real git work tree and the `git`
# binary — `.git` is dockerignored and `node:24-slim` ships no `git` at all,
# so `prepare` fails the build outright otherwise. A follow-up `pnpm rebuild`
# is NOT needed and NOT safe here: bare `pnpm rebuild` targets the workspace
# root too and re-runs the same failing `prepare` hook. It's also moot —
# better-sqlite3 (ADR-0069's embedded store) ships a prebuilt binary
# (`gypfile: false`), so pnpm never triggers a native build for it regardless
# of `--ignore-scripts`.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec turbo run build --filter=@m3l-automation/m3l-console-web...

# `nginx-unprivileged` (not plain `nginx`): the only published port in
# compose.yaml belongs to this image, and it is the SSE reverse proxy for
# `/api/v1/runs/:id/stream` (docker/default.conf), not merely a static file
# server — see ADR-0071's Update for the minimal-dependency reconciliation.
# Already runs as uid 101 on port 8080; no custom USER/port needed.
FROM nginxinc/nginx-unprivileged:1-alpine@sha256:aa8c9087d36d93e9d650c5365f883b421e8214aedbad24ade52b844c583358f1 AS runtime

COPY --from=builder /repo/packages/m3l-console-web/dist /usr/share/nginx/html
COPY packages/m3l-console-web/docker/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8080/"]
