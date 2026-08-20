/**
 * `internal/procedure/trace` — the per-run step/outcome tracer for
 * `M3LProcedure.run`, kept separate so `M3LProcedure.ts` stays lean (the
 * same reason `internal/pipeline/trace.ts` is separate from
 * `M3LOperationPipeline.ts` — see that file's header, which this module
 * transliterates).
 *
 * Tracing is opt-in and never load-bearing: a throwing `describeTrace`, a
 * throwing getter on its return, a throwing `classify` (including one raised
 * by a hostile `flow.goTo` getter), or a throwing `sink.record` is guarded
 * independently and can never change a run's outcome
 * (`docs/reference/core/procedure.md` § Tracing). A step's own settlement —
 * success, absorbed recovery, or unabsorbed failure/abort — is decided
 * entirely by the engine before this module is consulted; only the tracing
 * side effects (the `describeTrace` call, the `classify` call, and the
 * `sink.record` call) are guarded here — never as an argument expression
 * evaluated ahead of a guard, always inside one.
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
import type { M3LLogger } from "../../core/logging/M3LLogger.js";
import type {
  M3LProcedureContext,
  M3LProcedureFlow,
  M3LProcedureOutcome,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureTraceEntry,
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
 * breadcrumb-shaped sink can retain: the exact strings `"continue"`,
 * `"stop"`, and `"resolve"` pass through verbatim, and the `{ goTo }` object
 * form — which a scalar sink would otherwise silently drop — becomes
 * `"goTo:<targetId>"`, but only when `goTo` itself is genuinely a string.
 *
 * `flow` is declared as {@link M3LProcedureFlow}, but this function does not
 * trust that declaration at runtime: a step's own `execute` is caller code,
 * so `flow` can in practice be `null`, hold a non-string `goTo` (a `Symbol`,
 * for instance — interpolating one throws `TypeError`), or expose a `goTo`
 * accessor that throws. Every one of those degrades to `undefined` rather
 * than propagating a throw or a bogus string; the caller is responsible for
 * guarding the property read that can still throw (a hostile `goTo` getter)
 * — see {@link recordStep}.
 *
 * @param flow - The step's resolved flow directive.
 * @returns The scalar projection, or `undefined` when `flow` does not
 *   conform to the exact-string or `{ goTo: string }` shapes above.
 */
export function projectFlowToScalar(
  flow: M3LProcedureFlow<string>,
): string | undefined {
  if (flow === "continue" || flow === "stop" || flow === "resolve") {
    return flow;
  }
  if (typeof flow !== "object" || flow === null) return undefined;
  const goTo: unknown = flow.goTo;
  return isString(goTo) ? `goTo:${goTo}` : undefined;
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
   *   `durationMs` covers the whole execution, and INSIDE the same guarded
   *   region as the payload build and `sink.record` call — a throw from
   *   `classify` itself, or from a property read it triggers (e.g. a hostile
   *   `flow.goTo` getter), is warned about and dropped like any other
   *   tracing failure; it can never affect the `result` this method returns.
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

  /**
   * The {@link M3LProcedureTraceEntry} built for every `runStep` call so
   * far, in execution order — the SAME entries `runStep` derives the sink's
   * flattened payload from, never a second, independently-rebuilt
   * projection. The engine reads this once, when assembling
   * `outcome.trace`, instead of re-invoking a step's `describeTrace` itself;
   * that "one call, one projection, two consumers" shape is what keeps a
   * caller-supplied `describeTrace` from running twice per step (once for
   * the sink, once for the retained outcome), which would let a
   * non-idempotent or getter-backed return disagree between the two.
   * Always `[]` when tracing isn't configured for this run.
   */
  entries(): readonly M3LProcedureTraceEntry[];
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
      entries() {
        return [];
      },
    };
  }

  const source = options.source ?? DEFAULT_TRACE_SOURCE;
  const sink = options.sink;
  const entries: M3LProcedureTraceEntry[] = [];

  return {
    async runStep(step, context, attempt, body, classify) {
      const extra = safeDescribeStep(step, context, logger);
      const start = performance.now();
      const result = await body();

      // Recorded exactly once. `classify(result)` is evaluated INSIDE
      // recordStep's own guarded `try` (passed through unevaluated, along
      // with `result`) — a record-time failure, including one raised by
      // `classify` reading a hostile property on `result`, is fully guarded
      // and can never affect `result` returned below. The entry built here
      // is pushed onto `entries` BEFORE `sink.record` is attempted, so a
      // failing `sink.record` call warns but never discards the entry the
      // outcome's `trace` array will read back via {@link entries}.
      recordStep(
        sink,
        source,
        step,
        extra,
        attempt,
        start,
        result,
        classify,
        entries,
        logger,
      );
      return result;
    },
    recordOutcome(outcome) {
      recordOutcomeEntry(sink, source, outcome, logger);
    },
    entries() {
      return entries;
    },
  };
}

