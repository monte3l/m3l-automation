/**
 * `internal/procedure/trace` — the per-run step/outcome tracer for
 * `M3LProcedure.run`, kept separate so `M3LProcedure.ts` stays lean (the
 * same reason `internal/pipeline/trace.ts` is separate from
 * `M3LOperationPipeline.ts` — see that file's header, which this module
 * transliterates).
 *
 * Tracing is opt-in and never load-bearing: a throwing `describeTrace`, a
 * throwing getter on its return, or a throwing `sink.record` is guarded
 * independently and can never change a run's outcome
 * (`docs/reference/core/procedure.md` § Tracing). A step's own settlement —
 * success, absorbed recovery, or unabsorbed failure/abort — is decided
 * entirely by the engine before this module is consulted; only the tracing
 * side effects (the `describeTrace` call and the `sink.record` call) are
 * guarded here.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3L_ERROR_CODES, M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/index.js";
import { isBoolean, isNumber, isString } from "../../core/utils/guards.js";

import type { M3LBreadcrumbScalar } from "../../core/diagnostics/index.js";
import type { M3LLogger } from "../../core/logging/M3LLogger.js";
import type {
  M3LProcedureContext,
  M3LProcedureFlow,
  M3LProcedureOutcome,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureTraceOptions,
  M3LProcedureTraceSink,
} from "../../core/procedure/types.js";

/** The default `source` label passed to `sink.record` when `trace.source` is omitted. */
const DEFAULT_TRACE_SOURCE = "M3LProcedure";

/** The fixed event name every traced step entry is recorded under. */
const STEP_EVENT = "procedure:step";

/** The fixed event name the single per-run outcome entry is recorded under. */
const OUTCOME_EVENT = "procedure:outcome";

/** The literal logged in place of an error `code` that isn't a recognized `M3LErrorCode`. */
const UNCLASSIFIED_CODE = "unclassified";

/**
 * How one step's just-settled execution result classifies for tracing —
 * computed by the caller (`M3LProcedure.ts`) AFTER `body` resolves, since
 * only the caller knows the engine-private shape of its own step-execution
 * outcome type. `failed` is `true` whenever the step's `execute` threw on
 * this attempt, whether or not that throw was absorbed into a `"recovered"`
 * step record; `flow` is the scalar projection of the step's own returned
 * flow directive, `undefined` whenever `failed` is `true`.
 */
export interface M3LProcedureStepTraceClassification {
  readonly failed: boolean;
  readonly flow: string | undefined;
}

/**
 * Projects a step's {@link M3LProcedureFlow} directive to the scalar form a
 * breadcrumb-shaped sink can retain: `"continue"`, `"stop"`, and `"resolve"`
 * pass through verbatim, while the `{ goTo }` object form — which a scalar
 * sink would otherwise silently drop — becomes `"goTo:<targetId>"`.
 *
 * @param flow - The step's resolved flow directive.
 * @returns The scalar projection.
 */
export function projectFlowToScalar(flow: M3LProcedureFlow<string>): string {
  return typeof flow === "object" ? `goTo:${flow.goTo}` : flow;
}

/**
 * Per-run tracer for {@link M3LProcedure.run}, built fresh by
 * {@link createProcedureTracer} once per `run()` call (never stored on the
 * engine instance).
 *
 * @typeParam TShape - The procedure's declared shape.
 */
export interface M3LProcedureTracer<TShape extends M3LProcedureShape> {
  /**
   * Runs `body`, recording one `"procedure:step"` entry for `step` — or,
   * when tracing is not configured, simply invoking `body` with no timing
   * work and no sink interaction at all.
   *
   * @param step - The step about to execute; supplies the entry's
   *   `stepId`/`label`/`kind` and the `describeTrace` callback, if any.
   * @param context - The context `body` is about to receive, handed to
   *   `describeTrace` unchanged.
   * @param attempt - This execution's 1-based attempt number.
   * @param body - The step's actual execution, already fully resolved
   *   internally — never expected to throw.
   * @param classify - Reads `body`'s resolved result into the `failed`/`flow`
   *   this entry records. Called AFTER `body` settles, so the recorded
   *   `durationMs` covers the whole execution.
   * @returns Whatever `body` resolved, unchanged.
   */
  runStep<TResult>(
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    context: M3LProcedureContext<TShape>,
    attempt: number,
    body: () => Promise<TResult>,
    classify: (result: TResult) => M3LProcedureStepTraceClassification,
  ): Promise<TResult>;

  /**
   * Records the single `"procedure:outcome"` entry for this run — or, when
   * tracing is not configured, does nothing.
   *
   * @param outcome - The run's fully resolved outcome.
   */
  recordOutcome(outcome: M3LProcedureOutcome<TShape>): void;
}

