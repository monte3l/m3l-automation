# `script` — CLI / Lambda entry-point framework

The `script` module provides `M3LScript`, the single entry point for every script and Lambda handler. It wires together configuration, logging, prompts, AWS credential management, signal handling, and process fault guards so consumer code carries no boilerplate.

## Overview

`M3LScript` is instantiated with a single `M3LScriptOptions` object and does not extend any base class. Its constructor wires together config, logging, prompts, and AWS credential management. You then call either `run(mainFunction)` for CLI execution or `createLambdaHandler()` for an AWS Lambda-compatible handler — both drive the same initialization pipeline.

Eight lifecycle hooks let you observe and extend each stage of execution. A process-global guard layer (`installProcessGuards`) captures unhandled faults, and `M3LScriptPresetLoader` loads named parameter presets from YAML/JSON files with bounded nesting depth and typo suggestions.

## Public API

Exported from `@m3l-automation/m3l-common/core` (the `script` sub-module):

- `M3LScript`
- `M3LScriptOptions`
- `M3LScriptMetadata`
- `M3LScriptLifecycleHooks`
- `M3LScriptHookContext`
- `M3LScriptConfigLoader`
- `M3LScriptPresetLoader`
- `M3LPresetUnknownKeysError`
- `M3LPresetCycleError`
- `installProcessGuards`
- `serializeError`
- `setProcessGuardRequestId`
- `AWS_PROFILE_PARAM_NAME` / `AWS_REGION_PARAM_NAME` — the canonical config parameter names (`"aws.profile"` / `"aws.region"`) the AWS-provisioning seam looks up

## Execution flow

`run(mainFunction)` is the primary CLI entry point. It orchestrates initialization, config load, AWS provisioning, the user function, and cleanup, returning a `Promise<void>`. The stages are:

```text
M3LScript.run(mainFn)
  1. M3LExecutionEnvironment.detect()        ← reads env vars + filesystem markers
  2. hooks: onBeforeInit → onAfterInit
  3. config load (M3LScriptConfigLoader)     ← walks provider chain; resolves asyncFallbacks
  4. hooks: onBeforeConfigLoad → onAfterConfigLoad
  5. AWS provisioning                         ← only if an aws.profile param is defined
  6. hooks: onBeforeRun
  7. mainFn()                                ← user code
  8. hooks: onAfterRun → onCleanup
  9. file archival                           ← copies input/config files to the output dir
```

`createLambdaHandler<TEvent, TResult, TContext>()` wraps the same initialization pipeline in an AWS Lambda-compatible handler function. Per invocation, the `initialized` and `configLoaded` flags are reset and the config store is cleared, so each invocation starts clean. SDK clients are intentionally not reset between invocations, so connections are reused across warm starts.

## Lifecycle hooks

The eight hooks declared on `M3LScriptLifecycleHooks` are, in execution order:

- `onBeforeInit`
- `onAfterInit`
- `onBeforeConfigLoad`
- `onAfterConfigLoad`
- `onBeforeRun`
- `onAfterRun`
- `onError`
- `onCleanup`

Each hook receives a `M3LScriptHookContext` carrying the live config store and
the run's `correlationId` (see [Correlation IDs](#correlation-ids)), so a hook
can read resolved configuration and the trace id during any stage.

## Signal handling

Signal handlers for `SIGTERM`, `SIGINT`, and `SIGQUIT` are registered only in non-AWS environments. A second signal forces an immediate exit with code `1`. In AWS execution environments (for example, Lambda), these handlers are not installed.

## Process guards

`installProcessGuards()` is a process-global singleton that installs `unhandledRejection`, `uncaughtException`, `warning`, and `beforeExit` handlers. In Lambda, call `setProcessGuardRequestId(requestId)` to attribute guard-caught errors to the current invocation. `serializeError` produces a serializable representation of an error for these guard paths.

## Correlation IDs

`M3LScript` threads one optional **correlation id** through a run so hooks, logs,
and failure diagnostics can all be tied back to the same execution.

```typescript
interface M3LScriptOptions {
  // ...existing fields
  readonly correlationId?: string; // optional; generated per run when omitted
}

interface M3LScriptHookContext {
  readonly config: M3LReadonlyConfig;
  readonly correlationId: string; // always resolved by the first hook
}
```

- **Resolution.** When `options.correlationId` is supplied it is used verbatim
  for the run. When omitted, `run()` generates one per process run via
  `crypto.randomUUID()`. The id is resolved before the first hook fires, so
  `ctx.correlationId` on `M3LScriptHookContext` is always a non-empty string.
- **Lambda.** `createLambdaHandler()` resolves an id **per invocation**,
  preferring the platform request id when the runtime context exposes one
  (`context.awsRequestId`) over a generated UUID — so a run's logs line up with
  the Lambda request in CloudWatch. An explicit `options.correlationId` still
  wins if provided. This aligns with `setProcessGuardRequestId()`, which
  attributes guard-caught faults to the same invocation.
