/**
 * `core/pipeline/M3LOperationPipeline` — the declarative engine for the
 * multi-operation dispatcher skeleton that consumer scripts' `steps/run-*.ts`
 * modules hand-write: operation resolution, settings resolution, per-operation
 * required-field guards, the destructive-operation gate, handler dispatch,
 * optional persistence, and post-dispatch assertions.
 *
 * @packageDocumentation
 */

import { M3LPipelineInvalidOptionError } from "../../internal/pipeline/errors.js";

import type {
  M3LOperationPipelineBaseDeps,
  M3LOperationPipelineOptions,
  M3LOperationPipelineOutcome,
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
  TSettings,
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
    this.#options = options;
  }

  /**
   * Runs the ten-phase pipeline over `deps` and resolves the outcome.
   *
   * @param deps - The dependency bag; must extend {@link
   *   M3LOperationPipelineBaseDeps}.
   * @returns The completed or declined outcome.
   * @throws Any error from phases 1–9 propagates unmodified, except a decline
   *   handled by `onDecline: { kind: "soft-land" }`.
   */
  run(deps: TDeps): Promise<M3LOperationPipelineOutcome<TOp, TResult>> {
    void deps;
    return Promise.reject(
      new M3LPipelineInvalidOptionError(
        "M3LOperationPipeline.run: not yet implemented — see docs/reference/core/pipeline.md",
        { operations: this.#options.operations },
      ),
    );
  }
}
