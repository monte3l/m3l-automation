/**
 * `internal/procedure/evaluate` — the recursive condition evaluator: walks a
 * {@link M3LProcedureCondition} tree, dispatching each leaf kind to
 * `internal/procedure/resolve` and `internal/procedure/equality`, and
 * assembling the mirrored {@link M3LProcedureConditionEvaluation} tree.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 * `evaluateProcedureCondition` (`core/procedure/conditions.ts`) is a thin
 * public delegation to {@link evaluateCondition} below.
 */

import { deepEqual } from "./equality.js";
import { applyMatchesPattern, resolveReference } from "./resolve.js";
import { isArray, isPlainObject, isString } from "../../core/utils/guards.js";

import type {
  M3LProcedureCompareOperator,
  M3LProcedureCondition,
  M3LProcedureConditionEvaluation,
  M3LProcedureConditionKind,
  M3LProcedureConditionScope,
  M3LProcedureShape,
  M3LProcedureValue,
} from "../../core/procedure/types.js";
import { M3L_PROCEDURE_CONDITION_MAX_DEPTH } from "../../core/procedure/types.js";

/**
 * Every declared {@link M3LProcedureConditionKind}, keyed for an
 * `Object.hasOwn` membership check rather than a hand-maintained array —
 * adding or removing a condition kind without updating this map is a
 * compile error, the same guarantee `CATEGORY_RANK`-style lookups rely on
 * elsewhere in this codebase.
 */
const CONDITION_KINDS: Record<M3LProcedureConditionKind, true> = {
  compare: true,
  matches: true,
  contains: true,
  exists: true,
  and: true,
  or: true,
  not: true,
};

/**
 * True when `value` has the minimal shape every {@link M3LProcedureCondition}
 * node shares: a plain object whose `kind` is one of the seven declared
 * condition kinds. `evaluateCondition` is public and documented as callable
 * directly, bypassing `build()`'s own tree validation — so `and`/`or`/`not`
 * recursing into an operand that was never proven to even be kind-shaped
 * would fall through the exhaustive `switch`'s `default` arm with a value
 * that isn't a real {@link M3LProcedureCondition}, which is exactly the
 * crash this guard exists to prevent. Mirrors `applyMatchesPattern`
 * (`internal/procedure/resolve.ts`), the in-file precedent for defending
 * this evaluator against exactly this kind of unvalidated direct-call input.
 */
function isConditionNode<TShape extends M3LProcedureShape>(
  value: unknown,
): value is M3LProcedureCondition<TShape> {
  return (
    isPlainObject(value) &&
    isString(value["kind"]) &&
    Object.hasOwn(CONDITION_KINDS, value["kind"])
  );
}

/** The result of {@link evaluateOperandsSafely}: the evaluated conforming
 * operands, plus how many raw entries were dropped by the shape filter —
 * tracked so `and`/`or` can render the same "malformed operand" visibility
 * `not` already gives its own single-operand case, instead of silently
 * shrinking the operand count. */
interface OperandsEvaluation {
  readonly operands: M3LProcedureConditionEvaluation[];
  readonly malformedCount: number;
}

/**
 * Evaluates `rawOperands` for an `and`/`or` node, degrading to an empty
 * evaluation list instead of throwing when `rawOperands` isn't the
 * non-empty array of well-formed condition nodes the type declares — any
 * operand that fails {@link isConditionNode}'s shape check is dropped
 * rather than recursed into, and counted in `malformedCount` instead. Kept
 * total: this function is a pure array transform and never throws.
 */
function evaluateOperandsSafely<TShape extends M3LProcedureShape>(
  rawOperands: unknown,
  scope: M3LProcedureConditionScope<TShape>,
  depth: number,
): OperandsEvaluation {
  if (!isArray(rawOperands)) return { operands: [], malformedCount: 0 };
  const conforming = rawOperands.filter(isConditionNode<TShape>);
  return {
    operands: conforming.map((operand) =>
      evaluateCondition(operand, scope, depth + 1),
    ),
    malformedCount: rawOperands.length - conforming.length,
  };
}

/**
 * Joins each operand's rendered `detail` with `connective`, appending a
 * "malformed operand(s)" marker when {@link evaluateOperandsSafely} dropped
 * any raw entry — so a dropped operand is visible in the explanation rather
 * than silently shrinking the joined operand count, matching how
 * `evaluateNotNode` already marks its own single malformed operand.
 */
