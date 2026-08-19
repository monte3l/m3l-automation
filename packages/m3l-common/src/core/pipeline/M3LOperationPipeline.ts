/**
 * `core/pipeline/M3LOperationPipeline` — the declarative engine for the
 * multi-operation dispatcher skeleton that consumer scripts' `steps/run-*.ts`
 * modules hand-write: operation resolution, settings resolution, per-operation
 * required-field guards, the destructive-operation gate, handler dispatch,
 * optional persistence, and post-dispatch assertions.
 *
 * @packageDocumentation
 */

import { validatePipelineOptions } from "../../internal/pipeline/validate.js";
import { M3LPipelineInvalidOptionError } from "../../internal/pipeline/errors.js";
import { createPipelinePhaseTracer } from "../../internal/pipeline/trace.js";
import { M3LError } from "../errors/index.js";
import { M3LConfigAccessor } from "../config/M3LConfigAccessor.js";
import { confirmDestructive } from "../prompt/M3LDestructiveGate.js";

import type { M3LPipelinePhaseTracer } from "../../internal/pipeline/trace.js";
import type { M3LConfirmDestructiveOptions } from "../prompt/M3LDestructiveGate.js";
import type {
  M3LOperationPipelineBaseDeps,
  M3LOperationPipelineOptions,
  M3LOperationPipelineOutcome,
  M3LPipelineDestructiveOptions,
  M3LPipelineTraceSnapshot,
} from "./types.js";

/**
 * Narrows a `readonly T[]` to a non-empty tuple when the array contains at
 * least one element. Used in the recovery phase to earn the `"partial"` arm's
 * type without an `as` assertion while preserving reference identity.
 */
function isNonEmpty<T>(arr: readonly T[]): arr is readonly [T, ...T[]] {
  return arr.length > 0;
}

/**
 * Array-ness check that deliberately does NOT use a `value is T[]` type
 * predicate. `Array.isArray` itself has one (`arg is any[]`), and narrowing
 * the `recovery` callback's return through it directly at the call site
 * collapses that binding's static type to `any[]` for the rest of its scope
 * — tripping the `no-unsafe-return` lint rule on the later `return entries`
 * even though the value is soundly typed. Routing the check through this
 * plain-`boolean`-returning wrapper keeps the caller's binding at its
 * original `readonly M3LRunRecoveryEntry[]` type (reference identity
 * included) while still rejecting a non-array return from a JavaScript
 * caller or a TypeScript assertion.
 */
