---
name: eslint-flat-config
description: >-
  How this repo's ESLint flat config (eslint.config.js) is structured and how to
  change it safely. Use whenever you are adding, removing, or scoping a lint rule;
  adding or editing an override block; adjusting `ignores`; wiring a new plugin;
  or debugging a typescript-eslint type-checked lint error (projectService,
  "parserOptions.project", TS5110/no-unresolved) in m3l-automation. Reach for it
  even when the user just says "our linter is complaining", "turn off this rule for
  tests", "why is eslint failing on this file", or "add an eslint rule" — anything
  touching eslint.config.js here. Not for generic ESLint questions about other
  projects (use the context7-mcp skill for those); this skill is specifically the
  m3l-automation flat config.
---

# ESLint flat config (m3l-automation)

The single source of lint truth is [`eslint.config.js`](../../../eslint.config.js)
at the repo root. It is an **ordered array** built with `tseslint.config(...)`.
There is no `.eslintrc`; flat config is the only format ESLint 10 supports.

## When to use

Editing `eslint.config.js`: adding/scoping a rule, adding an override block,
changing `ignores`, wiring a plugin, or debugging a type-checked-lint failure.

## How this config is laid out (top to bottom — order matters)

Later objects override earlier ones for the files they match, so the sequence is
deliberate:

1. **Global `ignores`** — a standalone object with only `ignores` (no `files`).
   Ignores `**/dist/**`, `**/node_modules/**`, `**/coverage/**`,
   `.claude/{agents,skills,rules,worktrees}/**`, and `.remember/**`. Note
   `bin/**` and `.claude/hooks/**` are deliberately **not** ignored — they are the
   only real code under `.claude/` and get their own block below.
2. **Shared presets, spread in** — `js.configs.recommended`,
   `...tseslint.configs.recommendedTypeChecked`, `importX.flatConfigs.recommended`,
   `importX.flatConfigs.typescript`. Flat config has **no top-level `extends` key**;
   you compose by spreading preset arrays/objects into the top-level array.
3. **`**/*.ts` (type-checked core)** — turns on `projectService`, sets the import
   resolver, and enforces the project's rules (`.js` extension via
   `import-x/extensions`, `no-explicit-any`, `no-floating-promises`, the CommonJS
   ban, `import-x/no-unresolved` ignoring `^@m3l-automation/`, etc.).
4. **`packages/*/src/**` (shipped source only)** — stricter
   design rules that must not trip tests or config: `tsdoc/syntax`,
   `import-x/no-default-export`, `complexity`, `max-depth`,
   `no-magic-numbers`.
5. **Public barrels** (`src/index.ts`, `src/core/index.ts`, `src/aws/index.ts`) —
   `import-x/no-restricted-paths` forbids re-exporting `internal/` (ADR-0004).
6. **`bin/**/*.mjs`, `.claude/hooks/**/*.mjs`** — plain ESM, no TS project;
   opts out of typed rules and enables `no-empty` / `no-shadow`.
7. **Tests** (`**/tests/**/*.ts`, `**/*.test.ts`) — relaxes dep rules but bans
   real filesystem mutations and bare `fetch()` via `no-restricted-syntax`.
8. **`bin/tests/**`** — disables `no-unsafe-*` (imports from untyped `.mjs`).
9. **Root config files** (`*.js`, `*.config.js`, `*.config.ts`) — opts out of
   typed linting.

## Patterns to follow when editing

- **Scope with `files` globs.** A new rule that should apply only to one area is a
  new object with its own `files` array — don't widen an existing block. Put it
  _after_ the block whose rules it must override.
- **Plugins are objects, rules are namespaced.** `plugins: { tsdoc }` then
  `"tsdoc/syntax": "warn"`. The `import-x` and `typescript-eslint` rules follow the
  same `namespace/rule` shape.
- **Type-checked rules need a project.** Blocks that use type-aware rules require
  `languageOptions.parserOptions.projectService: true` (+ `tsconfigRootDir`). Any
  file _outside_ a tsconfig project (root config files, `.mjs` scripts/hooks) must
  opt out with `extends: [tseslint.configs.disableTypeChecked]` and
  `projectService: false`, or you get "file not found in project" errors. Note
  per-block `extends` (an array) _is_ valid inside `tseslint.config()`, unlike the
  removed top-level `extends` key.
- **Severity** is `"off" | "warn" | "error"` (or `[severity, options]`).
- **Stale disable directives are errors** — `reportUnusedDisableDirectives: "error"`
  is set, so a `// eslint-disable` that no longer suppresses anything fails lint.
- **Globals** come from the `globals` package (`globals.node`), not hand-listed.

## Verify

Run `pnpm lint` (root ESLint). For a single file, `pnpm exec eslint <path>`. If a
type-checked rule misbehaves, confirm the file is included by a tsconfig that the
block's `projectService`/`tsconfigRootDir` can see.

## Full API reference

For the current ESLint 10 flat-config API surface (config object keys,
`defineConfig`, `languageOptions`, processors, the typescript-eslint typed-linting
setup), see [`references/eslint-flat-config.md`](references/eslint-flat-config.md).
