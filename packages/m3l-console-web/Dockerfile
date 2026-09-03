# syntax=docker/dockerfile:1.7
#
# Two-stage build for the console frontend (ADR-0071, X12/issue #560).
#
# Build from the repo root: `docker build -f packages/m3l-console-web/Dockerfile .`
# (also what compose.yaml's `web` service does, via `context: .`).

FROM node:24-slim AS builder
WORKDIR /repo

# ADR-0001: no Corepack in this repo. pnpm is installed directly, pinned to
# the exact `packageManager` version — the same version pnpm/action-setup
# resolves for CI, just without Corepack as the install mechanism.
RUN npm install --global pnpm@11.9.0

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@m3l-automation/m3l-console-web...

# `nginx-unprivileged` (not plain `nginx`): the only published port in
# compose.yaml belongs to this image, and it is the SSE reverse proxy for
# `/api/v1/runs/:id/stream` (docker/default.conf), not merely a static file
# server — see ADR-0071's Update for the minimal-dependency reconciliation.
# Already runs as uid 101 on port 8080; no custom USER/port needed.
FROM nginxinc/nginx-unprivileged:1-alpine AS runtime

COPY --from=builder /repo/packages/m3l-console-web/dist /usr/share/nginx/html
COPY packages/m3l-console-web/docker/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8080/"]