function joinOperandDetails(
  operands: readonly M3LProcedureConditionEvaluation[],
  malformedCount: number,
  connective: "and" | "or",
): string {
  const parts = operands.map((operand) => operand.detail ?? "");
  if (malformedCount > 0) {
    parts.push(
      `${malformedCount} malformed operand${malformedCount === 1 ? "" : "s"}`,
    );
  }
  return capDetail(parts.join(` ${connective} `));
}

/**
 * Caps a rendered `detail` string so a very long resolved value never leaks
 * into the explanation verbatim — the tree is run-report grade (see the
 * contract's Explainability section) but still meant to be short prose.
 */
const DETAIL_MAX_LENGTH = 200;

function capDetail(detail: string): string {
  return detail.length > DETAIL_MAX_LENGTH
    ? `${detail.slice(0, DETAIL_MAX_LENGTH - 1)}…`
    : detail;
}

/**
 * Renders a resolved value for `detail` prose — never the reference name.
 * `JSON.stringify` throws on a circular structure; a resolved value is
 * caller data this evaluator must stay total over (see the self-referential
 * `contains`/`compare` regression tests), so a render failure degrades to a
 * placeholder rather than propagating.
 */
function renderValue(value: M3LProcedureValue | undefined): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value))
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unrenderable value]";
  }
}

/** Both sides as a numeric pair, or `undefined` when either isn't a real number. */
function asNumberPair(
  left: M3LProcedureValue | undefined,
  right: M3LProcedureValue | undefined,
): readonly [number, number] | undefined {
  if (typeof left !== "number" || typeof right !== "number") return undefined;
  if (Number.isNaN(left) || Number.isNaN(right)) return undefined;
  return [left, right];
}

