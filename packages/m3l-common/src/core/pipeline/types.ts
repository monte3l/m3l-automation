/**
 * `core/pipeline/types` — the public option, dependency, and outcome shapes
 * consumed and produced by {@link M3LOperationPipeline}.
 *
 * @packageDocumentation
 */

import type { M3LConfig } from "../config/M3LConfig.js";
import type { M3LConfigAccessor } from "../config/M3LConfigAccessor.js";
import type { M3LLogger } from "../logging/M3LLogger.js";
import type { M3LPrompt } from "../prompt/M3LPrompt.js";
import type {
  M3LDestructiveTarget,
  M3LDestructiveTargetPredicate,
} from "../prompt/M3LDestructiveGate.js";
import type {
  M3LBreadcrumbScalar,
  M3LRunRecoveryEntry,
} from "../diagnostics/index.js";

/**
 * The minimum dependency shape every {@link M3LOperationPipeline} run
 * requires: the raw config the pipeline reads via its own
 * `M3LConfigAccessor`, a logger for the decline-policy warning, and a prompt
 * used indirectly through `Core.confirmDestructive` in the destructive gate.
 *
 * A script's own `Deps` type extends this with whatever else its handlers,
 * `prepare`, `persist`, or `finalize` need (an AWS client, a correlation id,
 * `M3LPaths`, …) — the pipeline is generic over `TDeps` precisely so it can
 * pass the whole dependency bag through to script-owned callbacks unopened.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Deps extends Core.M3LOperationPipelineBaseDeps {
 *   readonly correlationId: string;
 * }
 * ```
 */
export interface M3LOperationPipelineBaseDeps {
  /** The raw config the pipeline wraps in its own `M3LConfigAccessor`. */
  readonly config: M3LConfig;
  /** Logger used for the `soft-land` decline policy's optional warning. */
  readonly logger: M3LLogger;
  /** Prompt passed through to `Core.confirmDestructive` for the gate phase. */
  readonly prompt: M3LPrompt;
}

/**
 * The subset of a settings struct's keys that {@link
 * M3LOperationPipelineOptions.requiredFields | requiredFields} may name.
 *
 * Only keys whose type includes `undefined` are admitted — a field that is
 * always present cannot be meaningfully "required," so naming it in
 * `requiredFields` is a type error rather than a silent no-op guard.
 *
 * @typeParam TSettings - The resolved settings struct for one pipeline.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Settings {
 *   readonly key?: string;
 *   readonly bucket: string;
 * }
 *
 * // "key" is guardable ("bucket" is not, since it lacks `undefined`).
 * type Guardable = Core.M3LGuardableKey<Settings>; // "key"
 * ```
 */
export type M3LGuardableKey<TSettings extends object> = {
  [K in keyof TSettings & string]: undefined extends TSettings[K] ? K : never;
}[keyof TSettings & string];

/**
 * The exhaustive per-operation handler table dispatched in the pipeline's
 * "Dispatch" phase. A mapped type over the operation union: every member of
 * `TOp` must have a handler entry, so adding an operation to `operations`
 * without adding its handler is a compile error.
 *
 * A handler declared over a literal sub-union of `TOp` (e.g. a function
 * shared by two operations) is assignable to each of its slots under
 * `strictFunctionTypes` contravariance, so one function can serve several
 * keys.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TDeps - The dependency bag passed through to every phase.
 * @typeParam TResult - The result type every handler resolves.
 * @typeParam TContext - The value `prepare` produced, or `undefined` when no
 *   `prepare` is configured.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * type Handlers = Core.M3LOperationHandlers<
 *   "list" | "get",
 *   { readonly bucket: string },
 *   Core.M3LOperationPipelineBaseDeps,
 *   { readonly count: number },
 *   undefined
 * >;
 * ```
 */
export type M3LOperationHandlers<
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