/**
 * Builds the tracer for one {@link M3LProcedure.run} call.
 *
 * When `options` is `undefined`, {@link M3LProcedureTracer.runStep} degrades
 * to invoking `body` directly — no `performance.now()` call, no
 * `describeTrace` invocation, no `sink` interaction — and
 * {@link M3LProcedureTracer.recordOutcome} does nothing: behavior is
 * byte-identical to a run without the `trace` option at all.
 *
 * @param options - The run's `trace` option, or `undefined`.
 * @param logger - The run's logger, used only to warn on a guarded tracing
 *   failure; never called when `options` is `undefined`. Absent, the
 *   warning is silently dropped.
 * @returns The tracer for this run.
 */
export function createProcedureTracer<TShape extends M3LProcedureShape>(
  options: M3LProcedureTraceOptions | undefined,
  logger: M3LLogger | undefined,
): M3LProcedureTracer<TShape> {
  if (options === undefined) {
    return {
      runStep(_step, _context, _attempt, body) {
        return body();
      },
      recordOutcome() {
        // Tracing not configured — no sink is ever touched.
      },
    };
  }

  const source = options.source ?? DEFAULT_TRACE_SOURCE;
  const sink = options.sink;

  return {
    async runStep(step, context, attempt, body, classify) {
      const extra = safeDescribeStep(step, context, logger);
      const start = performance.now();
      const result = await body();

      // Recorded exactly once — a record-time failure is fully guarded
      // inside recordStep and can never affect `result` returned below.
      recordStep(
        sink,
        source,
        step,
        extra,
        attempt,
        start,
        classify(result),
        logger,
      );
      return result;
    },
    recordOutcome(outcome) {
      recordOutcomeEntry(sink, source, outcome);
    },
  };
}

/**
 * Invokes `step.describeTrace` (when declared) with the context `execute` is
 * about to receive, guarded independently from the eventual `sink.record`
 * call. A throw is warned about (naming the step and, when classifiable, the
 * error's `code` — never its `message` or `name`) and degrades to an empty
 * extra-keys record — it never affects the step's own execution.
 */
function safeDescribeStep<TShape extends M3LProcedureShape>(
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  context: M3LProcedureContext<TShape>,
  logger: M3LLogger | undefined,
): Readonly<Record<string, M3LBreadcrumbScalar>> {
  const describeTrace = step.describeTrace;
  if (describeTrace === undefined) return {};
  try {
    return describeTrace(context);
  } catch (error) {
    warnTracingFailure(logger, `step '${step.id}'`, error);
    return {};
  }
}

/**
 * Narrows `value` to an {@link M3LBreadcrumbScalar} — the runtime
 * enforcement of the type-level pinning `describeTrace`'s return type
 * declares. A hostile caller-supplied return can still hold a nested object,
 * array, function, `Date`, or `Buffer`; without this check such a value
 * would be stored by reference, letting a later caller-side mutation change
 * what a deferred sink serializes.
 */
function isBreadcrumbScalarValue(value: unknown): value is M3LBreadcrumbScalar {
  return (
    value === null || isString(value) || isNumber(value) || isBoolean(value)
  );
}

/**
 * Projects `extra` (the `describeTrace` return) plus the engine's own
 * `stepId`/`label`/`kind`/`attempt`/`durationMs`/`failed`/`flow` keys into
 * the payload recorded for one step.
 *
 * Every property read on `extra` — including a hostile getter — happens
 * here, inside the caller's guarded `try` (see {@link recordStep}), so a
 * throwing accessor can never escape unguarded. Each `extra` key is kept
 * only when both:
 * - it is not a dangerous prototype-pollution key (`__proto__`,
 *   `constructor`, `prototype` — see `core/security`'s `isDangerousKey`),
 *   and
 * - its value is a genuine {@link M3LBreadcrumbScalar}; anything else is
 *   dropped rather than stored by reference.
 *
 * The engine's own keys are applied AFTER `extra` — a `describeTrace` return
 * forging `failed: true` on an otherwise-successful step is overwritten
 * rather than left standing. `failed` is always set (never omitted, even
 * when `false`); `flow` is set when defined and otherwise removed, since
 * `undefined` is not itself a valid {@link M3LBreadcrumbScalar}.
 */
