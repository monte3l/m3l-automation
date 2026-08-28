# 0067. Console frontend stack and the scoped bundler exception

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

`packages/m3l-console-web` is the repo's first browser-target code, and
the audit confirmed the collision squarely: [ADR-0001](./0001-toolchain-choices.md)
ratified "build with `tsc`, no bundler" (bundlers explicitly rejected),
the shared tsconfig is `module: nodenext` with no DOM lib, Vitest runs
Node-environment only, ESLint has no browser/JSX zones, and no dev-server,
CSS pipeline, or e2e framework exists. A browser SPA cannot exist without
a bundler and dev server — so the frontend needs both a stack decision
and a **scoped exception** to ADR-0001, following the gated-exception
shape ADR-0057 established for the (still-gated) SEA binary.

## Decision drivers

- **The UI is data-dense ops tooling**: JSON tree viewers with
  selectable/highlightable fields, virtualized result tables, live log
  tails, parameter forms generated from introspection — component
  ecosystem depth matters more here than framework minimalism.
- **One test runner**: the repo runs Vitest; the frontend should too.
- **TS strict end-to-end**, matching the workspace's non-negotiables.
- **The exception must not creep**: ADR-0001's stance must remain fully
  in force for every library and tool package.

## Considered options

1. **Lightweight / no framework** (Lit, vanilla + htmx-style). Rejected:
   closest to repo culture, but every data-dense component the console
   lives on would be hand-built and hand-maintained.
2. **Svelte 5 + Vite.** Rejected: excellent runtime profile, but the
   thinner ecosystem for exactly the components this app needs most
   (JSON viewers, data grids) shifts cost onto the maintainer.
3. **React 19 + Vite + TypeScript strict.** Chosen.

## Decision

We chose **option 3**.

- **Stack**: React 19, Vite (dev server + build), TypeScript `strict`
  with the workspace's severity; a deliberately thin dependency policy
  on top (component libraries admitted per need, each a normal
  Dependabot/license-policy citizen — ADR-0007/0036).
- **Testing**: Vitest with a browser-DOM environment for unit/component
  tests (the workspace keeps one runner); **Playwright** for end-to-end —
  the SQS drill-down scenario is X11's e2e acceptance. Playwright's CI
  cost (browser install + runtime) is decided at X9: a scoped or
  label-gated job rather than every-PR by default.
- **Workspace integration**: `m3l-console-web` carries its **own
  tsconfig** (DOM lib, bundler-mode resolution) — the composite-reference
  layout already permits per-package options, and `tsconfig.base.json`
  stays Node-only for everyone else; new **ESLint zones** for JSX/browser
  code (React hooks rules included) alongside the existing zones; the
  package registers with knip/coverage/gates like every workspace
  package.
- **The scoped bundler exception**: ADR-0001's no-bundler rule is
  **excepted for browser-target packages only** — a browser deliverable
  is a bundled artifact by nature, which is precisely the consumer-vs-
  build-tool distinction ADR-0002 already drew. Library packages
  (`m3l-common`), tool packages (`m3l-cli`, `m3l-mcp`,
  `m3l-console-server`), and scripts remain tsc-only, no bundler, ESM
  dist. ADR-0001 receives a dated Update block pointing here; its Status
  stays Accepted. **This exception does not unblock U14**: the Node SEA
  single-file binary still requires its own ADR per ADR-0057's gate —
  stated here and in the 0001 Update so the exception cannot be read
  expansively.

## Consequences

- **Positive:** the console's hardest UI problems (JSON selection,
  virtualized grids, live tails) land on the deepest available component
  ecosystem; one test runner across the workspace; the exception is
  fenced to the only package class that genuinely cannot exist without
  it.
- **Negative / trade-offs:** the repo's first browser dependency tree —
  the heaviest of the three options — grows the update/audit surface
  (dev-time and asset-build-time; the shipped artifact is static files);
  JSX/hooks are a new lint and review idiom; Vite config is a new
  toolchain artifact to maintain.
- **Semver impact:** none from this ADR (docs only). X9 adds a new
  private 0.x package; no `m3l-common` change.

## Update 2026-08-28 — Playwright CI-cost decision (X9b)

This ADR deferred one decision to X9's own PR: how expensive `ci.yml`
makes the Playwright suite by default. Landed as **path-scoped plus
label override**: `.github/workflows/ci.yml`'s `e2e` job runs when
`packages/m3l-console-web/**` or `packages/m3l-console-server/**`
changed (`bin/lib/changed-paths.mjs`'s new `console` category — narrower
than the broad `ts` one every other TypeScript change gates on), on any
PR carrying the `e2e` label regardless of what it touched, and
unconditionally on every push to `main`.

Considered and rejected: **label-gated only** (cheapest on PRs, but a
console change with no label would ship unverified until it hit `main`
— the opposite of what an e2e gate exists to catch); **main-only +
scheduled** (never blocks a PR, but pushes discovery of a broken drill-
down flow to post-merge, and X11's SQS scenario is exactly the kind of
regression a PR-time signal should catch before merge); **no CI job at
all, harness only** (ships `playwright.config.ts` and a smoke spec
runnable via `pnpm test:e2e` with zero CI wiring, deferring the
decision itself to X11 — rejected as not actually deciding what this
ADR named as X9's job to decide).

`pnpm verify` does not run the e2e suite by default either (a full
Chromium install is exactly the per-run cost being avoided) — `pnpm
verify -- --full` opts in locally, mirroring the `ci.yml` job's own
default-off-until-scoped posture.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Consumes:
  [ADR-0066](./0066-console-api-rest-sse.md).
- Excepted decision: [ADR-0001](./0001-toolchain-choices.md) (dated
  Update block points here; scope: browser-target packages only).
  Related: [ADR-0002](./0002-esm-only-output.md) (the consumer-vs-tool
  distinction), [ADR-0057](./0057-private-registry-distribution.md) (the
  gated-exception precedent; its U14/SEA gate is explicitly NOT opened
  by this ADR), [ADR-0007](./0007-dependency-management-strategy.md) /
  [ADR-0036](./0036-dependency-license-policy.md) (the processes the new
  tree joins).
