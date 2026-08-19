/**
 * `internal/pipeline/trace` — the per-run phase tracer for
 * `M3LOperationPipeline`, kept separate from the engine class itself so
 * `M3LOperationPipeline.ts` stays lean (the same reason `validate.ts` is
 * separate — see that file's header).
 *
 * Tracing is opt-in and never load-bearing: a throwing `describe` or a
 * throwing `sink.record` is guarded independently and can never change a
 * run's outcome (`docs/reference/core/pipeline.md` § Tracing).
 *
 * Private to `core/pipeline`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";

import type { M3LBreadcrumbScalar } from "../../core/diagnostics/index.js";
import type { M3LLogger } from "../../core/logging/M3LLogger.js";
import type {
  M3LPipelinePhase,
  M3LPipelineTraceOptions,
  M3LPipelineTraceSnapshot,
} from "../../core/pipeline/types.js";

/** The default `source` label passed to `sink.record` when `trace.source` is omitted. */
const DEFAULT_TRACE_SOURCE = "M3LOperationPipeline";

/** The fixed event name every traced phase entry is recorded under. */
const PIPELINE_PHASE_EVENT = "pipeline:phase";

/**
 * The subset of {@link M3LPipelineTraceOptions.sink} a recording helper
 * needs — independent of `TOp`/`TSettings`/`TContext` since `sink.record`'s
 * own signature never depends on them.
 */
interface PhaseSink {
  record(source: string, event: string, payload?: unknown): void;
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
   * @throws Whatever `body` throws, unmodified. The failing phase's entry is
   *   still recorded (with `failed: true`) before the error propagates.
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
      try {
        const result = await body();
        recordPhase(
          sink,
          source,
          phase,
          extra,
          start,
          operationForPayload(),
          logger,
        );
        return result;
      } catch (error) {
        recordPhase(
          sink,
          source,
          phase,
          extra,
          start,
          operationForPayload(),
          logger,
          true,
        );
        throw error;
      }
    },
  };
}

/**
 * Invokes `describe` (when configured) with `phase`'s entry-time snapshot,
 * guarded independently from the eventual `sink.record` call. A throw is
 * warned about (naming the phase and the error's `name`/`code`, never its
 * `message`) and degrades to an empty extra-keys record — it never affects
 * the phase's own outcome.
 */
function safeDescribe<TOp extends string, TSettings extends object, TContext>(
  describe: M3LPipelineTraceOptions<TOp, TSettings, TContext>["describe"],
  phase: M3LPipelinePhase,
  snapshot: () => M3LPipelineTraceSnapshot<TOp, TSettings, TContext>,
  logger: M3LLogger,
): Readonly<Record<string, M3LBreadcrumbScalar>> {
  if (describe === undefined) return {};
  try {
    return describe(phase, snapshot());
  } catch (error) {
    warnTracingFailure(logger, phase, error);
    return {};
  }
}

/**
 * Assembles one phase's payload and records it via `sink.record`, guarded
 * independently from the `describe` call above.
 *
 * The engine's own `phase`/`operation`/`durationMs`/`failed` keys are applied
 * AFTER `extra` and each is explicitly set-or-deleted (never merely
 * conditionally spread) — a `describe` return that forges `failed: true` on
 * an otherwise-successful phase, or a stray `operation` on the `"accessor"`
 * phase, is removed rather than left standing.
 */
function recordPhase(
  sink: PhaseSink,
  source: string,
  phase: M3LPipelinePhase,
  extra: Readonly<Record<string, M3LBreadcrumbScalar>>,
  startedAt: number,
  operation: string | undefined,
  logger: M3LLogger,
  failed = false,
): void {
  const durationMs = performance.now() - startedAt;
  const payload: Record<string, M3LBreadcrumbScalar> = { ...extra };
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
  try {
    sink.record(source, PIPELINE_PHASE_EVENT, payload);
  } catch (error) {
    warnTracingFailure(logger, phase, error);
  }
}

/**
 * Logs a `deps.logger.warning` naming `phase` and the failure's `name`/`code`
 * — never its `message`, which can embed caller data (mirrors
 * `breadcrumbs.ts`'s `import:error` summarizer, which withholds
 * `errorMessage` for the same reason). The logger call itself is guarded so
 * a failing logger cannot escalate a tracing failure into a run failure.
 */
function warnTracingFailure(
  logger: M3LLogger,
  phase: M3LPipelinePhase,
  error: unknown,
): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = error instanceof M3LError ? error.code : undefined;
  const detail = code === undefined ? name : `${name}, ${code}`;
  try {
    logger.warning(
      `M3LOperationPipeline: tracing failed at phase '${phase}' (${detail})`,
    );
  } catch {
    // Best-effort: tracing must never affect the run outcome, so a failing
    // logger call is swallowed rather than propagated.
  }
}