/** One of the four ordering operators, dispatched once both sides are proven real numbers. */
function evaluateOrderingOperator(
  operator: ">" | ">=" | "<" | "<=",
  pair: readonly [number, number],
): boolean {
  const [left, right] = pair;
  switch (operator) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    default: {
      /* istanbul ignore next -- unreachable: every ordering operator is
         handled above; this arm exists only to fail loud if a new one is
         ever added without a matching case. */
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

/**
 * Evaluates one `compare` operator over two already-resolved values.
 * `==`/`!=` use deep structural equality; the four ordering operators
 * require both sides to be non-`NaN` numbers, per the contract's `compare`
 * arm semantics — never coerced, never lexical.
 */
function evaluateCompareOperator(
  operator: M3LProcedureCompareOperator,
  left: M3LProcedureValue | undefined,
  right: M3LProcedureValue | undefined,
): boolean {
  if (operator === "==") return deepEqual(left, right, 0);
  if (operator === "!=") return !deepEqual(left, right, 0);
  const pair = asNumberPair(left, right);
  return pair !== undefined && evaluateOrderingOperator(operator, pair);
}

/** `contains`: array membership by deep equality, or string substring containment. */
function evaluateContains(
  subject: M3LProcedureValue | undefined,
  item: M3LProcedureValue | undefined,
): boolean {
  if (Array.isArray(subject)) {
    return subject.some((element) => deepEqual(element, item, 0));
  }
  if (typeof subject === "string") {
    return typeof item === "string" && subject.includes(item);
  }
  return false;
}

function evaluateCompareNode<TShape extends M3LProcedureShape>(
  condition: Extract<
    M3LProcedureCondition<TShape>,
    { readonly kind: "compare" }
  >,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureConditionEvaluation {
  const left = resolveReference(condition.left, scope);
  const right = resolveReference(condition.right, scope);
  const satisfied = evaluateCompareOperator(
    condition.operator,
    left.resolved,
    right.resolved,
  );
  const detail = capDetail(
    `${renderValue(left.resolved)} ${condition.operator} ${renderValue(right.resolved)}`,
  );
  return {
    kind: "compare",
    satisfied,
    references: [left, right],
    operands: [],
    detail,
  };
}

function evaluateMatchesNode<TShape extends M3LProcedureShape>(
  condition: Extract<
    M3LProcedureCondition<TShape>,
    { readonly kind: "matches" }
  >,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureConditionEvaluation {
  const subject = resolveReference(condition.subject, scope);
  const applied = applyMatchesPattern(
    subject,
    condition.pattern,
    condition.ignoreCase ?? false,
  );
  const flags = condition.ignoreCase === true ? "i" : "";
  const detail = capDetail(
    `${renderValue(applied.reference.resolved)} matches /${condition.pattern}/${flags}`,
  );
  return {
    kind: "matches",
    satisfied: applied.satisfied,
    references: [applied.reference],
    operands: [],
    detail,
  };
}

function evaluateContainsNode<TShape extends M3LProcedureShape>(
  condition: Extract<
    M3LProcedureCondition<TShape>,
    { readonly kind: "contains" }
  >,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureConditionEvaluation {
  const subject = resolveReference(condition.subject, scope);
  const item = resolveReference(condition.item, scope);
  const satisfied = evaluateContains(subject.resolved, item.resolved);
  const detail = capDetail(
    `${renderValue(subject.resolved)} contains ${renderValue(item.resolved)}`,
  );
  return {
    kind: "contains",
    satisfied,
    references: [subject, item],
    operands: [],
    detail,
  };
}

function evaluateExistsNode<TShape extends M3LProcedureShape>(
  condition: Extract<
    M3LProcedureCondition<TShape>,
    { readonly kind: "exists" }
  >,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureConditionEvaluation {
  const subject = resolveReference(condition.subject, scope);
  const detail = capDetail(`${subject.reference} exists`);
  return {
    kind: "exists",
    satisfied: subject.present,
    references: [subject],
    operands: [],
    detail,
  };
}

function evaluateAndNode<TShape extends M3LProcedureShape>(
  condition: Extract<M3LProcedureCondition<TShape>, { readonly kind: "and" }>,
  scope: M3LProcedureConditionScope<TShape>,
  depth: number,
): M3LProcedureConditionEvaluation {
  const { operands, malformedCount } = evaluateOperandsSafely(
    condition.operands,
    scope,
    depth,
  );
  return {
    kind: "and",
    // A malformed (non-array, or emptied-by-filtering) `operands` degrades
    // to `false`, not the vacuous-truth `true` an empty `.every()` would
    // otherwise report — an `and` with nothing genuinely evaluated is not
    // "satisfied".
    satisfied:
      operands.length > 0 && operands.every((operand) => operand.satisfied),
    references: [],
    operands,
    detail: joinOperandDetails(operands, malformedCount, "and"),
  };
}

function evaluateOrNode<TShape extends M3LProcedureShape>(
  condition: Extract<M3LProcedureCondition<TShape>, { readonly kind: "or" }>,
  scope: M3LProcedureConditionScope<TShape>,
  depth: number,
): M3LProcedureConditionEvaluation {
  const { operands, malformedCount } = evaluateOperandsSafely(
    condition.operands,
    scope,
    depth,
  );
  return {
    kind: "or",
    // `.some()` on an empty (malformed-input) array already degrades to
    // `false`, matching `and`'s deliberate fail-closed degrade above.
    satisfied: operands.some((operand) => operand.satisfied),
    references: [],
    operands,
    detail: joinOperandDetails(operands, malformedCount, "or"),
  };
}

function evaluateNotNode<TShape extends M3LProcedureShape>(
  condition: Extract<M3LProcedureCondition<TShape>, { readonly kind: "not" }>,
  scope: M3LProcedureConditionScope<TShape>,
  depth: number,
): M3LProcedureConditionEvaluation {
  const rawOperand: unknown = condition.operand;
  if (!isConditionNode<TShape>(rawOperand)) {
    // A malformed `operand` degrades to `false` rather than recursing into
    // `evaluateCondition` with something that was never proven to be a real
    // condition node — see `isConditionNode`'s TSDoc. Nothing was genuinely
    // evaluated here either, so this is a refusal like the main branch below.
    return {
      kind: "not",
      satisfied: false,
      refused: true,
      references: [],
      operands: [],
      detail: capDetail("not (malformed operand)"),
    };
  }
  const operand = evaluateCondition(rawOperand, scope, depth + 1);
  if (operand.refused) {
    // The child couldn't be genuinely evaluated (degraded, too-deep, or
    // shape-malformed) — all of which already report `satisfied: false`.
    // Inverting that would report `not` as satisfied even though nothing was
    // actually evaluated, a fail-open in the engine's decision path. Propagate
    // the refusal instead of inverting.
    return {
      kind: "not",
      satisfied: false,
      refused: true,
      references: [],
      operands: [operand],
      detail: capDetail(`not (${operand.detail ?? ""})`),
    };
  }
  return {
    kind: "not",
    satisfied: !operand.satisfied,
    references: [],
    operands: [operand],
    detail: capDetail(`not (${operand.detail ?? ""})`),
  };
}

/**
 * The evaluation returned when the ROOT `condition` argument to
 * {@link evaluateCondition} fails {@link isConditionNode}'s shape check —
 * the root-node counterpart to {@link evaluateNotNode}'s malformed-operand
 * branch. Unlike that branch, there is no parent-declared `kind` to fall
 * back on here: a malformed root has no trustworthy field to read at all,
 * and {@link M3LProcedureConditionEvaluation}'s `kind` has no "unknown" or
 * "invalid" member to report instead. `"exists"` is therefore a fixed,
 * documented placeholder — the actual "malformed" signal lives in
 * `satisfied: false` and `detail`, never in `kind`.
 */
function malformedRootEvaluation(): M3LProcedureConditionEvaluation {
  return {
    kind: "exists",
    satisfied: false,
    refused: true,
    references: [],
    operands: [],
    detail: capDetail("condition is malformed (not a recognised node)"),
  };
}

/** The evaluation returned once condition-tree nesting exceeds the bound, without recursing further. */
function tooDeepEvaluation<TShape extends M3LProcedureShape>(
  condition: M3LProcedureCondition<TShape>,
): M3LProcedureConditionEvaluation {
  return {
    kind: condition.kind,
    satisfied: false,
    refused: true,
    references: [],
    operands: [],
    detail: capDetail("condition nesting exceeds the max depth"),
  };
}

/**
 * The evaluation returned when dispatching a condition node throws — a
 * hostile getter or `Proxy` on caller-supplied `values`/`parameters`/step
 * `output` reads as a plain property access throughout
 * `internal/procedure/resolve.ts`, so a throwing accessor propagates as a
 * raw exception unless the public evaluator degrades it here. Mirrors
 * `applyMatchesPattern`'s own `refused: "invalid-pattern"` degradation: a
 * documented failure mode, not a crash. The caught error's own `message` is
 * never echoed — it originated from the caller's own hostile object and
 * could carry anything — so `detail` stays a generic, safe string.
 */
function degradedEvaluation<TShape extends M3LProcedureShape>(
  condition: M3LProcedureCondition<TShape>,
): M3LProcedureConditionEvaluation {
  return {
    kind: condition.kind,
    satisfied: false,
    refused: true,
    references: [],
    operands: [],
    detail: capDetail("evaluation failed: a value could not be read"),
  };
}

/**
 * Dispatches one condition node to its evaluator, by `kind`. Split out of
 * {@link evaluateCondition} purely to keep that function's own cyclomatic
 * complexity low around its `try`/`catch`; not otherwise meaningful on its
 * own.
 */
function dispatchCondition<TShape extends M3LProcedureShape>(
  condition: M3LProcedureCondition<TShape>,
  scope: M3LProcedureConditionScope<TShape>,
  depth: number,
): M3LProcedureConditionEvaluation {
  switch (condition.kind) {
    case "compare":
      return evaluateCompareNode(condition, scope);
    case "matches":
      return evaluateMatchesNode(condition, scope);
    case "contains":
      return evaluateContainsNode(condition, scope);
    case "exists":
      return evaluateExistsNode(condition, scope);
    case "and":
      return evaluateAndNode(condition, scope, depth);
    case "or":
      return evaluateOrNode(condition, scope, depth);
    case "not":
      return evaluateNotNode(condition, scope, depth);
    default: {
      /* istanbul ignore next -- unreachable: every M3LProcedureConditionKind
         is handled above; this arm exists only to fail loud if a new kind is
         ever added without a matching case. */
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * Evaluates a {@link M3LProcedureCondition} tree against `scope`. Total —
 * every arm resolves to a boolean without throwing, even when a hostile
 * getter or `Proxy` on caller-supplied state throws mid-evaluation (that
 * degrades to {@link degradedEvaluation} rather than propagating) — and
 * `and`/`or` deliberately do not short-circuit, so every operand's
 * evaluation appears in the returned tree even once the connective's
 * result is already known.
 *
 * `depth` bounds condition-tree nesting by
 * {@link M3L_PROCEDURE_CONDITION_MAX_DEPTH} (inclusive), guarding a
 * pathologically deep tree built by a caller who invokes this evaluator
 * directly rather than through `build()` (which validates tree depth
 * up front, in a later pass). A root `condition` that fails
 * {@link isConditionNode}'s shape check — another consequence of this
 * evaluator being callable directly, bypassing `build()`'s tree validation —
 * also degrades (to {@link malformedRootEvaluation}) rather than reaching
 * the exhaustive dispatch `switch`.
 */
export function evaluateCondition<TShape extends M3LProcedureShape>(
  condition: M3LProcedureCondition<TShape>,
  scope: M3LProcedureConditionScope<TShape>,
  depth = 0,
): M3LProcedureConditionEvaluation {
  if (!isConditionNode<TShape>(condition)) return malformedRootEvaluation();
  if (depth > M3L_PROCEDURE_CONDITION_MAX_DEPTH)
    return tooDeepEvaluation(condition);

  try {
    return dispatchCondition(condition, scope, depth);
  } catch {
    return degradedEvaluation(condition);
  }
}
