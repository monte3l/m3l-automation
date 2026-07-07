---
name: scaffolding-scripts
description: >-
  Scaffold a brand-new automation script package under scripts/<name>/ that consumes
  @m3l-automation/m3l-common via workspace:* — the greenfield entry point for a consumer
  script that has no directory yet. Creates the package.json, tsconfig, and the ratified
  modular src/ skeleton (thin main.ts composition root + config.ts + hooks.ts + a starter
  steps/ module), wires the root tsconfig reference, installs, builds, and smoke-runs, then
  hands off to implement the real logic. Use this whenever the user asks to add, create, or
  scaffold a new automation/consumer script, job, or CLI under scripts/ — even phrased
  casually like "set up a new export script", "add a report-generator automation", or "create
  a script that syncs S3 to Dynamo", and even if they never say "scaffold". This is for
  consumer scripts under scripts/, NOT library code: for a new Core/AWS library module use
  scaffolding-submodules, and to fill in an existing documented submodule use
  implementing-submodules.
---

# scaffolding-scripts

Scaffold a new automation script under the monorepo's `scripts/*` workspace —
the _greenfield_ entry point for a **net-new** consumer that has no
`scripts/<name>/` directory yet. It lays down the package manifest, the tsconfig,
and the ratified modular `src/` skeleton (a thin `main.ts` composition root with
the logic split into `config.ts`, `hooks.ts`, and `steps/` modules), wires the
build, and smoke-runs it — then hands the real business logic to implementation.
The fleet conventions it enforces are ratified in
[ADR-0022](../../../docs/adr/0022-reintroduce-scripts-workspace.md); the API the
script builds against is
[`docs/reference/core/script.md`](../../../docs/reference/core/script.md).

## Role boundaries (hub-and-spoke)

This skill runs in the **hub** (main agent) and only lays down the scaffold
seam — manifests, tsconfig, and stub `src/` modules whose bodies do nothing real
yet. It does **not** implement the script's business logic or review it: the real
`steps/` logic is handed to the implementer spoke (`submodule-implementer`, whose
grant covers `scripts/*/src` writes) and reviewed by `code-reviewer` +
`security-reviewer` (credential/secret handling) — the agent that writes the
logic is never the one that reviews it. Keep that separation by handing off
rather than implementing inline.

## Steps

0. **Run `/starting-work` first.** Scaffolding writes guarded paths
   (`scripts/<name>/src/**`), which `guard-branch-isolation.mjs` blocks while
   `HEAD` is `main`. `/starting-work` is the single source of truth for the
   branch/worktree, PR, and push decisions — it infers and confirms them up front
   so you branch proactively instead of hitting the block mid-scaffold.
1. Ask for the **script name** (kebab-case → `@m3l-automation/<name>`), a
   **one-line purpose**, and whether it **touches AWS** and is **CLI-only or
   CLI+Lambda**. These are required-parameter asks, exempt from the 5–7
   clarifying-question rule. First check `scripts/<name>/` does not already
   exist — if it does, **stop and redirect**: the script is already scaffolded,
   so implement/edit it directly instead of re-scaffolding.
2. Create `scripts/<name>/package.json` and `scripts/<name>/tsconfig.json` from
   the templates below.
3. Scaffold the **modular `src/` skeleton** from the templates below — a thin
   `main.ts` composition root plus `config.ts`, `hooks.ts`, and one starter
   `steps/<step>.ts` module with injected deps. Never a single-file `main.ts`.
   Relative imports carry the `.js` extension; named exports only; no `any`.
4. Add the new package's project reference to the root `tsconfig.json`
   (`{ "path": "./scripts/<name>" }`) so `tsc -b` builds it.
5. Run `pnpm install` (the workspace glob picks up the new package), then
   `pnpm build` (turbo orders `m3l-common` first), then the smoke run
   `pnpm --filter @m3l-automation/<name> start`.
6. Hand off: tell the user (or proceed, if asked) to implement the real logic in
   the `steps/` modules against `.claude/rules/scripts.md` and
   `docs/reference/core/script.md`, landing via PR with `code-reviewer` +
   `security-reviewer`. knip fails an unused `workspace:*` import, so the script
   must actually exercise the library to go green.

## Templates

**`scripts/<name>/package.json`:**

```json
{
  "name": "@m3l-automation/<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "<what this automation does>",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b",
    "start": "node --env-file-if-exists=.env dist/main.js"
  },
  "dependencies": {
    "@m3l-automation/m3l-common": "workspace:*"
  }
}
```

**`scripts/<name>/tsconfig.json`:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "references": [{ "path": "../../packages/m3l-common/tsconfig.build.json" }],
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

**`src/main.ts` — composition root only, no business logic:**

```ts
import { Core } from "@m3l-automation/m3l-common";
import { configParameters } from "./config.js";
import { hooks } from "./hooks.js";
import { runExport } from "./steps/run-export.js";

const script = new Core.M3LScript({
  metadata: { name: "<name>", version: "0.0.0" },
  config: configParameters,
  hooks,
});

await script.run(async (ctx) => {
  await runExport({
    correlationId: ctx.correlationId /* + paths, aws, config */,
  });
});
```

**`src/config.ts` — declared parameters with schema-time validators:**

```ts
import { Core } from "@m3l-automation/m3l-common";

export const configParameters = [
  new Core.M3LConfigParameter({
    name: "batchSize",
    type: "INT",
    defaultValue: 100,
    validate: Core.M3LConfigValidators.range(1, 10_000),
  }),
  // + a parameter declared with AWS_PROFILE_PARAM_NAME when the script touches AWS
];
```

**`src/steps/run-export.ts` — pure named export taking injected deps:**

```ts
export async function runExport(deps: {
  correlationId: string;
  // + outputDir, batchSize, logger, aws — injected, never read from process.env
}): Promise<void> {
  // starter body: implementation handed off per Step 6
  void deps;
}
```

## What "good" looks like

**Thin composition root, logic in an injected-deps step:**

```ts
// good — main.ts only wires + runs; runExport takes its deps as parameters
await script.run(async (ctx) =>
  runExport({ correlationId: ctx.correlationId, outputDir, batchSize }),
);
// bad — business logic inlined into main.ts (a loop, I/O, branching)
await script.run(async () => {
  for (const row of await readAll()) await writeOne(row); // reviewers reject this
});
```

**Config through the seam, never `process.env`:**

```ts
// good — declared parameter + validator; the loader is the only input seam
new Core.M3LConfigParameter({
  name: "batchSize",
  type: "INT",
  validate: Core.M3LConfigValidators.range(1, 10_000),
});
// bad — reading the environment directly bypasses validation and redaction
const batchSize = Number(process.env.BATCH_SIZE);
```

## Rules

- `main.ts` is a composition root only — any conditional, loop, or I/O beyond
  wiring belongs in a `steps/` module. Reviewers reject logic in `main.ts`.
- I/O only through `M3LPaths`; isolate a script's data with the `M3L_*_DIR` env
  overrides pointing at `data/<name>/…` (ADR-0022), never hardcoded paths.
- Secrets only via the gitignored `.env` or config `secretNames`, never literals.
- AWS access via the `aws.profile` seam (`AWS_PROFILE_PARAM_NAME` → `script.aws`),
  not hand-constructed SDK clients.
- Don't implement the business logic here; hand off to implementation.
- See `.claude/rules/scripts.md` and ADR-0022 for the full fleet conventions.
