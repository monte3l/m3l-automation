# @m3l-automation/m3l-console-web

Frontend for the m3l operations console (ADR-0064): a Vite + React 19 SPA,
TypeScript `strict` throughout, talking to `@m3l-automation/m3l-console-server`
over REST/SSE (ADR-0066). It is the repo's **first browser-target package**
(ADR-0067) — every other workspace package builds with `tsc`, no bundler
(ADR-0001); this one cannot exist without both, so it carries a scoped
exception to that rule rather than reopening it. The exception is fenced to
browser-target packages only — `m3l-common`, `m3l-cli`, `m3l-mcp`, and
`m3l-console-server` stay tsc-only, no bundler, ESM `dist`.

## Usage

```bash
pnpm console:server   # backend, one terminal (see packages/m3l-console-server/README.md)
pnpm console:web      # this package's dev server, another terminal
```

`pnpm console:web` starts Vite's dev server. Its dev-only proxy forwards
`/health` and `/ready` to the console server's default loopback bind
(`127.0.0.1:8787`), so the shell's health check works against the real
backend without the browser needing CORS handling. Nothing else is wired
yet — the run-launcher, session drill-down, and every other feature arrive
with X10 onward. What exists today is the toolchain and one working
round trip: a page load, a fetch to `/health`, and a rendered result.

```bash
pnpm --filter @m3l-automation/m3l-console-web build     # vite build -> dist/
pnpm --filter @m3l-automation/m3l-console-web preview   # serve the built bundle
```

## Toolchain

- **Build**: Vite (dev server + production bundle) — the scoped ADR-0001
  exception; `tsconfig.build.json` exists only to satisfy
  `bin/check-scaffold.mjs`'s root-reference requirement and give `tsc -b`
  a type-check surface, not to emit what ships.
- **Types**: this package's `tsconfig.json` extends the shared
  `tsconfig.base.json` but overrides its Node-only defaults — `module:
"ESNext"` + `moduleResolution: "bundler"`, DOM libs, `jsx: "react-jsx"`.
  Every other package keeps the base's `nodenext`/no-DOM shape.
- **Lint**: a dedicated ESLint zone in the root `eslint.config.js` adds
  browser globals and React hooks rules on top of the workspace's TS-strict
  base; this package's source may not import a `node:` builtin (browser
  code cannot reach one) the same way `m3l-cli`/`m3l-console-server`'s
  zones ban everything _except_ `node:` and `@m3l-automation/m3l-common`.
- **Unit/component tests**: Vitest with a `jsdom` environment
  (`vitest.web.config.ts` at the repo root — the workspace's fourth Vitest
  config, alongside the Node, bin, and integration ones), same perFile
  coverage thresholds as every other package.
- **End-to-end**: Playwright (added in a follow-up PR alongside its CI-cost
  decision, recorded as a dated Update on ADR-0067).

Full rationale: [ADR-0067](../../docs/adr/0067-console-frontend-stack.md).
