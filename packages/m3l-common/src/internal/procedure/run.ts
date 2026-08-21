/**
 * `internal/procedure/run` — the entry point `M3LProcedure.run()` delegates
 * to once option validation has passed: runs all three phases and resolves
 * the outcome.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { createInitialContext } from "./context.js";
import { checkAbortBoundary } from "./guards.js";
import { runPhaseOne, toConditionScope } from "./run-loop.js";
import { createProcedureTracer } from "./trace.js";
import {
  buildAbortedOutcome,
  buildFailedOutcome,
  conclude,
  evaluateCases,
  toAbortedPhaseOne,
} from "./outcome.js";

import type { M3LLogger } from "../../core/logging/index.js";
import type {
  M3LProcedureOutcome,
  M3LProcedureTraceOptions,
} from "../../core/procedure/run-types.js";
import type { M3LProcedureShape } from "../../core/procedure/types.js";
import type { CapturedProgressConfig } from "./progress.js";
import type {
  PhaseOneAccumulated,
  PhaseOneOutcome,
  ProcedureRuntime,
} from "./run-state.js";
import type { M3LProcedureTracer } from "./trace.js";

/**
 * The already-validated, capture-by-value pieces {@link executeProcedureRun}
 * needs from `run()`'s options — every field here is what `run-options.ts`'s
 * `validateRunOptions` (for `maxIterations`/`parameters`/`initialValues`/
 * `progress`) already resolved, plus `deps`/`signal`/`trace`/`logger` passed
 * through unchanged.
 */
export interface ExecuteProcedureRunInput<TShape extends M3LProcedureShape> {
  readonly deps: TShape["deps"];
  readonly signal: AbortSignal | undefined;
  readonly maxIterations: number;
  readonly parameters: Readonly<TShape["parameters"]>;
  readonly initialValues: Readonly<Partial<TShape["values"]>>;
  readonly trace: M3LProcedureTraceOptions | undefined;
  readonly logger: M3LLogger | undefined;
  readonly progress: CapturedProgressConfig<TShape> | undefined;
}

/**
 * Shared boundary check used both before phase 2 and before phase 3: when
 * `phaseOne.context.signal` has already fired, assembles the `"aborted"`
 * outcome (`abortedAt: undefined` — phase 1 has already concluded, so there
 * is no next step boundary left to name) and returns it; otherwise returns
 * `undefined` so the caller keeps going.
 */
function checkAbortBeforePhase<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  phaseOne: PhaseOneAccumulated<TShape>,
  startedAt: string,
  startedAtMs: number,
  tracer: M3LProcedureTracer<TShape>,
): M3LProcedureOutcome<TShape> | undefined {
  const abortError = checkAbortBoundary(phaseOne.context.signal);
  if (abortError === undefined) return undefined;
  return buildAbortedOutcome(
    runtime,
    digest,
    toAbortedPhaseOne(phaseOne, abortError),
    startedAt,
    startedAtMs,
    tracer,
  );
}

/**
 * Runs phases 2 (case evaluation) and 3 (the concluding action) once phase 1
 * has concluded via `"ended"` or `"matched"` — extracted purely to keep
 * {@link executeProcedureRun} under its line budget.
 */
async function runRemainingPhases<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  phaseOne: Extract<
    PhaseOneOutcome<TShape>,
    { kind: "ended" } | { kind: "matched" }
  >,
  startedAt: string,
  startedAtMs: number,
  tracer: M3LProcedureTracer<TShape>,
): Promise<M3LProcedureOutcome<TShape>> {
  // Boundary check before phase 2 (case evaluation): `abortedAt` is
  // `undefined` here — phase 1 has already concluded, so there is no next
  // step boundary left to name.
  const preCases = checkAbortBeforePhase(
    runtime,
    digest,
    phaseOne,
    startedAt,
    startedAtMs,
    tracer,
  );
  if (preCases !== undefined) return preCases;

  const pass =
    phaseOne.kind === "matched"
      ? phaseOne.pass
      : evaluateCases(runtime, toConditionScope(phaseOne.context));
  const earlyResolved = phaseOne.kind === "matched";

  // Boundary check before phase 3 (the concluding action).
  const preConclude = checkAbortBeforePhase(
    runtime,
    digest,
    phaseOne,
    startedAt,
    startedAtMs,
    tracer,
  );
  if (preConclude !== undefined) return preConclude;

  return conclude(
    runtime,
    digest,
    phaseOne,
    pass,
    earlyResolved,
    startedAt,
    startedAtMs,
    tracer,
  );
}

/**
 * Assembles the outcome for phase 1 concluding via an unabsorbed step
 * failure or an already-fired abort.
 */
function finishEarlyPhaseOne<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  phaseOne: Extract<
    PhaseOneOutcome<TShape>,
    { kind: "failed" } | { kind: "aborted" }
  >,
  startedAt: string,
  startedAtMs: number,
  tracer: M3LProcedureTracer<TShape>,
): M3LProcedureOutcome<TShape> {
  return phaseOne.kind === "failed"
    ? buildFailedOutcome(
        runtime,
        digest,
        phaseOne,
        startedAt,
        startedAtMs,
        tracer,
      )
    : buildAbortedOutcome(
        runtime,
        digest,
        phaseOne,
        startedAt,
        startedAtMs,
        tracer,
      );
}

/**
 * Runs the three-phase contract — steps, cases, conclusion — and resolves
 * the outcome. Only ever called once `M3LProcedure.run()`'s synchronous
 * option validation has already passed.
 *
 * @param runtime - The procedure's frozen step/case/fallback table.
 * @param digest - `M3LProcedure.digest`, copied onto every outcome.
 * @param input - The validated, capture-by-value run inputs.
 * @returns The resolved outcome. Only a throw from a case action or the
 *   fallback action propagates unmodified — everything else resolves.
 */
export async function executeProcedureRun<TShape extends M3LProcedureShape>(
  runtime: ProcedureRuntime<TShape>,
  digest: string,
  input: ExecuteProcedureRunInput<TShape>,
): Promise<M3LProcedureOutcome<TShape>> {
  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();
  const tracer = createProcedureTracer<TShape>(input.trace, input.logger);

  const initialContext = createInitialContext<TShape>({
    deps: input.deps,
    parameters: input.parameters,
    initialValues: input.initialValues,
    signal: input.signal,
  });

  const phaseOne = await runPhaseOne(
    runtime,
    initialContext,
    input.maxIterations,
    tracer,
    input.progress,
  );

  const outcome =
    phaseOne.kind === "failed" || phaseOne.kind === "aborted"
      ? finishEarlyPhaseOne(
          runtime,
          digest,
          phaseOne,
          startedAt,
          startedAtMs,
          tracer,
        )
      : await runRemainingPhases(
          runtime,
          digest,
          phaseOne,
          startedAt,
          startedAtMs,
          tracer,
        );

  tracer.recordOutcome(outcome);
  return outcome;
}
