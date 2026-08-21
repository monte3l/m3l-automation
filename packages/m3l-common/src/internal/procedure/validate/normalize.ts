/**
 * `internal/procedure/validate/normalize` — reads every raw step/case/
 * fallback field this module or the digest projection needs, exactly once
 * each, validating as it goes.
 *
 * **Defect fix (ADR-0072, slice 2a):** a step's `execute` and a case's
 * `action` are validated here — `typeof … === "function"` — and the
 * (possibly-invalid) reference is captured on the returned
 * `NormalizedStep`/`NormalizedCase` so it flows into the validated
 * projection. `M3LProcedureBuilder` must read `execute`/`action`/
 * `describeTrace` from that projection only, never a second time off the
 * caller's raw step/case object — the abandoned branch read them a second
 * time in `#buildRuntimeSteps`/`#buildRuntimeCases`, which both let a
 * non-function handler reach a caller as a bare `TypeError` (never
 * validated at all) and reopened the validate-then-re-read hazard this
 * module otherwise closes.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isNonEmptyString } from "../../../core/utils/guards.js";

import { MAX_REFERENCE_ARRAY_LENGTH, field, problem } from "./shared.js";
import type {
  NormalizedCase,
  NormalizedFallback,
  NormalizedLoop,
  NormalizedStep,
} from "./shared.js";
import type { M3LProcedureValidationProblem } from "../../../core/procedure/build-types.js";

// ---------------------------------------------------------------------------
// Step normalization
// ---------------------------------------------------------------------------

/** The empty-or-non-string step id declaration problem, or nothing when `id` is valid. */
function checkStepIdDeclaration(
  hasValidId: boolean,
  index: number,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidId) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step at index ${index} has an empty or non-string id`,
    }),
  ];
}

/** The empty-or-non-string step label declaration problem, or nothing when `label` is valid. */
function checkStepLabelDeclaration(
  hasValidLabel: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidLabel) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has an empty or non-string label`,
      ...(hasValidId ? { stepId: id } : {}),
    }),
  ];
}

/**
 * The empty-or-non-string step kind declaration problem, or nothing when
 * `kind` is valid. `M3LProcedureStepKind` is a closed union at the type
 * level only; an untyped caller's `kind` is otherwise unchecked, so this is
 * the runtime floor `internal/procedure/digest.ts`'s projection relies on
 * before it casts the validated string back to the literal union.
 */
function checkStepKindDeclaration(
  hasValidKind: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidKind) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has an empty or non-string kind`,
      ...(hasValidId ? { stepId: id } : {}),
    }),
  ];
}

/** A finite-integer-greater-than-0 `maxRevisits`, or nothing when `loop` is absent or valid. */
function checkStepLoopDeclaration(
  isValidMaxRevisits: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (isValidMaxRevisits) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has a loop.maxRevisits that is not a finite integer greater than 0`,
      ...(hasValidId ? { stepId: id } : {}),
    }),
  ];
}

/**
 * A `jumpsTo` array declaring more entries than {@link MAX_REFERENCE_ARRAY_LENGTH}
 * is `ERR_PROCEDURE_INVALID_DECLARATION`, naming the step's id — a genuinely
 * malformed declaration, unlike an absent/non-array `jumpsTo`, which stays
 * valid (there is simply nothing to jump to). Silently dropping every
 * declared jump target for an over-length array would otherwise let the
 * procedure build "successfully" with a graph missing those edges, and
 * `findProcedureCycles` would report no cycle for a definition that
 * genuinely has one.
 */
function checkStepJumpsToDeclaration(
  isValid: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (isValid) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has a jumpsTo array with more than ${MAX_REFERENCE_ARRAY_LENGTH} entries`,
      ...(hasValidId ? { stepId: id } : {}),
    }),
  ];
}

/**
 * A present-but-non-boolean `continueOnFailure` is
 * `ERR_PROCEDURE_INVALID_DECLARATION`, naming the step's id. `undefined`/
 * `null` stay valid — they already default to `false` in
 * {@link normalizeContinueOnFailure}.
 */
function checkStepContinueOnFailureDeclaration(
  hasValidContinueOnFailure: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidContinueOnFailure) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has a continueOnFailure that is not a boolean`,
      ...(hasValidId ? { stepId: id } : {}),
    }),
  ];
}

/**
 * A non-function `execute` is `ERR_PROCEDURE_INVALID_DECLARATION`, naming
 * the step's id — the R3/R4 defect fix. `execute` is captured on the
 * returned `NormalizedStep` regardless of validity, so the caller's raw step
 * object is never consulted again.
 */
