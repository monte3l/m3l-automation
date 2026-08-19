/**
 * `internal/pipeline/trace` — the per-run phase tracer for
 * `M3LOperationPipeline`, kept separate from the engine class itself so
 * `M3LOperationPipeline.ts` stays lean (the same reason `validate.ts` is
 * separate — see that file's header).
 *
 * Tracing is opt-in and never load-bearing: a throwing `describe` or a
 * throwing `sink.record` is guarded independently and can never change a
 * run's outcome (`docs/reference/core/pipeline.md` § Tracing). The phase
 * body's own settlement (success or throw) is captured before any
 * recording happens, and a failure from recording — anywhere in the
 * `describe`/payload-assembly/`sink.record` chain — can never replace,
 * wrap, or attach a `cause` to the phase's own error.
 *
 * Private to `core/pipeline`; never re-exported through a public barrel.
 */

import { M3L_ERROR_CODES, M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/index.js";
import { isBoolean, isNumber, isString } from "../../core/utils/guards.js";

import type { M3LBreadcrumbScalar } from "../../core/diagnostics/index.js";
import type { M3LLogger } from "../../core/logging/M3LLogger.js";
import type {
  M3LPipelinePhase,
  M3LPipelineTraceOptions,
  M3LPipelineTraceSink,
  M3LPipelineTraceSnapshot,
} from "../../core/pipeline/types.js";

/** The default `source` label passed to `sink.record` when `trace.source` is omitted. */
const DEFAULT_TRACE_SOURCE = "M3LOperationPipeline";

/** The fixed event name every traced phase entry is recorded under. */
const PIPELINE_PHASE_EVENT = "pipeline:phase";

/** The literal logged in place of an error `code` that isn't a recognized `M3LErrorCode`. */
const UNCLASSIFIED_CODE = "unclassified";

/**
 * One phase body's settlement, captured before any tracing side effect runs
 * so recording can never race with, replace, or observe a stale version of
 * the outcome {@link M3LPipelinePhaseTracer.run} ultimately returns/throws.
 */
type PhaseOutcome<TResult> =
  | { readonly ok: true; readonly value: TResult }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runs `body` and captures its settlement — success or throw — as a plain
 * value, without recording anything. Isolated in its own function (rather
 * than inlined in `run`) so the generic result type is inferred from `body`
 * itself instead of needing to be named at the call site.
 */
async function captureOutcome<TResult>(
  body: () => TResult | Promise<TResult>,
): Promise<PhaseOutcome<TResult>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Per-run phase tracer used internally by `M3LOperationPipeline.run`. One
 * instance is built fresh per `run()` call (never stored on the engine
 * instance), so all per-run tracing state — if any is ever added — lives in
 * that call's own frame, matching the engine's documented statelessness
 * across runs and safety under concurrent `run()` calls.
 *
 * Every `run` call wraps one phase's body: it captures a `describe` snapshot
 * at entry, times the body via `performance.now()`, and records exactly one
 * `"pipeline:phase"` entry at exit — on success or on throw. The phase's own
 * error, if any, always propagates unmodified; only the tracing side effects
 * (the `describe` call and the `sink.record` call) are guarded.
 */
export interface M3LPipelinePhaseTracer<
  TOp extends string,
  TSettings extends object,
  TContext,
> {
  /**
   * Runs `body`, recording one `"pipeline:phase"` entry for `phase` (or,
   * when tracing is not configured, simply invoking `body` with no timing
   * work and no sink interaction at all).
   *
   * @param phase - The phase name recorded as the entry's `phase` key.
   * @param snapshot - Builds the phase's entry-time snapshot; called once,
   *   before `body` runs, only when a `describe` callback is configured.
   * @param operationForPayload - Reads the operation to attach to the
   *   recorded payload. Called AFTER `body` settles (success or throw), so
   *   the `"operation"` phase's own exit payload can carry the value its own
   *   body just resolved, even though that value was absent from its
   *   entry-time snapshot.
   * @param body - The phase's actual work.
   * @returns Whatever `body` resolves.
   * @throws Whatever `body` throws, unmodified — captured before recording
   *   runs, so a tracing failure at record time never replaces, wraps, or
   *   attaches a `cause` to it. The failing phase's entry is still recorded
   *   (with `failed: true`) before the error propagates.
   */
  run<TResult>(
    phase: M3LPipelinePhase,
    snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
    operationForPayload: () => TOp | undefined,
    body: () => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

/**
 * Builds the tracer for one `M3LOperationPipeline.run` call.
 *
 * When `options` is `undefined`, every {@link M3LPipelinePhaseTracer.run}
 * call degrades to invoking `body` directly: no `performance.now()` call, no
 * `describe` invocation, no `sink` interaction — behavior is byte-identical
 * to a pipeline without the `trace` option at all.
 *
 * @param options - The pipeline's `trace` option, or `undefined`.
 * @param logger - The run's logger, used only to warn on a guarded tracing
 *   failure; never called when `options` is `undefined`.
 */
export function createPipelinePhaseTracer<
  TOp extends string,
  TSettings extends object,
  TContext,
>(
  options: M3LPipelineTraceOptions<TOp, TSettings, TContext> | undefined,
  logger: M3LLogger,
): M3LPipelinePhaseTracer<TOp, TSettings, TContext> {
  if (options === undefined) {
    return {
      run(_phase, _snapshot, _operationForPayload, body) {
        return Promise.resolve(body());
      },
    };
  }

  const source = options.source ?? DEFAULT_TRACE_SOURCE;
  const describe = options.describe;
  const sink = options.sink;

  return {
    async run(phase, snapshot, operationForPayload, body) {
      const extra = safeDescribe(describe, phase, snapshot, logger);
      const start = performance.now();
      const outcome = await captureOutcome(body);

      // Recorded exactly once, whichever branch above ran — a record-time
      // failure is fully guarded inside recordPhase and can never reach
      // here, so it can never pre-empt the `throw outcome.error` below.
      recordPhase(
        sink,
        source,
        phase,
        extra,
        start,
        operationForPayload(),
        logger,
        !outcome.ok,
      );

      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
  };
}

/**
 * Invokes `describe` (when configured) with `phase`'s entry-time snapshot,
 * guarded independently from the eventual `sink.record` call. A throw is
 * warned about (naming the phase and, when classifiable, the error's `code`
 * — never its `message` or `name`) and degrades to an empty extra-keys
 * record — it never affects the phase's own outcome.
 *
 * `snapshot()` itself runs OUTSIDE the `try`: it is the engine's own
 * closure, not caller-supplied, so a bug in it must surface as a real
 * failure rather than being silently swallowed and misreported as
 * `describe` having thrown.
 */
function safeDescribe<TOp extends string, TSettings extends object, TContext>(
  describe: M3LPipelineTraceOptions<TOp, TSettings, TContext>["describe"],
  phase: M3LPipelinePhase,
  snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
  logger: M3LLogger,
): Readonly<Record<string, M3LBreadcrumbScalar>> {
  if (describe === undefined) return {};
  const snap = snapshot();
  try {
    return describe(phase, snap);
  } catch (error) {
    warnTracingFailure(logger, phase, error);
    return {};
  }
}

/**
 * Narrows `value` to an {@link M3LBreadcrumbScalar} — the runtime
 * enforcement of the type-level pinning `describe`'s return type declares.
 * A JavaScript caller (or a TypeScript assertion) can still construct a
 * payload holding a nested object, array, function, `Date`, or `Buffer`;
 * without this check, a bare `record()`-shaped sink would receive such a
 * value by reference, letting a later caller-side mutation change what a
 * deferred sink serializes.
 */
function isBreadcrumbScalarValue(value: unknown): value is M3LBreadcrumbScalar {
  return (
    value === null || isString(value) || isNumber(value) || isBoolean(value)
  );
}

/**
 * Projects `extra` (the `describe` return) plus the engine's own
 * `phase`/`operation`/`durationMs`/`failed` keys into the payload recorded
 * for one phase.
 *
 * Every property read on `extra` — including a hostile getter — happens
 * here, inside the caller's guarded `try` (see {@link recordPhase}), so a
 * throwing accessor can never escape unguarded. Each `extra` key is kept
 * only when both:
 * - it is not a dangerous prototype-pollution key (`__proto__`,
 *   `constructor`, `prototype` — see `core/security`'s `isDangerousKey`),
 *   and
 * - its value is a genuine {@link M3LBreadcrumbScalar}; anything else
 *   (object, array, function, `Date`, `Buffer`, …) is dropped rather than
 *   stored by reference.
 *
 * The engine's own four keys are then applied AFTER `extra` and each is
 * explicitly set-or-deleted (never merely conditionally spread) — a
 * `describe` return that forges `failed: true` on an otherwise-successful
 * phase, or a stray `operation` on the `"accessor"` phase, is removed
 * rather than left standing.
 */
function buildPhasePayload(
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  phase: M3LPipelinePhase,
  operation: string | undefined,
  durationMs: number,
  failed: boolean,
): Record<string, M3LBreadcrumbScalar> {
  const payload: Record<string, M3LBreadcrumbScalar> = {};
  for (const key of Object.keys(extra)) {
    if (isDangerousKey(key)) continue;
    const value: unknown = extra[key];
    if (isBreadcrumbScalarValue(value)) {
      payload[key] = value;
    }
  }
  payload["phase"] = phase;
  if (operation === undefined) {
    delete payload["operation"];
  } else {
    payload["operation"] = operation;
  }
  payload["durationMs"] = durationMs;
  if (failed) {
    payload["failed"] = true;
  } else {
    delete payload["failed"];
  }
  return payload;
}

/**
 * Assembles one phase's payload and records it via `sink.record`, guarded
 * independently from the `describe` call above.
 *
 * Building the payload (every property read on `extra`) and calling
 * `sink.record` are covered by the SAME `try` — a hostile `describe` return
 * (e.g. a throwing getter) is only ever read here, never before this guard,
 * so it can never escape unguarded regardless of whether the phase's own
 * body succeeded or threw.
 */
function recordPhase(
  sink: M3LPipelineTraceSink,
  source: string,
  phase: M3LPipelinePhase,
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  startedAt: number,
  operation: string | undefined,
  logger: M3LLogger,
  failed = false,
): void {
  const durationMs = performance.now() - startedAt;
  try {
    const payload = buildPhasePayload(
      extra,
      phase,
      operation,
      durationMs,
      failed,
    );
    sink.record(source, PIPELINE_PHASE_EVENT, payload);
  } catch (error) {
    warnTracingFailure(logger, phase, error);
  }
}

/**
 * Classifies a tracing failure's `code` for the warning message, allowlisted
 * against {@link M3L_ERROR_CODES} rather than echoed verbatim: `error.code`
 * is caller-controlled (it comes from a `describe`/`sink.record` a caller
 * configured), so an unrecognized or invented code must not reach the log.
 * Reading `.code` itself is guarded — a hostile `code` getter must not
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
 * Logs a `logger.warning` naming `phase` and, when classifiable, the
 * failure's `M3LError` `code` — allowlisted against {@link M3L_ERROR_CODES}
 * so a caller-invented code can never be echoed. The error's `name` and
 * `message` are never logged: both can embed caller data (mirrors
 * `breadcrumbs.ts`'s `import:error` summarizer, which withholds
 * `errorMessage` for the same reason). The logger call itself is guarded so
 * a failing logger cannot escalate a tracing failure into a run failure.
 */
function warnTracingFailure(
  logger: M3LLogger,
  phase: M3LPipelinePhase,
  error: unknown,
): void {
  const detail = classifyTracingFailureCode(error);
  try {
    logger.warning(
      `M3LOperationPipeline: tracing failed at phase '${phase}' (${detail})`,
    );
  } catch {
    // Best-effort: tracing must never affect the run outcome, so a failing
    // logger call is swallowed rather than propagated.
  }
}
