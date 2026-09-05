---
paths:
  - "scripts/**"
---

# Automation script rules (`scripts/**`)

> Fleet conventions are ratified in
> [ADR-0022](../../docs/adr/0022-reintroduce-scripts-workspace.md); the API
> reference is
> [`docs/reference/core/script.md`](../../docs/reference/core/script.md). This
> file is the terse checklist that auto-loads when you edit a script.

## Naming & dependency boundary (ADR-0028 / ADR-0029)

- **Name AWS-scoped scripts after the full official AWS service** —
  kebab-case `<service>[-<purpose>]`, never an abbreviation (`cfn`, `apigw`,
  `dynamo`); non-AWS scripts (`json-etl`) are exempt (ADR-0028). Enforced by
  `serviceNameErrors()` (`bin/lib/script-scaffold.mjs`) via
  `pnpm scaffold:script` and `check:script-scaffold`.
- **Declare exactly one runtime dependency** —
  `"@m3l-automation/m3l-common": "workspace:*"` — and no devDependencies
  (ADR-0029). A capability the library lacks becomes a typed library wrapper
  first (the ADR-0027 pattern), never a script-local package. Enforced by
  `check:script-deps` plus ESLint's `@aws-sdk/*` and bare-import bans.

## Layout — modular, never a single-file script

- **`main.ts` is a composition root only:** construct `Core.M3LScript` with
  `M3LScriptOptions`, wire config/hooks, call `script.run(...)`. No business
  logic — reviewers reject a conditional, loop, or I/O in `main.ts`.
- **Logic lives in named-export modules that take their dependencies as
  parameters:** `config.ts`, `hooks.ts`, the optional ADR-0054 `command.ts`
  seam (below), and flat `steps/<step>.ts` modules — one per concern, no
  nesting. `check:script-scaffold` verifies the layout; ESLint design rules
  cap module shape; `main.ts`'s purity stays reviewer-checked.
- **A single-switch operation dispatcher doesn't scale past ~8–10
  operations.** Prefer `Core.M3LOperationPipeline`
  (`docs/reference/core/pipeline.md`) for a new multi-operation dispatcher —
  its exhaustive per-operation handler table sidesteps the ceiling entirely
  (`docs/logs/2026-08-18-scripts-codepipeline-ops-pipeline-migration.md`). A
  hand-written two-level type-predicate chain is the fallback only where the
  pipeline engine is deliberately out of scope, and needs its own narrower
  literal-union type per level — TypeScript doesn't narrow control flow
  across a function-call boundary
  (`docs/logs/2026-07-27-scripts-codepipeline-ops.md`).
- **Scaffold with the generator, never by hand:** `pnpm scaffold:script
<name>` emits the whole shape; evolve it via `templates/script/` + the
  manifest together.
- **Fill in the README's `### Examples` section before calling a script
  done** — at least 3 runnable examples spanning read-only → mutating →
  destructive/interactive. Full spec and enforcement:
  [`docs/contributing/script-docs-structure.md`](../../docs/contributing/script-docs-structure.md).

## The command-module seam (`command.ts`, ADR-0054)

- **`src/command.ts` is optional and additive.** It exports
  `commandModule: Core.M3LCommandModule` so a host can invoke the script
  in-process instead of spawning `dist/main.js`. `pnpm scaffold:script` emits
  it for every new script; the pre-U6 fleet is not required to adopt it. Full
  contract:
  [`docs/reference/core/cli-contract.md`](../../docs/reference/core/cli-contract.md).
- **An adopted `main.ts` delegates to `execute`** — via a context built from
  `Core.createCommandOutput()`/`Core.createCommandLogger()` — retiring the
  second composition site, rather than reimplementing the run loop. See
  cli-contract.md § What U7 shipped for the full shape.
- **Capture failures through `onError`, never a `try`/`catch` around the
  `mainFn` body.** `mainFn` is stage 7 of nine; the other eight throw outside
  it. See [`docs/reference/core/script.md`](../../docs/reference/core/script.md)
  § `captureRunFailures`.
- **Classify an abort as `interrupted`, not `failure`.** Detect by CODE, not
  class (ADR-0049): `error instanceof Error && Core.hasProperty(error,
"code") && error.code === "ERR_OPERATION_ABORTED"`. See script.md §
  Cooperative cancellation.
- **Use `Core.deriveCommandOutcome`, never a hand-rolled outcome mapper.** It
  already reports the honest `recoveryTotal`, not `recovery.length`. See
  cli-contract.md § Deriving an outcome.
- **Never call `process.exit` anywhere under `scripts/*/src/**`.** Resolve an
  `M3LCommandOutcome` and let `Core.runScript` drive `process.exitCode`
  instead. Enforced fleet-wide by ESLint (`no-restricted-properties` plus a
  `node:process` `exit`-import ban).
- **Annotate, never `satisfies`.** `export const commandModule:
Core.M3LCommandModule = { … }` — `tsconfig.build.json`'s
  `isolatedDeclarations` rejects an exported `satisfies` expression.

## Library usage

- **An unused dependency or a consumer-less export fails `knip`** — re-run
  `pnpm knip` after any fix round; its static-reachability check isn't
  covered by typecheck/lint/test/build.