/**
 * What the pipeline does when `Core.confirmDestructive` reports a decline
 * (an `M3LError` whose `code` equals the gate's `abortCode`).
 *
 * - `{ kind: "throw" }` — the decline error propagates to the caller
 *   unmodified. Use when a declined destructive operation should abort the
 *   whole run (e.g. `ecs-ops`'s `ERR_ECS_OPS_ABORTED`).
 * - `{ kind: "soft-land", result, warning? }` — the pipeline logs
 *   `warning(operation, settings, deps)` via `deps.logger.warning` when
 *   `warning` is provided, then resolves a `"declined"` outcome carrying
 *   `result(operation, settings, deps)` instead of dispatching. Use when a
 *   declined run should still return a well-formed summary (e.g.
 *   `s3-objects`'s empty `{ processed: 0, failed: 0 }`).
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TDeps - The dependency bag passed through to every phase.
 * @typeParam TResult - The result type the declined outcome carries.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * const policy: Core.M3LPipelineDeclinePolicy<
 *   "delete",
 *   { readonly yes: boolean },
 *   Core.M3LOperationPipelineBaseDeps,
 *   { readonly processed: number }
 * > = {
 *   kind: "soft-land",
 *   result: () => ({ processed: 0 }),
 * };
 * ```
 */
export type M3LPipelineDeclinePolicy<
  TOp extends string,
  TSettings extends object,
  TDeps,
  TResult,
> =
  | { readonly kind: "throw" }
  | {
      readonly kind: "soft-land";
      /** Builds the result carried by the `"declined"` outcome. */
      readonly result: (
        operation: TOp,
        settings: TSettings,
        deps: TDeps,
      ) => TResult;
      /** Builds the message logged via `deps.logger.warning` on decline. */
      readonly warning?: (
        operation: TOp,
        settings: TSettings,
        deps: TDeps,
      ) => string;
    };

/**
 * Configuration for the pipeline's "Gate" phase — the destructive-operation
 * confirmation run through `Core.confirmDestructive` before dispatch.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TDeps - The dependency bag passed through to every phase.
 * @typeParam TResult - The result type every handler resolves.
 * @typeParam TContext - The value `prepare` produced, fed to `describe`
 *   alongside the gate.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Settings {
 *   readonly key: string;
 *   readonly yes: boolean;
 * }
 *
 * const destructive: Core.M3LPipelineDestructiveOptions<
 *   "delete",
 *   Settings,
 *   Core.M3LOperationPipelineBaseDeps,
 *   { readonly processed: number },
 *   undefined
 * > = {
 *   operations: new Set(["delete"] as const),
 *   describe: (op, settings) => `${op} ${settings.key}`,
 *   yes: (settings) => settings.yes,
 *   abortCode: "ERR_EXAMPLE_ABORTED",
 *   onDecline: { kind: "throw" },
 * };
 * ```
 */
export interface M3LPipelineDestructiveOptions<
  TOp extends string,
  TSettings extends object,
  TDeps,
  TResult,
  TContext,
> {
  /** The subset of `operations` that requires confirmation. */
  readonly operations: ReadonlySet<TOp>;
  /** Builds the human-readable description of what the operation would do. */
  readonly describe: (
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ) => string;
  /** Reads the settings' own pre-confirmation flag (e.g. a `--yes` switch). */
  readonly yes: (settings: TSettings) => boolean;
  /** The `M3LError` code that identifies a decline from the gate. */
  readonly abortCode: string;
  /** What to do when the gate reports a decline. */
  readonly onDecline: M3LPipelineDeclinePolicy<TOp, TSettings, TDeps, TResult>;
  /**
   * Builds the {@link M3LDestructiveTarget} the operation is directed at.
   * Called with the same four arguments as {@link describe} — including the
   * same by-reference `context` value. When absent, the gate runs without
   * target-graded escalation; when supplied, the result is forwarded to
   * {@link confirmDestructive} together with {@link isSensitiveTarget} and
   * {@link yesSensitive}.
   *
   * A throw from this callback propagates unchanged and skips the prompt
   * and the handler, exactly as a throw from {@link describe} does.
   */
  readonly target?: (
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ) => M3LDestructiveTarget;
  /**
   * Caller-owned policy that classifies the resolved {@link target} as
   * sensitive. Only consulted when {@link target} is supplied; a sensitive
   * classification triggers the escalated typed-echo confirmation path
   * (via `prompt.text`) instead of the standard yes/no `prompt.confirm`
   * call.
   *
   * Both {@link target}`(...)` and `isSensitiveTarget(...)` are called
   * **exactly once**, **before** the gate's `try`. The engine pre-computes the
   * sensitivity verdict and forwards that pre-computed value, rather than
   * handing the predicate itself to `confirmDestructive`. This is
   * load-bearing: were either called inside the `try`, a throw carrying the
   * gate's own `abortCode` would be absorbed as an operator decline —
   * soft-landing the run to `status: "declined"`, discarding the real cause,
   * and never prompting anyone. A throw from `isSensitiveTarget` therefore
   * propagates to the caller, exactly as a throw from {@link target} does.
   *
   * Ignored when {@link target} is absent.
   */
  readonly isSensitiveTarget?: M3LDestructiveTargetPredicate;
  /**
   * Reads the settings' own sensitive-bypass flag — analogous to
   * {@link yes} but for the escalated typed-echo path. When this returns
   * `true` together with {@link yes} returning `true`, the gate is bypassed
   * even for a sensitive target and logs a single warning naming the target.
   * When absent or returning `false`, {@link yes} alone is insufficient to
   * bypass a sensitive-target gate — the escalated echo is always required.
   *
   * Ignored when {@link target} is absent or the resolved target is not
   * classified as sensitive by {@link isSensitiveTarget}.
   */
  readonly yesSensitive?: (settings: TSettings) => boolean;
}