function buildStepPayload<TShape extends M3LProcedureShape>(
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  durationMs: number,
  classification: M3LProcedureStepTraceClassification,
): Record<string, M3LBreadcrumbScalar> {
  const payload: Record<string, M3LBreadcrumbScalar> = {};
  for (const key of Object.keys(extra)) {
    if (isDangerousKey(key)) continue;
    const value: unknown = extra[key];
    if (isBreadcrumbScalarValue(value)) {
      payload[key] = value;
    }
  }
  payload["stepId"] = step.id;
  payload["label"] = step.label;
  payload["kind"] = step.kind;
  payload["attempt"] = attempt;
  payload["durationMs"] = durationMs;
  payload["failed"] = classification.failed;
  if (classification.flow === undefined) {
    delete payload["flow"];
  } else {
    payload["flow"] = classification.flow;
  }
  return payload;
}

/**
 * Assembles one step's payload and records it via `sink.record`, guarded
 * independently from the `describeTrace` call above.
 *
 * Building the payload (every property read on `extra`) and calling
 * `sink.record` are covered by the SAME `try` — a hostile `describeTrace`
 * return (e.g. a throwing getter) is only ever read here, never before this
 * guard, so it can never escape unguarded.
 */
function recordStep<TShape extends M3LProcedureShape>(
  sink: M3LProcedureTraceSink,
  source: string,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  attempt: number,
  startedAt: number,
  classification: M3LProcedureStepTraceClassification,
  logger: M3LLogger | undefined,
): void {
  const durationMs = performance.now() - startedAt;
  try {
    const payload = buildStepPayload(
      extra,
      step,
      attempt,
      durationMs,
      classification,
    );
    sink.record(source, STEP_EVENT, payload);
  } catch (error) {
    warnTracingFailure(logger, `step '${step.id}'`, error);
  }
}

/**
 * Builds the single per-run `"procedure:outcome"` payload from
 * engine-owned scalars only — never a `describeTrace`-style caller callback,
 * since the outcome event has none. Every value is a genuine
 * `string | number | boolean`; unlike the step payload, `null` is never
 * admitted here, and an absent optional field (`terminatedAt`, `failedStep`,
 * `abortedAt`) is omitted rather than recorded as `null`.
 */
function buildOutcomePayload<TShape extends M3LProcedureShape>(
  outcome: M3LProcedureOutcome<TShape>,
): Record<string, M3LBreadcrumbScalar> {
  const payload: Record<string, M3LBreadcrumbScalar> = {
    status: outcome.status,
    digest: outcome.digest,
    parametersDigest: outcome.parametersDigest,
    durationMs: outcome.telemetry.durationMs,
    iterations: outcome.telemetry.iterations,
    stepsSkipped: outcome.telemetry.stepsSkipped,
    resolveChecks: outcome.telemetry.resolveChecks,
    recoveredTotal: outcome.telemetry.recoveredTotal,
    earlyResolved: outcome.telemetry.earlyResolved,
  };

  const terminatedAt = outcome.telemetry.terminatedAt;
  if (terminatedAt !== undefined) {
    payload["terminatedAt"] = terminatedAt;
  }
  if (outcome.status === "failed" && outcome.failedStep !== undefined) {
    payload["failedStep"] = outcome.failedStep;
  }
  if (outcome.status === "aborted" && outcome.abortedAt !== undefined) {
    payload["abortedAt"] = outcome.abortedAt;
  }
  return payload;
}

/**
 * Assembles the run's outcome payload and records it via `sink.record`,
 * guarded the same way {@link recordStep} guards its own payload
 * build + record pair — except a failure here is swallowed without a
 * `logger.warning` call: the documented warning contract names *the step*
 * a tracing failure occurred at, and the single per-run outcome event has
 * no step to name.
 */
function recordOutcomeEntry<TShape extends M3LProcedureShape>(
  sink: M3LProcedureTraceSink,
  source: string,
  outcome: M3LProcedureOutcome<TShape>,
): void {
  try {
    const payload = buildOutcomePayload(outcome);
    sink.record(source, OUTCOME_EVENT, payload);
  } catch {
    // Best-effort, unlogged: see the TSDoc above for why this differs from
    // `recordStep`'s guarded-and-warned failure path.
  }
}

/**
 * Classifies a tracing failure's `code` for the warning message, allowlisted
 * against {@link M3L_ERROR_CODES} rather than echoed verbatim: `error.code`
 * is caller-controlled (it comes from a `describeTrace`/`sink.record` a
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
 * Logs a `logger.warning` naming `label` (a step, or the run outcome) and,
 * when classifiable, the failure's `M3LError` `code` — allowlisted against
 * {@link M3L_ERROR_CODES} so a caller-invented code can never be echoed. The
 * error's `name` and `message` are never logged: both can embed caller data.
 * Dropped entirely when `logger` is absent, and the logger call itself is
 * guarded so a failing logger cannot escalate a tracing failure into a run
 * failure.
 */
function warnTracingFailure(
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
