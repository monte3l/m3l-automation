/**
 * `internal/procedure/step-exec` — executes one step against a context and
 * folds the result into a {@link StepExecutionOutcome}.
 *
 * `docs/reference/core/procedure.md` § Phase 1 step 5 draws a hard line
 * between a step's `execute` **throwing** (absorbable via
 * `continueOnFailure`) and `execute` **resolving with a malformed result**
 * (an engine-level contract violation, never absorbed — "absorbing it would
 * let a step's own implementation bug masquerade as an ordinary, expected
 * failure"). `executeOneStep` is written so that distinction is
 * structural, not incidental: the try/catch around the awaited
 * `step.execute(context)` call wraps ONLY the call itself, and the settled
 * result's `flow` is shape-checked (via `flow.ts`'s `classifyFlowShape`,
 * which never throws for any input) strictly AFTER that try/catch has
 * already exited — so a missing/malformed `flow` can never reach the same
 * catch block that absorbs a genuine throw, regardless of the step's own
 * `continueOnFailure` declaration.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { serializeErrorChain } from "../../core/diagnostics/index.js";
import { M3LOperationAbortedError } from "../../core/errors/M3LOperationAbortedError.js";
import { isPlainObject, isString } from "../../core/utils/guards.js";

import { deriveContext } from "./context.js";
import { classifyFlowShape } from "./flow.js";
import { isAborted } from "./guards.js";
import { M3LProcedureUndeclaredJumpError } from "./errors.js";

import type { M3LRunRecoveryEntry } from "../../core/diagnostics/index.js";
import type {
  M3LProcedureContext,
  M3LProcedureFlow,
  M3LProcedureStep,
} from "../../core/procedure/step-types.js";
import type {
  M3LProcedureShape,
  M3LProcedureStepRecord,
  M3LProcedureValue,
} from "../../core/procedure/types.js";
import type { FlowShape } from "./flow.js";
import type { StepExecutionOutcome } from "./run-state.js";

/**
 * True when `error` carries the stable `"ERR_OPERATION_ABORTED"` code.
 * Checked by `code`, never `instanceof M3LOperationAbortedError` — a step
 * that throws a plain `M3LError` (or any object) carrying this code is still
 * recognised as an abort, matching the discrimination rule the rest of the
 * engine's abort handling uses.
 */
function isAbortErrorCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code: unknown }).code === "ERR_OPERATION_ABORTED"
  );
}

function buildRecord<TShape extends M3LProcedureShape>(
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  status: M3LProcedureStepRecord["status"],
  output: M3LProcedureStepRecord["output"],
  note: M3LProcedureStepRecord["note"],
  durationMs: number,
): M3LProcedureStepRecord {
  return {
    id: step.id,
    label: step.label,
    kind: step.kind,
    status,
    attempt,
    output,
    note,
    durationMs,
  };
}

/**
 * The small, local, fully-validated projection a step's resolved result is
 * reduced to by {@link validateStepResult} — a single guarded pass that reads
 * `flow`/`output`/`note`/`values` exactly once each. `advanceFromResult`
 * consumes only this projection, never the raw `unknown` result, so a
 * hostile getter that returns a different value on a second read can never
 * make the classification decision and the actually-used value disagree.
 */
interface ValidatedStepResult<TShape extends M3LProcedureShape> {
  readonly flowShape: FlowShape;
  readonly output: M3LProcedureValue | undefined;
  readonly note: string | undefined;
  readonly values: Readonly<Partial<TShape["values"]>> | undefined;
}

/**
 * True unless `value` could never plausibly be an {@link M3LProcedureValue} —
 * a function, a `Symbol`, or a `BigInt`. Deliberately shallow: this validates
 * one step's own single output value, not a nested caller structure like
 * `parameters`, so a full recursive check is unnecessary here.
 */
function isPlausibleStepOutput(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value !== "function" &&
      typeof value !== "symbol" &&
      typeof value !== "bigint")
  );
}

