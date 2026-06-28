# 0002. ESM-only output

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

`@m3l-automation/m3l-common` is a types-first Node.js library targeting Node 24+.
At the time of the initial release, the team needed to decide whether to publish
ESM-only, a CJS+ESM dual package, or a bundled CJS shim. The decision was made
implicitly; this ADR formalizes it so it is not relitigated.

## Decision drivers

- Faithful `.d.ts` emit from `tsc` with no bundler distortion.
- The target audience (Node 24+ scripts and modern bundlers) understands ESM
  natively.
- Minimal complexity; a dual package doubles the surface area to maintain and
  test.
- The `--profile esm-only` gate in CI catches any CJS bleed.

## Considered options

1. **ESM-only** (chosen) — `"type": "module"` in `package.json`; `exports` map
   exposes only `default` (ESM `.js`); no `require` condition; `tsc` with
   `"module": "nodenext"` and `"verbatimModuleSyntax": true`.
2. **CJS + ESM dual package** — publish both `dist/cjs/` and `dist/esm/`; add
   `require` and `import` conditions to the `exports` map; use a build step to
   emit both.
3. **Bundled CJS shim** — run a bundler (tsup/rollup) to produce a single
   `index.cjs` shim for CJS consumers; keep ESM as primary.

## Decision

We chose **ESM-only** because the library targets Node 24+ exclusively, where
native ESM is first-class. A dual package would require a bundler (rejected in
ADR 0001 for declaration-fidelity reasons), double the CI surface, and introduce
the subtle dual-package hazard (two module instances). Bundled CJS shims were
rejected for the same bundler reasons. The `attw --profile esm-only` gate
enforces this in CI.

## Consequences

- **Positive:** single output format; `tsc` declarations are faithful; no bundler
  in the critical path; `--profile esm-only` fails CI if a `require` condition is
  accidentally added.
- **Negative / trade-offs:** consumers using older CommonJS toolchains (Node 18
  or Jest without ESM config) cannot require the package. This is an accepted
  trade-off given the Node 24+ floor (ADR 0003).
- **Semver impact:** none (output format was ESM-only from the first commit; no
  existing consumers).

## Links

- Related: ADR 0001 (toolchain choices — `tsc`, no bundler), ADR 0003 (Node 24
  floor), `packages/m3l-common/package.json` (exports map), `tsconfig.base.json`,
  `package.json` (`check:exports` script).
