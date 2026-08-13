# @m3l-automation/m3l-cli

Script-facing CLI for the m3l-automation workspace: discovery, introspection,
and guided execution over the `configParameters` seam declared by every
`scripts/*` package (ADR-0042).

## Usage

```bash
pnpm m3l list              # enumerate all automation scripts
pnpm m3l inspect json-etl  # show a script's declared parameters
pnpm m3l help              # usage
```

Build first (`pnpm build` at the workspace root) — the CLI prefers each
script's compiled `dist/config.js` for discovery and its own `dist/` for
execution.

## Contract

The full command contract, design invariants, exit-code conventions, and
cache layout live in [`docs/reference/cli.md`](../../docs/reference/cli.md).
The activation record and phased build-out are ADR-0042 and the m3l-cli
build-out tracker in `docs/plans/IMPLEMENTATION.md`.

## Boundaries

- Zero runtime dependencies: only `@m3l-automation/m3l-common`
  (`workspace:*`) and `node:` builtins, enforced by ESLint + `check:zones`.
- No `exports` map — this package is bin-first (`m3l`) and nothing in it is
  importable by other packages.
- `src/` modules are import-inert; `bin/m3l.mjs` is the only process entry.