/**
 * The fixed, ordered set of phases {@link M3LOperationPipeline.run} executes.
 * A `trace` sink records at most one `"pipeline:phase"` entry per phase that
 * actually runs; see `docs/reference/core/pipeline.md` § Tracing for the full
 * per-phase contract.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function label(phase: Core.M3LPipelinePhase): string {
 *   return `phase: ${phase}`;
 * }
 * ```
 */
export type M3LPipelinePhase =
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

/**
 * The partial run state a {@link M3LPipelineTraceOptions.describe} callback
 * observes at a given phase's **entry**, before that phase's body runs.
 *
 * Every field is optional and its absence is meaningful, not incidental:
 * `operation` is absent for the `"accessor"` phase and for `"operation"`
 * itself (the phase that resolves it); `settings` is absent through
 * `"settings"` itself; `context` is absent through `"prepare"` itself and
 * always absent when no `prepare` is configured (`TContext` is `undefined`).
 * See `docs/reference/core/pipeline.md` § Tracing for the exhaustive
 * per-phase table.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TContext - The value `prepare` produces, or `undefined` when no
 *   `prepare` is configured.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function describeSnapshot(
 *   snapshot: Core.M3LPipelineTraceSnapshot<
 *     "list" | "delete",
 *     { readonly bucket?: string },
 *     undefined
 *   >,
 * ): string {
 *   return snapshot.settings?.bucket ?? "(no bucket yet)";
 * }
 * ```
 */
export interface M3LPipelineTraceSnapshot<
  TOp extends string,
  TSettings extends object,
  TContext,
> {
  /** The resolved operation, absent for `"accessor"` and `"operation"` itself. */
  readonly operation?: TOp;
  /** The resolved settings struct, absent through `"settings"` itself. */
  readonly settings?: TSettings;
  /** `prepare`'s resolved return value, absent through `"prepare"` itself. */
  readonly context?: TContext;
}

/**
 * The minimal `record`-shaped sink a pipeline trace writes to — independent
 * of the operation/settings/context type parameters {@link
 * M3LPipelineTraceOptions} is generic over, since `sink.record`'s own
 * signature never depends on them. Kept as a **structural** interface (not a
 * branded/nominal type) so a real emitter can satisfy it with zero adapter:
 * {@link M3LBreadcrumbTrail} satisfies this shape as-is, and so does any
 * two-line test double exposing a matching `record` method.
 *
 * @example
 * ```ts
 * import type { M3LPipelineTraceSink } from "@m3l-automation/m3l-common/core";
 *
 * const sink: M3LPipelineTraceSink = {
 *   record: (source, event, payload) => console.log(source, event, payload),
 * };
 * ```
 */
export interface M3LPipelineTraceSink {
  /** Records one phase entry. `payload` carries the engine's own keys plus `describe`'s return, if any. */
  record(source: string, event: string, payload?: unknown): void;
}