- **Logs.** Correlated logging is opt-in: `M3LScript` does not emit log lines of
  its own, so it stamps no logger for you. To tie your log lines to the run,
  construct a logger with the id — `new M3LLogger(handlers, { correlationId })` —
  seeding it from `ctx.correlationId` (available in the first hook) or from the
  `correlationId` you passed in `M3LScriptOptions`. Every event such a logger
  emits carries the id, and `M3LJsonLoggerHandler` includes it in the JSON line
  (see [`logging` → Correlation IDs](./logging.md#correlation-ids)).
- **Failure traceability.** On a stage failure the id is observable two ways
  without mutating the thrown error (whose `context` is `readonly`): the
  `onError` hook receives it via `ctx.correlationId`, and the best-effort stderr
  diagnostics line carries it **after** redaction, so a failed run is traceable
  to its id. A correlation id is not a secret and is never redacted.

## Preset loader

`M3LScriptPresetLoader` loads named parameter presets from YAML or JSON files. It enforces a maximum nesting depth of 64 (`MAX_PRESET_STRUCTURE_DEPTH`) and uses Damerau-Levenshtein distance to suggest corrections for unknown keys. When a preset contains keys that are not recognized, it throws `M3LPresetUnknownKeysError`.

### Preset inheritance (`extends`)

A preset may inherit from another by declaring an optional top-level
`extends: <path>` key. The base preset is loaded first and the extending preset
is layered over it, so a family of presets can share a common baseline and
override only what differs.

- **Path resolution.** `extends` is a path to the base preset, resolved
  **relative to the directory of the extending file** (not the process CWD).
  The same YAML/JSON extension dispatch as a direct `load()` applies, so a YAML
  preset may extend a JSON base and vice versa.
- **Shallow merge.** The base and derived records are combined by a **shallow**
  merge: a top-level key present in the derived preset **wholly replaces** the
  base's key (a nested object or array is replaced as a unit, never
  deep-merged), and a key present only in the base is inherited. Like config
  value resolution — where a higher-priority provider wins wholesale rather than
  merging into a lower one — `extends` never silently splices a base's nested
  value into a derived structure. The `extends` key itself is **stripped** from
  the returned record.
- **Chains.** `extends` may chain (a derived preset extends a base that itself
  extends another). Each level is resolved and merged in turn, deepest base
  first, so the nearest override wins.
- **Cycle & depth safety.** A cycle in the `extends` chain (a preset that,
  directly or transitively, extends itself) throws `M3LPresetCycleError`
  (`code: "ERR_PRESET_CYCLE"`), whose `context.chain` is the ordered list of
  resolved file paths that form the cycle. An `extends` chain longer than
  `MAX_PRESET_EXTENDS_DEPTH` (**16**) also throws `M3LPresetCycleError` (a
  runaway or pathological chain is treated as a cycle for safety).
- **Validation runs on the merged result.** The unknown-key check and the
  structure-depth guard run on the **fully merged** record — so a base may
  legitimately carry keys the derived file omits — and `extends` is exempt from
  unknown-key checking at every level of the chain.

```yaml
# base.yaml
region: eu-south-1
retries: 3
tags:
  - baseline

# prod.yaml
extends: ./base.yaml
retries: 5
tags:
  - prod
```

Loading `prod.yaml` yields `{ region: "eu-south-1", retries: 5, tags: ["prod"] }`
— `region` is inherited, `retries` is overridden, and `tags` is **replaced**
wholesale (not concatenated), with `extends` stripped.

## Usage examples

CLI script:

```typescript
import { M3LScript } from "@m3l-automation/m3l-common/core";

const script = new M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
  hooks: {
    onAfterConfigLoad: (ctx) => {
      // ctx carries the live config store
    },
  },
});

await script.run(async () => {
  // user code
});
```

Lambda handler:

```typescript
import { M3LScript } from "@m3l-automation/m3l-common/core";

const script = new M3LScript({
  metadata: { name: "report-builder", version: "1.0.0" },
});

export const handler = script.createLambdaHandler<MyEvent, MyResult>(
  async () => {
    // user code; per-invocation state is reset, SDK clients stay warm
    return { ok: true } as MyResult;
  },
);
```

## Notes and behavior

- `M3LScript` is not subclassed. Pass options (metadata, config schema, hooks, logging options) and call `run`.
- Step 5 (AWS provisioning) runs only when the config schema declares an `aws.profile` parameter. When it does, the resolved profile (and optional region) is used to construct an [`AWSProvider`](../aws/clients.md), assigned to `script.aws` for use in `mainFn` and later hooks. When no `aws.profile` parameter is declared, `script.aws` is unset and no AWS SDK client is constructed.
- The provisioning seam looks up its values under the exported constants `AWS_PROFILE_PARAM_NAME` (`"aws.profile"`) and `AWS_REGION_PARAM_NAME` (`"aws.region"`). Declare the parameter with the constant — `new M3LConfigParameter({ name: AWS_PROFILE_PARAM_NAME, type: M3LConfigParameterType.STRING })` — rather than a hand-typed `"aws.profile"` string, so a typo is a compile error instead of a silent no-op (the provisioning stage simply never fires for a mis-named parameter). The resolved values are validated through `parseAWSProfile`/`parseAWSRegion`, so a malformed configured value fails loud with `M3LAWSIdentityError`.
- `script.paths` exposes the script's own [`M3LPaths`](./utils.md) instance (the one `M3LScript` builds at construction and uses for run archival), so `mainFn` and hooks resolve the canonical `data/` tree — including `paths.resolveInput(name)` / `paths.resolveOutput(name)` — without constructing a second `new M3LPaths()`.
- Per-invocation Lambda reset clears `initialized`, `configLoaded`, and the config store; it does not tear down client providers.
- Signal handlers exist only outside AWS environments.

## See also

- [config](./config.md)
- [environment](./environment.md)
- [errors](./errors.md)
- [logging](./logging.md)
- [Guide: Writing a script](../../guides/writing-a-script.md)
- [Guide: Lambda handlers](../../guides/lambda-handlers.md)
- [Architecture overview](../../m3l-common-architecture.md)
