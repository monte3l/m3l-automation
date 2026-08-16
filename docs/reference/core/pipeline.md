# Core: `pipeline`

A declarative engine for the multi-operation dispatcher skeleton that consumer
scripts' `steps/run-*.ts` modules hand-write — operation resolution, settings
resolution, per-operation required-field guards, the destructive-operation
gate, handler dispatch, optional persistence, and post-dispatch assertions —
behind one typed class: `M3LOperationPipeline`.

## Overview

Every multi-operation consumer script repeats the same run skeleton: read the
`operation` config parameter against a closed union, resolve a settings
struct, verify the operation's required fields, confirm destructive operations
through `Core.confirmDestructive`, dispatch to a per-operation handler,
persist the result, and run post-dispatch assertions. `M3LOperationPipeline`
owns that ordering; the script keeps everything genuinely script-specific —
the operation list, the settings resolver, the handler functions, the error
codes, and log text.

The engine opens the gate recorded in
[ADR-0043](../../adr/0043-step-pipeline-engine-deferred.md) (Update
2026-08-16): it is built against two named consumers, `scripts/s3-objects`
and `scripts/ecs-ops`.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- Engine: `M3LOperationPipeline`
- Options: `M3LOperationPipelineOptions`, `M3LPipelineDestructiveOptions`,
  `M3LPipelineDeclinePolicy`
- Contracts: `M3LOperationPipelineBaseDeps`, `M3LOperationHandlers`,
  `M3LGuardableKey`
- Outcome: `M3LOperationPipelineOutcome`

No error class is exported. Guard and configuration failures throw `M3LError`
with the **caller-supplied** `configCode`; construction-time option validation
throws an internal `M3LError` subclass with code `ERR_PIPELINE_INVALID_OPTION`
(origin `caller`, not retryable).

## The run contract

`run(deps)` executes exactly these phases, in exactly this order:

1. **Accessor** — builds a `Core.M3LConfigAccessor` over `deps.config` with
   the pipeline's `configCode`, so every guard failure carries the script's
   own error code.
2. **Operation** — `accessor.oneOf("operation", operations)`. The config
   parameter name is fixed to `"operation"` (every current multi-op script
   uses it); an off-union value throws with `configCode`.
3. **Settings** — `resolveSettings(accessor, operation)` (sync or async).
   The resolver must not re-read `"operation"` or apply its own required-field
   guards; those belong to phases 2 and 4.
4. **Guards** — when `requiredFields` is present, each listed key of the
   resolved settings is checked via `accessor.requiredFor(value, name,
operation)`, producing the message `'<name>' is required for operation
'<operation>'` — byte-identical to the hand-rolled guards the engine
   replaces. Keys are checked in the row's array order; the first missing
   field throws. Operations requiring nothing use an empty array; the table
   is exhaustive over the operation union at the type level.
5. **Prepare** — `prepare?.(operation, settings, deps)` runs once, before the
   gate, and its return value (`TContext`) feeds both the gate description
   and the handler. Use it for work that must happen exactly once and whose
   result the gate text needs (e.g. reading an input file to describe what a
   write would do).
6. **Gate** — when `destructive` is configured and the operation is a member
   of `destructive.operations`, the engine calls `Core.confirmDestructive`
   with `deps.prompt`, `deps.logger`, `destructive.describe(...)`,
   `destructive.yes(settings)`, and `destructive.abortCode`. Behavior on
   decline follows `onDecline` (below). Only an `M3LError` whose `code`
   equals `abortCode` is treated as a decline; any other failure from the
   gate propagates unmodified. (The `yes: true` bypass warning on this path
   is emitted by `confirmDestructive` itself, not authored by the engine.)
7. **Dispatch** — `handlers[operation](operation, settings, context, deps)`.
8. **Persist** — `persist?.(result, settings, deps)`.
9. **Finalize** — `finalize?.(result, settings, deps)`. Runs **after**
   persist, so a post-dispatch assertion that throws (e.g. a wait operation
   that did not stabilize) still leaves the persisted result on disk.
10. **Outcome** — resolves `{ status: "completed", operation, result }`.

