---
name: new-script
description: Scaffold a new automation script under scripts/<name> that consumes @m3l-automation/m3l-common via workspace:* and wires the M3LScript lifecycle. Use when the user asks to create a new automation, script, or job in this monorepo.
---

# new-script

Scaffold a new automation in `scripts/<name>/`, consuming the library through
the `workspace:*` dependency and the documented `M3LScript` lifecycle.

## Steps

1. Ask for the script name if not given. Slugify to kebab-case → `<name>`.
   Refuse if `scripts/<name>/` already exists.
2. Create `scripts/<name>/package.json`:
   - `"name": "@m3l-automation/<name>"`, `"private": true`, `"type": "module"`
   - `"engines": { "node": ">=24" }`
   - `"dependencies": { "@m3l-automation/m3l-common": "workspace:*" }`
   - scripts: `"build": "tsc -b"`, `"start": "node dist/main.js"`
3. Create `scripts/<name>/tsconfig.json` extending `../../tsconfig.base.json`
   with `rootDir: src`, `outDir: dist`, and a project reference to
   `../../packages/m3l-common`.
4. Create `scripts/<name>/src/main.ts` following `scripts/example-automation`
   as the template: import `{ Core }` from `@m3l-automation/m3l-common`,
   construct `new Core.M3LScript({ name, version, hooks })`, and call
   `await script.run(async (ctx) => { ... })`.
5. Add `{ "path": "./scripts/<name>" }` to the root `tsconfig.json` references.
6. Run `pnpm install` to link the workspace, then `pnpm -C scripts/<name> build`.

## Rules

- ESM only: relative imports carry `.js`; named exports; no `any`; no CommonJS.
- Get paths from `M3LPaths`; never hardcode `data/`, `input/`, `output/`.
- See `.claude/rules/scripts.md` and `docs/guides/writing-a-script.md`.
