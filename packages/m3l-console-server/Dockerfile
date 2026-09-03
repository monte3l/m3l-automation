# syntax=docker/dockerfile:1.7
#
# Two-stage build for the console server (ADR-0071, X12/issue #560).
#
# `pnpm deploy` (not `COPY node_modules`) produces the runtime stage's
# dependency tree: a workspace `node_modules` is full of `workspace:*`
# symlinks back into `/repo`, which don't resolve once the builder stage is
# discarded. `deploy` writes real, self-contained copies instead.
#
# Build from the repo root: `docker build -f packages/m3l-console-server/Dockerfile .`
# (also what compose.yaml's `server` service does, via `context: .`).

FROM node:24-slim AS builder
WORKDIR /repo

# ADR-0001: no Corepack in this repo. pnpm is installed directly, pinned to
# the exact `packageManager` version — the same version pnpm/action-setup
# resolves for CI, just without Corepack as the install mechanism.
RUN npm install --global pnpm@11.9.0

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@m3l-automation/m3l-console-server...
RUN pnpm --filter @m3l-automation/m3l-console-server --prod deploy /deploy

FROM node:24-slim AS runtime
WORKDIR /app

# `Core.M3LPaths().getDataDir()` (config/paths.ts's `resolveStoreDatabasePath`
# calls it even when `M3L_CONSOLE_DB_PATH` is set) auto-detects MONOREPO mode
# by walking up for `pnpm-workspace.yaml` — a marker this image, containing
# only the deployed package, will never have. Force STANDALONE mode and
# anchor its base directory at the volume mount, or the server fails to boot.
ENV M3L_DEPLOYMENT_MODE=standalone
ENV M3L_DATA_DIR=/data
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /deploy /app

# The official image's non-root `node` user (uid 1000, home `/home/node`) —
# matches compose.yaml's host-SSO volume mount target.
USER node

EXPOSE 8787

# `node:24-slim` ships neither curl nor wget; the global `fetch` (Node 24) is
# the only HTTP client guaranteed present. Always targets 127.0.0.1 — the
# origin guard's Host check runs in `preRouting` ahead of this route too
# (main.ts), so a probe aimed at a service name or container IP gets a 400,
# not a 200.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "bin/m3l-console-server.mjs"]
