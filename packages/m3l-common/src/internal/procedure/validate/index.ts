/**
 * `internal/procedure/validate` — collects every {@link
 * M3LProcedureValidationProblem} `M3LProcedureBuilder.build()` finds in a
 * definition, in the documented table order, then throws exactly one
 * `M3LProcedureInvalidDefinitionError` carrying all of them — never one
 * rejection at a time. Modelled closely on `internal/pipeline/validate.ts`,
 * including its `renderMessage` one-vs-many shape.
 *
 * `ERR_PROCEDURE_INVALID_DECLARATION` (a non-finite case priority, a
 * non-finite condition `literal`, a non-function `execute`/`action`, ...) is
 * collected alongside every other check, all BEFORE `M3LProcedureBuilder.build()`
 * ever calls `canonicalJsonHash` — that hash rejects a non-finite number with
 * `ERR_INVALID_ARGUMENT`, a code this contract does not name, so the digest
 * is only ever computed once this module confirms zero problems.
 *
 * Every raw field this module inspects is read exactly once, during
 * normalization (`normalizeStep`/`normalizeCase`/`normalizeFallback` in
 * `./normalize.js`), and the validated result carries the read value
 * forward — this module's success arm hands back a definition built from
 * those same normalized values, never from a second read of the caller's
 * (possibly accessor-backed) raw graph. A value that passed validation on
 * one read and produced a different value on a second read would defeat the
 * whole point of validating before `canonicalJsonHash` — and, per the R3/R4
 * defect fix, before `M3LProcedureBuilder` ever invokes a handler.
 *
 * Split across `shared.ts` (raw/validated shapes, `field`/`problem`),
 * `normalize.ts` (per-entry reads + declaration checks), `structure.ts`
 * (empty/duplicate/jump/cycle/priority checks), `conditions.ts` (the
 * condition-tree walk), and this orchestrator, purely to stay under the
 * per-file byte ceiling (`check:file-budget`).
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isNonEmptyString } from "../../../core/utils/guards.js";

import { walkAllConditions } from "./conditions.js";
import {
  normalizeCase,
  normalizeFallback,
  normalizeRevision,
  normalizeStep,
} from "./normalize.js";
import { DANGEROUS_KEYS, problem } from "./shared.js";
import {
  checkCycles,
  checkDuplicateCaseIds,
  checkDuplicateCasePriorities,
  checkDuplicateStepIds,
  checkEmptySteps,
  checkInvalidJumpTargets,
} from "./structure.js";
import type {
  NormalizedCase,
  NormalizedFallback,
  NormalizedStep,
  ProcedureValidationOutcome,
  RawProcedureInput,
  ValidatedProcedureDefinition,
} from "./shared.js";
import type { M3LProcedureValidationProblem } from "../../../core/procedure/build-types.js";

export type {
  ProcedureValidationOutcome,
  RawProcedureInput,
  ValidatedProcedureDefinition,
} from "./shared.js";

// ---------------------------------------------------------------------------
// 11 (non-condition portion). Procedure name, parameter name declarations.
// ---------------------------------------------------------------------------

function checkProcedureName(
  hasValidName: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidName) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: "M3LProcedure: the procedure name must be a non-empty string",
    }),
  ];
}

function checkParameterNameDeclarations(
  names: readonly string[],
): readonly M3LProcedureValidationProblem[] {
  const problems: M3LProcedureValidationProblem[] = [];
  const seen = new Set<string>();
  const duplicatesReported = new Set<string>();
  for (const name of names) {
    if (!isNonEmptyString(name)) {
      problems.push(
        problem({
          code: "ERR_PROCEDURE_INVALID_DECLARATION",
          message:
            "M3LProcedure: a declared parameter name must be a non-empty string",
        }),
      );
      continue;
    }
    if (DANGEROUS_KEYS.has(name)) {
      problems.push(
        problem({
          code: "ERR_PROCEDURE_INVALID_DECLARATION",
          message: `M3LProcedure: '${name}' is not a safe parameter name`,
        }),
      );
      continue;
    }
    if (seen.has(name) && !duplicatesReported.has(name)) {
      duplicatesReported.add(name);
      problems.push(
        problem({
          code: "ERR_PROCEDURE_INVALID_DECLARATION",
          message: `M3LProcedure: parameter name '${name}' is declared more than once via .parameters()`,
        }),
      );
    }
    seen.add(name);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Message rendering — the shape `internal/pipeline/validate.ts`'s
// `renderMessage` established: a single problem renders inline; several
// render as a numbered list, one line per problem in declaration order.
// ---------------------------------------------------------------------------

/**
 * Renders the collected problems into the message the thrown error carries:
 * with exactly one problem the error's own message IS that problem's
 * message; with several it is a summary line followed by each problem's
 * message, 1-based and numbered.
 *
 * @param problems - Every problem `validateProcedureDefinition` found.
 * @returns The rendered message.
 */
