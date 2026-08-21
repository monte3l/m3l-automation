/**
 * `internal/procedure/validate/conditions` — walks every case's condition
 * tree exactly once, both validating (pattern safety, depth bound, unknown
 * references, literal scalar-ness) and, in the SAME pass, constructing a
 * fresh, plain, primitives-only projected copy of the tree. The leaf-level
 * validators this walk calls at each node (operator membership, pattern
 * safety, scalar-literal checks, discriminant rendering) live in the sibling
 * `./condition-literals.js` — this file owns only the recursive
 * walk-and-project orchestration and its accumulator state.
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
 * `M3L_PROCEDURE_CONDITION_MAX_DEPTH` like any other too-deep tree — **and**
 * by a total-visit counter ({@link M3L_PROCEDURE_CONDITION_MAX_NODE_VISITS}),
 * incremented on every node visited regardless of depth or identity. The
 * depth bound alone only stops a chain; it does nothing for BREADTH — a
 * shared/aliased sub-tree referenced multiple times by one parent (e.g. an
 * `and` node whose `operands` array holds three references to itself) makes
 * a fresh projected node get allocated per *visit*, not per unique input
 * object, so branching-factor `^` depth visits are possible well within the
 * depth bound. A legal, non-circular DAG can reproduce the same explosion on
 * the success path, so this is a genuine unbounded-breadth bound, not merely
 * a circularity guard.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3L_PROCEDURE_CONDITION_MAX_DEPTH } from "../../../core/procedure/types.js";

import {
  describeInvalidLiteral,
  describeUnknownDiscriminant,
  isPatternSafe,
  isValidCompareOperator,
  isValidScalarLiteral,
} from "./condition-literals.js";
import {
  DANGEROUS_KEYS,
  MAX_REFERENCE_ARRAY_LENGTH,
  field,
  problem,
} from "./shared.js";
import type { NormalizedCase } from "./shared.js";
import type { M3LProcedureValidationProblem } from "../../../core/procedure/build-types.js";

/**
 * Ceiling on the TOTAL number of condition nodes visited while projecting
 * one case's condition tree — distinct from
 * {@link M3L_PROCEDURE_CONDITION_MAX_DEPTH}, which only bounds recursion
 * DEPTH and does nothing to stop an aliased sub-tree from being visited an
 * exponential number of times at a legal depth. Internal build-time safety
 * bound only — not part of the documented public contract, so it is not
 * re-exported through the public barrel. A few thousand is generous for any
 * legitimate, hand-authored condition tree (depth 16 with reasonable
 * branching per level is nowhere close to this) while remaining firm against
 * the demonstrated exploit (a handful of aliased nodes reaching millions of
 * visits well under the depth bound).
 */
const M3L_PROCEDURE_CONDITION_MAX_NODE_VISITS = 5000;

interface ConditionWalkAccumulator {
  readonly caseId: string;
  readonly knownStepIds: ReadonlySet<string>;
  readonly knownParameterNames: ReadonlySet<string>;
  readonly patternProblems: M3LProcedureValidationProblem[];
  readonly tooDeepProblems: M3LProcedureValidationProblem[];
  readonly unknownReferenceProblems: M3LProcedureValidationProblem[];
  readonly declarationProblems: M3LProcedureValidationProblem[];
  /**
   * Mutable list, shared across one case's whole walk, whose LENGTH counts
   * every {@link projectCondition} visit regardless of depth or object
   * identity — see the module doc for why the depth bound alone cannot stop
   * an aliased sub-tree from being visited an exponential number of times.
   * Mutated only via `.push()`, never property assignment, matching every
   * other accumulator field in this file — a plain `count` property would
   * trip `no-param-reassign`'s `props: true` check on `acc`.
   */
  readonly nodeVisits: unknown[];
}

/**
 * Fresh copy of a reference's `path`, filtering any non-string entry —
 * mirrors `normalizeJumpsTo`'s filter-and-copy shape. Returns `undefined`
 * when there is nothing to carry (never an empty array). A non-array `path`
 * stays `undefined` with no problem reported — there is simply nothing to
 * carry. A `path` that IS an array but declares more than
 * {@link MAX_REFERENCE_ARRAY_LENGTH} entries is a genuinely malformed
 * declaration: silently projecting it to `undefined` (as a length-only
 * sparse array otherwise would, forcing `.filter()` to perform one
 * `HasProperty` check per declared index) would make the reference resolve
 * the ROOT value instead of the nested one it was written to reach — a
 * caller-visible correctness bug, not just a cost concern — so this reports
 * `ERR_PROCEDURE_INVALID_DECLARATION` instead.
 */