function checkStepExecuteDeclaration(
  hasValidExecute: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidExecute) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has an 'execute' that is not a function`,
      ...(hasValidId ? { stepId: id } : {}),
    }),
  ];
}

/** {@link normalizeContinueOnFailure}'s result: the coerced value plus its validity. */
interface NormalizedContinueOnFailure {
  readonly continueOnFailure: boolean;
  readonly isValid: boolean;
}

/**
 * Reads a step's `continueOnFailure` exactly once, defaulting absent/null to
 * `false` and validating any other present value is actually a `boolean` — an
 * untyped caller's truthy non-boolean (e.g. the string `"false"`) would
 * otherwise flow straight into the digest and invert this field's semantics
 * at run time.
 */
function normalizeContinueOnFailure(raw: unknown): NormalizedContinueOnFailure {
  const rawContinueOnFailure = field(raw, "continueOnFailure");
  if (rawContinueOnFailure === undefined || rawContinueOnFailure === null) {
    return { continueOnFailure: false, isValid: true };
  }
  if (typeof rawContinueOnFailure === "boolean") {
    return { continueOnFailure: rawContinueOnFailure, isValid: true };
  }
  return { continueOnFailure: false, isValid: false };
}

/** {@link normalizeJumpsTo}'s result: the coerced value plus its validity. */
interface NormalizedJumpsTo {
  readonly jumpsTo: readonly string[];
  readonly isValid: boolean;
}

/**
 * Reads a step's `jumpsTo` exactly once, dropping any non-string entry. A
 * non-array `jumpsTo` stays valid — there is simply nothing to jump to. An
 * array declaring more entries than {@link MAX_REFERENCE_ARRAY_LENGTH} is a
 * genuinely malformed declaration (`isValid: false`, reported by
 * {@link checkStepJumpsToDeclaration}), rather than paying an
 * `Array.prototype.filter` pass over a hostile length-only sparse array and
 * silently dropping every declared jump target.
 */
function normalizeJumpsTo(raw: unknown): NormalizedJumpsTo {
  const rawJumpsTo = field(raw, "jumpsTo");
  if (!Array.isArray(rawJumpsTo)) {
    return { jumpsTo: [], isValid: true };
  }
  if (rawJumpsTo.length > MAX_REFERENCE_ARRAY_LENGTH) {
    return { jumpsTo: [], isValid: false };
  }
  return {
    jumpsTo: rawJumpsTo.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    isValid: true,
  };
}

/** Reads a step's `loop` exactly once, validating `maxRevisits` in the same pass. */
function normalizeLoop(raw: unknown): NormalizedLoop {
  const rawLoop = field(raw, "loop");
  if (rawLoop === undefined || rawLoop === null) {
    return { hasLoop: false, loop: undefined, isValidMaxRevisits: true };
  }

  const rawMaxRevisits = field(rawLoop, "maxRevisits");
  const rawReason = field(rawLoop, "reason");
  const isValidMaxRevisits =
    typeof rawMaxRevisits === "number" &&
    Number.isInteger(rawMaxRevisits) &&
    rawMaxRevisits > 0;

  return {
    hasLoop: true,
    loop: {
      reason: typeof rawReason === "string" ? rawReason : "",
      maxRevisits:
        isValidMaxRevisits && typeof rawMaxRevisits === "number"
          ? rawMaxRevisits
          : 0,
    },
    isValidMaxRevisits,
  };
}

/**
 * Reads every field this module or the digest projection needs off one raw
 * step — exactly once each — and validates them in the same pass.
 */
export function normalizeStep(raw: unknown, index: number): NormalizedStep {
  const rawId = field(raw, "id");
  const hasValidId = isNonEmptyString(rawId);
  const id = hasValidId ? rawId : `#invalid-step-${index}`;

  const rawLabel = field(raw, "label");
  const hasValidLabel = isNonEmptyString(rawLabel);
  const label = hasValidLabel ? rawLabel : "";

  const rawKind = field(raw, "kind");
  const hasValidKind = isNonEmptyString(rawKind);
  const kind = hasValidKind ? rawKind : "";

  const continueOnFailureInfo = normalizeContinueOnFailure(raw);
  const continueOnFailure = continueOnFailureInfo.continueOnFailure;
  const jumpsToInfo = normalizeJumpsTo(raw);
  const jumpsTo = jumpsToInfo.jumpsTo;
  const loopInfo = normalizeLoop(raw);

  const execute = field(raw, "execute");
  const hasValidExecute = typeof execute === "function";
  const describeTrace = field(raw, "describeTrace");

  return {
    index,
    rawId,
    id,
    hasValidId,
    label,
    kind,
    continueOnFailure,
    jumpsTo,
    hasLoop: loopInfo.hasLoop,
    loop: loopInfo.loop,
    execute,
    describeTrace,
    declarationProblems: [
      ...checkStepIdDeclaration(hasValidId, index),
      ...checkStepLabelDeclaration(hasValidLabel, id, hasValidId),
      ...checkStepKindDeclaration(hasValidKind, id, hasValidId),
      ...checkStepLoopDeclaration(loopInfo.isValidMaxRevisits, id, hasValidId),
      ...checkStepContinueOnFailureDeclaration(
        continueOnFailureInfo.isValid,
        id,
        hasValidId,
      ),
      ...checkStepJumpsToDeclaration(jumpsToInfo.isValid, id, hasValidId),
      ...checkStepExecuteDeclaration(hasValidExecute, id, hasValidId),
    ],
  };
}

// ---------------------------------------------------------------------------
// Case normalization
// ---------------------------------------------------------------------------

