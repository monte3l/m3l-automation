# TypeScript tsconfig — compiler-option reference snapshot

> **Provenance** — Source: Context7 `/microsoft/typescript/v6.0.2` (repo uses
> `typescript@6.0.3`). Snapshot: 2026-07-02. Patch delta only; option semantics
> below are stable across it. Refresh: re-run `/skill-creator` (or
> `ctx7 skills generate`) on a major bump.

Current semantics for the options this repo relies on, distilled for editing its
tsconfig set.

## Module & resolution (NodeNext)

- `module: "nodenext"` selects Node's ESM/CJS-aware output; `moduleResolution:
"nodenext"` selects the matching resolver. They must agree — a mismatch is
  **TS5110**. (`node20` is an alias; prefer the canonical `nodenext`.)
- Under NodeNext, **relative imports require an explicit extension** (`.js`,
  `.mjs`, `.cjs`). Bare package specifiers are fine; directory/`index` resolution
  is not. Missing/incorrect extensions surface as **TS2834 / TS2835**.
- `target` (syntax level, `es2024` here) is independent of `module` (output
  format). Both are set explicitly.
- `rewriteRelativeImportExtensions` exists (rewrite `./x.ts` → `./x.js` in emit)
  but this repo instead writes `.js` in source directly; don't mix approaches.

## Strictness

- `strict: true` turns on: `noImplicitAny`, `strictNullChecks`,
  `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`,
  `strictBuiltinIteratorReturn`, `useUnknownInCatchVariables`, `alwaysStrict`.
  Individual members can be toggled after `strict` for gradual adoption.
- **Not** included in `strict` (so set explicitly):
  - `noUncheckedIndexedAccess` — indexed access yields `T | undefined`.
  - `exactOptionalPropertyTypes` — optional `?` ≠ `| undefined`; assigning
    explicit `undefined` to an optional property is an error.
  - `noImplicitOverride`, `noFallthroughCasesInSwitch` — also opt-in.

## Interop constraints

- `verbatimModuleSyntax: true` — write imports/exports verbatim; type-only imports
  must use `import type`. Avoids elision differences in ESM.
- `isolatedModules: true` — each file must be transpilable alone (no cross-file
  type-only constructs at runtime); required for safe per-file tooling.
- Related flags in this family: `isolatedDeclarations`, `erasableSyntaxOnly`
  (not enabled here).

## Declarations, composite & references

- `declaration: true` emits `.d.ts`; `declarationMap: true` emits `.d.ts.map` for
  go-to-source through declarations. `sourceMap: true` for runtime debugging.
- `composite: true` enables project references + incremental build and **implies
  `declaration` is required** — disabling declaration while composite is on is an
  error. Composite projects also want a defined `rootDir` and emit
  `.tsbuildinfo` (`tsBuildInfoFile`).
- A **solution tsconfig** (`"files": []` + `references: [{ "path": … }]`) builds
  nothing itself; `tsc --build` walks the references in dependency order.
- Common split: a **build** tsconfig (composite, declaration, excludes tests,
  emits to `outDir`) and a **tooling** tsconfig (extends base, `composite:false`,
  `declaration:false`, `noEmit:true`, includes tests) for editor/lint/test type
  checks.

## Performance

- `skipLibCheck: true` skips type-checking of declaration files (mostly
  `node_modules`), trading a little safety for large build-time savings.

## Version notes

- These semantics are stable across TypeScript 6.0.x; no breaking changes between
  6.0.2 and the repo's 6.0.3.
