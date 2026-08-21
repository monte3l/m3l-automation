/**
 * `internal/procedure/trace-payload` — the guarded payload-assembly helpers
 * `trace.ts`'s tracer delegates to: safely invoking a step's `describeTrace`,
 * allowlisting its return, assembling one {@link M3LProcedureTraceEntry},
 * flattening it for `sink.record`, building the `procedure:outcome` payload,
 * and classifying/warning about a guarded tracing failure.
 *
 * Modeled on `internal/pipeline/trace.ts`'s equivalent helpers, but this is a
 * **separate** declaration with its own vocabulary and payload keys — see
 * `docs/reference/core/procedure.md` § Tracing for why the two engines don't
 * share one trace type.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3L_ERROR_CODES, M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/index.js";
import {
  isBoolean,
  isNumber,
  isPlainObject,
  isString,
} from "../../core/utils/guards.js";

import type { M3LBreadcrumbScalar } from "../../core/diagnostics/index.js";
import type { M3LLogger } from "../../core/logging/index.js";
import type {
  M3LProcedureOutcome,
  M3LProcedureTraceEntry,
} from "../../core/procedure/run-types.js";
import type {
  M3LProcedureContext,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";
import type { M3LProcedureStepTraceClassification } from "./trace.js";

/** The literal logged in place of an error `code` that isn't a recognized `M3LErrorCode`. */
const UNCLASSIFIED_CODE = "unclassified";

/**
 * Reports one guarded tracing failure for the current run — bound by
 * `trace.ts`'s tracer to at most one `logger.warning` call per run, so a
 * persistently broken `sink`/`describeTrace` cannot spam the log once per
 * step. Never throws.
 */
export type TracingFailureReporter = (label: string, error: unknown) => void;

/**
 * Invokes `step.describeTrace` (when declared) with `context`, guarded
 * independently from the eventual `sink.record` call. A non-plain-object
 * return (a string, an array, `undefined`) degrades to `{}`; a throw is
 * reported (naming `step.id`) and also degrades to `{}` — it never affects
 * the step's own execution or the run's outcome.
 */
export function safeDescribeStep<TShape extends M3LProcedureShape>(
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  context: M3LProcedureContext<TShape>,
  reportFailure: TracingFailureReporter,
): Readonly<Record<string, unknown>> {
  if (step.describeTrace === undefined) return {};
  try {
    const described: unknown = step.describeTrace(context);
    return isPlainObject(described) ? described : {};
  } catch (error) {
    reportFailure(`step '${step.id}'`, error);
    return {};
  }
}

/**
 * Narrows `value` to an {@link M3LBreadcrumbScalar} — the runtime
 * enforcement of the type-level pinning `describeTrace`'s return type
 * declares. A caller (or a cast) can still construct a payload holding a
 * nested object, array, function, `Date`, or `Buffer`; without this check,
 * such a value would be stored by reference, letting a later caller-side
 * mutation change what a deferred sink serializes.
 */
function isBreadcrumbScalarValue(value: unknown): value is M3LBreadcrumbScalar {
  return (
    value === null || isString(value) || isNumber(value) || isBoolean(value)
  );
}

/**
 * Projects `extras` (a `describeTrace` return) into a fresh, sanitized
 * record: a dangerous key (`__proto__`, `constructor`, `prototype`) or a
 * non-scalar value is dropped individually — a single bad entry never
 * discards the whole payload — and no value is ever stored by reference
 * beyond this copy.
 */
