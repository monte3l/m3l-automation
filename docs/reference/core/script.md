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

## File archival (stage 9)

Stage 9 archives the run's inputs: a fresh `M3LFileCopier` auto-discovers every
regular file in `paths.getInputDir()` and `paths.getConfigDir()` and copies
them into a per-run timestamped directory:

```text
data/output/
├── inputs/    # snapshot of data/input at run time
└── configs/   # snapshot of data/config at run time
```

Constraints: 100 MB per-file default cap, no overwrite of existing
destinations, path-traversal guards. The archive result is available afterwards
via `getLastArchiveReport()`.

> Archival is **flat and not timestamped**: `M3LFileCopier` resolves its
> destination from `M3LPaths.getOutputDir()` directly and groups files by
> `getDefaultSubdirForPathType` (`inputs`/`configs`). An earlier draft of this
> page drew a `data/output/<timestamp>/` tree with `input/`/`config/`
> subdirectories; neither the timestamp nor those singular names have ever
> existed in the code.

Archival runs on the **success path only** — a run that fails before stage 9
archives nothing today. The
[diagnostics run report](./diagnostics.md#m3lrunreport--m3lrunreporter)
(ADR-0035 phase 1) is written on **both** outcomes, failure included, into its
own per-run `data/output/<startedAt>/` directory — deliberately _not_ shared
with the flat archival above, since changing that layout would break the nine
consumer scripts already reading it. Reconciling the two is ADR-0035 phase 5.

## Exit codes

`run()` itself never exits and never sets an exit code: on failure it re-throws
after the `onError`/`onCleanup` hooks, and the process falls through to Node's
default unhandled-rejection behavior (exit code `1`) unless the composition
root intervenes. The differentiated exit-code contract — `2` caller/config,
`3` external, `4` library, `5` interrupted — is provided by the opt-in
[`runScript()` wrapper](./diagnostics.md#runscript) (ADR-0035), which sets
`process.exitCode` from `mapErrorToExitCode`; bare `run()` behavior is
unchanged.

## Signal handling

Signal handlers for `SIGTERM`, `SIGINT`, and `SIGQUIT` are registered only in non-AWS environments. A second signal forces an immediate exit with code `1`. In AWS execution environments (for example, Lambda), these handlers are not installed.

## Process guards

`installProcessGuards()` is a process-global singleton that installs `unhandledRejection`, `uncaughtException`, `warning`, and `beforeExit` handlers. In Lambda, call `setProcessGuardRequestId(requestId)` to attribute guard-caught errors to the current invocation. `serializeError` produces a serializable representation of an error for these guard paths.

**Who installs the guards.** `M3LScript` never calls `installProcessGuards()`
itself — installation is the composition root's responsibility, and the two
fault-handling layers deliberately differ:

- **Guards observe, signals control.** The process guards only capture and
  report faults (a redacted JSON diagnostic on stderr); they never change exit
  behavior. Note the flip side: installing an `uncaughtException` handler
  suppresses Node's default crash-and-exit for that fault class, so an
  observed process may keep running after an uncaught exception. The signal
  layer is the opposite: it _controls_ shutdown and force-exits on a second
  signal.
- **CLI:** call `installProcessGuards()` once at the top of `main.ts` — or use
  the [`runScript()` wrapper](./diagnostics.md#runscript) (ADR-0035), which
  installs them, adds a top-level catch, and sets the exit code.
- **Lambda:** guards are optional; if used, call `installProcessGuards()` once
  at module scope (cold start). `setProcessGuardRequestId` is wired per
  invocation by `createLambdaHandler()` automatically.

## Correlation IDs

`M3LScript` threads one optional **correlation id** through a run so hooks, logs,
and failure diagnostics can all be tied back to the same execution.

```typescript
interface M3LScriptOptions {
  // ...existing fields
  readonly correlationId?: string; // optional; generated per run when omitted
  readonly preset?: string; // optional path to a YAML/JSON preset file (see Preset loader)
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

### Wiring a preset into config (`options.preset`)

`M3LScriptOptions.preset` is an optional path to a YAML/JSON preset file. When
supplied, stage 3 (config load) loads the file via `M3LScriptPresetLoader` —
validated against the script's declared `config.params` schema — and inserts its
values into configuration resolution at **precedence level 6**: below CLI
(level 1) and environment (level 4), above static `defaultValue`s (level 7). See
[`config` → Resolution order](./config.md#resolution-order).

When `options.preset` is omitted, no preset file is read and no preset provider
is added — there is no behavior change. Supplying `preset` **without** a `config`
declaration means there is no schema to validate against, so every top-level key
is treated as unknown and the loader throws `M3LPresetUnknownKeysError` — a
preset is meant to be used alongside a declared `config`. An empty string is
treated as **present** (and fails at load with an `M3LError` coded
`ERR_PRESET_LOAD`), not absent — omit the field to mean "no preset."

Any throw from the preset loader — `M3LPresetUnknownKeysError`,
`M3LPresetCycleError`, or an `M3LError` coded `ERR_PRESET_LOAD` for a
missing/malformed file — propagates unchanged; the preset seam introduces no new
error types and does not catch or swallow the failure.

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
- [diagnostics](./diagnostics.md) — `runScript()`, exit codes, run reports
- [environment](./environment.md)
- [errors](./errors.md)
- [logging](./logging.md)
- [Guide: Writing a script](../../guides/writing-a-script.md)
- [Guide: Troubleshooting](../../guides/troubleshooting.md)
- [Guide: Lambda handlers](../../guides/lambda-handlers.md)
- [Architecture overview](../../m3l-common-architecture.md)
