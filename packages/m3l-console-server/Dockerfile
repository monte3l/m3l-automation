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
#
# `node:24-slim` is pinned by digest, not just tag: a tag alone is a moving
# target, and `.github/dependabot.yml`'s new `docker` ecosystem entries only
# have something to bump if the Dockerfile pins a digest for them to update.
# A stale/incorrect digest fails the pull loudly (Docker verifies it
# cryptographically) rather than silently resolving to the wrong image.

FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS builder
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
RUN pnpm exec turbo run build --filter=@m3l-automation/m3l-console-server...
RUN pnpm --filter @m3l-automation/m3l-console-server --prod deploy /deploy

FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS runtime
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