function projectPath(
  rawPath: unknown,
  acc: ConditionWalkAccumulator,
): readonly string[] | undefined {
  if (!Array.isArray(rawPath)) {
    return undefined;
  }
  if (rawPath.length > MAX_REFERENCE_ARRAY_LENGTH) {
    acc.declarationProblems.push(
      problem({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: case '${acc.caseId}' has a reference path array with more than ${MAX_REFERENCE_ARRAY_LENGTH} entries`,
        caseId: acc.caseId,
      }),
    );
    return undefined;
  }
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
  const path = projectPath(field(reference, "path"), acc);
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
  const path = projectPath(field(reference, "path"), acc);
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
  const path = projectPath(field(reference, "path"), acc);
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
  if (reference === null || typeof reference !== "object") {
    acc.declarationProblems.push(
      problem({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: case '${acc.caseId}' has a reference that is not an object (received ${describeUnknownDiscriminant(reference)})`,
        caseId: acc.caseId,
      }),
    );
    return undefined;
  }
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

/**
 * Reports the too-deep/too-large problem at most once per case, regardless
 * of how many branches independently trip either bound. Reused for BOTH the
 * depth bound and the node-visit-count bound — see the module doc — since
 * both describe the same underlying condition: this case's tree is too
 * large to build safely.
 */
function reportConditionTooLarge(acc: ConditionWalkAccumulator): void {
  if (acc.tooDeepProblems.length > 0) return;
  acc.tooDeepProblems.push(
    problem({
      code: "ERR_PROCEDURE_CONDITION_TOO_DEEP",
      message: `M3LProcedure: case '${acc.caseId}' condition nests past the max depth or visits too many total nodes`,
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

/**
 * Projects a `compare` node, validating `operator` against the six literals
 * `M3LProcedureCompareOperator` admits — the defect fix: before this, ANY
 * string (a typo, a garbage value) flowed straight through into the runtime
 * case table and the digest, unvalidated, mirroring how an unrecognized
 * condition `kind` or reference `source` is now handled.
 */
function projectCompareNode(
  condition: unknown,
  acc: ConditionWalkAccumulator,
): unknown {
  const left = projectReference(field(condition, "left"), acc);
  const operator = field(condition, "operator");
  const right = projectReference(field(condition, "right"), acc);
  if (!isValidCompareOperator(operator)) {
    acc.declarationProblems.push(
      problem({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: case '${acc.caseId}' has a compare condition with an unrecognized operator '${describeUnknownDiscriminant(operator)}'`,
        caseId: acc.caseId,
      }),
    );
  }
  return {
    kind: "compare",
    left,
    operator: isValidCompareOperator(operator) ? operator : "",
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
 * depth counter increments on every descent independent of object identity
 * — AND bounded to at most {@link M3L_PROCEDURE_CONDITION_MAX_NODE_VISITS}
 * total visits across the whole tree, checked and incremented on every
 * single call regardless of depth: an aliased sub-tree referenced multiple
 * times by one parent is visited (and a fresh node allocated) once per
 * occurrence, not once per unique object, so the depth bound alone cannot
 * stop `branchingFactor ^ depth` visits from happening at a legal, shallow
 * depth. A non-object condition (a garbage `kind`-less value some caller
 * substituted for a real node) is likewise `ERR_PROCEDURE_INVALID_DECLARATION`
 * rather than silently projecting to `undefined`.
 */
function projectCondition(
  condition: unknown,
  acc: ConditionWalkAccumulator,
  depth: number,
): unknown {
  acc.nodeVisits.push(undefined);
  if (
    acc.nodeVisits.length > M3L_PROCEDURE_CONDITION_MAX_NODE_VISITS ||
    depth > M3L_PROCEDURE_CONDITION_MAX_DEPTH
  ) {
    reportConditionTooLarge(acc);
    return undefined;
  }
  if (condition === null || typeof condition !== "object") {
    acc.declarationProblems.push(
      problem({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: case '${acc.caseId}' has a condition that is not an object (received ${describeUnknownDiscriminant(condition)})`,
        caseId: acc.caseId,
      }),
    );
    return undefined;
  }
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
      nodeVisits: [],
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
