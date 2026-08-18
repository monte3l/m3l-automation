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
import { M3LError } from "../errors/index.js";
import { M3LConfigAccessor } from "../config/M3LConfigAccessor.js";
import { confirmDestructive } from "../prompt/M3LDestructiveGate.js";

import type { M3LConfirmDestructiveOptions } from "../prompt/M3LDestructiveGate.js";
import type {
  M3LOperationPipelineBaseDeps,
  M3LOperationPipelineOptions,
  M3LOperationPipelineOutcome,
  M3LPipelineDestructiveOptions,
} from "./types.js";

/**
 * Runs the fixed ten-phase order documented in `docs/reference/core/pipeline.md`
 * (accessor, operation, settings, guards, prepare, gate, dispatch, persist,
 * finalize, outcome) over a script-supplied
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
   * Runs the ten-phase pipeline over `deps` and resolves the outcome.
   *
   * All per-run state lives in this call's own frame — nothing is written to
   * the instance — so one pipeline instance is reusable across sequential
   * runs and safe under concurrent `run()` calls.
   *
   * @param deps - The dependency bag; must extend {@link
   *   M3LOperationPipelineBaseDeps}.
   * @returns The completed or declined outcome.
   * @throws Any error from phases 1–9 propagates unmodified, except a decline
   *   handled by `onDecline: { kind: "soft-land" }`.
   */
  async run(deps: TDeps): Promise<M3LOperationPipelineOutcome<TOp, TResult>> {
    const options = this.#options;

    // Phase 1-2: accessor + operation.
    const accessor = new M3LConfigAccessor({
      config: deps.config,
      code: options.configCode,
    });
    const operation = accessor.oneOf("operation", options.operations);

    // Phase 3: settings (sync or async resolver, awaited either way).
    const settings = await options.resolveSettings(accessor, operation);

    // Phase 4: guards, checked in the row's array order; first miss throws.
    this.#runGuards(accessor, operation, settings);

    // Phase 5: prepare, once, before the gate. M3LOperationPipelineOptions
    // makes `prepare` required whenever TContext is not `undefined` (a
    // conditional type keyed on TContext), so the only way to reach this
    // branch with `options.prepare` absent is TContext === undefined — the
    // cast below is type-system-guaranteed, not merely documented.
    const context = options.prepare
      ? await options.prepare(operation, settings, deps)
      : (undefined as TContext);

    // Phase 6: the destructive gate, only for a member operation. A
    // returned outcome means the gate soft-landed a decline — persist and
    // finalize (phases 8-9) never run for a declined outcome (R1).
    const declined = await this.#runGate(operation, settings, context, deps);
    if (declined !== undefined) return declined;

    // Phase 7: dispatch.
    const result = await this.#dispatch(operation, settings, context, deps);

    // Phase 8-9: persist, then finalize — strictly sequential so a throwing
    // finalize (e.g. a wait that did not stabilize) still leaves the
    // persisted result on disk.
    if (options.persist) {
      await options.persist(result, settings, deps, operation);
    }
    if (options.finalize) {
      await options.finalize(result, settings, deps, operation);
    }

    // Phase 10: outcome.
    return { status: "completed", operation, result };
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
   * Phase 6: the destructive-confirmation gate. Resolves `undefined` when
   * the operation isn't gated or confirmation succeeds (the run should
   * continue to dispatch); resolves a `"declined"` outcome when
   * `onDecline: { kind: "soft-land" }` absorbed the decline. Any other gate
   * failure — including `onDecline: { kind: "throw" }`'s decline error —
   * propagates by throwing.
   */
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
