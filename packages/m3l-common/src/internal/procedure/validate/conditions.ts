/**
 * `internal/procedure/validate/conditions` — walks every case's condition
 * tree exactly once, both validating (pattern safety, depth bound, unknown
 * references, literal scalar-ness) and, in the SAME pass, constructing a
 * fresh, plain, primitives-only projected copy of the tree.
 *
 * **Defect fix (ADR-0072, slice 2a review):** the projected copy — never the
 * caller's original `condition` reference — is what {@link walkAllConditions}
 * hands back for `buildProcedureSummary`/`canonicalJsonHash` to consume.
 * Before this fix, the caller's raw condition object flowed straight through
 * into the digest, so `canonicalJsonHash` walked it a SECOND, independent
 * time: a `bigint` literal or a hostile/inconsistent getter could pass this
 * validation pass and then disagree (or throw uncoded) on that second read.
 * Building the projection HERE, off the exact same reads this walk already
 * performs for validation, closes that gap the same way `normalizeLoop`
 * already rebuilds a step's `loop` into a fresh object rather than forwarding
 * the caller's `loop` reference.
 *
 * A circular object used as a condition node needs no separate cycle
 * detection: this walk's recursion is bounded by a logical depth counter,
 * incremented on every `and`/`or`/`not` descent regardless of the input's
 * actual object identity, so a self-referencing node simply hits
 * `M3L_PROCEDURE_CONDITION_MAX_DEPTH` like any other too-deep tree.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import {
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
} from "../../../core/procedure/types.js";

import { DANGEROUS_KEYS, field, problem } from "./shared.js";
import type { NormalizedCase } from "./shared.js";
import type { M3LProcedureValidationProblem } from "../../../core/procedure/build-types.js";
import type { M3LProcedureScalar } from "../../../core/procedure/types.js";

/** The scan's two flags: whether the previous character was an unconsumed `\\`, and whether the scan is inside a `[...]` character class. */
interface PatternScanState {
  readonly inEscape: boolean;
  readonly inClass: boolean;
}

/** Whether `char` would repeat a preceding group — the four quantifier starts this scan treats as "quantified". */
function isQuantifierChar(char: string | undefined): boolean {
  return char === "+" || char === "*" || char === "?" || char === "{";
}

/**
 * Advances the scan by one character, returning the next state and whether
 * THIS character is an unescaped, out-of-class `)` immediately followed by a
 * quantifier — the one signal {@link hasQuantifiedGroup} looks for.
 */
function advancePatternScan(
  state: PatternScanState,
  char: string,
  next: string | undefined,
): { readonly state: PatternScanState; readonly quantifiedClose: boolean } {
  if (state.inEscape) {
    return {
      state: { inEscape: false, inClass: state.inClass },
      quantifiedClose: false,
    };
  }
  if (char === "\\") {
    return {
      state: { inEscape: true, inClass: state.inClass },
      quantifiedClose: false,
    };
  }
  if (state.inClass) {
    return {
      state: { inEscape: false, inClass: char !== "]" },
      quantifiedClose: false,
    };
  }
  if (char === "[") {
    return {
      state: { inEscape: false, inClass: true },
      quantifiedClose: false,
    };
  }
  return { state, quantifiedClose: char === ")" && isQuantifierChar(next) };
}

/**
 * Scans `pattern` left-to-right for a `)` that closes a group and is
 * immediately followed by a quantifier (`+`, `*`, `?`, `{`), tracking two
 * flags — "in escape" and "in character class" — so an escaped `\\)` and a
 * `)` inside `[...]` are never mistaken for a group closer.
 */
function hasQuantifiedGroup(pattern: string): boolean {
  let state: PatternScanState = { inEscape: false, inClass: false };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) continue;
    const result = advancePatternScan(state, char, pattern[index + 1]);
    if (result.quantifiedClose) return true;
    state = result.state;
  }
  return false;
}

