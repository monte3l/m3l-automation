/**
 * `internal/pipeline/validate` — eager constructor-time option validation for
 * `M3LOperationPipeline`, kept separate from the engine class itself so
 * `M3LOperationPipeline.ts` stays lean.
 *
 * Private to `core/pipeline`; never re-exported through a public barrel.
 */

import { M3LPipelineInvalidOptionError } from "./errors.js";

import type {
  M3LOperationPipelineBaseDeps,
  M3LOperationPipelineOptions,
} from "../../core/pipeline/types.js";

/**
 * Validates a pipeline's constructor options eagerly, throwing
 * {@link M3LPipelineInvalidOptionError} for exactly three malformed shapes:
 *
 * 1. `operations` is empty.
 * 2. `operations` contains a duplicate entry.
 * 3. `destructive.operations` names an operation absent from `operations`.
 *
 * Type-level exhaustiveness (the mapped `handlers`/`requiredFields` tables,
 * `destructive.operations: ReadonlySet<TOp>`) makes all three unreachable
 * from well-typed TypeScript; this runtime check exists to guard JavaScript
 * callers and dynamic construction.
 *
 * @typeParam TOp - The closed operation-name union.
 * @typeParam TSettings - The resolved settings struct.
 * @typeParam TDeps - The dependency bag passed to `run`.
 * @typeParam TResult - The result type every handler resolves.
 * @typeParam TContext - The value `prepare` produces, or `undefined`.
 * @param options - The pipeline's constructor options.
 * @throws {@link M3LPipelineInvalidOptionError} On any of the three invalid
 *   shapes described above.
 */
export function validatePipelineOptions<
  TOp extends string,
  TSettings extends object,
  TDeps extends M3LOperationPipelineBaseDeps,
  TResult,
  TContext,
>(
  options: M3LOperationPipelineOptions<
    TOp,
    TSettings,
    TDeps,
    TResult,
    TContext
  >,
): void {
  if (options.operations.length === 0) {
    throw new M3LPipelineInvalidOptionError(
      "M3LOperationPipeline: 'operations' must not be empty",
    );
  }

  const seen = new Set<TOp>();
  for (const operation of options.operations) {
    if (seen.has(operation)) {
      throw new M3LPipelineInvalidOptionError(
        `M3LOperationPipeline: 'operations' contains a duplicate entry: '${operation}'`,
        { operation },
      );
    }
    seen.add(operation);
  }

  if (options.destructive === undefined) return;

  for (const operation of options.destructive.operations) {
    if (!seen.has(operation)) {
      throw new M3LPipelineInvalidOptionError(
        `M3LOperationPipeline: destructive.operations names an operation absent from 'operations': '${operation}'`,
        { operation, operations: options.operations },
      );
    }
  }
}
