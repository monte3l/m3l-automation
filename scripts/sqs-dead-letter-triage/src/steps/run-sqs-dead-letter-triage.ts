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
import { applyActions } from "./execute-actions.js";
import {
  EXECUTE_CODE,
  buildExecutePlan,
  logExecutePlan,
  resolveSourceQueueUrl,
} from "./execute-plan.js";
import { explainRunbook } from "./explain-runbook.js";
import { createDynamoDBLookup } from "./lookup-entity.js";
import { buildTriageReport, logTriageReport } from "./report.js";
import { triageQueue } from "./triage-queue.js";
import { reportValidation, validateRunbooks } from "./validate-runbooks.js";
import { writeJsonArtifact } from "./write-artifact.js";
import type { ConversionResult } from "./convert-runbook.js";
import type { ApplyResult } from "./execute-actions.js";
import type { ExecutePlan } from "./execute-plan.js";
import type { TriagePreset } from "./preset.js";
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
  /** Where a planned `reinsert` sends — guarded at run time, only when the built plan needs it (see {@link resolveSourceQueueUrl}). */
  readonly sourceQueueUrl: string | undefined;
  /** Gates whether `execute` mutates at all; `false` prints the plan only. */
  readonly apply: boolean;
  /** `Core.confirmDestructive`'s ungraded bypass flag. */
  readonly yes: boolean;
  /** `Core.confirmDestructive`'s sensitive-target bypass flag — requires strict `yes === true` alongside it. */
  readonly yesSensitive: boolean;
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
 * whether or not real credentials resolve — `dispatchTriage`/`dispatchExecute`
 * are the handlers that insist on both being present and fail loud, naming
 * `aws.profile`, when they are not.
 *
 * `awsTarget` mirrors `M3LScript.awsTarget` (`core/script/M3LScript.ts`)
 * exactly: `undefined` unless a resolved AWS identity was provisioned, and
 * threaded through as the `target` `Core.confirmDestructive` grades
 * `execute --apply`'s destructive gate on. `dispatchExecute` refuses to
 * `--apply` at all when this is `undefined` (review round 2, MUST-FIX 6) —
 * see its TSDoc.
 *
 * `reportRecovery` is the narrow callback (review round 2, MUST-FIX 2) that
 * demotes a run with per-message `execute --apply` failures from
 * `"success"` to `"partial"` (`M3LScript.reportRecovery`, exit code
 * `M3L_EXIT_CODES.PARTIAL`) — deliberately not the whole `M3LScript`, so
 * this dispatcher stays testable with a plain `vi.fn()` and does not couple
 * a step module to the script object.
 */
export interface RunTriageDeps extends Core.M3LOperationPipelineBaseDeps {
  readonly paths: Core.M3LPaths;
  readonly reader: Core.M3LInputFileReader;
  readonly sqs: AWS.M3LSQSOperations | undefined;
  readonly dynamo: AWS.M3LDynamoDBOperations | undefined;
  readonly awsTarget: Core.M3LDestructiveTarget | undefined;
  readonly signal: AbortSignal | undefined;
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
}

/** The union of result shapes any dispatched operation can resolve. */
type DispatchResult =
  | ValidationSummary
  | Core.M3LProcedureSummary
  | ConversionResult
  | TriageReport
  | ApplyResult;

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
    sourceQueueUrl: accessor.optionalString("sourceQueueUrl"),
    apply: accessor.booleanWithDefault("apply", false),
    yes: accessor.booleanWithDefault("yes", false),
    yesSensitive: accessor.booleanWithDefault("yesSensitive", false),
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
  // `sourceQueueUrl` is deliberately absent — see decision 1: it is guarded
  // at run time, only when the built plan actually contains a `reinsert`
  // (`resolveSourceQueueUrl`), not unconditionally required for `execute`.
  execute: ["queue", "queueUrl"],
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
 * Runs one triage pass — drains the queue and evaluates the compiled preset
 * per message — shared by `triage` and `execute`'s plan-building path, which
 * otherwise built the identical `triageQueue` + `buildTriageReport` pair
 * independently (review round 2, SHOULD-FIX 12). `onReport` runs BEFORE the
 * mid-drain abort check below, so a caller's own logging/persistence of the
 * pass's (possibly partial) report — `dispatchTriage`'s artifact write, in
 * particular — still happens even when this then throws.
 *
 * Putting the `"aborted"` check here, rather than duplicated per caller, is
 * what review round 1's MUST-FIX 1 needed: `dispatchTriage` already guarded
 * this outcome, but `execute`'s plan-building path built the exact same pass
 * with no such check, so a cancelled run there could print a
 * complete-looking plan — or, under `--apply`, confirm the destructive gate
 * and mutate SQS — on triage evidence that stopped partway through.
 * Extracting the guard into the one function both callers route through
 * means neither can omit it again.
 *
 * @throws {@link Core.M3LOperationAbortedError} when the drain was cancelled
 *   mid-pass — thrown AFTER `onReport` runs, never instead of it.
 */