function isPatternSafe(pattern: string): boolean {
  if (pattern.length > M3L_PROCEDURE_MAX_PATTERN_LENGTH) return false;
  if (hasQuantifiedGroup(pattern)) return false;
  try {
    // Caller-authored, build-time-only compile check; the whole point of
    // this pass is to catch a pattern `new RegExp` rejects before it ever
    // reaches a run.
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** One of the four types {@link M3LProcedureScalar} admits — `bigint`, a plain object, a function, and a symbol are all rejected. */
function isValidScalarLiteral(value: unknown): value is M3LProcedureScalar {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean" ||
    value === null
  );
}

/** A short, safe-to-interpolate description of a rejected literal's shape — never calls `String()` on the value itself, since a hostile `Symbol` or object could throw or leak content. */
function describeInvalidLiteral(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return "a non-finite number";
  return `a value of type '${typeof value}'`;
}

/**
 * Renders an unrecognized `source`/`kind` discriminant for a message or a
 * projected placeholder without ever calling `.toString()`/`String()` on an
 * object or symbol — both could stringify to `"[object Object]"` or throw.
 */
function describeUnknownDiscriminant(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return typeof value;
}

interface ConditionWalkAccumulator {
  readonly caseId: string;
  readonly knownStepIds: ReadonlySet<string>;
  readonly knownParameterNames: ReadonlySet<string>;
  readonly patternProblems: M3LProcedureValidationProblem[];
  readonly tooDeepProblems: M3LProcedureValidationProblem[];
  readonly unknownReferenceProblems: M3LProcedureValidationProblem[];
  readonly declarationProblems: M3LProcedureValidationProblem[];
}

/** Fresh copy of a reference's `path`, filtering any non-string entry — mirrors `normalizeJumpsTo`'s filter-and-copy shape. Returns `undefined` when there is nothing to carry (never an empty array). */
function projectPath(rawPath: unknown): readonly string[] | undefined {
  if (!Array.isArray(rawPath)) return undefined;
  const path = rawPath.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return path.length > 0 ? [...path] : undefined;
}

/**
 * Validates and projects a `literal` reference in one step: a non-scalar
 * `literal` (a `bigint`, an object, a function, a symbol, `undefined`) is
 * `ERR_PROCEDURE_INVALID_DECLARATION` — see the module doc on why this must
 * happen here rather than being discovered by `canonicalJsonHash`.
 */
function projectLiteralReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const literal = field(reference, "literal");
  if (isValidScalarLiteral(literal)) {
    return { source: "literal", literal };
  }
  acc.declarationProblems.push(
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: case '${acc.caseId}' has a condition literal that is not a string, finite number, boolean, or null (received ${describeInvalidLiteral(literal)})`,
      caseId: acc.caseId,
    }),
  );
  return { source: "literal", literal: null };
}

/** A `step` reference naming an undeclared step is `ERR_PROCEDURE_UNKNOWN_REFERENCE`. */
function projectStepReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const step = field(reference, "step");
  if (typeof step === "string" && !acc.knownStepIds.has(step)) {
    acc.unknownReferenceProblems.push(
      problem({
        code: "ERR_PROCEDURE_UNKNOWN_REFERENCE",
        message: `M3LProcedure: case '${acc.caseId}' references a step '${step}' that was never declared`,
        caseId: acc.caseId,
      }),
    );
  }
  const path = projectPath(field(reference, "path"));
  return {
    source: "step",
    step: typeof step === "string" ? step : "",
    ...(path !== undefined ? { path } : {}),
  };
}

/**
 * A dangerous `value` key (`__proto__`/`constructor`/`prototype`) is
 * `ERR_PROCEDURE_INVALID_DECLARATION`. No build-time manifest of declared
 * `values` keys exists — there is no `.values()` builder method (only
 * `.parameters()`) — so an ordinary value key can never be flagged unknown
 * here.
 */
function projectValueReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const key = field(reference, "key");
  if (typeof key === "string" && DANGEROUS_KEYS.has(key)) {
    acc.declarationProblems.push(
      problem({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: case '${acc.caseId}' references a dangerous value key '${key}'`,
        caseId: acc.caseId,
      }),
    );
  }
  const path = projectPath(field(reference, "path"));
  return {
    source: "value",
    key: typeof key === "string" ? key : "",
    ...(path !== undefined ? { path } : {}),
  };
}

/**
 * A dangerous `parameter` key is `ERR_PROCEDURE_INVALID_DECLARATION`
 * (exclusive of the unknown-reference check below); otherwise a key absent
 * from the declared `.parameters()` set is `ERR_PROCEDURE_UNKNOWN_REFERENCE`.
 */
function projectParameterReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const key = field(reference, "key");
  if (typeof key === "string") {
    if (DANGEROUS_KEYS.has(key)) {
      acc.declarationProblems.push(
        problem({
          code: "ERR_PROCEDURE_INVALID_DECLARATION",
          message: `M3LProcedure: case '${acc.caseId}' references a dangerous parameter key '${key}'`,
          caseId: acc.caseId,
        }),
      );
    } else if (!acc.knownParameterNames.has(key)) {
      acc.unknownReferenceProblems.push(
        problem({
          code: "ERR_PROCEDURE_UNKNOWN_REFERENCE",
          message: `M3LProcedure: case '${acc.caseId}' references parameter '${key}', which was never declared via .parameters()`,
          caseId: acc.caseId,
        }),
      );
    }
  }
  const path = projectPath(field(reference, "path"));
  return {
    source: "parameter",
    key: typeof key === "string" ? key : "",
    ...(path !== undefined ? { path } : {}),
  };
}

/**
 * Dispatches one reference by its `source`, validating AND projecting it in
 * one step. An unrecognized `source` (a typo, or a forward-compat kind an
 * older build doesn't know) used to fall through `default: return` silently
 * — skipping the reference AND everything beneath it in the condition tree.
 * The `default` arm below closes that hole: any unrecognized `source` is
 * itself a declaration problem, which blocks `build()` from ever reaching
 * the digest regardless of what is nested beneath it.
 */
function projectReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  if (reference === null || typeof reference !== "object") return undefined;
  const source = field(reference, "source");

  switch (source) {
    case "literal":
      return projectLiteralReference(reference, acc);
    case "step":
      return projectStepReference(reference, acc);
    case "value":
      return projectValueReference(reference, acc);
    case "parameter":
      return projectParameterReference(reference, acc);
    default:
      acc.declarationProblems.push(
        problem({
          code: "ERR_PROCEDURE_INVALID_DECLARATION",
          message: `M3LProcedure: case '${acc.caseId}' references a value with an unrecognized source '${describeUnknownDiscriminant(source)}'`,
          caseId: acc.caseId,
        }),
      );
      return { source: describeUnknownDiscriminant(source) };
  }
}

/** Reports the too-deep problem at most once per case, regardless of how many branches independently trip the depth bound. */
function reportConditionTooDeep(acc: ConditionWalkAccumulator): void {
  if (acc.tooDeepProblems.length > 0) return;
  acc.tooDeepProblems.push(
    problem({
      code: "ERR_PROCEDURE_CONDITION_TOO_DEEP",
      message: `M3LProcedure: case '${acc.caseId}' condition nests past the max depth`,
      caseId: acc.caseId,
    }),
  );
}

function projectMatchesNode(
  condition: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const subject = projectReference(field(condition, "subject"), acc);
  const pattern = field(condition, "pattern");
  if (typeof pattern === "string" && !isPatternSafe(pattern)) {
    acc.patternProblems.push(
      problem({
        code: "ERR_PROCEDURE_INVALID_PATTERN",
        message: `M3LProcedure: case '${acc.caseId}' has an unsafe 'matches' pattern`,
        caseId: acc.caseId,
      }),
    );
  }
  const ignoreCase = field(condition, "ignoreCase");
  return {
    kind: "matches",
    subject,
    pattern: typeof pattern === "string" ? pattern : "",
    ...(typeof ignoreCase === "boolean" ? { ignoreCase } : {}),
  };
}

function projectCompareNode(
  condition: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const left = projectReference(field(condition, "left"), acc);
  const operator = field(condition, "operator");
  const right = projectReference(field(condition, "right"), acc);
  return {
    kind: "compare",
    left,
    operator: typeof operator === "string" ? operator : "",
    right,
  };
}

/** Shared projection for `and`/`or`: both are an operand array, recursed one level deeper. */
function projectJunctionNode(
  condition: unknown,
  kind: "and" | "or",
  acc: ConditionWalkAccumulator,
  depth: number,
): unknown {
  const operands = field(condition, "operands");
  const projectedOperands = Array.isArray(operands)
    ? operands.map((operand) => projectCondition(operand, acc, depth + 1))
    : [];
  return { kind, operands: projectedOperands };
}