Any throw from phases 1–9 (other than a soft-landed decline) propagates to
the caller unmodified — the engine never swallows, wraps, or re-codes errors.

A pipeline instance is **stateless across runs**: `run()` keeps all per-run
state in its own call frame, so an instance is reusable for sequential runs
and safe under concurrent `run()` calls (mirroring `core/polling`'s per-call
isolation).

## Decline policy

`M3LPipelineDeclinePolicy` is a discriminated union chosen per pipeline:

- `{ kind: "throw" }` — the decline error (an `M3LError` with
  `destructive.abortCode`) propagates to the caller. This is `ecs-ops`'s
  behavior (`ERR_ECS_OPS_ABORTED`).
- `{ kind: "soft-land", result, warning? }` — the engine logs
  `warning(operation, settings, deps)` via `deps.logger.warning` (when
  provided), then resolves `{ status: "declined", operation, result:
result(operation, settings, deps) }` without dispatching. A declined run
  produced no handler result, so `persist` and `finalize` are **skipped** —
  the run resolves immediately after the warning. This is `s3-objects`'s
  behavior (an empty `{ processed: 0, failed: 0 }` summary).

The outcome's `status` field makes a declined run first-class: callers that
care can branch on it; thin wrappers that preserve a legacy signature can
return `outcome.result` unconditionally.

## Types

```typescript
interface M3LOperationPipelineBaseDeps {
  readonly config: M3LConfig;
  readonly logger: M3LLogger;
  readonly prompt: M3LPrompt;
}

type M3LGuardableKey<TSettings> = {
  [K in keyof TSettings & string]: undefined extends TSettings[K] ? K : never;
}[keyof TSettings & string];

type M3LOperationHandlers<
  TOp extends string,
  TSettings,
  TDeps,
  TResult,
  TContext,
> = {
  readonly [K in TOp]: (
    operation: K,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ) => Promise<TResult>;
};

type M3LPipelineDeclinePolicy<TOp extends string, TSettings, TDeps, TResult> =
  | { readonly kind: "throw" }
  | {
      readonly kind: "soft-land";
      readonly result: (
        operation: TOp,
        settings: TSettings,
        deps: TDeps,
      ) => TResult;
      readonly warning?: (
        operation: TOp,
        settings: TSettings,
        deps: TDeps,
      ) => string;
    };

interface M3LPipelineDestructiveOptions<
  TOp extends string,
  TSettings,
  TDeps,
  TResult,
  TContext,
> {
  readonly operations: ReadonlySet<TOp>;
  readonly describe: (
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ) => string;
  readonly yes: (settings: TSettings) => boolean;
  readonly abortCode: string;
  readonly onDecline: M3LPipelineDeclinePolicy<TOp, TSettings, TDeps, TResult>;
}

interface M3LOperationPipelineOptions<
  TOp extends string,
  TSettings,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext = undefined,
> {
  readonly operations: readonly TOp[];
  readonly configCode: string;
  readonly resolveSettings: (
    accessor: M3LConfigAccessor,
    operation: TOp,
  ) => TSettings | Promise<TSettings>;
  readonly requiredFields?: {
    readonly [K in TOp]: readonly M3LGuardableKey<TSettings>[];
  };
  readonly prepare?: (
    operation: TOp,
    settings: TSettings,
    deps: TDeps,
  ) => Promise<TContext>;
  readonly destructive?: M3LPipelineDestructiveOptions<
    TOp,
    TSettings,
    TDeps,
    TResult,
    TContext
  >;
  readonly handlers: M3LOperationHandlers<
    TOp,
    TSettings,
    TDeps,
    TResult,
    TContext
  >;
  readonly persist?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
  ) => Promise<void>;
  readonly finalize?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
  ) => void | Promise<void>;
}

interface M3LOperationPipelineOutcome<TOp extends string, TResult> {
  readonly operation: TOp;
  readonly status: "completed" | "declined";
  readonly result: TResult;
}

class M3LOperationPipeline<
  TOp extends string,
  TSettings,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext = undefined,
> {
  constructor(
    options: M3LOperationPipelineOptions<
      TOp,
      TSettings,
      TDeps,
      TResult,
      TContext
    >,
  );
  run(deps: TDeps): Promise<M3LOperationPipelineOutcome<TOp, TResult>>;
}
```