/**
 * Opt-in, additive tracing configuration for {@link M3LOperationPipeline}.
 * Absent `trace`, behavior is byte-identical to a pipeline without the
 * option and the engine performs no timing work at all.
 *
 * When configured, the engine records one `"pipeline:phase"` entry per phase
 * that actually executes via `sink.record`, guarding each `describe` and
 * `sink.record` call independently so tracing can never change a run's
 * outcome — see `docs/reference/core/pipeline.md` § Tracing.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TContext - The value `prepare` produces, or `undefined` when no
 *   `prepare` is configured.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * declare const trail: Core.M3LBreadcrumbTrail;
 *
 * const trace: Core.M3LPipelineTraceOptions<
 *   "list" | "delete",
 *   { readonly bucket?: string },
 *   undefined
 * > = {
 *   sink: trail,
 *   describe: (_phase, snapshot) => ({
 *     bucket: snapshot.settings?.bucket ?? null,
 *   }),
 * };
 * ```
 */
export interface M3LPipelineTraceOptions<
  TOp extends string,
  TSettings extends object,
  TContext,
> {
  /**
   * Receives every `"pipeline:phase"` entry the engine records. A
   * {@link M3LBreadcrumbTrail} satisfies this structurally; any other
   * `record`-shaped object receives the `describe` return **verbatim** — the
   * engine does not redact.
   */
  readonly sink: M3LPipelineTraceSink;
  /**
   * Builds extra payload keys from the phase's entry-time snapshot. Invoked
   * at each phase's **entry**, before that phase's body runs. The engine's
   * own `phase`/`durationMs`/`operation`/`failed` keys are applied last and
   * win a name collision, so this return cannot forge them.
   *
   * A throw here is guarded independently from a throwing `sink.record` —
   * the run's outcome and the phase's own recorded entry are unaffected; the
   * engine logs a warning naming the phase and the error's `name`/`code`
   * (never its `message`) and proceeds.
   */
  readonly describe?: (
    phase: M3LPipelinePhase,
    snapshot: M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
  ) => Readonly<Record<string, M3LBreadcrumbScalar>>;
  /** Overrides the default `"M3LOperationPipeline"` source label passed to `sink.record`. */
  readonly source?: string;
}

/**
 * The members of {@link M3LOperationPipelineOptions} that don't depend on
 * whether `prepare` is required — kept as its own (unexported) shape so the
 * public type can intersect it with a `prepare` arm chosen conditionally on
 * `TContext`, instead of duplicating every other member across two branches.
 *
 * @typeParam TOp - The closed operation-name union read from the `operation`
 *   config parameter via `accessor.oneOf`.
 * @typeParam TSettings - The struct `resolveSettings` returns.
 * @typeParam TDeps - The dependency bag passed to `run`; must extend {@link
 *   M3LOperationPipelineBaseDeps}.
 * @typeParam TResult - The result type every handler resolves and the
 *   outcome carries.
 * @typeParam TContext - The value `prepare` produces, fed to the gate's
 *   `describe` and to every handler. Defaults to `undefined` when no
 *   `prepare` is configured.
 */
interface M3LOperationPipelineCoreOptions<
  TOp extends string,
  TSettings extends object,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext,