export function renderProcedureProblemsMessage(
  problems: readonly M3LProcedureValidationProblem[],
): string {
  if (problems.length === 1) {
    return problems.map((entry) => entry.message).join("");
  }
  const lines = problems.map(
    (entry, index) => `  ${index + 1}. ${entry.message}`,
  );
  return [
    `M3LProcedureBuilder.build(): ${problems.length} invalid findings:`,
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Assembling the validated definition once zero problems were found
// ---------------------------------------------------------------------------

/**
 * Projects the already-normalized steps/cases/fallback into the shape
 * `buildProcedureSummary` consumes, carrying each step's `execute`/
 * `describeTrace` and each case's `action` forward unchanged — every field
 * here was read exactly once, by `normalizeStep`/`normalizeCase`/
 * `normalizeFallback` — this function only re-shapes values already in
 * hand, it never touches the caller's raw graph again.
 */
function buildValidatedDefinition(
  input: RawProcedureInput,
  name: string,
  revision: string | undefined,
  steps: readonly NormalizedStep[],
  cases: readonly NormalizedCase[],
  projectedConditions: readonly unknown[],
  fallback: NormalizedFallback,
): ValidatedProcedureDefinition {
  return {
    name,
    revision,
    steps: steps.map((step) => ({
      id: step.id,
      label: step.label,
      kind: step.kind,
      continueOnFailure: step.continueOnFailure,
      jumpsTo: step.jumpsTo,
      loop: step.loop,
      execute: step.execute,
      describeTrace: step.describeTrace,
    })),
    // `projectedConditions[index]` — never `entry.condition` — is the fresh,
    // primitives-only copy `internal/procedure/validate/conditions.ts`
    // already validated AND built in one pass; see that module's doc for
    // why the caller's raw `condition` reference must never reach the
    // digest projection a second time.
    cases: cases.map((entry, index) => ({
      id: entry.id,
      description: entry.description,
      prose: entry.prose,
      priority: entry.priority,
      condition: projectedConditions[index],
      action: entry.action,
    })),
    fallback: { description: fallback.description, prose: fallback.prose },
    parameters: [...input.declaredParameters],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validates a raw, not-yet-type-checked procedure declaration in the
 * documented table order, collecting every {@link
 * M3LProcedureValidationProblem} rather than short-circuiting on the first
 * violation found. On success, hands back the validated definition built
 * from the very same normalized reads the checks ran against — `build()`
 * must use this as its sole source of the validated definition rather than
 * re-deriving one from the raw graph, or a mutable/accessor-backed caller
 * value could validate on this pass and read differently on a second one.
 *
 * Type-level exhaustiveness (`M3LProcedureBuilder.step`/`.case`'s
 * `Exclude`-based narrowing, `build()`'s required positional `fallback`)
 * makes most of these checks unreachable from well-typed TypeScript; this
 * runtime pass exists to guard a JavaScript caller or a dynamically
 * assembled procedure.
 *
 * @param input - The raw name, steps, cases, fallback, declared parameter
 *   names, and revision `M3LProcedureBuilder.build()` collected.
 * @returns `{ kind: "invalid", problems }` with every problem found, in the
 *   documented table order, or `{ kind: "valid", definition, fallbackAction }`
 *   when the declaration is valid.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 * // import { validateProcedureDefinition } from "../../internal/procedure/validate/index.js";
 *
 * // const outcome = validateProcedureDefinition({
 * //   name: "log-triage",
 * //   steps: [],
 * //   cases: [],
 * //   fallback: undefined,
 * //   declaredParameters: [],
 * //   revision: undefined,
 * // });
 * // if (outcome.kind === "invalid") {
 * //   throw new M3LError("invalid", { code: "ERR_PROCEDURE_INVALID_DEFINITION" });
 * // }
 * ```
 */
export function validateProcedureDefinition(
  input: RawProcedureInput,
): ProcedureValidationOutcome {
  const problems: M3LProcedureValidationProblem[] = [];

  // 1. EMPTY_STEPS
  problems.push(...checkEmptySteps(input.steps));

  const steps = input.steps.map((raw, index) => normalizeStep(raw, index));
  const cases = input.cases.map((raw, index) => normalizeCase(raw, index));
  const fallback = normalizeFallback(input.fallback);

  const rawName = input.name;
  const hasValidName = isNonEmptyString(rawName);
  const name = hasValidName ? rawName : "";

  // 2. DUPLICATE_STEP_ID
  problems.push(...checkDuplicateStepIds(steps));

  const knownStepIds = new Set(
    steps.filter((step) => step.hasValidId).map((step) => step.id),
  );

  // 3. INVALID_JUMP_TARGET
  problems.push(...checkInvalidJumpTargets(steps, knownStepIds));

  // 4. CYCLE_DETECTED
  problems.push(...checkCycles(steps));

  // 5. DUPLICATE_CASE_ID
  problems.push(...checkDuplicateCaseIds(cases));

  // 6. DUPLICATE_CASE_PRIORITY
  problems.push(...checkDuplicateCasePriorities(cases));

  // 7. MISSING_FALLBACK
  problems.push(...fallback.declarationProblems);

  const knownParameterNames = new Set(input.declaredParameters);
  const conditionResults = walkAllConditions(
    cases,
    knownStepIds,
    knownParameterNames,
  );
  const revisionResult = normalizeRevision(input.revision);

  // 8. INVALID_PATTERN
  problems.push(...conditionResults.patternProblems);
  // 9. CONDITION_TOO_DEEP
  problems.push(...conditionResults.tooDeepProblems);
  // 10. UNKNOWN_REFERENCE
  problems.push(...conditionResults.unknownReferenceProblems);

  // 11. INVALID_DECLARATION (name, per-step, per-case, per-parameter-name,
  // condition-derived, revision — combined, in that order).
  problems.push(...checkProcedureName(hasValidName));
  for (const step of steps) problems.push(...step.declarationProblems);
  for (const entry of cases) problems.push(...entry.declarationProblems);
  problems.push(...checkParameterNameDeclarations(input.declaredParameters));
  problems.push(...conditionResults.declarationProblems);
  problems.push(...revisionResult.declarationProblems);

  if (problems.length > 0) {
    return { kind: "invalid", problems };
  }

  return {
    kind: "valid",
    definition: buildValidatedDefinition(
      input,
      name,
      revisionResult.revision,
      steps,
      cases,
      conditionResults.projectedConditions,
      fallback,
    ),
    fallbackAction: fallback.action,
  };
}
