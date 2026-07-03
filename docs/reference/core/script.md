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
- `installProcessGuards`
- `serializeError`
- `setProcessGuardRequestId`

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

Each hook receives a `M3LScriptHookContext` carrying the live config store, so a hook can read resolved configuration during any stage.

## Signal handling

Signal handlers for `SIGTERM`, `SIGINT`, and `SIGQUIT` are registered only in non-AWS environments. A second signal forces an immediate exit with code `1`. In AWS execution environments (for example, Lambda), these handlers are not installed.

## Process guards

`installProcessGuards()` is a process-global singleton that installs `unhandledRejection`, `uncaughtException`, `warning`, and `beforeExit` handlers. In Lambda, call `setProcessGuardRequestId(requestId)` to attribute guard-caught errors to the current invocation. `serializeError` produces a serializable representation of an error for these guard paths.

## Preset loader

`M3LScriptPresetLoader` loads named parameter presets from YAML or JSON files. It enforces a maximum nesting depth of 64 (`MAX_PRESET_STRUCTURE_DEPTH`) and uses Damerau-Levenshtein distance to suggest corrections for unknown keys. When a preset contains keys that are not recognized, it throws `M3LPresetUnknownKeysError`.

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