async function runTriagePass(
  queue: string,
  queueUrl: string,
  sqs: AWS.M3LSQSOperations,
  dynamo: AWS.M3LDynamoDBOperations,
  settings: RawSettings,
  deps: RunTriageDeps,
  onReport: (report: TriageReport) => void | Promise<void>,
): Promise<{
  readonly report: TriageReport;
  readonly preset: TriagePreset;
  /** The drain's own held messages — see `execute-actions.ts`'s `ApplyActionsDeps.messages`. */
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string;
    readonly receiptHandle: string;
  }[];
}> {
  const result = await triageQueue({
    sqs,
    lookup: createDynamoDBLookup({ operations: dynamo, signal: deps.signal }),
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

  await onReport(report);

  // The report above is this cancelled run's durable, partial evidence —
  // built and (via `onReport`) written/logged BEFORE this throw, never
  // instead of it. Resolving here would report a half-cancelled pass as a
  // successful one.
  if (result.outcomes.at(-1)?.status === "aborted") {
    throw new Core.M3LOperationAbortedError(
      `triage of '${queue}' cancelled after ${String(result.outcomes.length)}/${String(result.drained)} message(s)`,
    );
  }

  return { report, preset: result.preset, messages: result.messages };
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
 * rather than resolving; see {@link runTriagePass}'s TSDoc for why.
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

  const { report } = await runTriagePass(
    queue,
    queueUrl,
    deps.sqs,
    deps.dynamo,
    settings,
    deps,
    async (builtReport) => {
      logTriageReport(deps.logger, builtReport);
      const artifactName = `${queue}/triage-${builtReport.generatedAt.replaceAll(":", "-")}.json`;
      await writeJsonArtifact(deps.paths, artifactName, builtReport);
    },
  );
  return report;
}

/**
 * Re-runs the same triage pass as `triage` (via {@link runTriagePass}) to
 * obtain a fresh report and its preset, then builds and logs the
 * {@link ExecutePlan} from it. Split out of `dispatchExecute` purely to stay
 * under the per-function line ceiling; `sqs` and `dynamo` are taken as their
 * own narrowed parameters (rather than read off `deps` again) because
 * TypeScript's narrowing of `deps.sqs`/`deps.dynamo` from `dispatchExecute`'s
 * own guard does not survive the function-call boundary.
 */
async function buildExecuteReportAndPlan(
  queue: string,
  queueUrl: string,
  sqs: AWS.M3LSQSOperations,
  dynamo: AWS.M3LDynamoDBOperations,
  settings: RawSettings,
  deps: RunTriageDeps,
): Promise<{
  readonly report: TriageReport;
  readonly plan: ExecutePlan;
  readonly preset: TriagePreset;
  /** The drain's own held messages — see `execute-actions.ts`'s `ApplyActionsDeps.messages`. */
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string;
    readonly receiptHandle: string;
  }[];
}> {
  const { report, preset, messages } = await runTriagePass(
    queue,
    queueUrl,
    sqs,
    dynamo,
    settings,
    deps,
    () => undefined,
  );
  const plan = buildExecutePlan(report);
  logExecutePlan(deps.logger, plan);
  return { report, plan, preset, messages };
}

/**
 * Records one {@link Core.M3LRunRecoveryEntry} per {@link ApplyResult.failed}
 * element (review round 2, MUST-FIX 2) — otherwise a throttled
 * `deleteBatch`, a lapsed receipt handle, or a malformed FIFO group id leaves
 * messages unresolved (a `drop` that failed to delete stays in the DLQ, a
 * `move` that failed to send never arrives) while the run still resolves
 * `"success"`.
 *
 * Also records one entry per {@link ApplyResult.skipped} id (claude-pr-review
 * Must-fix on PR #629): a `skipped` id is a planned action that was never
 * acted on at all, which is exactly as unresolved as a `failed` one — routing
 * only `failed` here let a run where `applyActions` found no matching held
 * message for any planned id (before handle reuse: every re-receive coming
 * back empty) still resolve `"success"` with zero sends and zero deletes.
 * With handle reuse a `skipped` id is now structurally near-impossible
 * (every planned id comes from the same drain that produced
 * `deps.messages`), so a non-empty `skipped` here signals an
 * internal-invariant violation, not routine drift — it still must demote the
 * run rather than pass silently.
 *
 * `M3LScript.reportRecovery` is what demotes the outcome to `"partial"`
 * (exit code `M3L_EXIT_CODES.PARTIAL`).
 */
function reportUnresolvedActions(
  reportRecovery: RunTriageDeps["reportRecovery"],
  applyResult: ApplyResult,
): void {
  for (const failure of applyResult.failed) {
    reportRecovery({
      item: failure.messageId,
      error: [{ name: "Error", message: failure.reason }],
      recordedAt: new Date().toISOString(),
    });
  }
  for (const messageId of applyResult.skipped) {
    reportRecovery({
      item: messageId,
      error: [
        {
          name: "Error",
          message:
            "planned action skipped: no held message matched this id (internal invariant violation — see ApplyResult.skipped)",
        },
      ],
      recordedAt: new Date().toISOString(),
    });
  }
}

/**
 * Confirms the destructive gate, with the `yes`/`yesSensitive` bypass flags
 * threaded straight through — mind the deliberately asymmetric polarity
 * documented on `Core.confirmDestructive` itself. Every resolved target is
 * treated as sensitive (review round 2, MUST-FIX 7): the library never
 * populates `M3LDestructiveTarget.accountId`, so an account-keyed allow-list
 * could never fire, and the prior `nonSensitiveAccounts` parameter was dead
 * config documented as a working carve-out. A decline propagates unchanged
 * (never swallowed): the gate throws, and this function performs no further
 * AWS calls.
 *
 * `preset` is the exact one `buildExecuteReportAndPlan`'s triage pass
 * already loaded and ran (review round 2, SHOULD-FIX 11) — never re-read
 * after the interactive confirmation prompt returns, which would otherwise
 * leave a window where a concurrent preset write redirects where a
 * confirmed plan sends. `messages` is that same triage pass's drained
 * messages (with their receipt handles) — `applyActions` reuses them
 * directly rather than re-receiving; see its TSDoc for why a fresh receive
 * here would only see the drain's own lockout. Applying writes
 * `<queue>/execute-<timestamp>.json` and logs the applied counts.
 *
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_EXECUTE` when the
 *   destructive gate is declined, or {@link resolveSourceQueueUrl} rejects
 *   the supplied (or missing) `sourceQueueUrl`.
 */
async function confirmAndApplyExecutePlan(
  queue: string,
  queueUrl: string,
  sqs: AWS.M3LSQSOperations,
  report: TriageReport,
  plan: ExecutePlan,
  preset: TriagePreset,
  messages: readonly {
    readonly messageId: string;
    readonly body: string;
    readonly receiptHandle: string;
  }[],
  settings: RawSettings,
  deps: RunTriageDeps,
): Promise<ApplyResult> {
  await Core.confirmDestructive({
    prompt: deps.prompt,
    logger: deps.logger,
    description: `apply execute plan for '${queue}' (remove=${String(plan.removeCount)}, reinsert=${String(plan.reinsertCount)})`,
    yes: settings.yes,
    yesSensitive: settings.yesSensitive,
    code: EXECUTE_CODE,
    ...(deps.awsTarget !== undefined && { target: deps.awsTarget }),
    isSensitiveTarget: (): true => true,
  });

  const sourceQueueUrl = resolveSourceQueueUrl(
    plan,
    preset,
    settings.sourceQueueUrl,
    queueUrl,
  );

  const applyResult = await applyActions(plan, {
    sqs,
    logger: deps.logger,
    queueUrl,
    sourceQueueUrl,
    preset,
    signal: deps.signal,
    messages,
  });

  reportUnresolvedActions(deps.reportRecovery, applyResult);

  deps.logger.step(
    `execute applied for '${queue}': removed=${String(applyResult.removed)} reinserted=${String(applyResult.reinserted)} skipped=${String(applyResult.skipped.length)} failed=${String(applyResult.failed.length)}`,
  );

  const artifactName = `${queue}/execute-${report.generatedAt.replaceAll(":", "-")}.json`;
  await writeJsonArtifact(deps.paths, artifactName, applyResult);

  return applyResult;
}

/**
 * `execute`: re-runs the same triage pass as `triage` to obtain a fresh
 * report, builds and logs the {@link ExecutePlan} from it, and stops there
 * unless `apply` is `true` — the plan-only surface never mutates SQS beyond
 * the triage drain itself (a receive, not a send/delete). See
 * {@link buildExecuteReportAndPlan} and {@link confirmAndApplyExecutePlan}
 * for what each phase does.
 *
 * `--apply` refuses to run at all when `deps.awsTarget` is `undefined`
 * (review round 2, MUST-FIX 6), before the gate and before any mutation —
 * `M3LScript.provisionAws` leaves `resolvedAwsTarget` (and therefore
 * `awsTarget`) `undefined` whenever `profile` itself is undefined, which is
 * reachable with AWS fully working (an instance role, or `AWS_PROFILE`
 * exported with no `aws.profile` config value). Without this guard, that
 * state would take `confirmDestructive`'s ungraded no-`target` path, and
 * `--yes` alone would delete production messages with no prompt at all. The
 * plan-only surface (no `--apply`) is deliberately exempt — it never
 * mutates SQS, so it must keep working with no resolved identity.
 *
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_CONFIG` when
 *   `script.aws` was never provisioned.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_EXECUTE` when
 *   `--apply` was requested with no resolved AWS identity, the destructive
 *   gate is declined, or {@link resolveSourceQueueUrl} rejects the supplied
 *   (or missing) `sourceQueueUrl`.
 */
async function dispatchExecute(
  _operation: "execute",
  settings: RawSettings,
  _context: undefined,
  deps: RunTriageDeps,
): Promise<DispatchResult> {
  if (deps.sqs === undefined || deps.dynamo === undefined) {
    throw new Core.M3LError(
      `'execute' requires AWS credentials — set '${Core.AWS_PROFILE_PARAM_NAME}'`,
      { code: CONFIG_CODE },
    );
  }
  if (settings.apply && deps.awsTarget === undefined) {
    throw new Core.M3LError(
      `'execute --apply' requires a resolved AWS identity — set '${Core.AWS_PROFILE_PARAM_NAME}'`,
      { code: EXECUTE_CODE },
    );
  }
  const queue = requireDefined(settings.queue, "queue");
  const queueUrl = requireDefined(settings.queueUrl, "queueUrl");

  const { report, plan, preset, messages } = await buildExecuteReportAndPlan(
    queue,
    queueUrl,
    deps.sqs,
    deps.dynamo,
    settings,
    deps,
  );

  if (!settings.apply) {
    return report;
  }

  return confirmAndApplyExecutePlan(
    queue,
    queueUrl,
    deps.sqs,
    report,
    plan,
    preset,
    messages,
    settings,
    deps,
  );
}

/**
 * The `sqs-dead-letter-triage` pipeline: resolve settings, guard the
 * operation's required fields, and dispatch. No `persist` is configured —
 * `convert`, `triage` and an applying `execute` each write their own
 * artifact via `M3LPaths`, and `validate`/`explain` are console-only.
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
    execute: dispatchExecute,
  },
});

/**
 * Composes `sqs-dead-letter-triage` end to end via
 * `Core.M3LOperationPipeline`: dispatches `validate`, `explain`, `convert`,
 * `triage`, or the graded-destructive `execute`.
 *
 * @param deps - The resolved config, `M3LPaths`, input-file reader, logger,
 *   prompt, resolved AWS target, and recovery-reporting callback.
 * @returns A promise that resolves once the operation completes.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_CONFIG` when a
 *   guard-checked per-operation requirement is unmet.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_VALIDATE` when
 *   `validate` found a problem in any preset.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_EXECUTE` when
 *   `execute --apply` has no resolved AWS identity, its destructive gate is
 *   declined, or its `sourceQueueUrl` guard rejects a missing/mismatched
 *   value.
 * @throws {@link Core.M3LOperationAbortedError} When `triage` (or
 *   `execute`'s triage pass) is cancelled mid-drain — the partial report is
 *   still archived and logged first where `triage` does so.
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
