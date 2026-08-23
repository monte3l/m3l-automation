import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import {
  MAX_MESSAGES_DEFAULT,
  RUNBOOK_DIR_DEFAULT,
  TRIAGE_OPERATIONS,
  VISIBILITY_TIMEOUT_DEFAULT,
} from "../config.js";
import type { TriageOperation } from "../config.js";
import { convertRunbook } from "./convert-runbook.js";
import { explainRunbook } from "./explain-runbook.js";
import { createDynamoDBLookup } from "./lookup-entity.js";
import { buildTriageReport, logTriageReport } from "./report.js";
import { triageQueue } from "./triage-queue.js";
import { reportValidation, validateRunbooks } from "./validate-runbooks.js";
import { writeJsonArtifact } from "./write-artifact.js";
import type { ConversionResult } from "./convert-runbook.js";
import type { TriageReport } from "./report.js";
import type { ValidationSummary } from "./validate-runbooks.js";

/** The error code every config/guard failure in this script carries. */
const CONFIG_CODE = "ERR_DLQ_TRIAGE_CONFIG";

/** The per-operation-optional config values the pipeline resolves once, up front. */
interface RawSettings {
  readonly runbookDir: string;
  readonly queue: string | undefined;
  readonly source: string | undefined;
  readonly output: string | undefined;
  readonly queueUrl: string | undefined;
  readonly maxMessages: number;
  readonly visibilityTimeout: number;
}

/**
 * The full dependency bag the pipeline threads through to every handler.
 *
 * `sqs`/`dynamo` are `undefined` exactly when `script.aws` is — and
 * `script.aws` is `undefined` only when `M3LScript.provisionAws` itself
 * failed (`M3LAWSProvisioningError`), NOT whenever credentials are absent:
 * `aws.profile` is declared here (so the facade is always provisioned) but
 * not `required: true`, and an absent/empty `aws.profile` still provisions
 * a facade that defers to the SDK's default credential chain. `validate`,
 * `explain` and `convert` simply never reach AWS, so they stay runnable
 * whether or not real credentials resolve — `dispatchTriage` is the one
 * handler that insists on both being present and fails loud, naming
 * `aws.profile`, when they are not.
 */
export interface RunTriageDeps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly reader: Core.M3LInputFileReader;
  readonly sqs: AWS.M3LSQSOperations | undefined;
  readonly dynamo: AWS.M3LDynamoDBOperations | undefined;
  readonly signal: AbortSignal | undefined;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | ValidationSummary
  | Core.M3LProcedureSummary
  | ConversionResult
  | TriageReport;

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
    queueUrl: accessor.optionalString("queueUrl"),
    maxMessages: accessor.optionalNumber("maxMessages") ?? MAX_MESSAGES_DEFAULT,
    visibilityTimeout:
      accessor.optionalNumber("visibilityTimeout") ??
      VISIBILITY_TIMEOUT_DEFAULT,
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
  triage: ["queue", "queueUrl"],
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
 * `triage`: drains the queue, runs the compiled preset per message, then
 * writes and logs the report. Fails loud, naming `aws.profile`, when
 * `script.aws` was never provisioned — `sqs`/`dynamo` arrive `undefined`
 * exactly when it wasn't.
 *
 * A cancelled run's report is still built, logged and archived — the
 * partial evidence for however many messages WERE triaged must survive —
 * but this function then throws {@link Core.M3LOperationAbortedError}
 * rather than resolving. Per ADR-0049, `runScript` only classifies a run
 * `"interrupted"` when the callback rejects with a signal-coded error;
 * resolving normally here (as a plain `return report` would) reports a
 * half-cancelled queue as a successful `triage`, with a success exit code,
 * even though every message past the cancellation point carries no verdict
 * at all.
 */
async function dispatchTriage(
  _operation: "triage",
  settings: RawSettings,
  _context: undefined,
  deps: RunTriageDeps,
): Promise<DispatchResult> {
  if (deps.sqs === undefined || deps.dynamo === undefined) {
    throw new Core.M3LError(
      `'triage' requires AWS credentials — set '${Core.AWS_PROFILE_PARAM_NAME}'`,
      { code: CONFIG_CODE },
    );
  }
  const queue = requireDefined(settings.queue, "queue");
  const queueUrl = requireDefined(settings.queueUrl, "queueUrl");

  const result = await triageQueue({
    sqs: deps.sqs,
    lookup: createDynamoDBLookup({
      operations: deps.dynamo,
      signal: deps.signal,
    }),
    reader: deps.reader,
    paths: deps.paths,
    logger: deps.logger,
    runbookDir: settings.runbookDir,
    queue,
    queueUrl,
    maxMessages: settings.maxMessages,
    visibilityTimeout: settings.visibilityTimeout,
    signal: deps.signal,
  });

  const report = buildTriageReport({
    result,
    queueUrl,
    messages: result.messages,
    escalateTo: result.escalateTo,
    followUps: result.followUps,
    generatedAt: new Date().toISOString(),
  });
  logTriageReport(deps.logger, report);
  const artifactName = `${queue}/triage-${report.generatedAt.replaceAll(":", "-")}.json`;
  await writeJsonArtifact(deps.paths, artifactName, report);
  // The report above is this cancelled run's durable, partial evidence —
  // written and logged BEFORE this throw, never instead of it. Resolving
  // here would report a half-cancelled queue as a successful `triage`.
  if (result.outcomes.at(-1)?.status === "aborted") {
    throw new Core.M3LOperationAbortedError(
      `triage of '${queue}' cancelled after ${String(result.outcomes.length)}/${String(result.drained)} message(s)`,
    );
  }
  return report;
}

/**
 * The `sqs-dead-letter-triage` pipeline: resolve settings, guard the
 * operation's required fields, and dispatch. No `persist` is configured —
 * `convert` and `triage` each write their own artifact via `M3LPaths`, and
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
    triage: dispatchTriage,
  },
});

/**
 * Composes `sqs-dead-letter-triage` end to end via
 * `Core.M3LOperationPipeline`: dispatches `validate`, `explain`, `convert`
 * or `triage`. The graded-destructive `execute` operation is not part of
 * this slice.
 *
 * @param deps - The resolved config, `M3LPaths`, input-file reader, logger
 *   and prompt.
 * @returns A promise that resolves once the operation completes.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_CONFIG` when a
 *   guard-checked per-operation requirement is unmet.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_VALIDATE` when
 *   `validate` found a problem in any preset.
 * @throws {@link Core.M3LOperationAbortedError} When `triage` is cancelled
 *   mid-drain — the partial report is still archived and logged first.
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