/**
 * Validates `result` in ONE guarded pass: `result` must be a plain object,
 * and reading its `flow`/`output`/`note`/`values` properties must not throw
 * (a hostile getter on any of them is caught here, not on a later, separate
 * read). `flow` is classified via `flow.ts`'s `classifyFlowShape`; `note`
 * must be `undefined` or a `string`; `values` must be `undefined` or a plain
 * object; `output` must pass {@link isPlausibleStepOutput}. Any failure —
 * malformed shape, an unreadable property, or an invalid value — returns
 * `undefined` uniformly; the caller folds all of them into the SAME
 * `ERR_PROCEDURE_UNDECLARED_JUMP` failure, never absorbed by
 * `continueOnFailure`.
 */
function validateStepResult<TShape extends M3LProcedureShape>(
  result: unknown,
): ValidatedStepResult<TShape> | undefined {
  if (!isPlainObject(result)) return undefined;

  let flowValue: unknown;
  let output: unknown;
  let note: unknown;
  let values: unknown;
  try {
    flowValue = result["flow"];
    output = result["output"];
    note = result["note"];
    values = result["values"];
  } catch {
    return undefined;
  }

  const flowShape = classifyFlowShape(flowValue);
  if (flowShape === undefined) return undefined;
  if (note !== undefined && !isString(note)) return undefined;
  if (values !== undefined && !isPlainObject(values)) return undefined;
  if (!isPlausibleStepOutput(output)) return undefined;

  return {
    flowShape,
    // Validated above: `output` is `undefined` or excludes a function/Symbol/
    // BigInt; `values` is `undefined` or a plain object. Neither is validated
    // any deeper than that (see `isPlausibleStepOutput`'s TSDoc).
    output: output as M3LProcedureValue | undefined,
    note,
    values: values as Readonly<Partial<TShape["values"]>> | undefined,
  };
}

/**
 * Converts a syntactically classified {@link FlowShape} back into the public
 * `M3LProcedureFlow<string>` directive `StepExecutionOutcome`'s `"advanced"`
 * arm carries.
 */
function flowShapeToDirective(shape: FlowShape): M3LProcedureFlow<string> {
  switch (shape.kind) {
    case "continue":
      return "continue";
    case "stop":
      return "stop";
    case "resolve":
      return "resolve";
    case "goTo":
      return { goTo: shape.target };
    default: {
      const exhaustive: never = shape;
      throw new M3LProcedureUndeclaredJumpError(
        `unreachable flow shape ${String(exhaustive)}`,
        {},
      );
    }
  }
}

/**
 * Folds a step's resolved, shape-validated result into the `"advanced"` arm
 * of {@link StepExecutionOutcome}: builds the `"succeeded"` record and
 * derives the next context, carrying `values` only when the step actually
 * returned one (`exactOptionalPropertyTypes` rejects an explicit `undefined`
 * on `deriveContext`'s optional field). Consumes ONLY the already-validated
 * {@link ValidatedStepResult} projection — never the raw result a hostile
 * getter could still be attached to.
 */
function advanceFromResult<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  start: number,
  validated: ValidatedStepResult<TShape>,
): Extract<StepExecutionOutcome<TShape>, { kind: "advanced" }> {
  const record = buildRecord(
    step,
    attempt,
    "succeeded",
    validated.output,
    validated.note,
    performance.now() - start,
  );
  const values = validated.values;
  const nextContext = deriveContext(context, {
    stepId: step.id,
    record,
    ...(values !== undefined ? { values } : {}),
  });
  return {
    kind: "advanced",
    context: nextContext,
    record,
    flow: flowShapeToDirective(validated.flowShape),
  };
}

/**
 * Folds an absorbed `execute` throw (`step.continueOnFailure === true`,
 * already confirmed by the caller) into a {@link StepExecutionOutcome}:
 * builds the `"recovered"` record, appends an `M3LRunRecoveryEntry`, and
 * derives the next context. A step that threw never got to return its own
 * flow directive.
 *
 * A step declaring `loop` has explicitly opted into being revisited on
 * absorption, so its outcome is the `"retry"` kind — consumed directly by
 * the run loop, re-executing the SAME step (bounded by the step's own
 * `loop.maxRevisits`/`maxIterations`, same as an explicit `goTo`) rather than
 * silently advancing past a still-failing operation. This is deliberately
 * never a synthesized `goTo` flow directive: routing it through `flow.ts`'s
 * flow interpretation would validate it against the declaring step's own
 * `jumpsTo` allowlist, but a step declaring `loop` has no obligation to also
 * list itself in `jumpsTo` — that would reject the engine's own retry as an
 * "undeclared jump" the step never returned. A step with no `loop`
 * declaration advances normally via the `"advanced"` kind, with an implicit
 * `"continue"` flow.
 */