### Type-safety contracts

- **Exhaustive handler table.** `M3LOperationHandlers` is a mapped type over
  the operation union: adding an operation to `operations` without a handler
  entry (or a `requiredFields` row) is a compile error. This retires the
  two-level type-predicate dispatch pattern — each operation is its own
  handler function, so per-function size caps are never approached.
- **Shared handlers narrow per key.** Because each key `K` maps to a handler
  receiving `operation: K`, a shared handler declared over a literal
  sub-union (e.g. `(op: "describe" | "get", …)`) is assignable to each of its
  slots under `strictFunctionTypes` contravariance.
- **Only optional settings are guardable.** `M3LGuardableKey<TSettings>`
  admits only keys whose type includes `undefined`, so a `requiredFields` row
  can never name an always-present field.
- **Inference.** All five generics infer from a single options-object literal
  when `resolveSettings` and the handler functions are standalone typed
  declarations. If inference proves brittle in practice, the pre-agreed
  fallback is a curried builder (`createOperationPipeline<TSettings,
TDeps>()({...})`) — a decision to make at spec-conformance review, not
  mid-implementation.

## Construction-time validation

The constructor validates its options eagerly and throws
`ERR_PIPELINE_INVALID_OPTION` (internal `M3LError` subclass, never exported)
when:

- `operations` is empty or contains duplicates;
- `destructive.operations` contains an operation not present in `operations`.

Type-level exhaustiveness makes these unreachable from well-typed TypeScript;
the runtime checks guard JavaScript callers and dynamic construction.

## Example — soft-landing pipeline (s3-objects shape)

```typescript
import { Core } from "@m3l-automation/m3l-common";

const OPS = [
  "list",
  "describe",
  "get",
  "put",
  "copy",
  "delete",
  "delete-batch",
] as const;

const pipeline = new Core.M3LOperationPipeline({
  operations: OPS,
  configCode: "ERR_S3_OBJECTS_CONFIG",
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  destructive: {
    operations: new Set(["put", "copy", "delete", "delete-batch"] as const),
    describe: (op, settings) => describeDestructiveOp(op, settings),
    yes: (settings) => settings.yes,
    abortCode: "ERR_S3_OBJECTS_ABORTED",
    onDecline: {
      kind: "soft-land",
      result: () => ({ processed: 0, failed: 0 }),
      warning: (op, _settings, deps) =>
        `s3-objects run ${deps.correlationId} aborted before '${op}'`,
    },
  },
  handlers: {
    list: dispatchList,
    describe: dispatchDescribeOrGet,
    get: dispatchDescribeOrGet,
    put: dispatchPutObject,
    copy: dispatchCopyObject,
    delete: dispatchDeleteObject,
    "delete-batch": dispatchDeleteBatch,
  },
  finalize: (result) => assertNoFailedKeys(result),
});

export async function runS3Objects(deps: Deps): Promise<RunS3ObjectsSummary> {
  return (await pipeline.run(deps)).result;
}
```

A throwing pipeline (ecs-ops shape) differs only in `onDecline: { kind:
"throw" }`, a `prepare` phase that plans the write dispatch once before the
gate, and a `persist` that exports the result before `finalize` asserts wait
stability.

## Out of scope

Recorded here so the engine does not creep past its evidence
(ADR-0043 Update 2026-08-16):

- **Checkpoint/resume** (`dynamodb-crud`) — resumable multi-phase runs stay
  script-local; a handler may compose `core/checkpoint` internally.
- **Multi-file routing** (`rds-data-sql`) — a script may build one pipeline
  per operation family and route above them; the engine does not model
  routers.
- **Thin passthroughs and single-operation scripts** — nothing to absorb.
- **Custom gate variants** — only the canonical `Core.confirmDestructive`
  shape.
- **Completion-log text** — script-owned (in `finalize` or after `run()`
  resolves); the engine never invents log lines.
- **Configurable operation parameter name** — fixed to `"operation"`.