- **Construct `Core.M3LScript` once; never subclass it.** Run with
  `script.run(async () => { ... })` — `mainFn` takes zero parameters. Reach
  run-scoped context through the closed-over `script` instance, not a
  callback parameter. See
  [`docs/reference/core/script.md`](../../docs/reference/core/script.md).
- **Lifecycle hooks run in fixed order** — see script.md § Lifecycle hooks.
- **Declare config with `M3LConfigParameter`**; resolution order is CLI >
  JSON > YAML > env/.env > Lambda event > preset > default > asyncFallback
  (`docs/reference/core/config.md` § Resolution order). Attach schema-time
  validators with `Core.M3LConfigValidators` (`range` / `regex` / `oneOf`)
  instead of hand-rolled checks. Never read `process.env` directly — config
  is the only input seam.
- **Parameter mode rule** (style guide § Script config declarations):
  `required: true` = always needed, no fallback; `defaultValue` = optional
  with one sensible fallback; bare-optional = operation-specific, validated
  via `configValidators` or a run-start guard.
- **A `configValidators` entry with a defaulted `dependent`/`required` pair
  is a silent no-op** — `M3LScript` resolves every declared default before
  any validator runs, so use a value-based inline predicate instead whenever
  both operands have defaults. And **exporting a `configValidators` array
  proves nothing about whether it's wired** — `main.ts` must explicitly pass
  `validate: configValidators`, and `command.ts` (if adopted) is an
  independent second composition site with its own wiring to check. Both
  shipped silently across 10 scripts
  (`docs/logs/2026-08-25-a2b-fleet-destructive-confirmation-retrofit.md`).
- **When promoting a local config-read helper onto `Core.M3LConfigAccessor`,
  grep the whole file for `config.get(` afterward — not just the helper's
  callers.** An always-inlined field is invisible to a "find every caller"
  sweep and can carry the same bug the promotion exists to fix
  (`docs/logs/2026-07-28-w5-config-accessor-completion.md`).
- **Read the correlation id from the hook context** (`ctx.correlationId`);
  set `M3LScriptOptions.correlationId` only to inherit an upstream trace. See
  script.md § Correlation IDs.
- **A `Core.M3LCheckpointStore<T>` type guard must reject a field pair that
  is present-without-its-correlate — for every correlated pair on the type,
  not just the first one you fix.** A checkpoint written by an older script
  version can otherwise satisfy an independently-optional validator while
  silently resuming from the wrong point; audit every other field on a type
  once you find one gap (`docs/logs/2026-08-15-exporter-resume-seam.md`).

## I/O, config files, secrets, AWS

- **Paths come from `M3LPaths`** — never hardcode `data/`, `input/`,
  `output/`. In this monorepo they anchor at the workspace root, shared by
  every script; isolate a script's I/O by pointing `M3L_CONFIG_DIR` /
  `M3L_INPUT_DIR` / `M3L_OUTPUT_DIR` (in its `.env`) at a per-script subtree.
- **Preset/config files** live under `data/config/presets/`, passed to the
  loader by explicit path — no library search root or per-script fallback.
- **Secrets** only via the gitignored `.env` or config `secretNames`, never
  literals (`guard-secret-writes` + gitleaks enforce). List `.env` in
  `.worktreeinclude` so worktrees inherit it.
- **AWS access via the `aws.profile` config seam:** declare it with
  `AWS_PROFILE_PARAM_NAME`, not a hand-typed `"aws.profile"` string, and use
  the provisioned `script.aws` provider — never a hand-constructed SDK
  client.

## Lambda

- Expose via `createLambdaHandler<TEvent, TResult>()`; set
  `M3L_DEPLOYMENT_MODE=standalone` and `M3L_BASE_DIR=/tmp`. Do not register
  signal handlers (the platform owns the process lifecycle).

## Testing & style

- **Scripts are exempt from the per-file coverage gate** (coverage is scoped
  to `packages/*/src`), but each ships **at least a config-declaration smoke
  test**; unit-test `steps/` modules with plain mocks where it earns its
  keep.
- **`pnpm build` is a distinct gate from `pnpm typecheck` for `scripts/**`
  too — never call a `config.ts` change green without it.** Each
  `scripts/*/tsconfig.build.json` sets `isolatedDeclarations`, which
  `pnpm typecheck` doesn't catch. Two forms trip it: `] as const satisfies
SomeType;` (use plain `] as const;`) and any `export const` initialised from
  a function call, which needs an explicit type annotation — the literal
  union, never `string`, or an exhaustive `Record<Op, …>` dispatch table
  silently stops catching unhandled cases. This rule is also in
  `.claude/rules/tests.md`, but that file is scoped to `**/tests/**` and so
  does not load while editing `scripts/*/src/**`
  (`docs/logs/2026-08-19-a3-partial-run-outcome.md`).
- **ESM `.js` extensions, named exports, no `any`** apply here too — see
  [`docs/contributing/style-guide.md`](../../docs/contributing/style-guide.md) for
  the full code, test, and refactoring rules that also govern `scripts/`.