function isUnknownArray(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * The result of phases 5-7 (prepare, gate, dispatch), returned by
 * {@link M3LOperationPipeline.#runPrepareGateDispatch} so `run()` can branch
 * on a soft-landed decline without that branch itself counting against
 * `run()`'s own size.
 */
type PrepareGateDispatchResult<TOp extends string, TResult, TContext> =
  | {
      readonly kind: "declined";
      readonly outcome: M3LOperationPipelineOutcome<TOp, TResult>;
    }
  | {
      readonly kind: "dispatched";
      readonly context: TContext;
      readonly result: TResult;
    };

/**
 * Runs the fixed eleven-phase order documented in `docs/reference/core/pipeline.md`
 * (accessor, operation, settings, guards, prepare, gate, dispatch, persist,
 * finalize, recovery, outcome) over a script-supplied
 * {@link M3LOperationPipelineOptions}. The script keeps everything genuinely
 * script-specific — the operation list, the settings resolver, the handler
 * functions, the error codes, and log text — while the engine owns the
 * ordering.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TDeps - The dependency bag passed to `run`; must extend {@link
 *   M3LOperationPipelineBaseDeps}.
 * @typeParam TResult - The result type every handler resolves.
 * @typeParam TContext - The value `prepare` produces, or `undefined` when no
 *   `prepare` is configured.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const OPS = ["list", "delete"] as const;
 *
 * const pipeline = new Core.M3LOperationPipeline({
 *   operations: OPS,
 *   configCode: "ERR_S3_OBJECTS_CONFIG",
 *   resolveSettings: (accessor, operation) => ({
 *     key: accessor.optionalString("key"),
 *     yes: accessor.optionalBoolean("yes") ?? false,
 *   }),
 *   requiredFields: { list: [], delete: ["key"] },
 *   destructive: {
 *     operations: new Set(["delete"] as const),
 *     describe: (op, settings) => `${op} ${String(settings.key)}`,
 *     yes: (settings) => settings.yes,
 *     abortCode: "ERR_S3_OBJECTS_ABORTED",
 *     onDecline: {
 *       kind: "soft-land",
 *       result: () => ({ processed: 0, failed: 0 }),
 *     },
 *   },
 *   handlers: {
 *     list: async () => ({ processed: 0, failed: 0 }),
 *     delete: async () => ({ processed: 1, failed: 0 }),
 *   },
 * });
 *
 * export async function runS3Objects(
 *   deps: Core.M3LOperationPipelineBaseDeps,
 * ): Promise<{ readonly processed: number; readonly failed: number }> {
 *   return (await pipeline.run(deps)).result;
 * }
 * ```
 */
export class M3LOperationPipeline<
  TOp extends string,
  TSettings extends object,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext = undefined,
> {
  readonly #options: M3LOperationPipelineOptions<
    TOp,
    TSettings,
    TDeps,
    TResult,
    TContext
  >;

  /**
   * @param options - The operation table, settings resolver, guards,
   *   optional prepare/destructive-gate/persist/finalize phases, and the
   *   exhaustive handler table.
   * @throws An internal `M3LError` (code `ERR_PIPELINE_INVALID_OPTION`) when
   *   `operations` is empty or contains duplicates, or when
   *   `destructive.operations` names an operation absent from `operations`.
   *   Every violation found is aggregated under the thrown error's
   *   `context.problems` — a single throw reports all of them, not just the
   *   first.
   */
  constructor(
    options: M3LOperationPipelineOptions<
      TOp,
      TSettings,
      TDeps,
      TResult,
      TContext
    >,
  ) {
    validatePipelineOptions(options);
    this.#options = options;
  }

  /**
   * Runs the eleven-phase pipeline over `deps` and resolves the outcome.
   *
   * All per-run state — including every tracing accumulator, when `trace` is
   * configured — lives in this call's own frame; nothing is written to the
   * instance. One pipeline instance is therefore reusable across sequential
   * runs and safe under concurrent `run()` calls.
   *
   * @param deps - The dependency bag; must extend {@link
   *   M3LOperationPipelineBaseDeps}.
   * @returns The completed, partial, or declined outcome.
   * @throws Any error from phases 1–10 propagates unmodified, except a decline
   *   handled by `onDecline: { kind: "soft-land" }`.
   */
  async run(deps: TDeps): Promise<M3LOperationPipelineOutcome<TOp, TResult>> {
    const tracer = createPipelinePhaseTracer<TOp, TSettings, TContext>(
      this.#options.trace,
      deps.logger,
    );
    // Every phase-running helper below receives `snapshot`/`operationForPayload`
    // (closures over this call's own trace state) plus explicit setters,
    // rather than reading or writing instance fields — see
    // `#createTraceState`'s own doc and TR-17's concurrent-run proof.
    const {
      snapshot,
      operationForPayload,
      setOperation,
      setSettings,
      setContext,
    } = this.#createTraceState();

    // Phases 1-4: accessor, operation, settings, guards.
    const { operation, settings } = await this.#runAccessorThroughGuards(
      tracer,
      snapshot,
      operationForPayload,
      deps,
      setOperation,
      setSettings,
    );

    // Phases 5-7: prepare, gate, dispatch.
    const prepared = await this.#runPrepareGateDispatch(
      tracer,
      snapshot,
      operationForPayload,
      operation,
      settings,
      deps,
      setContext,
    );
    if (prepared.kind === "declined") return prepared.outcome;
    const { result } = prepared;

    // Phases 8-9: persist, then finalize.
    await this.#runPersistAndFinalize(
      tracer,
      snapshot,
      operationForPayload,
      result,
      settings,
      deps,
      operation,
    );

    // Phases 10-11: recovery, then outcome.
    return await this.#runRecoveryAndOutcome(
      tracer,
      snapshot,
      operationForPayload,
      result,
      settings,
      deps,
      operation,
    );
  }

  /**
   * Builds this call's per-run trace state bundle: the mutable
   * `knownOperation`/`knownSettings`/`knownContext` slots (never written to
   * `this`), the `snapshot`/`operationForPayload` closures every
   * phase-running helper reads, and the setters that update them as each
   * phase resolves a new value. A fresh bundle is returned on every call —
   * nothing here is shared across `run()` invocations, preserving the
   * engine's statelessness across runs and safety under concurrent `run()`
   * calls (TR-17).
   */
  #createTraceState(): {
    readonly snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>;
    readonly operationForPayload: () => TOp | undefined;
    readonly setOperation: (operation: TOp) => void;
    readonly setSettings: (settings: TSettings) => void;
    readonly setContext: (context: TContext) => void;
  } {
    let knownOperation: TOp | undefined;
    let knownSettings: TSettings | undefined;
    // Only ever read when `contextKnown` is true — the placeholder cast
    // mirrors the type-system-guaranteed `undefined as TContext` pattern
    // used inside `#runPrepareGateDispatch` for the no-`prepare` case.
    let knownContext: TContext = undefined as TContext;
    let contextKnown = false;

    return {
      snapshot: () => ({
        ...(knownOperation !== undefined ? { operation: knownOperation } : {}),
        ...(knownSettings !== undefined ? { settings: knownSettings } : {}),
        ...(contextKnown ? { context: knownContext } : {}),
      }),
      operationForPayload: () => knownOperation,
      setOperation: (operation) => {
        knownOperation = operation;
      },
      setSettings: (settings) => {
        knownSettings = settings;
      },
      setContext: (context) => {
        knownContext = context;
        contextKnown = true;
      },
    };
  }

  /**
   * Phases 1-4: accessor, operation, settings, guards. `setOperation` and
   * `setSettings` update `run()`'s own per-call-frame trace state as each
   * value resolves — this method carries no state of its own beyond its
   * local `accessor`.
   */
  async #runAccessorThroughGuards(
    tracer: M3LPipelinePhaseTracer<TOp, TSettings, TContext>,
    snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
    operationForPayload: () => TOp | undefined,
    deps: TDeps,
    setOperation: (operation: TOp) => void,
    setSettings: (settings: TSettings) => void,
  ): Promise<{ readonly operation: TOp; readonly settings: TSettings }> {
    const options = this.#options;

    const accessor = await tracer.run(
      "accessor",
      snapshot,
      operationForPayload,
      () =>
        new M3LConfigAccessor({
          config: deps.config,
          code: options.configCode,
        }),
    );

    // `knownOperation` (via `setOperation`) is set inside the traced body so
    // this phase's own EXIT payload can carry it, even though it was absent
    // from this same phase's ENTRY snapshot (docs/reference/core/pipeline.md
    // § Tracing's asymmetry, TR-5).
    const operation = await tracer.run(
      "operation",
      snapshot,
      operationForPayload,
      () => {
        const resolved = accessor.oneOf("operation", options.operations);
        setOperation(resolved);
        return resolved;
      },
    );

    const settings = await tracer.run(
      "settings",
      snapshot,
      operationForPayload,
      async () => {
        const resolved = await options.resolveSettings(accessor, operation);
        setSettings(resolved);
        return resolved;
      },
    );

    await tracer.run("guards", snapshot, operationForPayload, () =>
      this.#runGuards(accessor, operation, settings),
    );

    return { operation, settings };
  }

  /**
   * Phases 5-7: prepare, gate, dispatch. Returns a `"declined"` result (the
   * gate soft-landed) or a `"dispatched"` result carrying `context` and the
   * handler's `result`, so `run()` can branch without that branch counting
   * against its own size. `setContext` updates `run()`'s per-call-frame trace
   * state the same way `#runAccessorThroughGuards`'s setters do.
   */
  async #runPrepareGateDispatch(
    tracer: M3LPipelinePhaseTracer<TOp, TSettings, TContext>,
    snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
    operationForPayload: () => TOp | undefined,
    operation: TOp,
    settings: TSettings,
    deps: TDeps,
    setContext: (context: TContext) => void,
  ): Promise<PrepareGateDispatchResult<TOp, TResult, TContext>> {
    // Only when configured; an unconfigured `prepare` contributes no trace
    // entry (TR-3). M3LOperationPipelineOptions makes `prepare` required
    // whenever TContext is not `undefined` (a conditional type keyed on
    // TContext), so the only way to reach the `else` branch is TContext ===
    // undefined — the cast there is type-system-guaranteed, not merely
    // documented.
    const prepare = this.#options.prepare;
    const context = prepare
      ? await tracer.run("prepare", snapshot, operationForPayload, async () => {
          const resolved = await prepare(operation, settings, deps);
          setContext(resolved);
          return resolved;
        })
      : (undefined as TContext);

    // The gate, only for a member operation. A returned outcome means the
    // gate soft-landed a decline — persist and finalize never run for a
    // declined outcome (R1); the decline still records its own "outcome"
    // entry here.
    const declined = await tracer.run(
      "gate",
      snapshot,
      operationForPayload,
      () => this.#runGate(operation, settings, context, deps),
    );
    if (declined !== undefined) {
      const outcome = await tracer.run(
        "outcome",
        snapshot,
        operationForPayload,
        () => declined,
      );
      return { kind: "declined", outcome };
    }

    const result = await tracer.run(
      "dispatch",
      snapshot,
      operationForPayload,
      () => this.#dispatch(operation, settings, context, deps),
    );
    return { kind: "dispatched", context, result };
  }

  /**
   * Phases 8-9: persist, then finalize — strictly sequential so a throwing
   * finalize (e.g. a wait that did not stabilize) still leaves the persisted
   * result on disk. Each runs (and traces) only when configured; every
   * argument is threaded through explicitly rather than read off `this` or a
   * closure, so no per-run state escapes `run()`'s own call frame.
   */
  async #runPersistAndFinalize(
    tracer: M3LPipelinePhaseTracer<TOp, TSettings, TContext>,
    snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
    operationForPayload: () => TOp | undefined,
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ): Promise<void> {
    const persist = this.#options.persist;
    if (persist) {
      await tracer.run("persist", snapshot, operationForPayload, () =>
        persist(result, settings, deps, operation),
      );
    }
    const finalize = this.#options.finalize;
    if (finalize) {
      await tracer.run("finalize", snapshot, operationForPayload, () =>
        finalize(result, settings, deps, operation),
      );
    }
  }

  /**
   * Phase 10: recovery — only invoked (and traced) when the option is
   * configured. A non-empty array classifies the run as "partial"; an empty
   * array (or no callback) resolves as "completed". The engine never
   * inspects `result` to decide — only the handler callback knows what "an
   * item" means. A throw here propagates unmodified (no swallow, wrap, or
   * re-code).
   *
   * Phase 11: outcome — completed when no recovery entries were returned.
   * The `recovery` key is intentionally omitted (not set to undefined) so
   * `Object.hasOwn(outcome, "recovery") === false` on a completed run
   * (`exactOptionalPropertyTypes` requires absence, not explicit undefined).
   */
  async #runRecoveryAndOutcome(
    tracer: M3LPipelinePhaseTracer<TOp, TSettings, TContext>,
    snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
    operationForPayload: () => TOp | undefined,
    result: TResult,
    settings: TSettings,
    deps: TDeps,
    operation: TOp,
  ): Promise<M3LOperationPipelineOutcome<TOp, TResult>> {
    const recovery = this.#options.recovery;
    if (recovery) {
      const recoveryEntries = await tracer.run(
        "recovery",
        snapshot,
        operationForPayload,
        () => {
          const entries = recovery(result, settings, deps, operation);
          // P1 guard: the callback must return an array. A non-array return
          // (e.g. from a JavaScript caller or a TypeScript assertion) would
          // otherwise let `.length` access below produce a bare TypeError,
          // violating the rule that every throw from library code must be an
          // M3LError subclass. `isUnknownArray` keeps `entries` at its
          // declared type rather than collapsing it to `any[]` (see that
          // helper's own doc).
          if (!isUnknownArray(entries)) {
            throw new M3LPipelineInvalidOptionError(
              "M3LOperationPipeline: 'recovery' callback must return a readonly array of M3LRunRecoveryEntry",
            );
          }
          return entries;
        },
      );
      // P2: earn the partial arm — a first entry must be present for the run
      // to be classified "partial". An empty array falls through to "completed",
      // matching the runtime contract. The type predicate narrows the array to
      // the non-empty tuple type without an unsafe assertion and preserves the
      // original array reference so callers can compare by identity.
      if (isNonEmpty(recoveryEntries)) {
        return await tracer.run(
          "outcome",
          snapshot,
          operationForPayload,
          () => ({
            status: "partial",
            operation,
            result,
            recovery: recoveryEntries,
          }),
        );
      }
    }

    return await tracer.run("outcome", snapshot, operationForPayload, () => ({
      status: "completed",
      operation,
      result,
    }));
  }

  /** Phase 4: checks each `requiredFields[operation]` key in array order. */
  #runGuards(
    accessor: M3LConfigAccessor,
    operation: TOp,
    settings: TSettings,
  ): void {
    const requiredKeys = this.#options.requiredFields?.[operation];
    if (requiredKeys === undefined) return;
    for (const key of requiredKeys) {
      accessor.requiredFor(settings[key], key, operation);
    }
  }

  /**
   * Builds the {@link M3LConfirmDestructiveOptions} to pass into
   * `confirmDestructive`. When {@link M3LPipelineDestructiveOptions.target} is
   * present, calls it with all four run arguments and forwards the result
   * plus `isSensitiveTarget` and `yesSensitive` into the options bag using
   * conditional spreads so absent optional fields are never present-but-undefined
   * (`exactOptionalPropertyTypes`). A throw from `target()` propagates to
   * the caller before `confirmDestructive` is ever invoked.
   */
  #buildGateOptions(
    destructive: M3LPipelineDestructiveOptions<
      TOp,
      TSettings,
      TDeps,
      TResult,
      TContext
    >,
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ): M3LConfirmDestructiveOptions {
    const base: M3LConfirmDestructiveOptions = {
      prompt: deps.prompt,
      logger: deps.logger,
      description: destructive.describe(operation, settings, context, deps),
      yes: destructive.yes(settings),
      code: destructive.abortCode,
    };
    if (destructive.target === undefined) {
      return base;
    }
    // A throw from target() propagates here, skipping confirmDestructive (TG-8).
    const target = destructive.target(operation, settings, context, deps);
    if (destructive.isSensitiveTarget !== undefined) {
      // Pre-compute the verdict here (outside the try/catch in #runGate) so a
      // throwing predicate propagates before confirmDestructive is entered
      // (TG-SF-P2). Forward a closure returning the pre-computed boolean so
      // confirmDestructive never re-invokes the original predicate.
      const isSensitive = destructive.isSensitiveTarget(target);
      return {
        ...base,
        target,
        isSensitiveTarget: () => isSensitive,
        ...(destructive.yesSensitive !== undefined
          ? { yesSensitive: destructive.yesSensitive(settings) }
          : {}),
      };
    }
    return {
      ...base,
      target,
      ...(destructive.yesSensitive !== undefined
        ? { yesSensitive: destructive.yesSensitive(settings) }
        : {}),
    };
  }

  /**
   * Phase 6: the destructive-confirmation gate. Resolves `undefined` when
   * the operation isn't gated or confirmation succeeds (the run should
   * continue to dispatch); resolves a `"declined"` outcome when
   * `onDecline: { kind: "soft-land" }` absorbed the decline. Any other gate
   * failure — including `onDecline: { kind: "throw" }`'s decline error —
   * propagates by throwing.
   */
  async #runGate(
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ): Promise<M3LOperationPipelineOutcome<TOp, TResult> | undefined> {
    const destructive = this.#options.destructive;
    if (destructive === undefined || !destructive.operations.has(operation)) {
      return undefined;
    }

    // #buildGateOptions calls destructive.target() when present; a throw from
    // the callback propagates before confirmDestructive is invoked (TG-8).
    const confirmOptions = this.#buildGateOptions(
      destructive,
      operation,
      settings,
      context,
      deps,
    );
    try {
      await confirmDestructive(confirmOptions);
      return undefined;
    } catch (error) {
      // Only an M3LError carrying the gate's own abortCode is a decline;
      // any other failure (a different M3LError code, or a non-M3LError
      // thrown by a custom prompt adapter) propagates unmodified.
      if (
        !(error instanceof M3LError) ||
        error.code !== destructive.abortCode
      ) {
        throw error;
      }
      const policy = destructive.onDecline;
      if (policy.kind === "throw") {
        throw error;
      }
      if (policy.warning) {
        deps.logger.warning(policy.warning(operation, settings, deps));
      }
      return {
        status: "declined",
        operation,
        result: policy.result(operation, settings, deps),
      };
    }
  }

  /**
   * Phase 7: dispatch. `handlers` is an exhaustive mapped type keyed by
   * `TOp`, where each key `K`'s handler narrows its first parameter to `K`.
   * Indexing the table by the very `operation: TOp` value that resolved it
   * is exactly the shape TypeScript's homomorphic-mapped-type indexing
   * resolves to: a function taking `TOp`, `TSettings`, `TContext`, and
   * `TDeps`, returning `Promise<TResult>` — no runtime cast is needed here;
   * the table's exhaustiveness (every member of `TOp` has an entry) is what
   * makes this call sound.
   */
  async #dispatch(
    operation: TOp,
    settings: TSettings,
    context: TContext,
    deps: TDeps,
  ): Promise<TResult> {
    const handler = this.#options.handlers[operation];
    return handler(operation, settings, context, deps);
  }
}
