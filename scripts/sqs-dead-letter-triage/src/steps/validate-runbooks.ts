import { Core } from "@m3l-automation/m3l-common";

import { buildTriageProcedure } from "./build-procedure.js";
import { listRunbooks, loadRunbook } from "./load-runbook.js";

/** The error code a failing `validate` run exits with. */
export const VALIDATE_CODE = "ERR_DLQ_TRIAGE_VALIDATE";

/** One problem found in one preset. */
export interface RunbookProblem {
  /** The preset's path, relative to the input directory. */
  readonly preset: string;
  readonly message: string;
  /** The `M3LProcedureProblemCode`, or the trust-boundary error's own code. */
  readonly code: string;
  readonly caseId?: string;
  readonly stepId?: string;
}

/** What one `validate` run found across the whole preset directory. */
export interface ValidationSummary {
  readonly checked: number;
  readonly problems: readonly RunbookProblem[];
}

/** What {@link validateRunbooks} needs. */
export interface ValidateRunbooksDeps {
  readonly paths: Core.M3LPaths;
  readonly reader: Core.M3LInputFileReader;
  readonly logger: Core.M3LLogger;
  /** The preset directory, relative to the input directory. */
  readonly runbookDir: string;
}

/**
 * Reads `error.context.problems` when a build failure carried the engine's
 * structured findings, so `validate` reports every collision at once rather
 * than the first one.
 */
function readProcedureProblems(
  error: unknown,
): readonly Core.M3LProcedureValidationProblem[] {
  if (!(error instanceof Core.M3LError)) return [];
  const problems = error.context["problems"];
  return Array.isArray(problems)
    ? (problems as readonly Core.M3LProcedureValidationProblem[])
    : [];
}

/** Converts whatever one preset threw into report rows. */
function toProblems(preset: string, error: unknown): readonly RunbookProblem[] {
  const structured = readProcedureProblems(error);
  if (structured.length > 0) {
    return structured.map((problem) => ({
      preset,
      code: problem.code,
      message: problem.message,
      ...(problem.caseId !== undefined && { caseId: problem.caseId }),
      ...(problem.stepId !== undefined && { stepId: problem.stepId }),
    }));
  }
  const code = error instanceof Core.M3LError ? error.code : "ERR_UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  return [{ preset, code, message }];
}

/**
 * A non-empty `todos` is a validation problem, one row per entry (ADR-0077):
 * a partially converted preset must not be able to produce a confident
 * wrong verdict.
 */
function todoProblems(
  preset: string,
  todos: readonly string[],
): readonly RunbookProblem[] {
  return todos.map((todo) => ({
    preset,
    code: "ERR_DLQ_TRIAGE_TODO",
    message: `unresolved conversion marker: ${todo}`,
  }));
}

/**
 * Builds every preset in the runbook directory and reports every problem at
 * once. Runs entirely offline — `build()` performs no AWS call and executes
 * no step — which is what makes this the CI-runnable gate that keeps a
 * case-id or priority collision, or an unresolved conversion marker, out of
 * an incident.
 *
 * Never stops at the first bad preset: every file is loaded, built, and
 * reported in one pass.
 *
 * @param deps - Paths, the input-file reader, the logger, and the preset
 *   directory relative to the input directory.
 * @returns How many presets were checked and everything wrong with them.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { validateRunbooks } from "./validate-runbooks.js";
 *
 * const paths = new Core.M3LPaths();
 * const summary = await validateRunbooks({
 *   paths,
 *   reader: new Core.M3LInputFileReader({ paths, code: "ERR_DLQ_TRIAGE_PRESET" }),
 *   logger: new Core.M3LLogger([]),
 *   runbookDir: "runbooks",
 * });
 * console.log(summary.problems.length);
 * ```
 */
export async function validateRunbooks(
  deps: ValidateRunbooksDeps,
): Promise<ValidationSummary> {
  const files = await listRunbooks(deps.paths, deps.runbookDir);
  const problems: RunbookProblem[] = [];
  for (const file of files) {
    try {
      const preset = await loadRunbook(deps.reader, file);
      problems.push(...todoProblems(file, preset.todos));
      buildTriageProcedure(preset);
    } catch (error) {
      problems.push(...toProblems(file, error));
    }
  }
  return { checked: files.length, problems };
}

/**
 * Logs a {@link ValidationSummary} and throws when it found anything, so a
 * failing `validate` exits non-zero.
 *
 * @param logger - The run's logger.
 * @param summary - The summary to report.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_VALIDATE` when
 *   `summary.problems` is non-empty.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { reportValidation } from "./validate-runbooks.js";
 *
 * reportValidation(new Core.M3LLogger([]), { checked: 1, problems: [] });
 * ```
 */
export function reportValidation(
  logger: Core.M3LLogger,
  summary: ValidationSummary,
): void {
  for (const problem of summary.problems) {
    logger.error(`${problem.preset}: ${problem.message}`, {
      code: problem.code,
      ...(problem.caseId !== undefined && { caseId: problem.caseId }),
      ...(problem.stepId !== undefined && { stepId: problem.stepId }),
    });
  }
  if (summary.problems.length > 0) {
    throw new Core.M3LError(
      `${String(summary.problems.length)} problem(s) across ${String(summary.checked)} preset(s)`,
      { code: VALIDATE_CODE, context: { checked: summary.checked } },
    );
  }
  logger.success(`${String(summary.checked)} preset(s) build clean`);
}