> {
  /**
   * The closed set of operation names, checked via `accessor.oneOf`. A
   * non-empty readonly tuple, not a plain `readonly TOp[]` — a widened
   * `readonly string[]` no longer type-checks here, so `TOp` cannot
   * silently widen to `string` and dissolve the handler table's
   * exhaustiveness (an empty array would otherwise type-check while
   * defeating every mapped type keyed off `TOp`).
   */
  readonly operations: readonly [TOp, ...(readonly TOp[])];
  /** The `M3LError` code attached to every guard/config failure. */
  readonly configCode: string;
  /**
   * Resolves the settings struct for the chosen operation. Must not re-read
   * the `"operation"` parameter or apply its own required-field guards —
   * those are owned by the "Operation" and "Guards" phases.
   */
  readonly resolveSettings: (
    accessor: M3LConfigAccessor,
    operation: TOp,
  ) => TSettings | Promise<TSettings>;
  /**
   * Per-operation list of guardable settings keys checked via
   * `accessor.requiredFor`. Exhaustive over `TOp` at the type level;
   * operations requiring nothing use an empty array.
   */
  readonly requiredFields?: {
    readonly [K in TOp]: readonly M3LGuardableKey<TSettings>[];
  };
  /** Destructive-operation confirmation gate; omit for a non-destructive pipeline. */
  readonly destructive?: M3LPipelineDestructiveOptions<
    TOp,
    TSettings,
    TDeps,
    TResult,
    TContext
  >;
  /** The exhaustive per-operation dispatch table. */
  readonly handlers: M3LOperationHandlers<
    TOp,
    TSettings,
    TDeps,
    TResult,
    TContext
  >;
  /**
   * Runs after dispatch, before `finalize`, to persist the handler's result.
   *
   * @param operation - The operation that was dispatched. Appended last
   *   (unlike other pipeline callbacks where operation comes first) so
   *   existing 3-argument persist implementations remain source-compatible.
   */
  readonly persist?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ) => Promise<void>;
  /**
   * Runs after `persist`, so a post-dispatch assertion that throws still
   * leaves the persisted result on disk.
   *
   * @param operation - The operation that was dispatched. Appended last
   *   (unlike other pipeline callbacks where operation comes first) so
   *   existing 3-argument finalize implementations remain source-compatible.
   */
  readonly finalize?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ) => void | Promise<void>;
  /**
   * Runs after `finalize` and returns the per-item failures the handler
   * absorbed during this run. An empty array means every item succeeded
   * (the outcome resolves as `"completed"`); a non-empty array means some
   * items were handled but at least one failed (the outcome resolves as
   * `"partial"`).
   *
   * The engine never inspects `result` to decide classification — only this
   * callback knows what "an item" means for the operation. A pipeline that
   * declares no `recovery` callback can never resolve `"partial"`, and its
   * behavior is byte-identical to before this phase existed.
   *
   * A throw from this callback propagates to the caller unmodified — the
   * engine never swallows, wraps, or re-codes errors raised here.
   *
   * @param operation - The operation that was dispatched. Appended last,
   *   mirroring the `persist` and `finalize` argument order.
   */
  readonly recovery?: (
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ) => readonly M3LRunRecoveryEntry[];
  /**
   * Opt-in, additive phase tracing. Absent, the run is byte-identical to a
   * pipeline built without this option and the engine performs no timing
   * work at all. See {@link M3LPipelineTraceOptions} and
   * `docs/reference/core/pipeline.md` § Tracing.
   */
  readonly trace?: M3LPipelineTraceOptions<TOp, TSettings, TContext>;
}

/**
 * Constructor options for {@link M3LOperationPipeline}. Fully generic over
 * the operation union, settings struct, dependency bag, result type, and the
 * optional `prepare`-produced context type.
 *
 * `prepare` is conditionally required: when `TContext` is `undefined` (the
 * default, no `prepare` configured), `prepare` stays optional; when
 * `TContext` is anything else, `prepare` becomes a required member. This
 * makes the engine's `undefined as TContext` fallback cast
 * (`M3LOperationPipeline.run`, phase 5) type-system-guaranteed rather than
 * merely documented — a caller cannot pin a non-`undefined` `TContext`
 * without also supplying the `prepare` that produces it.
 *
 * @typeParam TOp - The closed operation-name union read from the `operation`
 *   config parameter via `accessor.oneOf`.
 * @typeParam TSettings - The struct `resolveSettings` returns.
 * @typeParam TDeps - The dependency bag passed to `run`; must extend {@link
 *   M3LOperationPipelineBaseDeps}.
 * @typeParam TResult - The result type every handler resolves and the
 *   outcome carries.
 * @typeParam TContext - The value `prepare` produces, fed to the gate's
 *   `describe` and to every handler. Defaults to `undefined` when no
 *   `prepare` is configured.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * interface Settings {
 *   readonly key?: string;
 * }
 *
 * const options: Core.M3LOperationPipelineOptions<
 *   "list" | "get",
 *   Settings,
 *   Core.M3LOperationPipelineBaseDeps,
 *   { readonly count: number }
 * > = {
 *   operations: ["list", "get"] as const,
 *   configCode: "ERR_EXAMPLE_CONFIG",
 *   resolveSettings: (accessor) => ({ key: accessor.optionalString("key") }),
 *   requiredFields: { list: [], get: ["key"] },
 *   handlers: {
 *     list: async () => ({ count: 0 }),
 *     get: async () => ({ count: 1 }),
 *   },
 * };
 * ```
 */
export type M3LOperationPipelineOptions<
  TOp extends string,
  TSettings extends object,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext = undefined,
