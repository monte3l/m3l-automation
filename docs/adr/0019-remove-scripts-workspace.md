# 0019. Remove the `scripts/` example-automation workspace

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** m3l-automation maintainers

## Context and problem statement

The monorepo shipped a second pnpm workspace, `scripts/*`, holding a single
`example-automation` package that consumed `@m3l-automation/m3l-common` via
`workspace:*`. Its original purpose was to demonstrate — and dogfood — the
`M3LScript` lifecycle framework end-to-end.

In practice the example consumer added maintenance surface (a second tsconfig
project reference, a knip workspace, an eslint `files` scope, a path-scoped rule,
a scaffolding skill, and branch-isolation guard paths) without shipping any
value: it is never published, real consumers live in their own repositories, and
`M3LScript` is already exercised by the library's own tests. The example drifted
into pure overhead that every tooling and governance change had to account for.

## Decision drivers

- Minimal maintenance surface — do not carry config, rules, and guards for a
  package that ships nothing.
- Keep the monorepo layout honest: one published package, no dead example code.
- `M3LScript` is a public library export exercised by the library's own tests;
  it does not need an in-repo consumer to prove it works.

## Considered options

1. Keep the `scripts/` workspace and the `example-automation` package as-is.
2. Keep an example but move it under `packages/` or into docs as a snippet.
3. Remove the `scripts/` workspace entirely, making this a single-package
   (`packages/m3l-common`) monorepo.

## Decision

We chose **option 3 — remove the `scripts/` workspace entirely** because the
example consumer added tooling and governance surface without shipping value,
`M3LScript` is already covered by the library's own tests, and real consumers
live in their own repositories. `M3LScript` remains a public export of
`@m3l-automation/m3l-common`; only the in-repo example workspace is removed.

## Consequences

- **Positive:** fewer moving parts — the workspace list, tsconfig references,
  knip config, eslint scope, branch-isolation guard, path-scoped rules, and the
  scaffolding skill no longer have to account for a `scripts/*` workspace.
- **Negative / trade-offs:** no in-repo, runnable example of the `M3LScript`
  lifecycle; consumers rely on the `docs/reference` spec and the library's tests
  instead.
- **Semver impact:** none. `scripts/` was a private dev workspace, never
  published; removing it does not touch the `exports` map or any public type.

## Links

- Supersedes / superseded by: supersedes the `scripts/`-workspace aspect of
  [ADR-0001](./0001-toolchain-choices.md).
- Related: `pnpm-workspace.yaml`, `tsconfig.json`, `knip.json`,
  `eslint.config.js`, `.claude/hooks/guard-branch-isolation.mjs`.