/**
 * A non-function `action` is `ERR_PROCEDURE_INVALID_DECLARATION`, naming the
 * case's id — the R3/R4 defect fix's case-side counterpart. Scoped to a
 * *case*'s `action` only: the fallback's `action` is validated separately
 * under `ERR_PROCEDURE_MISSING_FALLBACK` (see {@link normalizeFallback}),
 * never this code.
 */
function checkCaseActionDeclaration(
  hasValidAction: boolean,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidAction) return [];
  return [
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: case '${id}' has an 'action' that is not a function`,
      ...(hasValidId ? { caseId: id } : {}),
    }),
  ];
}

/**
 * Reads every field this module or the digest projection needs off one raw
 * case — exactly once each — and validates them in the same pass.
 */
export function normalizeCase(raw: unknown, index: number): NormalizedCase {
  const rawId = field(raw, "id");
  const hasValidId = isNonEmptyString(rawId);
  const id = hasValidId ? rawId : `#invalid-case-${index}`;

  const rawDescription = field(raw, "description");
  const description = typeof rawDescription === "string" ? rawDescription : "";

  const rawProse = field(raw, "prose");
  const prose = typeof rawProse === "string" ? rawProse : "";

  const rawPriority = field(raw, "priority");
  const hasValidPriority =
    typeof rawPriority === "number" && Number.isFinite(rawPriority);
  const priority =
    hasValidPriority && typeof rawPriority === "number" ? rawPriority : 0;

  const condition = field(raw, "condition");

  const action = field(raw, "action");
  const hasValidAction = typeof action === "function";

  return {
    index,
    rawId,
    id,
    hasValidId,
    description,
    prose,
    priority,
    hasValidPriority,
    condition,
    action,
    declarationProblems: [
      ...(hasValidId
        ? []
        : [
            problem({
              code: "ERR_PROCEDURE_INVALID_DECLARATION",
              message: `M3LProcedure: case at index ${index} has an empty or non-string id`,
            }),
          ]),
      ...(hasValidPriority
        ? []
        : [
            problem({
              code: "ERR_PROCEDURE_INVALID_DECLARATION",
              message: `M3LProcedure: case '${id}' has a priority that is not a finite number`,
              ...(hasValidId ? { caseId: id } : {}),
            }),
          ]),
      ...checkCaseActionDeclaration(hasValidAction, id, hasValidId),
    ],
  };
}

// ---------------------------------------------------------------------------
// Revision normalization
// ---------------------------------------------------------------------------

/** {@link normalizeRevision}'s result: the validated value plus any problem found. */
export interface NormalizedRevision {
  readonly revision: string | undefined;
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

/**
 * Reads `M3LProcedureBuildOptions.revision` exactly once, validating it is
 * `undefined` or a `string` — nothing else. A non-string, non-undefined
 * value (a `bigint`, a `NaN`, a plain object, ...) is
 * `ERR_PROCEDURE_INVALID_DECLARATION` rather than being forwarded raw into
 * `buildProcedureSummary`/`canonicalJsonHash`, which would otherwise leak an
 * uncoded failure a second, independent read away from this validation.
 */
export function normalizeRevision(raw: unknown): NormalizedRevision {
  if (raw === undefined) {
    return { revision: undefined, declarationProblems: [] };
  }
  if (typeof raw === "string") {
    return { revision: raw, declarationProblems: [] };
  }
  return {
    revision: undefined,
    declarationProblems: [
      problem({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message:
          "M3LProcedure: build() options.revision must be a string when provided",
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Fallback normalization
// ---------------------------------------------------------------------------

/**
 * Reads every field the builder needs off the raw fallback — exactly once
 * each — and validates them in the same pass. `action` is captured here
 * even though it is not itself a digest field, so the builder never needs a
 * second read of the caller's (possibly accessor-backed) fallback object to
 * recover it.
 */
export function normalizeFallback(fallback: unknown): NormalizedFallback {
  if (fallback === null || typeof fallback !== "object") {
    return {
      action: undefined,
      description: "",
      prose: "",
      declarationProblems: [
        problem({
          code: "ERR_PROCEDURE_MISSING_FALLBACK",
          message: "M3LProcedure: a fallback is required",
        }),
      ],
    };
  }

  const action = field(fallback, "action");
  const hasValidAction = typeof action === "function";

  const rawDescription = field(fallback, "description");
  const rawProse = field(fallback, "prose");
  const description = isNonEmptyString(rawDescription) ? rawDescription : "";
  const prose = isNonEmptyString(rawProse) ? rawProse : "";

  if (!hasValidAction) {
    return {
      action,
      description,
      prose,
      declarationProblems: [
        problem({
          code: "ERR_PROCEDURE_MISSING_FALLBACK",
          message:
            "M3LProcedure: the fallback must declare an 'action' function",
        }),
      ],
    };
  }

  if (description === "" || prose === "") {
    return {
      action,
      description,
      prose,
      declarationProblems: [
        problem({
          code: "ERR_PROCEDURE_MISSING_FALLBACK",
          message:
            "M3LProcedure: the fallback must declare non-empty 'description' and 'prose' strings",
        }),
      ],
    };
  }

  return { action, description, prose, declarationProblems: [] };
}
