---
name: tsconfig-strict-esm
description: >-
  How this repo's TypeScript project is configured — the strict/ESM compiler
  options in tsconfig.base.json and the composite build-vs-tooling split — and how
  to change it without breaking the build. Use whenever you are editing any
  tsconfig*.json here, standing up a new package's tsconfig, adding a project
  reference, or debugging a compiler error tied to module resolution or strictness
  (TS5110 module/moduleResolution mismatch, TS2834/2835 missing ".js" extension,
  "composite may not disable declaration", exactOptionalPropertyTypes or
  noUncheckedIndexedAccess surprises). Reach for it even when the user says "add a
  package", "the build can't find my import", "why do I need .js in imports", or
  "loosen this compiler flag" — anything touching tsconfig in m3l-automation. Not
  for generic TypeScript language questions unrelated to this repo's config (use
  the context7-mcp skill for those).
---

# TypeScript strict ESM config (m3l-automation)

The shared options live in
[`tsconfig.base.json`](../../../tsconfig.base.json); every other tsconfig extends
it. The repo is **ESM-only, Node 24+, `strict: true`**, compiled with `tsc` (no
bundler), so the config choices are load-bearing — changing one can break emit,
resolution, or the `.d.ts` output that consumers rely on.

## When to use

Editing any `tsconfig*.json`, adding a package/project reference, or diagnosing a
compiler error about modules, extensions, or strictness.

## The project layout (why there are several tsconfigs)

- **`tsconfig.base.json`** — all the real compiler options; the single place to
  change a flag repo-wide. Sets `composite: true` and `declaration: true`.
- **`tsconfig.json` (root)** — a _solution_ file: `"files": []` plus `references`
  to the buildable projects. It builds nothing itself; it wires `tsc --build`.
- **`packages/m3l-common/tsconfig.build.json`** — the **emit** project: extends
  base, sets `rootDir: src`, `outDir: dist`, `tsBuildInfoFile`, and _excludes
  tests_. This is what produces shippable `dist/` (`.js` + `.d.ts`).
- **`packages/m3l-common/tsconfig.json`** — the **tooling** project (editor,
  ESLint typed linting, test type-checking): extends base but turns
  `composite`/`declaration`/`declarationMap` **off** and sets `noEmit: true`, and
  _includes tests_. It type-checks the world without emitting.

The build-vs-tooling split exists because emit wants a narrow, composite,
declaration-producing project, while the editor wants a broad, no-emit project
that also sees tests. Keep new packages on the same two-file pattern.

## Key options in base (and why they're set)

- **`module: nodenext` + `moduleResolution: nodenext`** must move together (a
  mismatch is TS5110). NodeNext is what makes this a real Node-ESM project.
- **Explicit `.js` on relative imports.** Under NodeNext, `import "./foo.js"` (not
  `"./foo"`), because `tsc` does not rewrite extensions and Node won't resolve
  without them. ESLint's `import-x/extensions` enforces the same thing.
- **`verbatimModuleSyntax: true`** — emit imports/exports as written; forces
  `import type` for type-only imports. Prevents surprise elision in ESM output.
- **`strict: true`** — the umbrella (noImplicitAny, strictNullChecks, …). Two
  extra strict flags are set _on top_ because they're **not** part of `strict`:
  - `noUncheckedIndexedAccess` — `obj[key]` is `T | undefined`; narrow before use.
  - `exactOptionalPropertyTypes` — `{ x?: T }` is not `{ x: T | undefined }`;
    don't assign explicit `undefined` to an optional prop.
- Also on: `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`,
  `forceConsistentCasingInFileNames`.
- **`declaration` + `declarationMap` + `sourceMap`** — ship faithful `.d.ts` and
  map back to source. **`composite: true`** enables project references and
  incremental builds; composite _requires_ `declaration`, so don't disable
  declaration while composite is on (the tooling project disables both together).
- **`skipLibCheck: true`** — skip type-checking `node_modules` `.d.ts` for speed.

## Editing guidance

- Change a flag **in base** to affect the whole repo; override in a leaf tsconfig
  only for a genuine per-project need (as the tooling project does for emit).
- A **new package** gets a `tsconfig.build.json` (emit) + `tsconfig.json`
  (tooling), and a `references` entry in the root solution file so
  `tsc --build` / `turbo run build` picks it up.
- Don't hand-loosen `strict` or the two extra strict flags to silence an error —
  fix the code; these flags encode project invariants.

## Verify

`pnpm typecheck` (turbo → `tsc`) and `pnpm build`. A resolution error usually
means a missing `.js` extension or a `module`/`moduleResolution` mismatch; a
"declaration" error usually means `composite` and `declaration` disagree.

## Full option reference

For the current TypeScript compiler-option semantics (NodeNext resolution rules,
the strict-flag breakdown, composite/references, interop constraints), see
[`references/tsconfig-strict-esm.md`](references/tsconfig-strict-esm.md).