/** The declaration problem plus placeholder projection for an unrecognized condition `kind`. */
function projectUnrecognizedKind(
  kind: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  acc.declarationProblems.push(
    problem({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: case '${acc.caseId}' has a condition node with an unrecognized kind '${describeUnknownDiscriminant(kind)}'`,
      caseId: acc.caseId,
    }),
  );
  return { kind: describeUnknownDiscriminant(kind) };
}

/**
 * Dispatches one already-depth-checked condition node by its `kind`,
 * validating AND projecting it in one step. An unrecognized `kind` used to
 * fall through `default: return` silently — see {@link projectReference}'s
 * TSDoc for why that let a malformed leaf hide arbitrarily deep in the tree.
 * {@link projectUnrecognizedKind} closes the same hole for condition nodes:
 * an unrecognized `kind` is itself a declaration problem.
 */
function projectConditionNode(
  condition: unknown,
  kind: unknown,
  acc: ConditionWalkAccumulator,
  depth: number,
): unknown {
  switch (kind) {
    case "compare":
      return projectCompareNode(condition, acc);
    case "matches":
      return projectMatchesNode(condition, acc);
    case "contains": {
      const subject = projectReference(field(condition, "subject"), acc);
      const item = projectReference(field(condition, "item"), acc);
      return { kind: "contains", subject, item };
    }
    case "exists":
      return {
        kind: "exists",
        subject: projectReference(field(condition, "subject"), acc),
      };
    case "and":
    case "or":
      return projectJunctionNode(condition, kind, acc, depth);
    case "not":
      return {
        kind: "not",
        operand: projectCondition(field(condition, "operand"), acc, depth + 1),
      };
    default:
      return projectUnrecognizedKind(kind, acc);
  }
}

/**
 * Validates and projects one condition tree, recursing at most
 * {@link M3L_PROCEDURE_CONDITION_MAX_DEPTH} levels deep regardless of the
 * input's actual object shape — a self-referencing (circular) node is
 * caught by this bound rather than needing its own cycle check, since the
 * depth counter increments on every descent independent of object identity.
 */
function projectCondition(
  condition: unknown,
  acc: ConditionWalkAccumulator,
  depth: number,
): unknown {
  if (depth > M3L_PROCEDURE_CONDITION_MAX_DEPTH) {
    reportConditionTooDeep(acc);
    return undefined;
  }
  if (condition === null || typeof condition !== "object") return undefined;
  return projectConditionNode(condition, field(condition, "kind"), acc, depth);
}

interface ConditionWalkResults {
  readonly patternProblems: readonly M3LProcedureValidationProblem[];
  readonly tooDeepProblems: readonly M3LProcedureValidationProblem[];
  readonly unknownReferenceProblems: readonly M3LProcedureValidationProblem[];
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
  /**
   * One fresh, plain, primitives-only projected condition tree per entry in
   * `cases`, same order. This — never `entry.condition` — is what
   * `buildValidatedDefinition` must carry into
   * `buildProcedureSummary`/`canonicalJsonHash`.
   */
  readonly projectedConditions: readonly unknown[];
}

export function walkAllConditions(
  cases: readonly NormalizedCase[],
  knownStepIds: ReadonlySet<string>,
  knownParameterNames: ReadonlySet<string>,
): ConditionWalkResults {
  const patternProblems: M3LProcedureValidationProblem[] = [];
  const tooDeepProblems: M3LProcedureValidationProblem[] = [];
  const unknownReferenceProblems: M3LProcedureValidationProblem[] = [];
  const declarationProblems: M3LProcedureValidationProblem[] = [];
  const projectedConditions: unknown[] = [];

  for (const entry of cases) {
    const acc: ConditionWalkAccumulator = {
      caseId: entry.id,
      knownStepIds,
      knownParameterNames,
      patternProblems: [],
      tooDeepProblems: [],
      unknownReferenceProblems: [],
      declarationProblems: [],
    };
    // `entry.condition` was already read once, in `normalizeCase` — this
    // walk reads the tree's nested fields (never `entry.raw` again) and
    // builds the fresh projected copy in the same pass.
    projectedConditions.push(projectCondition(entry.condition, acc, 0));

    patternProblems.push(...acc.patternProblems);
    tooDeepProblems.push(...acc.tooDeepProblems);
    unknownReferenceProblems.push(...acc.unknownReferenceProblems);
    declarationProblems.push(...acc.declarationProblems);
  }

  return {
    patternProblems,
    tooDeepProblems,
    unknownReferenceProblems,
    declarationProblems,
    projectedConditions,
  };
}