function advanceFromRecovery<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
  start: number,
  error: unknown,
): Extract<
  StepExecutionOutcome<TShape>,
  { kind: "advanced" } | { kind: "retry" }
> {
  const record = buildRecord(
    step,
    attempt,
    "recovered",
    undefined,
    undefined,
    performance.now() - start,
  );
  const recoveryEntry: M3LRunRecoveryEntry = {
    item: step.id,
    error: serializeErrorChain(error),
    recordedAt: new Date().toISOString(),
  };
  const nextContext = deriveContext(context, {
    stepId: step.id,
    record,
    recoveryEntry,
  });
  if (step.loop === undefined) {
    return {
      kind: "advanced",
      context: nextContext,
      record,
      flow: "continue",
    };
  }
  return { kind: "retry", context: nextContext, record };
}

/**
 * Executes one step against `context`, returning the derived next context
 * and its record on success (or `continueOnFailure`-absorbed failure) —
 * never mutating `context` itself. An unabsorbed throw is reported, not
 * folded — no context transition and no step record.
 *
 * The settled result's shape AND its `output`/`note`/`values` are validated
 * (via {@link validateStepResult}) AFTER the `try`/`catch` around
 * `step.execute` has already exited (see this module's TSDoc) in ONE guarded
 * pass — a malformed result (missing `flow`, one outside the four recognized
 * directive forms, or an unreadable/invalid `output`/`note`/`values`,
 * including a hostile getter) resolves as `ERR_PROCEDURE_UNDECLARED_JUMP`
 * unconditionally, never absorbed by `continueOnFailure` even when the step
 * declares it, and never rejects `run()`'s promise.
 */
export async function executeOneStep<TShape extends M3LProcedureShape>(
  context: M3LProcedureContext<TShape>,
  step: M3LProcedureStep<TShape, TShape["stepId"], TShape["stepId"]>,
  attempt: number,
): Promise<StepExecutionOutcome<TShape>> {
  const start = performance.now();
  let result: unknown;
  try {
    result = await step.execute(context);
  } catch (error) {
    // Abort wins over everything, including a step's own error handling: the
    // signal is re-verified directly (not just classified by the thrown
    // error's own code), so a step that throws an ordinary error while
    // `context.signal` has already fired still resolves as "aborted" rather
    // than "failed" — the caller's cancellation must never be silently
    // missed just because the step's own throw raced it. Either check firing
    // routes here; order between them does not matter.
    if (isAborted(context.signal) || isAbortErrorCode(error)) {
      // An error that is ALREADY a genuine M3LOperationAbortedError is
      // surfaced unchanged, preserving its own identity/context; only a
      // plain object/other M3LError merely carrying the abort code gets a
      // fresh instance minted for it.
      return {
        kind: "aborted",
        error:
          error instanceof M3LOperationAbortedError
            ? error
            : new M3LOperationAbortedError(
                error instanceof Error ? error.message : undefined,
              ),
      };
    }
    if (step.continueOnFailure !== true) {
      return { kind: "failed", stepId: step.id, error };
    }
    return advanceFromRecovery(context, step, attempt, start, error);
  }

  // The validation below is deliberately OUTSIDE the try/catch above: it
  // never throws (validateStepResult catches its own hostile-getter reads
  // internally), and a malformed/invalid result must never be routed through
  // the continueOnFailure absorption path — it is an engine-level contract
  // violation, not a step failure (D6).
  const validated = validateStepResult<TShape>(result);
  if (validated === undefined) {
    return {
      kind: "failed",
      stepId: step.id,
      error: new M3LProcedureUndeclaredJumpError(
        `step "${step.id}" returned a result that could not be validated — a missing or unrecognized flow directive, or an output/note/values that could not be read or had an invalid type`,
        { stepId: step.id },
      ),
    };
  }
  return advanceFromResult(context, step, attempt, start, validated);
}
