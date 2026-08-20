/**
 * `internal/procedure/context` — the only producers of a
 * {@link M3LProcedureContext}: `createInitialContext` builds the very first
 * context a run's first step receives, and `deriveContext` folds one step's
 * returned patch into the next.
 *
 * `docs/reference/core/procedure.md` § Context states the guarantee this
 * module exists to enforce structurally, not just document: a step returns a
 * *patch*, never a context, and no constructor/factory/`with*` method for
 * `M3LProcedureContext` exists in the public surface. Both functions here
 * `Object.freeze` their result — the context object itself and its
 * `results`/`values`/`parameters`/`recovered` containers — so a step cannot
 * mutate what it was handed. `Object.freeze` is shallow: the values *inside*
 * those containers are not deep-frozen, and `deps` is never frozen or
 * replaced — it is the same reference for the whole run.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3L_RECOVERY_LIMIT } from "../../core/diagnostics/index.js";

import type { M3LRunRecoveryEntry } from "../../core/diagnostics/index.js";
import type {
  M3LProcedureContext,
  M3LProcedureShape,
  M3LProcedureStepRecord,
} from "../../core/procedure/types.js";

/**
 * The inputs {@link createInitialContext} needs to build a run's first
 * context. `parameters` and `initialValues` are already the fresh, one-read
 * copies `M3LProcedure.run()` produced — this module only freezes them, it
 * never re-reads a caller-supplied object.
 */
export interface InitialContextInput<TShape extends M3LProcedureShape> {
  readonly deps: TShape["deps"];
  readonly parameters: TShape["parameters"];
  readonly initialValues: Readonly<Partial<TShape["values"]>>;
  readonly signal: AbortSignal | undefined;
}

/**
 * Builds the frozen context a run's first step receives: empty `results`,
 * `values` seeded from `initialValues`, zero `recovered`/`recoveredTotal`,
 * and `iteration: 0`.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @param input - The run's `deps`, already-copied `parameters`, already-copied
 *   `initialValues`, and `signal`.
 * @returns The frozen initial context.
 */
export function createInitialContext<TShape extends M3LProcedureShape>(
  input: InitialContextInput<TShape>,
): M3LProcedureContext<TShape> {
  return Object.freeze({
    deps: input.deps,
    results: Object.freeze({}),
    values: Object.freeze({ ...input.initialValues }),
    parameters: Object.freeze({
      ...input.parameters,
    }),
    recovered: Object.freeze([]),
    recoveredTotal: 0,
    signal: input.signal,
    iteration: 0,
  });
}

/**
 * One step execution's contribution to the next context: the step id it
 * ran under, the {@link M3LProcedureStepRecord} to record (overwriting any
 * prior record under the same id, on a revisit), an optional `values` patch
 * (merged shallowly, last-write-wins, omitted keys untouched), and an
 * optional recovery entry when the execution was absorbed via
 * `continueOnFailure`.
 */
export interface ContextPatchInput<TShape extends M3LProcedureShape> {
  readonly stepId: TShape["stepId"];
  readonly record: M3LProcedureStepRecord;
  readonly values?: Readonly<Partial<TShape["values"]>>;
  readonly recoveryEntry?: M3LRunRecoveryEntry;
}

/** Appends `entry` (when present) to `previous`, trimming to {@link M3L_RECOVERY_LIMIT} with the oldest evicted, and returns the true, uncapped total. */
function appendRecovery(
  previous: readonly M3LRunRecoveryEntry[],
  previousTotal: number,
  entry: M3LRunRecoveryEntry | undefined,
): {
  readonly recovered: readonly M3LRunRecoveryEntry[];
  readonly recoveredTotal: number;
} {
  if (entry === undefined) {
    return { recovered: previous, recoveredTotal: previousTotal };
  }
  const appended = [...previous, entry];
  const recovered =
    appended.length > M3L_RECOVERY_LIMIT
      ? appended.slice(appended.length - M3L_RECOVERY_LIMIT)
      : appended;
  return { recovered, recoveredTotal: previousTotal + 1 };
}

/**
 * Derives the next frozen context from `previous` and one step's
 * {@link ContextPatchInput}. This is the engine's one call site for
 * "producing a context": `previous` itself is never mutated, and the object
 * returned is a distinct, frozen instance — `deps`, `parameters` and
 * `signal` carry over by reference unchanged; `iteration` counts one higher.
 *
 * @typeParam TShape - The procedure's declared shape.
 * @param previous - The context the executing step received.
 * @param patch - That step's contribution.
 * @returns The frozen context the next step (or the case-evaluation phase)
 *   receives.
 */
export function deriveContext<TShape extends M3LProcedureShape>(
  previous: M3LProcedureContext<TShape>,
  patch: ContextPatchInput<TShape>,
): M3LProcedureContext<TShape> {
  const results: Partial<Record<TShape["stepId"], M3LProcedureStepRecord>> = {
    ...previous.results,
    [patch.stepId]: patch.record,
  };
  const values: Partial<TShape["values"]> = {
    ...previous.values,
    ...patch.values,
  };
  const { recovered, recoveredTotal } = appendRecovery(
    previous.recovered,
    previous.recoveredTotal,
    patch.recoveryEntry,
  );

  return Object.freeze({
    deps: previous.deps,
    results: Object.freeze(results),
    values: Object.freeze(values),
    parameters: previous.parameters,
    recovered: Object.freeze(recovered),
    recoveredTotal,
    signal: previous.signal,
    iteration: previous.iteration + 1,
  });
}
