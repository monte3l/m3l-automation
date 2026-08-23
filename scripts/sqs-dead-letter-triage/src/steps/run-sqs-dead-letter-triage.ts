import { Core } from "@m3l-automation/m3l-common";

import { RUNBOOK_DIR_DEFAULT, TRIAGE_OPERATIONS } from "../config.js";
import type { TriageOperation } from "../config.js";
import { convertRunbook } from "./convert-runbook.js";
import { explainRunbook } from "./explain-runbook.js";
import { reportValidation, validateRunbooks } from "./validate-runbooks.js";
import type { ConversionResult } from "./convert-runbook.js";
import type { ValidationSummary } from "./validate-runbooks.js";

/** The error code every config/guard failure in this script carries. */
const CONFIG_CODE = "ERR_DLQ_TRIAGE_CONFIG";

/** The per-operation-optional config values the pipeline resolves once, up front. */
interface RawSettings {
  readonly runbookDir: string;
  readonly queue: string | undefined;
  readonly source: string | undefined;
  readonly output: string | undefined;
}

/** The full dependency bag the pipeline threads through to every handler. */
export interface RunTriageDeps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly reader: Core.M3LInputFileReader;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  ValidationSummary | Core.M3LProcedureSummary | ConversionResult;

/**
 * Narrows an already-guarded optional settings field. The pipeline's
 * `requiredFields` phase has enforced presence before any handler runs —
 * this is a type-narrowing safety net, not an expected path.
 */
function requireDefined<TValue>(
  value: TValue | undefined,
  name: string,
): TValue {
  if (value === undefined) {
    throw new Core.M3LError(`'${name}' is required for this operation`, {
      code: CONFIG_CODE,
    });
  }
  return value;
}

/** Resolves the raw config values once. Must not re-read `operation`. */
function resolveSettings(accessor: Core.M3LConfigAccessor): RawSettings {
  return {
    runbookDir: accessor.optionalString("runbookDir") ?? RUNBOOK_DIR_DEFAULT,
    queue: accessor.optionalString("queue"),
    source: accessor.optionalString("source"),
    output: accessor.optionalString("output"),
  };
}

/**
 * Which bare-optional settings each operation cannot run without, checked
 * by the engine's Guards phase. Duplicates `config.ts`'s cross-parameter
 * validator on purpose: that one fails at config load with an
 * operator-facing message, this one keeps the handler signatures honest if
 * a value ever arrives by another route.
 */
const REQUIRED_FIELDS: Record<
  TriageOperation,
  readonly Core.M3LGuardableKey<RawSettings>[]
> = {
  validate: [],
  explain: ["queue"],
  convert: ["source"],
};

/** `validate`: builds every preset offline and fails on any problem. */
async function dispatchValidate(
  _operation: "validate",
  settings: RawSettings,
  _context: undefined,
  deps: RunTriageDeps,
): Promise<DispatchResult> {
  const summary = await validateRunbooks({
    paths: deps.paths,
    reader: deps.reader,
    logger: deps.logger,
    runbookDir: settings.runbookDir,
  });
  reportValidation(deps.logger, summary);
  return summary;
}

/** `explain`: prints one preset's compiled step graph, cases and digest. */
async function dispatchExplain(
  _operation: "explain",
  settings: RawSettings,
  _context: undefined,
  deps: RunTriageDeps,
): Promise<DispatchResult> {
  return explainRunbook({
    reader: deps.reader,
    logger: deps.logger,
    runbookDir: settings.runbookDir,
    queue: requireDefined(settings.queue, "queue"),
  });
}

/** `convert`: turns one runbook markdown file into a preset skeleton. */
async function dispatchConvert(
  _operation: "convert",
  settings: RawSettings,
  _context: undefined,
  deps: RunTriageDeps,
): Promise<DispatchResult> {
  return convertRunbook({
    reader: deps.reader,
    paths: deps.paths,
    logger: deps.logger,
    source: requireDefined(settings.source, "source"),
    queue: settings.queue,
    output: settings.output,
  });
}

/**
 * The `sqs-dead-letter-triage` pipeline for this slice: resolve settings,
 * guard the operation's required fields, and dispatch. No `persist` is
 * configured — `convert` writes its own artifact via `M3LPaths`, and
 * `validate`/`explain` are console-only.
 */
const pipeline = new Core.M3LOperationPipeline<
  TriageOperation,
  RawSettings,
  RunTriageDeps,
  DispatchResult
>({
  operations: TRIAGE_OPERATIONS,
  configCode: CONFIG_CODE,
  resolveSettings,
  requiredFields: REQUIRED_FIELDS,
  handlers: {
    validate: dispatchValidate,
    explain: dispatchExplain,
    convert: dispatchConvert,
  },
});

/**
 * Composes `sqs-dead-letter-triage`'s offline spine end to end via
 * `Core.M3LOperationPipeline`: dispatches `validate`, `explain` or
 * `convert`. The AWS-facing `triage`/`execute` operations are not part of
 * this slice.
 *
 * @param deps - The resolved config, `M3LPaths`, input-file reader, logger
 *   and prompt.
 * @returns A promise that resolves once the operation completes.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_CONFIG` when a
 *   guard-checked per-operation requirement is unmet.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_VALIDATE` when
 *   `validate` found a problem in any preset.
 *
 * @example
 * ```typescript
 * import { runSqsDeadLetterTriage } from "./run-sqs-dead-letter-triage.js";
 *
 * declare const deps: Parameters<typeof runSqsDeadLetterTriage>[0];
 * await runSqsDeadLetterTriage(deps);
 * ```
 */
export async function runSqsDeadLetterTriage(
  deps: RunTriageDeps,
): Promise<void> {
  const outcome = await pipeline.run(deps);
  deps.logger.step("sqs-dead-letter-triage run complete", {
    operation: outcome.operation,
  });
}