> = M3LOperationPipelineCoreOptions<TOp, TSettings, TDeps, TResult, TContext> &
  ([TContext] extends [undefined]
    ? {
        /**
         * Runs once, before the destructive gate. Its return value feeds
         * both the gate's `describe` and every handler as `context`.
         * Optional here because `TContext` is `undefined` — no `prepare`
         * is configured, so `context` is `undefined` throughout the run.
         */
        readonly prepare?: (
          operation: TOp,
          settings: TSettings,
          deps: TDeps,
        ) => Promise<TContext>;
      }
    : {
        /**
         * Runs once, before the destructive gate. Its return value feeds
         * both the gate's `describe` and every handler as `context`.
         * Required here because `TContext` is not `undefined` — the engine
         * has no other way to produce a `TContext` value.
         */
        readonly prepare: (
          operation: TOp,
          settings: TSettings,
          deps: TDeps,
        ) => Promise<TContext>;
      });

/**
 * The fields shared by every arm of {@link M3LOperationPipelineOutcome}: the
 * resolved operation name and the result value. Its role is as a composition
 * primitive: {@link M3LOperationPipelineOutcome} is defined as
 * `M3LOperationPipelineOutcomeBase & (arm_A | arm_B | arm_C)`, so every arm
 * of the discriminated union automatically carries `operation` and `result`
 * without those fields being repeated on each arm.
 *
 * Accessing `outcome.result` or `outcome.operation` unconditionally — without
 * first narrowing on `status` — is valid on the union itself
 * ({@link M3LOperationPipelineOutcome}) because the base fields are present
 * on every arm. Type against the union directly for that use case; reserve
 * this base type for building a richer outcome type that must share the same
 * common fields.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TResult - The result type every arm carries.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * // Extend the base to add cross-cutting fields that every arm should carry.
 * interface TimedOutcome<TOp extends string, TResult>
 *   extends Core.M3LOperationPipelineOutcomeBase<TOp, TResult> {
 *   /** Wall-clock milliseconds consumed by the run. *\/
 *   readonly elapsedMs: number;
 * }
 * ```
 */
export interface M3LOperationPipelineOutcomeBase<TOp extends string, TResult> {
  /** The operation that was resolved from config for this run. */
  readonly operation: TOp;
  /** The handler's result, or the decline policy's soft-landed result. */
  readonly result: TResult;
}

/**
 * The value resolved by {@link M3LOperationPipeline.run}.
 *
 * A discriminated union on `status` — three arms:
 * - `"completed"`: every item succeeded; `recovery` is absent.
 * - `"partial"`: the handler absorbed some failures; `recovery` holds them.
 * - `"declined"`: a soft-landed destructive-gate decline; no handler ran;
 *   `recovery` is absent.
 *
 * The base fields (`operation` and `result`) are common to all three arms via
 * {@link M3LOperationPipelineOutcomeBase}, so a thin wrapper that preserves a
 * legacy signature can return `outcome.result` unconditionally regardless of
 * `status`.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TResult - The result type carried by every arm.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 *
 * function summarize(
 *   outcome: Core.M3LOperationPipelineOutcome<"list" | "delete", { readonly count: number }>,
 * ): string {
 *   if (outcome.status === "partial") {
 *     return `partial: ${String(outcome.recovery.length)} failures`;
 *   }
 *   return outcome.status === "declined"
 *     ? `declined before '${outcome.operation}'`
 *     : `completed '${outcome.operation}' with ${String(outcome.result.count)}`;
 * }
 * ```
 */
export type M3LOperationPipelineOutcome<
  TOp extends string,
  TResult,
> = M3LOperationPipelineOutcomeBase<TOp, TResult> &
  (
    | {
        /** The run dispatched and some items failed — at least one recovery entry. */
        readonly status: "partial";
        /**
         * The per-item failures the `recovery` callback returned.
         * A non-empty tuple — the engine only produces this arm when the
         * callback's return contains at least one entry; an empty array yields
         * `status: "completed"` instead.
         */
        readonly recovery: readonly [
          M3LRunRecoveryEntry,
          ...M3LRunRecoveryEntry[],
        ];
      }
    | {
        /** The run dispatched and every item succeeded. */
        readonly status: "completed";
        /** Absent on a completed run — do not set to `undefined`. */
        readonly recovery?: undefined;
      }
    | {
        /** A soft-landed destructive-gate decline; no handler ran. */
        readonly status: "declined";
        /** Absent on a declined run — do not set to `undefined`. */
        readonly recovery?: undefined;
      }
  );
