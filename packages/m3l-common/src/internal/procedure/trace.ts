/**
 * `internal/procedure/trace` — the per-run step tracer for
 * `M3LProcedure.run`, kept separate from the run loop itself so
 * `run-loop.ts` stays focused on control flow.
 *
 * Tracing is opt-in and never load-bearing: a throwing `describeTrace` or a
 * throwing `sink.record` is guarded independently (`trace-payload.ts`) and
 * can never change a run's outcome (`docs/reference/core/procedure.md` §
 * Tracing). Modeled on `internal/pipeline/trace.ts`'s structure/guarding
 * style, but this is a **separate** declaration — its vocabulary
 * (`stepId`/`kind`/`procedure:step`), its `failed`-always-present payload
 * shape, and its optional (rather than required) `logger` parameter are all
 * `core/procedure`'s own, not a reuse of the pipeline's types.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import {
  recordOutcomeEntry,
  recordStep,
  safeDescribeStep,
  warnTracingFailure,
} from "./trace-payload.js";

import type { M3LLogger } from "../../core/logging/index.js";
import type { TracingFailureReporter } from "./trace-payload.js";
import type {
  M3LProcedureOutcome,
  M3LProcedureTraceEntry,
  M3LProcedureTraceOptions,
} from "../../core/procedure/run-types.js";
import type {
  M3LProcedureContext,
  M3LProcedureFlow,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";

/** The default `source` label passed to `sink.record` when `trace.source` is omitted. */
const DEFAULT_TRACE_SOURCE = "M3LProcedure";

/**
 * What one step execution's result classifies to for tracing purposes: was
 * it a clean success (`failed: false`, carrying the step's own projected
 * `flow`) or one of the four "not a clean success" cases the contract
 * treats identically (`failed: true`, `flow: undefined`) — an unabsorbed
 * throw, an absorbed `continueOnFailure` throw (with or without `loop`), or
 * a malformed result.
 */
export interface M3LProcedureStepTraceClassification {
  readonly failed: boolean;
  readonly flow: M3LProcedureTraceEntry["flow"];
}

/**
 * Projects an engine-produced flow directive to the scalar form a trace
 * entry carries: `"continue"`/`"stop"`/`"resolve"` pass through verbatim; a
 * `{ goTo }` object becomes the string `goTo:` followed by the jump target.
 *
 * This is fed ONLY the engine's own already-validated/synthesized flow —
 * never raw caller data — so the `undefined` fallback below is purely
 * defensive (unreachable for any directive `step-exec.ts` can actually
 * produce), not a caller-facing validation branch.
 *
 * @example
 * ```ts
 * import type { Core } from "@m3l-automation/m3l-common";
 * declare function projectFlowToScalar(
 *   flow: Core.M3LProcedureFlow<string>,
 * ): "continue" | "stop" | "resolve" | `goTo:${string}` | undefined;
 * ```
 */
export function projectFlowToScalar(
  flow: M3LProcedureFlow<string>,
): M3LProcedureTraceEntry["flow"] {
  if (flow === "continue" || flow === "stop" || flow === "resolve") {
    return flow;
  }
  if (
    typeof flow === "object" &&
    flow !== null &&
    typeof flow.goTo === "string"
  ) {
    return `goTo:${flow.goTo}`;
  }
  return undefined;
}

/**
 * Per-run step tracer used internally by `M3LProcedure.run`. One instance
 * is built fresh per `run()` call (never stored on the engine instance).
 */
export interface M3LProcedureTracer<TShape extends M3LProcedureShape> {
  /**
   * Runs `body` (one step's execution), recording one `"procedure:step"`
   * entry classified via `classify` — or, when tracing is not configured,
   * simply invoking `body` with no timing work and no sink interaction.
   *
   * @param step - The step about to execute; its `describeTrace` (if
   *   declared) is invoked with `context` BEFORE `body` runs.
   * @param context - The context `body`'s underlying `step.execute` is
   *   about to receive.
   * @param attempt - This step's 1-based attempt number.
   * @param body - The step's actual execution.
   * @param classify - Classifies `body`'s resolved result into
   *   `failed`/`flow`.
   * @returns Whatever `body` resolves.
   */
  runStep<TResult>(
    step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
    context: M3LProcedureContext<TShape>,
    attempt: number,
    body: () => Promise<TResult>,
    classify: (result: TResult) => M3LProcedureStepTraceClassification,
  ): Promise<TResult>;

  /** Records the `"procedure:outcome"` event for the resolved `outcome`. */
  recordOutcome(outcome: M3LProcedureOutcome<TShape>): void;

  /** The retained per-step trace, in execution order. */
  entries(): readonly M3LProcedureTraceEntry[];
}

/**
 * Builds the tracer for one `M3LProcedure.run` call.
 *
 * When `options` is `undefined`, every {@link M3LProcedureTracer.runStep}
 * call degrades to invoking `body` directly: no `performance.now()` call,
 * no `describeTrace` invocation, no `sink` interaction — behavior is
 * byte-identical to a run without the `trace` option at all.
 * {@link M3LProcedureTracer.recordOutcome} is then a no-op and
 * {@link M3LProcedureTracer.entries} always returns `[]`.
 *
 * @param options - The run's `trace` option, or `undefined`.
 * @param logger - The run's `logger` option, used only to warn on a guarded
 *   tracing failure; never called when `options` is `undefined`.
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
        // No-op: tracing is not configured for this run.
      },
      entries() {
        return [];
      },
    };
  }

  const source = options.source ?? DEFAULT_TRACE_SOURCE;
  const sink = options.sink;
  const entries: M3LProcedureTraceEntry[] = [];

  // Bounds the number of `logger.warning` calls to at most one per run,
  // regardless of how many distinct tracing failures occur (a broken
  // `describeTrace`/`sink` across many steps, plus a failing outcome
  // record) — a persistently broken tracing configuration must not spam
  // the log once per step.
  let hasWarned = false;
  const reportFailure: TracingFailureReporter = (label, error) => {
    if (hasWarned) return;
    hasWarned = true;
    warnTracingFailure(logger, label, error);
  };

  return {
    async runStep(step, context, attempt, body, classify) {
      const extras = safeDescribeStep(step, context, reportFailure);
      const startedAt = performance.now();
      const result = await body();
      recordStep(
        entries,
        source,
        sink,
        reportFailure,
        step,
        attempt,
        startedAt,
        extras,
        result,
        classify,
      );
      return result;
    },
    recordOutcome(outcome) {
      recordOutcomeEntry(source, sink, reportFailure, outcome);
    },
    entries() {
      return [...entries];
    },
  };
}
