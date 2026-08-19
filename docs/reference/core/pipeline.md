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
- Outcome: `M3LOperationPipelineOutcome`, `M3LOperationPipelineOutcomeBase`
- Tracing: `M3LPipelineTraceOptions`, `M3LPipelineTraceSink`,
  `M3LPipelineTraceSnapshot`, `M3LPipelinePhase`

No error class is exported. Guard and configuration failures throw `M3LError`
with the **caller-supplied** `configCode`; construction-time option validation
throws an internal `M3LError` subclass with code `ERR_PIPELINE_INVALID_OPTION`
(origin `caller`, not retryable). That same code is also thrown **at run time**
in one case — a `recovery` callback that returns a non-array (see
[Partial runs](#partial-runs)) — so `ERR_PIPELINE_INVALID_OPTION` is not
exclusively a construction-time signal.

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
   `destructive.yes(settings)`, and `destructive.abortCode` — plus, when
   configured, `destructive.target(...)`, the `destructive.isSensitiveTarget`
   verdict and `destructive.yesSensitive(settings)`, which forward the ADR-0048
   target-grading dimension unchanged (see
   [Core / prompt](./prompt.md#confirmdestructive) for the five states). With
   no `target` configured, this phase behaves exactly as it did before target
   grading. Behavior on decline follows `onDecline` (below). Only an `M3LError`
   whose `code` equals `abortCode` **raised by the confirmation itself** is
   treated as a decline — including the failed-typed-echo decline on a
   sensitive target; any other failure from the gate propagates unmodified,
   and so does an `abortCode`-carrying throw from `target(...)` or
   `isSensitiveTarget(...)`, since those run before the `try`. (The bypass warning on this path is emitted by
   `confirmDestructive` itself, not authored by the engine. It names the target
   only for a **sensitive** one bypassed via `yesSensitive`; a supplied but
   non-sensitive target takes the ungraded branch and logs the plain
   `destructive confirmation bypassed (yes=true): <description>` with no target
   fields.)
7. **Dispatch** — `handlers[operation](operation, settings, context, deps)`.
8. **Persist** — `persist?.(result, settings, deps, operation)`.
9. **Finalize** — `finalize?.(result, settings, deps, operation)`. Runs **after**
   persist, so a post-dispatch assertion that throws (e.g. a wait operation
   that did not stabilize) still leaves the persisted result on disk.
10. **Recovery** — `recovery?.(result, settings, deps, operation)`. Returns the
    per-item failures the handler absorbed, as `M3LRunRecoveryEntry[]`.
11. **Outcome** — resolves `{ status: "completed", operation, result }`, or
    `{ status: "partial", operation, result, recovery }` when phase 10 returned
    a non-empty array.

Any throw from phases 1–10 (other than a soft-landed decline) propagates to
the caller unmodified — the engine never swallows, wraps, or re-codes errors.

When `trace` is configured, each phase that runs contributes one entry to the
sink (see [Tracing](#tracing)). The eleven phases above correspond one-to-one
with the `M3LPipelinePhase` values, which are lowercase (`"accessor"`,
`"operation"`, …).

A pipeline instance is **stateless across runs**: `run()` keeps all per-run
state in its own call frame, so an instance is reusable for sequential runs
and safe under concurrent `run()` calls (mirroring `core/polling`'s per-call
isolation).

**Both `destructive.target(...)` and `destructive.isSensitiveTarget(...)` run
before the gate's `try`, and each exactly once.** The engine pre-computes the
sensitivity verdict and forwards that, rather than handing the predicate itself
to `confirmDestructive`. This is load-bearing, not incidental: a throw from
either callback must reach the caller, and were either invoked inside the
`try`, a throw carrying the gate's own `abortCode` would be absorbed as an
operator decline — soft-landing the run to `status: "declined"`, discarding the
real cause, and never prompting anyone. Do not move either call inside the
`try`.

## Decline policy

`M3LPipelineDeclinePolicy` is a discriminated union chosen per pipeline:

- `{ kind: "throw" }` — the decline error (an `M3LError` with
  `destructive.abortCode`) propagates to the caller. This is `ecs-ops`'s
  behavior (`ERR_ECS_OPS_ABORTED`).
- `{ kind: "soft-land", result, warning? }` — the engine logs
  `warning(operation, settings, deps)` via `deps.logger.warning` (when
  provided), then resolves `{ status: "declined", operation, result:
result(operation, settings, deps) }` without dispatching. A declined run
  produced no handler result, so `persist`, `finalize` and `recovery` are
  **skipped** —
  the run resolves immediately after the warning. This is `s3-objects`'s
  behavior (an empty `{ processed: 0, failed: 0 }` summary).

The outcome's `status` field makes a declined run first-class: callers that
care can branch on it; thin wrappers that preserve a legacy signature can
return `outcome.result` unconditionally.

## Partial runs

`recovery` is the **only** way a run becomes `"partial"`. The engine never
inspects a result to decide whether it was degraded — it cannot, since only the
handler knows what "an item" is for its operation. A pipeline that declares no
`recovery` callback can never resolve `"partial"`, and its behavior is
byte-identical to before this phase existed.

The engine's sole contribution is the emptiness test: an empty array is a clean
run (`"completed"`), a non-empty one is `"partial"`. A callback returning
anything that is not an array — reachable from JavaScript, or from TypeScript
via an assertion — is a caller error and fails loud with an `M3LError` rather
than surfacing as a bare `TypeError` from inside the engine. This keeps the
classification honest in both directions — a handler cannot report a degraded
run as clean by omission, and the engine cannot invent a degradation the
handler never reported.

A `"partial"` run **still ran `persist` and `finalize`**: it dispatched
successfully and produced a real result. This is the distinction the outcome
exists to preserve — a run that processed 997 of 1000 keys deleted 997 keys,
and reporting it as a `failure` implies it deleted none.

## Tracing

`trace` is opt-in and additive. **Absent `trace`, behavior is byte-identical**
to a pipeline without the option, and the engine performs no timing work at all.

```typescript
const trail = new Core.M3LBreadcrumbTrail();

const pipeline = new Core.M3LOperationPipeline({
  // …operations, handlers, …
  trace: {
    sink: trail,
    describe: (phase, snapshot) => ({
      bucket: snapshot.settings?.bucket ?? null,
      dryRun: snapshot.settings?.dryRun ?? false,
    }),
  },
});

await Core.runScript(main, { trail }); // the trail feeds the report `timeline`
```

### What is recorded

One entry per phase that **actually executes**, recorded under the event name
`pipeline:phase`, against the source label `trace.source` — defaulting to
`"M3LOperationPipeline"`. A phase whose optional callback is not configured
(`prepare`, `persist`, `finalize`, `recovery`) contributes nothing — the trace
reflects what ran, not what could have run.

`guards` and `gate` are the exceptions: both are traced **unconditionally**,
even with no `requiredFields` and no `destructive` configured. They are phases
of the run that always execute (and no-op internally), not caller callbacks that
may be absent. A soft-landed decline returns at phase 6, so
phases 7–10 are absent from its trace; both the declined and the partial return
paths still record their `outcome` entry.

Each entry's payload carries:

| Key          | Meaning                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`      | The `M3LPipelinePhase` value.                                                                                                                                                                                                                                                                                                        |
| `durationMs` | Wall-clock duration of that phase, from `performance.now()`.                                                                                                                                                                                                                                                                         |
| `operation`  | The resolved operation. Present on the `operation` phase's own entry, because the payload is recorded at phase **exit**, by which point that phase has resolved it. Omitted for the `accessor` phase, and for a **failing** `operation` phase — an off-union value means no operation was ever resolved, so there is none to report. |
| `failed`     | `true` only when the phase threw. Omitted otherwise.                                                                                                                                                                                                                                                                                 |

Plus every key `describe` returned. **The engine's four keys are applied last
and win** a name collision, so a `describe` return cannot forge `durationMs` or
mislabel `phase`.

### `describe` runs at phase entry

`describe` is invoked at each phase's **entry**, before the phase body, so it
records the value the phase actually used rather than what was declared at
construction time. Its `snapshot` therefore carries only what has been resolved
so far:

- `operation` — absent for `accessor` and for `operation` itself, since the
  `operation` phase is the one that resolves it.
- `settings` — absent until the `settings` phase has completed, so absent for
  `accessor`, `operation`, and `settings` itself.
- `context` — absent until `prepare` has completed; always absent when no
  `prepare` is configured (`TContext` is `undefined`).

The payload is pinned to `M3LBreadcrumbScalar` (`string | number | boolean |
null`), and that pin is **enforced at run time as well as in the type**: the
engine keeps only genuine scalar values and drops everything else — a nested
object, an array, a function, a `Date` — before handing the payload to the sink.
A `__proto__`-style dangerous key is skipped outright. So a JavaScript caller,
or a TypeScript assertion, cannot smuggle a non-scalar through, and no sink
receives a live reference to a caller's object.

That is the allowlist constraint from
[ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md)'s 2026-07-23
update, where four adversarial rounds established that every allowlisted
surface held and every denylisted one leaked.

### Tracing is never load-bearing

A tracing failure **cannot change a run's outcome**. This covers three distinct
routes, each guarded independently: a throwing `describe` call, a **hostile
`describe` return value** (a throwing getter fires when the payload is read, not
when `describe` returns), and a throwing `sink.record`. On any of them the run
proceeds unaffected.

A phase that throws still records its entry with `failed: true`, and its own
error **always** propagates unmodified — recording happens once, after the
phase's outcome is captured, so a failure inside the tracing path can never
replace, wrap, re-code, or attach a `cause` to the phase's real error.

The warning the engine logs is deliberately minimal, because an error's fields
are caller-controlled:

- It **never** logs the error's `message` or `stack`.
- It **never** logs the error's `name`.
- It names the phase, plus the error's `code` **only** when that code is a
  member of the library's own `M3L_ERROR_CODES`. An unrecognized or
  caller-invented code renders as `unclassified` rather than being echoed.

```text
M3LOperationPipeline: tracing failed at phase 'guards' (ERR_INVALID_ARGUMENT)
M3LOperationPipeline: tracing failed at phase 'guards' (unclassified)
```

### Redaction is the sink's responsibility

The engine enforces the payload's _shape_ (scalars only, dangerous keys
dropped) but does not sanitize scalar _values_. It deliberately does not
redact — that keeps `core/pipeline`'s import graph shallow and leaves one owner
for the redaction policy — so a bare `record()`-shaped sink receives every
surviving scalar verbatim.

`M3LBreadcrumbTrail` is the sink that adds redaction, and it is the recommended
one. Be precise about what it does and does not cover:

- It **does** mask values whose key names `redactSensitiveLogValue` recognizes
  as sensitive by name.
- It does **not** honor a caller-declared secrets specifier — the trail calls
  `redactSensitiveLogValue` with no options, so a value a caller declared
  sensitive elsewhere is still persisted verbatim if its key name is not one the
  heuristic recognizes.
- It does **not** recognize a bare, context-free secret in free text. The
  redactor is pattern- and key-name-based; a lone token in a `describe` string
  is not caught.

So trail redaction is **best effort**, not a guarantee. `describe` is
caller-authored, and its return reaches the run report on disk: the durable rule
is to not put a secret in it in the first place, rather than to rely on the sink
to remove one.

## Types

```typescript
interface M3LOperationPipelineBaseDeps {
  readonly config: M3LConfig;
  readonly logger: M3LLogger;
  readonly prompt: M3LPrompt;
}

type M3LGuardableKey<TSettings extends object> = {
  [K in keyof TSettings & string]: undefined extends TSettings[K] ? K : never;
}[keyof TSettings & string];

type M3LOperationHandlers<
  TOp extends string,
  TSettings extends object,
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

type M3LPipelineDeclinePolicy<
  TOp extends string,
  TSettings extends object,
  TDeps,
  TResult,
> =
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
  TSettings extends object,
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
  // ADR-0048 target grading — all optional; omitting them leaves the gate
  // phase byte-identical to its pre-grading behavior.
  readonly target?: (
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ) => M3LDestructiveTarget;
  readonly isSensitiveTarget?: M3LDestructiveTargetPredicate;
  readonly yesSensitive?: (settings: TSettings) => boolean;
}

// The exported options type is an intersection: a core shape carrying every
// member except `prepare`, plus a conditional arm that makes `prepare`
// OPTIONAL when `TContext` is `undefined` and REQUIRED otherwise — so a
// handler can never receive a typed-non-undefined `context` holding
// `undefined` at runtime.
type M3LOperationPipelineOptions<
  TOp extends string,
  TSettings extends object,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext = undefined,
> = M3LOperationPipelineCoreOptions<TOp, TSettings, TDeps, TResult, TContext> &
  ([TContext] extends [undefined]
    ? {
        readonly prepare?: (
          operation: TOp,
          settings: TSettings,
          deps: TDeps,
        ) => Promise<TContext>;
      }
    : {
        readonly prepare: (
          operation: TOp,
          settings: TSettings,
          deps: TDeps,
        ) => Promise<TContext>;
      });

// Core shape (not exported — reachable only through M3LOperationPipelineOptions):
interface M3LOperationPipelineCoreOptions<
  TOp extends string,
  TSettings extends object,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext,
> {
  /** Non-empty tuple of literal operation names — a widened `readonly
   *  string[]` is rejected so `TOp` cannot silently widen to `string`. */
  readonly operations: readonly [TOp, ...(readonly TOp[])];
  readonly configCode: string;
  readonly resolveSettings: (
    accessor: M3LConfigAccessor,
    operation: TOp,
  ) => TSettings | Promise<TSettings>;
  readonly requiredFields?: {
    readonly [K in TOp]: readonly M3LGuardableKey<TSettings>[];
  };
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
    operation: TOp,
  ) => Promise<void>;
  readonly finalize?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ) => void | Promise<void>;
  readonly recovery?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ) => readonly M3LRunRecoveryEntry[];
  readonly trace?: M3LPipelineTraceOptions<TOp, TSettings, TContext>;
}

interface M3LOperationPipelineOutcomeBase<TOp extends string, TResult> {
  readonly operation: TOp;
  readonly result: TResult;
}

type M3LOperationPipelineOutcome<
  TOp extends string,
  TResult,
> = M3LOperationPipelineOutcomeBase<TOp, TResult> &
  (
    | {
        readonly status: "partial";
        readonly recovery: readonly [
          M3LRunRecoveryEntry,
          ...M3LRunRecoveryEntry[],
        ];
      }
    | {
        readonly status: "completed";
        readonly recovery?: undefined;
      }
    | {
        readonly status: "declined";
        readonly recovery?: undefined;
      }
  );

type M3LPipelinePhase =
  | "accessor"
  | "operation"
  | "settings"
  | "guards"
  | "prepare"
  | "gate"
  | "dispatch"
  | "persist"
  | "finalize"
  | "recovery"
  | "outcome";

interface M3LPipelineTraceSnapshot<
  TOp extends string,
  TSettings extends object,
  TContext,
> {
  readonly operation?: TOp;
  readonly settings?: TSettings;
  readonly context?: TContext;
}

interface M3LPipelineTraceSink {
  record(source: string, event: string, payload?: unknown): void;
}

interface M3LPipelineTraceOptions<
  TOp extends string,
  TSettings extends object,
  TContext,
> {
  readonly sink: M3LPipelineTraceSink;
  readonly describe?: (
    phase: M3LPipelinePhase,
    snapshot: M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
  ) => Readonly<Record<string, M3LBreadcrumbScalar>>;
  readonly source?: string;
}

class M3LOperationPipeline<
  TOp extends string,
  TSettings extends object,
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
  declarations — proven at contract time by compiling s3-objects-shaped
  fixtures with zero diagnostics and locked by the suite's type-level tests.
  The once-considered curried-builder fallback is **declined** (recorded at
  spec-conformance review). One caveat the fixtures encode: `TDeps` infers
  only from callback parameter positions, so at least one callback must
  annotate its `deps` parameter with the script's deps type.

## Construction-time validation

The constructor validates its options eagerly and throws
`ERR_PIPELINE_INVALID_OPTION` (internal `M3LError` subclass, never exported)
when:

- `operations` is empty or contains duplicates;
- `destructive.operations` contains an operation not present in `operations`.

Type-level exhaustiveness makes these unreachable from well-typed TypeScript;
the runtime checks guard JavaScript callers and dynamic construction.

**Every problem is reported at once.** Validation collects all violations before
throwing, so constructing a pipeline with three malformed options surfaces three
problems in one throw rather than one per fix-and-rerun cycle. The thrown
error's `code` remains `ERR_PIPELINE_INVALID_OPTION`; each individual problem
carries its own code in `context.problems`:

| Problem code                                 | Raised when                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ERR_PIPELINE_EMPTY_OPERATIONS`              | `operations` is empty.                                                                                |
| `ERR_PIPELINE_DUPLICATE_OPERATION`           | `operations` repeats an entry. Reported once per duplicated name.                                     |
| `ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION` | `destructive.operations` names an operation absent from `operations`. Reported once per unknown name. |

`context.problems` is a non-empty array of `{ code, message }`, each entry also
carrying `operation` where the problem names one. With exactly one problem the
error's `message` is that problem's message; with several it is a summary line
followed by each problem's message.

Because collection replaces short-circuiting, an empty `operations` list no
longer hides the `destructive` check — an empty list with a configured
`destructive.operations` reports both the emptiness and every destructive name
as unknown.

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
