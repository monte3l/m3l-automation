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
  kebab-case `<service>[-<purpose>]`: `dynamodb-crud`,
  `cloudwatch-logs-insights`, `cloudformation-stacks`. Never abbreviations
  (`cfn`, `apigw`, `dynamo`). Non-AWS scripts (`json-etl`) are exempt.
  Why: one greppable name per service across submodule, script, reference
  page, and roadmap (ADR-0028 carries the noncompliance ledger for shipped
  pre-policy names). Enforcement: `serviceNameErrors()` (a known-abbreviation
  denylist, `bin/lib/script-scaffold.mjs`) is checked by both
  `pnpm scaffold:script` and `check:script-scaffold` (ROADMAP follow-up T5).
- **Declare exactly one runtime dependency** —
  `"@m3l-automation/m3l-common": "workspace:*"` — and no devDependencies
  (the workspace root owns tooling). A capability the library lacks becomes
  a typed library wrapper first (the ADR-0027 pattern); never a script-local
  package. Why: one mediation seam, one supply-chain audit point, mockable
  step tests. Enforcement: `check:script-deps`
  (`bin/check-script-deps.mjs`) asserts the package.json declaration; the
  `@aws-sdk/*`-specific and blanket bare-import bans (ESLint,
  `scripts/*/src/**/*.ts`) cover the source level (ROADMAP follow-up T6,
  ADR-0029).

## Layout — modular, never a single-file script

- **`main.ts` is a composition root only:** construct `Core.M3LScript` with
  `M3LScriptOptions`, wire config/hooks, call `script.run(...)`. It carries no
  business logic — any conditional, loop, or I/O beyond wiring belongs in a step
  module, and reviewers reject logic in `main.ts`.
- **Logic lives in named-export modules** that take their dependencies (config
  values, logger, paths, aws provider) as parameters: `config.ts` (the declared
  `M3LConfigParameter` set), `hooks.ts` (lifecycle hooks — always present), and
  `steps/<step>.ts` (one module per concern, flat — no nesting). Injected deps
  keep each step unit-testable without running the lifecycle. Enforcement is
  split: `pnpm check:script-scaffold` machine-verifies the **layout** (required
  files, package contract, smoke test, docs — from the shared manifest
  `bin/lib/script-scaffold.mjs`), and the `scripts/*/src/**` ESLint design
  rules (complexity ≤ 10, max-depth ≤ 3, max-lines-per-function ≤ 60, named
  exports, no default export) cap **module size and shape**; the
  composition-root purity of `main.ts` itself remains reviewer-checked.
- **Scaffold with the generator, never by hand:** `pnpm scaffold:script <name>`
  emits the whole shape from `templates/script/`; to evolve the shape, change
  the templates + manifest together — a hand-added or hand-dropped file fails
  `check:script-scaffold` in CI.

## Library usage

- **Consume the library via `workspace:*`**
  (`"@m3l-automation/m3l-common": "workspace:*"`), not a published version. knip
  fails an unused dependency, so the script must actually exercise the library.
- **Construct `Core.M3LScript` once with `M3LScriptOptions`; never subclass it.**
  Run with `script.run(async (ctx) => { ... })`.
- **Lifecycle hooks run in fixed order:** `onBeforeInit` → `onAfterInit` →
  `onBeforeConfigLoad` → `onAfterConfigLoad` → `onBeforeRun` → `onAfterRun` →
  `onError` → `onCleanup`.
- **Declare config with `M3LConfigParameter`**; resolution order is CLI > JSON >
  YAML > env/.env > Lambda event > preset > default > asyncFallback. Attach
  schema-time validators with `Core.M3LConfigValidators` (`range` / `regex` /
  `oneOf`) instead of hand-rolled checks. Never read `process.env` directly —
  config is the only input seam.
- **Read the per-run correlation id from the hook context** (`ctx.correlationId`,
  always a non-empty string) and thread it through your own logs; set
  `M3LScriptOptions.correlationId` only to inherit an upstream trace. It is
  re-resolved per Lambda invocation.

## I/O, config files, secrets, AWS

- **Paths come from `M3LPaths`** — never hardcode `data/`, `input/`, `output/`.
  In this monorepo they anchor at the workspace root automatically, and that root
  is **shared** by every script. Isolate a script's I/O by pointing
  `M3L_CONFIG_DIR` / `M3L_INPUT_DIR` / `M3L_OUTPUT_DIR` (in its `.env`) at a
  per-script subtree, e.g. `data/<script-name>/…`. This is the only isolation the
  library offers and the defence against concurrent-run races on the shared root.
- **Preset/config files** live under `data/config/presets/` and are passed to the
  loader by explicit path — there is no library search root or per-script
  fallback, so do not assume one.
- **Secrets** only via the gitignored `.env` or config `secretNames` — never
  literals (`guard-secret-writes` + gitleaks enforce). List `.env` in
  `.worktreeinclude` so worktrees inherit it.
- **AWS access via the `aws.profile` config seam:** declare the parameter with
  `AWS_PROFILE_PARAM_NAME` (not a hand-typed `"aws.profile"` string) and use the
  provisioned `script.aws` provider — never a hand-constructed SDK client.

## Lambda

- Expose via `createLambdaHandler<TEvent, TResult>()`; set
  `M3L_DEPLOYMENT_MODE=standalone` and `M3L_BASE_DIR=/tmp`. Do not register
  signal handlers (the platform owns the process lifecycle).

## Testing & style

- **Scripts are exempt from the 80% coverage gate** (coverage is scoped to
  `packages/*/src`), but each ships **at least a config-declaration smoke test**;
  unit-test `steps/` modules with plain mocks where it earns its keep.
- **ESM `.js` extensions, named exports, no `any`** apply here too — see
  [`docs/contributing/style-guide.md`](../../docs/contributing/style-guide.md) for
  the full code, test, and refactoring rules that also govern `scripts/`.
