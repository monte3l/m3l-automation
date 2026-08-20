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
- **A single-switch operation dispatcher does not scale past ~8-10 operations
  under the size caps above.** `ecs-ops`'s `switch (group)` over a
  `DISPATCH_GROUP` table (8 operations, 4 families) fits comfortably; copying
  the same shape for a 13-operation/7-family dispatcher (`codepipeline-ops`)
  blew `max-lines-per-function`/`complexity` on the first pass. For a double-digit
  operation count, split into a two-level exhaustive type-predicate chain from
  the start: a top-level function handling a subset of operations directly via
  `if (isXOperation(operation)) return dispatchX(...)`, falling through to a
  second function for the remainder. The second function's parameter needs its
  own narrower literal-union type (e.g. `Exclude<Operation, ...already-handled>`),
  not the full operation union — TypeScript does not carry control-flow
  narrowing across a function-call boundary, so a full-union parameter leaves
  the final `exhaustive: never` completeness check failing to compile even when
  the runtime dispatch is already correct (`aws/codepipeline`'s `codepipeline-ops`,
  2026-07-27). **Since 2026-08-16 the preferred shape for a NEW multi-operation
  dispatcher — and the migration target for existing ones (issue #334 wave) —
  is `Core.M3LOperationPipeline`** (`docs/reference/core/pipeline.md`): its
  exhaustive per-operation handler table gives each operation its own function,
  so the size ceiling that motivated the two-level split never approaches.
  Reach for the two-level split only where the engine is deliberately out of
  scope (multi-file routers, checkpoint/resume dispatchers).
- **Scaffold with the generator, never by hand:** `pnpm scaffold:script <name>`
  emits the whole shape from `templates/script/`; to evolve the shape, change
  the templates + manifest together — a hand-added or hand-dropped file fails
  `check:script-scaffold` in CI.
- **Fill in the README's `### Examples` section before calling a script
  done:** at least 3 runnable examples spanning read-only → mutating →
  destructive/interactive; scale the count to the script's operation count
  and complexity (a 6-operation script typically warrants 6 examples).
  Enforcement: `check:script-docs` (`bin/lib/script-docs.mjs`) requires ≥3
  runnable `node dist/main.js` invocations after the `### Examples` heading and
  rejects a leftover scaffold placeholder. `check:script-scaffold` (via
  `readmeExamplesErrors`) still verifies the heading exists and has at least one
  invocation as a backstop. The full README and reference-page structure spec is
  [`docs/contributing/script-docs-structure.md`](../../docs/contributing/script-docs-structure.md).

## Library usage

- **Consume the library via `workspace:*`**
  (`"@m3l-automation/m3l-common": "workspace:*"`), not a published version. knip
  fails an unused dependency **or a consumer-less export** — re-run `pnpm knip`
  after any fix/remediation round; its static-reachability check is not covered
  by typecheck/lint/test/build, so the script must actually exercise the library
  and every export must have a consumer.
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
- **Parameter mode rule** (style guide § Script config declarations):
  `required: true` = always needed, no fallback; `defaultValue` = optional
  with one sensible fallback (all confirm-gate `yes`/`force` flags);
  bare-optional = operation-specific, validated via cross-parameter
  `configValidators` or a run-start guard — state which in the contract page.
- **When promoting a script's local config-read helper onto
  `Core.M3LConfigAccessor`, grep the whole file for `config.get(` afterward —
  not just for callers of the helper being deleted.** A boolean/string field
  that was always inlined at its call site (never routed through the shared
  helper) is invisible to a "find every caller of `readX`" sweep and can carry
  the exact silent-wrong-type-default bug the promotion exists to fix (e.g. a
  confirm-gate's `yes`/`force` flag read as `config.get(name) === true`,
  silently resolving `false` for any non-boolean value instead of throwing).
  Found during the W5 config-accessor completion pass, 2026-07-28.
- **Read the per-run correlation id from the hook context** (`ctx.correlationId`,
  always a non-empty string) and thread it through your own logs; set
  `M3LScriptOptions.correlationId` only to inherit an upstream trace. It is
  re-resolved per Lambda invocation.
- **A `Core.M3LCheckpointStore<T>` type guard must reject a field pair that
  is present-without-its-correlate, not just validate each field
  independently — and this applies to EVERY correlated pair on the
  checkpoint, not just the first one you fix.** When one checkpoint field is
  meaningless without another (a resume offset without the byte-length it
  corresponds to, a chunk index without its byte/record count), require
  them to co-occur — a checkpoint written by an older version of the
  script, or by a sibling code path under a different format, can otherwise
  satisfy an independently-optional validator while silently resuming from
  the wrong point. Confirmed three times in the same change:
  `rds-data-sql`'s `isRunQueryCheckpoint` got `offset`⟺`outputBytes`
  right, but its sibling `isRunLoadCheckpoint` only checked
  `chunkIndex`⟺`failedOutputBytes` and missed the checkpoint's THIRD
  correlated field, `recordsProcessed` — silently duplicating already-committed
  DB inserts and `failed.jsonl` rows on a checkpoint missing just that one
  field, caught only by a final whole-diff review pass comparing the two
  functions side by side, not by either function's own individual review.
  `cloudwatch-logs-insights` took a structurally different but equally valid
  path: its `rows`⟺`outputBytes` correlate is format-dependent (`rows` is
  legitimately populated for a CSV checkpoint), so it's enforced downstream
  in the JSON-writer-open step rather than in the type guard itself — a
  reminder that "co-occurrence" is the invariant to enforce, not "in the
  type guard" specifically, when the correlate depends on something the
  guard can't see. When you find and fix one missing co-occurrence check on
  a checkpoint type, audit every OTHER field on that same type for the same
  gap before moving on (`docs/logs/2026-08-15-exporter-resume-seam.md`).

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

- **Scripts are exempt from the per-file coverage gate** (coverage is scoped to
  `packages/*/src`), but each ships **at least a config-declaration smoke test**;
  unit-test `steps/` modules with plain mocks where it earns its keep.
- **ESM `.js` extensions, named exports, no `any`** apply here too — see
  [`docs/contributing/style-guide.md`](../../docs/contributing/style-guide.md) for
  the full code, test, and refactoring rules that also govern `scripts/`.
