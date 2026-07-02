---
paths:
  - "scripts/**"
---

# Automation script rules (`scripts/**`)

> **Forward guidance:** the `M3LScript` API below is not consumable yet —
> `core/script` is `❌ not-started` (see `docs/implementation-status.md`). These
> rules describe the target shape so scripts written now anticipate it.

- **Consume the library via `workspace:*`**
  (`"@m3l-automation/m3l-common": "workspace:*"`), not a published version.
- **Construct `Core.M3LScript` once with `M3LScriptOptions`; never subclass it.**
  Run with `script.run(async (ctx) => { ... })`.
- **Lifecycle hooks run in fixed order:** `onBeforeInit` → `onAfterInit` →
  `onBeforeConfigLoad` → `onAfterConfigLoad` → `onBeforeRun` → `onAfterRun` →
  `onError` → `onCleanup`.
- **Declare config with `M3LConfigParameter`**; resolution order is CLI > JSON >
  YAML > env/.env > Lambda event > preset > default > asyncFallback.
- **Paths come from `M3LPaths`** — do not hardcode `data/`, `input/`, `output/`.
  In this monorepo they anchor at the workspace root automatically.
- **Lambda:** expose via `createLambdaHandler<TEvent, TResult>()`; set
  `M3L_DEPLOYMENT_MODE=standalone` and `M3L_BASE_DIR=/tmp`. Do not register
  signal handlers (the platform owns the process lifecycle).
- **ESM `.js` extensions, named exports, no `any`** apply here too — see
  [`docs/contributing/style-guide.md`](../../docs/contributing/style-guide.md) for
  the full code, test, and refactoring rules that also govern `scripts/`.
