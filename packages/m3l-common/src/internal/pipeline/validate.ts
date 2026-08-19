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
 * One malformed-option finding surfaced by {@link validatePipelineOptions}.
 * `operation` is present only for a problem that names a specific operation
 * (a duplicate or an unknown destructive entry) — the empty-`operations`
 * problem names none.
 */
interface PipelineValidationProblem {
  readonly code:
    | "ERR_PIPELINE_EMPTY_OPERATIONS"
    | "ERR_PIPELINE_DUPLICATE_OPERATION"
    | "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION";
  readonly message: string;
  readonly operation?: string;
}

/**
 * Builds the single problem for an empty `operations` list, or `undefined`
 * when the list is non-empty.
 */
function checkEmptyOperations(
  operations: readonly string[],
): PipelineValidationProblem | undefined {
  if (operations.length > 0) return undefined;
  return {
    code: "ERR_PIPELINE_EMPTY_OPERATIONS",
    message: "M3LOperationPipeline: 'operations' must not be empty",
  };
}

/**
 * Builds one problem per distinct name that repeats in `operations`, in the
 * order each name's duplication was first detected.
 */
function checkDuplicateOperations(
  operations: readonly string[],
): readonly PipelineValidationProblem[] {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
  }

  const problems: PipelineValidationProblem[] = [];
  const reported = new Set<string>();
  for (const operation of operations) {
    if (reported.has(operation)) continue;
    const count = counts.get(operation) ?? 0;
    if (count <= 1) continue;
    reported.add(operation);
    problems.push({
      code: "ERR_PIPELINE_DUPLICATE_OPERATION",
      message: `M3LOperationPipeline: 'operations' contains a duplicate entry: '${operation}'`,
      operation,
    });
  }
  return problems;
}

/**
 * Builds one problem per `destructive.operations` member absent from the
 * known `operations` set, in the destructive set's own iteration order.
 */
function checkUnknownDestructiveOperations(
  known: ReadonlySet<string>,
  destructiveOperations: ReadonlySet<string>,
): readonly PipelineValidationProblem[] {
  const problems: PipelineValidationProblem[] = [];
  for (const operation of destructiveOperations) {
    if (known.has(operation)) continue;
    problems.push({
      code: "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION",
      message: `M3LOperationPipeline: destructive.operations names an operation absent from 'operations': '${operation}'`,
      operation,
    });
  }
  return problems;
}

/**
 * Renders the collected problems into the message the thrown error carries:
 * with exactly one problem the error's own message IS that problem's
 * message; with several it is a summary line followed by each problem's
 * message.
 */
function renderMessage(problems: readonly PipelineValidationProblem[]): string {
  // `.map` yields each element by iteration rather than by index, so this
  // stays a plain `string` under `noUncheckedIndexedAccess` — no
  // possibly-`undefined` element type to guard against, and no unreachable
  // "empty array" branch to carry (the caller never invokes this with one).
  if (problems.length === 1) {
    return problems.map((problem) => problem.message).join("");
  }

  const lines = problems.map(
    (problem, index) => `  ${index + 1}. ${problem.message}`,
  );
  return [
    `M3LOperationPipeline: ${problems.length} invalid options:`,
    ...lines,
  ].join("\n");
}

/**
 * Validates a pipeline's constructor options eagerly, collecting every
 * problem before throwing a single {@link M3LPipelineInvalidOptionError} —
 * rather than short-circuiting on the first violation found — across three
 * malformed shapes:
 *
 * 1. `operations` is empty.
 * 2. `operations` contains a duplicate entry (reported once per duplicated
 *    name, however many times it repeats).
 * 3. `destructive.operations` names an operation absent from `operations`
 *    (reported once per unknown name).
 *
 * Because collection replaces short-circuiting, an empty `operations` list no
 * longer hides the `destructive` check: an empty list with a configured
 * `destructive.operations` reports both the emptiness and every destructive
 * name as unknown.
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
 * @throws {@link M3LPipelineInvalidOptionError} When one or more of the three
 *   invalid shapes described above is present. `context.problems` carries
 *   every finding as `{ code, message, operation? }`.
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
  const operations: readonly string[] = options.operations;
  const known = new Set(operations);

  const problems: PipelineValidationProblem[] = [];

  const emptyProblem = checkEmptyOperations(operations);
  if (emptyProblem !== undefined) problems.push(emptyProblem);

  problems.push(...checkDuplicateOperations(operations));

  if (options.destructive !== undefined) {
    problems.push(
      ...checkUnknownDestructiveOperations(
        known,
        options.destructive.operations,
      ),
    );
  }

  if (problems.length === 0) return;

  throw new M3LPipelineInvalidOptionError(renderMessage(problems), {
    problems,
  });
}