/**
 * Invokes `step.describeTrace` (when declared) with the context `execute` is
 * about to receive, guarded independently from the eventual `sink.record`
 * call. A throw is warned about (naming the step and, when classifiable, the
 * error's `code` — never its `message` or `name`) and degrades to an empty
 * extra-keys record — it never affects the step's own execution.
 *
 * Both the `step.describeTrace` read and the `step.id` read used to build the
 * warning label happen INSIDE the `try`, alongside the call itself — a
 * throwing `describeTrace` accessor or a throwing `id` getter is guarded the
 * same way a throwing `describeTrace()` call is. `stepId` is read once into
 * `stepRef`, reused by the `catch` below instead of re-reading `step.id` a
 * second time (which could itself throw, or diverge from the first read).
 *
 * The return is also shape-narrowed: a `describeTrace` that returns anything
 * other than a plain object (e.g. it falls off the end and returns
 * `undefined`, or returns a string/array) degrades to `{}` rather than
 * reaching `Object.keys` downstream, so a malformed return only drops the
 * `describeTrace` extras — never the engine-owned `stepId`/`failed`/
 * `durationMs` keys {@link buildStepPayload} applies afterward.
 */
function safeDescribeStep<TShape extends M3LProcedureShape>(
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  context: M3LProcedureContext<TShape>,
  logger: M3LLogger | undefined,
): Readonly<Record<string, M3LBreadcrumbScalar>> {
  let stepRef = "step";
  try {
    stepRef = `step '${String(step.id)}'`;
    const describeTrace = step.describeTrace;
    if (describeTrace === undefined) return {};
    const described: unknown = describeTrace(context);
    return isPlainObject(described)
      ? (described as Readonly<Record<string, M3LBreadcrumbScalar>>)
      : {};
  } catch (error) {
    warnTracingFailure(logger, stepRef, error);
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
 * Sanitizes `extra` (the `describeTrace` return) into a genuine
 * breadcrumb-safe payload, dropping any dangerous prototype-pollution key
 * (`__proto__`, `constructor`, `prototype` — see `core/security`'s
 * `isDangerousKey`) and any non-{@link M3LBreadcrumbScalar} value — every
 * property read on `extra`, including a hostile getter, happens here, inside
 * the caller's guarded `try` (see {@link recordStep}), so a throwing
 * accessor can never escape unguarded. The result becomes the retained
 * {@link M3LProcedureTraceEntry}'s own `payload` field — never stored by
 * reference from the caller's original return.
 */
function sanitizeTraceExtras(
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
): Record<string, M3LBreadcrumbScalar> {
  const sanitized: Record<string, M3LBreadcrumbScalar> = {};
  for (const key of Object.keys(extra)) {
    if (isDangerousKey(key)) continue;
    const value: unknown = extra[key];
    if (isBreadcrumbScalarValue(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Builds the single {@link M3LProcedureTraceEntry} for one step attempt —
 * the ONE projection both the sink payload ({@link flattenEntryForSink}) and
 * the retained `outcome.trace` entry ({@link M3LProcedureTracer.entries})
 * are derived from, so a caller-supplied `describeTrace` is read exactly
 * once per step rather than once per consumer.
 */
function buildTraceEntry<TShape extends M3LProcedureShape>(
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  durationMs: number,
  classification: M3LProcedureStepTraceClassification,
): M3LProcedureTraceEntry {
  return {
    stepId: step.id,
    label: step.label,
    kind: step.kind,
    attempt,
    durationMs,
    failed: classification.failed,
    flow: classification.flow,
    payload: sanitizeTraceExtras(extra),
  };
}

/**
 * Flattens `entry` into the single-level payload `sink.record` expects: the
 * sanitized `describeTrace` extras plus the engine's own scalar fields,
 * applied AFTER the extras so a `describeTrace` return forging e.g.
 * `failed: true` on an otherwise-successful step is overwritten rather than
 * left standing. `flow` is included only when defined — `entry.flow` is
 * already the scalar-or-`undefined` projection {@link projectFlowToScalar}
 * guarantees, so no further allowlist check is needed here.
 */
function flattenEntryForSink(
  entry: M3LProcedureTraceEntry,
): Record<string, M3LBreadcrumbScalar> {
  const payload: Record<string, M3LBreadcrumbScalar> = { ...entry.payload };
  payload["stepId"] = entry.stepId;
  payload["label"] = entry.label;
  payload["kind"] = entry.kind;
  payload["attempt"] = entry.attempt;
  payload["durationMs"] = entry.durationMs;
  payload["failed"] = entry.failed;
  if (entry.flow !== undefined) {
    payload["flow"] = entry.flow;
  } else {
    delete payload["flow"];
  }
  return payload;
}

/**
 * Classifies `result`, builds the one {@link M3LProcedureTraceEntry} for
 * this attempt, retains it on `entries`, and records its flattened form via
 * `sink.record` — guarded independently from the `describeTrace` call above.
 *
 * `classify(result)` is passed through unevaluated and invoked HERE, inside
 * the same `try` that covers building the entry (every property read on
 * `extra`) and the `sink.record` call itself — a throw from `classify`, or
 * from any property read it triggers on `result` (e.g. a hostile `flow.goTo`
 * getter reached through {@link projectFlowToScalar}), is guarded exactly
 * like a hostile `describeTrace` return, so it can never escape unguarded
 * and can never affect the already-settled `result` the caller returns; on
 * such a throw, no entry is pushed at all — both consumers lose the same
 * attempt uniformly, rather than one seeing a partial record the other
 * doesn't.
 *
 * The entry is pushed onto `entries` BEFORE `sink.record` is attempted, so a
 * failing `sink.record` call — warned about below — never discards the
 * entry the outcome's `trace` array will read back.
 *
 * `step.id` is read once into `stepRef`, inside the same `try`, and reused by
 * the `catch` below instead of being re-read there — the warning names the
 * step from a single observation, never a second one that could diverge from
 * (or itself throw independently of) the first.
 */
function recordStep<TShape extends M3LProcedureShape, TResult>(
  sink: M3LProcedureTraceSink,
  source: string,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  attempt: number,
  startedAt: number,
  result: TResult,
  classify: (result: TResult) => M3LProcedureStepTraceClassification,
  entries: M3LProcedureTraceEntry[],
  logger: M3LLogger | undefined,
): void {
  const durationMs = performance.now() - startedAt;
  let stepRef = "step";
  try {
    stepRef = `step '${String(step.id)}'`;
    const classification = classify(result);
    const entry = buildTraceEntry(
      extra,
      step,
      attempt,
      durationMs,
      classification,
    );
    entries.push(entry);
    sink.record(source, STEP_EVENT, flattenEntryForSink(entry));
  } catch (error) {
    warnTracingFailure(logger, stepRef, error);
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
 * guarded exactly the way {@link recordStep} guards its own payload
 * build + record pair, including the same `logger.warning` call on failure —
 * `warnTracingFailure`'s `label` parameter is free-form, so the single
 * per-run outcome event is named `"run outcome"` in place of a step id.
 */
function recordOutcomeEntry<TShape extends M3LProcedureShape>(
  sink: M3LProcedureTraceSink,
  source: string,
  outcome: M3LProcedureOutcome<TShape>,
  logger: M3LLogger | undefined,
): void {
  try {
    const payload = buildOutcomePayload(outcome);
    sink.record(source, OUTCOME_EVENT, payload);
  } catch (error) {
    warnTracingFailure(logger, "run outcome", error);
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