function sanitizeTraceExtras(
  extras: Readonly<Record<string, unknown>>,
): Record<string, M3LBreadcrumbScalar> {
  const sanitized: Record<string, M3LBreadcrumbScalar> = {};
  for (const key of Object.keys(extras)) {
    if (isDangerousKey(key)) continue;
    const value: unknown = extras[key];
    if (isBreadcrumbScalarValue(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Assembles one {@link M3LProcedureTraceEntry} from the already-sanitized
 * `describeTrace` extras plus the engine's own step/attempt/timing/
 * classification fields.
 */
function buildTraceEntry<TShape extends M3LProcedureShape>(
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  durationMs: number,
  classification: M3LProcedureStepTraceClassification,
  extras: Readonly<Record<string, unknown>>,
): M3LProcedureTraceEntry {
  return {
    stepId: step.id,
    label: step.label,
    kind: step.kind,
    attempt,
    durationMs,
    failed: classification.failed,
    flow: classification.flow,
    payload: sanitizeTraceExtras(extras),
  };
}

/**
 * Merges `entry.payload` first, then applies the engine's own 7 keys LAST —
 * so a forging `describeTrace` return (e.g. claiming `attempt: 999`) is
 * overwritten, not left standing. `flow` is applied only when defined;
 * `entry.flow === undefined` means it is omitted from the flattened record
 * entirely (the step threw, or never returned a genuine directive).
 */
function flattenEntryForSink(
  entry: M3LProcedureTraceEntry,
): Record<string, M3LBreadcrumbScalar> {
  const flattened: Record<string, M3LBreadcrumbScalar> = { ...entry.payload };
  flattened["stepId"] = entry.stepId;
  flattened["label"] = entry.label;
  flattened["kind"] = entry.kind;
  flattened["attempt"] = entry.attempt;
  flattened["durationMs"] = entry.durationMs;
  flattened["failed"] = entry.failed;
  if (entry.flow === undefined) {
    delete flattened["flow"];
  } else {
    flattened["flow"] = entry.flow;
  }
  return flattened;
}

/**
 * The guarded pass a traced step's `runStep` delegates to once `body()` has
 * settled: computes `durationMs`, classifies the result, builds the entry
 * and pushes it onto `entries` BEFORE attempting `sink.record` (so a
 * failing `sink.record` never discards the retained entry), then attempts
 * `sink.record` inside the same guard. Any throw here — from a hostile
 * `describeTrace`-forged getter re-read, or from `sink.record` itself — is
 * warned about and swallowed; it never reaches the step's own result.
 */
export function recordStep<TShape extends M3LProcedureShape, TResult>(
  entries: M3LProcedureTraceEntry[],
  source: string,
  sink: { record(source: string, event: string, payload?: unknown): void },
  reportFailure: TracingFailureReporter,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  startedAt: number,
  extras: Readonly<Record<string, unknown>>,
  result: TResult,
  classify: (result: TResult) => M3LProcedureStepTraceClassification,
): void {
  try {
    const durationMs = performance.now() - startedAt;
    const classification = classify(result);
    const entry = buildTraceEntry(
      step,
      attempt,
      durationMs,
      classification,
      extras,
    );
    entries.push(entry);
    sink.record(source, "procedure:step", flattenEntryForSink(entry));
  } catch (error) {
    reportFailure(`step '${step.id}'`, error);
  }
}

/**
 * Assembles the `procedure:outcome` payload: exactly these 7 keys, always
 * present. `primaryCaseId` is `null` — never omitted — on every arm but
 * `"matched"`, since `undefined` is not an {@link M3LBreadcrumbScalar} and
 * `null` is the one representable "no case" value.
 */
function buildOutcomePayload<TShape extends M3LProcedureShape>(
  outcome: M3LProcedureOutcome<TShape>,
): Record<string, M3LBreadcrumbScalar> {
  return {
    status: outcome.status,
    digest: outcome.digest,
    iterations: outcome.telemetry.iterations,
    resolveChecks: outcome.telemetry.resolveChecks,
    earlyResolved: outcome.telemetry.earlyResolved,
    alsoMatchedCount: outcome.alsoMatched.length,
    primaryCaseId: outcome.status === "matched" ? outcome.primary.caseId : null,
  };
}

/**
 * The guarded pass for the `procedure:outcome` event: calling
 * `sink.record` and reading `outcome`'s fields both happen inside the same
 * `try` — a throw either way is warned about (labeled `"run outcome"`) and
 * swallowed rather than propagated.
 */
export function recordOutcomeEntry<TShape extends M3LProcedureShape>(
  source: string,
  sink: { record(source: string, event: string, payload?: unknown): void },
  reportFailure: TracingFailureReporter,
  outcome: M3LProcedureOutcome<TShape>,
): void {
  try {
    sink.record(source, "procedure:outcome", buildOutcomePayload(outcome));
  } catch (error) {
    reportFailure("run outcome", error);
  }
}

/**
 * Classifies a tracing failure's `code` for the warning message, allowlisted
 * against {@link M3L_ERROR_CODES} rather than echoed verbatim: `error.code`
 * can be caller-controlled (it comes from a `describeTrace`/`sink.record` a
 * caller configured), so an unrecognized or invented code must not reach the
 * log. Reading `.code` itself is guarded — a hostile `code` getter must not
 * propagate out of this classification step.
 */
function classifyTracingFailureCode(error: unknown): string {
  try {
    if (error instanceof M3LError) {
      const code: string = error.code;
      if ((M3L_ERROR_CODES as readonly string[]).includes(code)) {
        return code;
      }
    }
  } catch {
    // A hostile `code` getter must not propagate — fall through to the
    // unclassified literal, same as any other non-`M3LError`/unknown code.
  }
  return UNCLASSIFIED_CODE;
}

/**
 * Logs a `logger.warning` naming `label` and, when classifiable, the
 * failure's `M3LError` `code` — allowlisted against {@link M3L_ERROR_CODES}
 * so a caller-invented code can never be echoed. The error's `name` and
 * `message` are never logged: both can embed caller data. A no-op when
 * `logger` is `undefined`. The logger call itself is guarded so a failing
 * logger cannot escalate a tracing failure into a run failure.
 */
export function warnTracingFailure(
  logger: M3LLogger | undefined,
  label: string,
  error: unknown,
): void {
  if (logger === undefined) return;
  const detail = classifyTracingFailureCode(error);
  try {
    logger.warning(`M3LProcedure: tracing failed at ${label} (${detail})`);
  } catch {
    // Best-effort: tracing must never affect the run outcome, so a failing
    // logger call is swallowed rather than propagated.
  }
}
