# ESLint flat config — API reference snapshot

> **Provenance** — Source: Context7 `/eslint/eslint/v10.5.0` (repo uses
> `eslint@10.6.0` + `typescript-eslint@8.62.0`). Snapshot: 2026-07-02.
> Patch/minor delta only (10.5.0 → 10.6.0); flat-config API is stable across it.
> Refresh: re-run `/skill-creator` (or `ctx7 skills generate`) on a major bump.

Current flat-config facts, distilled for editing this repo's `eslint.config.js`.
The repo composes its config with `tseslint.config(...)` (typescript-eslint's typed
helper), which is a thin, type-checked wrapper over the same flat-config array.

## Config object shape

A flat config is an **array of config objects**, evaluated in order. Each object
may contain:

- `files` — glob(s) this object applies to (relative to `eslint.config.js`).
- `ignores` — glob(s) to exclude. An object with **only** `ignores` (no `files`)
  is a **global** ignore.
- `languageOptions` — `{ ecmaVersion, sourceType, globals, parser, parserOptions }`.
- `linterOptions` — e.g. `reportUnusedDisableDirectives`.
- `plugins` — an object mapping a namespace to an imported plugin module:
  `plugins: { tsdoc }`.
- `rules` — `{ "namespace/rule": "error" | "warn" | "off" | [severity, options] }`.
- `settings` — shared data for plugins (e.g. the import resolver).
- `processor` — `"namespace/processor-name"` for non-JS sources.
- `extends` — **per-block only**, an array of configs merged into that block
  (typescript-eslint supports this inside `tseslint.config()`).

## Composition (no top-level `extends`)

Flat config removed the `.eslintrc` `extends` key. Compose by **spreading** shared
flat configs into the top-level array:

```js
export default tseslint.config(
  { ignores: ["**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked, // an array → spread it
  importX.flatConfigs.recommended,
  { files: ["**/*.ts"], rules: {/* overrides */} },
);
```

`defineConfig` from `"eslint/config"` is the vanilla equivalent when not using the
typescript-eslint helper; it provides the same array structure with type hints.

## Files / ignores

- Both use glob patterns relative to the config file.
- A config object can carry both `files` (include) and `ignores` (exclude within
  that block).
- Later objects override earlier ones for overlapping `files` — ordering is how
  you layer stricter rules onto a subset (e.g. shipped `src/**` after `**/*.ts`).

## languageOptions

- `ecmaVersion`, `sourceType: "module"`.
- `globals` — merge predefined sets from the `globals` package
  (`globals.node`), marked `"readonly"`/`"writable"`.
- `parser` — a custom parser module (typescript-eslint sets this internally).
- `parserOptions` — for typed linting, `projectService: true` (preferred) or
  `project: [...tsconfig paths]`, plus `tsconfigRootDir`.

## typescript-eslint typed linting

- `...tseslint.configs.recommendedTypeChecked` pulls in the type-aware rule set;
  it requires `parserOptions.projectService`/`project` so the rules can read types.
- Files not covered by any tsconfig (root `*.config.*`, `.mjs` tooling) must opt
  out per-block with `extends: [tseslint.configs.disableTypeChecked]` and
  `parserOptions: { projectService: false }` — otherwise typed rules error that the
  file isn't part of a project.
- Rules are referenced as `@typescript-eslint/<rule>`.

## Severity & directives

- Severity: `"off"` (0), `"warn"` (1), `"error"` (2); options via
  `[severity, { ... }]`.
- `linterOptions.reportUnusedDisableDirectives: "error"` makes stale
  `// eslint-disable` comments a hard failure.

## Notable version notes

- `.eslintrc` is fully unsupported in ESLint 9+/10 — flat config only.
- typescript-eslint v8's `tseslint.config()` and `configs.*TypeChecked` shapes are
  stable across the 8.x line; no changes expected against the repo's 8.62.0.
