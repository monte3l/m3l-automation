/**
 * `internal/procedure/validate` — collects every {@link
 * M3LProcedureValidationProblem} `M3LProcedureBuilder.build()` finds in a
 * definition, in the documented table order, then throws exactly one
 * `M3LProcedureInvalidDefinitionError` carrying all of them - never one
 * rejection at a time. Modelled closely on `internal/pipeline/validate.ts`,
 * including its `renderMessage` one-vs-many shape.
 *
 * `ERR_PROCEDURE_INVALID_DECLARATION` (a non-finite case priority, a
 * non-finite condition `literal`, ...) is collected alongside every other
 * check, all BEFORE `M3LProcedureBuilder.build()` ever calls
 * `canonicalJsonHash` - that hash rejects a non-finite number with
 * `ERR_INVALID_ARGUMENT`, a code this contract does not name, so the digest
 * is only ever computed once this module confirms zero problems.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isNonEmptyString } from "../../core/utils/guards.js";

import { findProcedureCycles } from "./graph.js";

import {
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_PATTERN_LENGTH,
} from "../../core/procedure/types.js";
import type { M3LProcedureValidationProblem } from "../../core/procedure/types.js";

/**
 * Keys that never resolve as a reference segment or a declared name - a
 * `__proto__`, `constructor` or `prototype` value/parameter key is refused
 * unconditionally, mirroring `internal/procedure/resolve.ts`'s path-walk
 * rule.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The minimum repeat count that makes an id/priority "duplicated". */
const DUPLICATE_THRESHOLD = 2;

/** Safe own-property reader over an `unknown` - an untyped caller's raw declaration may be anything. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------
// Raw input this module validates
// ---------------------------------------------------------------------------

/** The raw, not-yet-validated pieces `M3LProcedureBuilder.build()` hands to this module. */
export interface RawProcedureInput {
  readonly name: unknown;
  readonly steps: readonly unknown[];
  readonly cases: readonly unknown[];
  readonly fallback: unknown;
  /** Declared via `M3LProcedureBuilder.parameters()`; empty when never called. */
  readonly declaredParameters: readonly string[];
  readonly revision: string | undefined;
}

/** One summary-projection step, already validated - see `M3LProcedureSummary`. */
export interface ValidatedStepProjection {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly continueOnFailure: boolean;
  readonly jumpsTo: readonly string[];
  readonly loop:
    { readonly reason: string; readonly maxRevisits: number } | undefined;
}

/** One summary-projection case, already validated - see `M3LProcedureSummary`. */
export interface ValidatedCaseProjection {
  readonly id: string;
  readonly description: string;
  readonly prose: string;
  readonly priority: number;
  readonly condition: unknown;
}

/** The validated pieces this module hands back once zero problems were found. */
export interface ValidatedProcedureDefinition {
  readonly name: string;
  readonly revision: string | undefined;
  readonly steps: readonly ValidatedStepProjection[];
  readonly cases: readonly ValidatedCaseProjection[];
  readonly fallback: { readonly description: string; readonly prose: string };
  readonly parameters: readonly string[];
}

// ---------------------------------------------------------------------------
// Step normalization
// ---------------------------------------------------------------------------

interface NormalizedStep {
  readonly raw: unknown;
  readonly index: number;
  readonly rawId: unknown;
  readonly id: string;
  readonly hasValidId: boolean;
  readonly jumpsTo: readonly string[];
  readonly hasLoop: boolean;
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

/** The empty-or-non-string step id declaration problem, or nothing when `id` is valid. */
function checkStepIdDeclaration(
  hasValidId: boolean,
  index: number,
): readonly M3LProcedureValidationProblem[] {
  if (hasValidId) return [];
  return [
    {
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step at index ${index} has an empty or non-string id`,
    },
  ];
}

/** The empty-or-non-string step label declaration problem, or nothing when `label` is valid. */
function checkStepLabelDeclaration(
  raw: unknown,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  const rawLabel = field(raw, "label");
  if (isNonEmptyString(rawLabel)) return [];
  const extra = hasValidId ? { stepId: id } : {};
  return [
    {
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has an empty or non-string label`,
      ...extra,
    },
  ];
}

/** A finite-integer-greater-than-0 `maxRevisits`, or nothing when `loop` is absent. */
function checkStepLoopDeclaration(
  raw: unknown,
  id: string,
  hasValidId: boolean,
): readonly M3LProcedureValidationProblem[] {
  const rawLoop = field(raw, "loop");
  if (rawLoop === undefined || rawLoop === null) return [];

  const maxRevisits = field(rawLoop, "maxRevisits");
  const isValidMaxRevisits =
    typeof maxRevisits === "number" &&
    Number.isInteger(maxRevisits) &&
    maxRevisits > 0;
  if (isValidMaxRevisits) return [];

  const extra = hasValidId ? { stepId: id } : {};
  return [
    {
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: step '${id}' has a loop.maxRevisits that is not a finite integer greater than 0`,
      ...extra,
    },
  ];
}

function normalizeStep(raw: unknown, index: number): NormalizedStep {
  const rawId = field(raw, "id");
  const hasValidId = isNonEmptyString(rawId);
  const id = hasValidId ? rawId : `#invalid-step-${index}`;

  const rawJumpsTo = field(raw, "jumpsTo");
  const jumpsTo: readonly string[] = Array.isArray(rawJumpsTo)
    ? rawJumpsTo.filter((entry): entry is string => typeof entry === "string")
    : [];

  const rawLoop = field(raw, "loop");
  const hasLoop = rawLoop !== undefined && rawLoop !== null;

  return {
    raw,
    index,
    rawId,
    id,
    hasValidId,
    jumpsTo,
    hasLoop,
    declarationProblems: [
      ...checkStepIdDeclaration(hasValidId, index),
      ...checkStepLabelDeclaration(raw, id, hasValidId),
      ...checkStepLoopDeclaration(raw, id, hasValidId),
    ],
  };
}

// ---------------------------------------------------------------------------
// Case normalization
// ---------------------------------------------------------------------------

interface NormalizedCase {
  readonly raw: unknown;
  readonly index: number;
  readonly rawId: unknown;
  readonly id: string;
  readonly hasValidId: boolean;
  readonly priority: unknown;
  readonly hasValidPriority: boolean;
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

function normalizeCase(raw: unknown, index: number): NormalizedCase {
  const rawId = field(raw, "id");
  const hasValidId = isNonEmptyString(rawId);
  const id = hasValidId ? rawId : `#invalid-case-${index}`;
  const problems: M3LProcedureValidationProblem[] = [];

  if (!hasValidId) {
    problems.push({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: case at index ${index} has an empty or non-string id`,
    });
  }

  const priority = field(raw, "priority");
  const hasValidPriority =
    typeof priority === "number" && Number.isFinite(priority);
  if (!hasValidPriority) {
    const extra = hasValidId ? { caseId: id } : {};
    problems.push({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: case '${id}' has a priority that is not a finite number`,
      ...extra,
    });
  }

  return {
    raw,
    index,
    rawId,
    id,
    hasValidId,
    priority,
    hasValidPriority,
    declarationProblems: problems,
  };
}

// ---------------------------------------------------------------------------
// 1. Empty steps
// ---------------------------------------------------------------------------

function checkEmptySteps(
  steps: readonly unknown[],
): readonly M3LProcedureValidationProblem[] {
  if (steps.length > 0) return [];
  return [
    {
      code: "ERR_PROCEDURE_EMPTY_STEPS",
      message: "M3LProcedure: build() requires at least one declared step",
    },
  ];
}

// ---------------------------------------------------------------------------
// 2 / 5. Duplicate step / case ids
// ---------------------------------------------------------------------------

interface DuplicatableEntry {
  readonly rawId: unknown;
  readonly id: string;
  readonly hasValidId: boolean;
}

/** Every `rawId` that repeats across `entries`, each reported once regardless of repeat count. */
function findDuplicateEntries(
  entries: readonly DuplicatableEntry[],
): readonly DuplicatableEntry[] {
  const counts = new Map<unknown, number>();
  for (const entry of entries) {
    counts.set(entry.rawId, (counts.get(entry.rawId) ?? 0) + 1);
  }

  const duplicates: DuplicatableEntry[] = [];
  const reported = new Set<unknown>();
  for (const entry of entries) {
    if (reported.has(entry.rawId)) continue;
    if ((counts.get(entry.rawId) ?? 0) <= 1) continue;
    reported.add(entry.rawId);
    duplicates.push(entry);
  }
  return duplicates;
}

function checkDuplicateStepIds(
  steps: readonly DuplicatableEntry[],
): readonly M3LProcedureValidationProblem[] {
  return findDuplicateEntries(steps).map((entry) => {
    const label = entry.hasValidId ? `'${entry.id}'` : String(entry.rawId);
    const extra = entry.hasValidId ? { stepId: entry.id } : {};
    return {
      code: "ERR_PROCEDURE_DUPLICATE_STEP_ID",
      message: `M3LProcedure: two or more steps share the id ${label}`,
      ...extra,
    };
  });
}

function checkDuplicateCaseIds(
  cases: readonly DuplicatableEntry[],
): readonly M3LProcedureValidationProblem[] {
  return findDuplicateEntries(cases).map((entry) => {
    const label = entry.hasValidId ? `'${entry.id}'` : String(entry.rawId);
    const extra = entry.hasValidId ? { caseId: entry.id } : {};
    return {
      code: "ERR_PROCEDURE_DUPLICATE_CASE_ID",
      message: `M3LProcedure: two or more cases share the id ${label}`,
      ...extra,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Invalid jump target
// ---------------------------------------------------------------------------

function checkInvalidJumpTargets(
  steps: readonly NormalizedStep[],
  knownStepIds: ReadonlySet<string>,
): readonly M3LProcedureValidationProblem[] {
  const problems: M3LProcedureValidationProblem[] = [];
  for (const step of steps) {
    for (const target of step.jumpsTo) {
      if (knownStepIds.has(target)) continue;
      const extra = step.hasValidId ? { stepId: step.id } : {};
      problems.push({
        code: "ERR_PROCEDURE_INVALID_JUMP_TARGET",
        message: `M3LProcedure: step '${step.id}' has a jumpsTo entry naming an undeclared step '${target}'`,
        ...extra,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 4. Cycle detection
// ---------------------------------------------------------------------------

function checkCycles(
  steps: readonly NormalizedStep[],
): readonly M3LProcedureValidationProblem[] {
  const graphSteps = steps.map((step) => ({
    id: step.id,
    jumpsTo: step.jumpsTo,
    hasLoop: step.hasLoop,
  }));
  const cycles = findProcedureCycles(graphSteps);
  return cycles.map((path) => ({
    code: "ERR_PROCEDURE_CYCLE_DETECTED" as const,
    message: `M3LProcedure: cycle detected in the step graph: ${path
      .map((id) => `'${id}'`)
      .join(
        " -> ",
      )} (annotate the jumping step with \`loop\` if this repetition is deliberate)`,
    path,
  }));
}

// ---------------------------------------------------------------------------
// 6. Duplicate case priority
// ---------------------------------------------------------------------------

function checkDuplicateCasePriorities(
  cases: readonly NormalizedCase[],
): readonly M3LProcedureValidationProblem[] {
  const byPriority = new Map<number, string[]>();
  for (const entry of cases) {
    if (!entry.hasValidPriority) continue;
    const priority = entry.priority as number;
    const list = byPriority.get(priority) ?? [];
    list.push(entry.id);
    byPriority.set(priority, list);
  }

  const problems: M3LProcedureValidationProblem[] = [];
  for (const [priority, ids] of byPriority) {
    if (ids.length < DUPLICATE_THRESHOLD) continue;
    problems.push({
      code: "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY",
      message: `M3LProcedure: cases share priority ${priority}: ${ids
        .map((id) => `'${id}'`)
        .join(", ")}`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 7. Missing / malformed fallback
// ---------------------------------------------------------------------------

function checkFallback(
  fallback: unknown,
): readonly M3LProcedureValidationProblem[] {
  if (
    fallback === undefined ||
    fallback === null ||
    typeof fallback !== "object"
  ) {
    return [
      {
        code: "ERR_PROCEDURE_MISSING_FALLBACK",
        message: "M3LProcedure: a fallback is required",
      },
    ];
  }

  const action = field(fallback, "action");
  if (typeof action !== "function") {
    return [
      {
        code: "ERR_PROCEDURE_MISSING_FALLBACK",
        message: "M3LProcedure: the fallback must declare an 'action' function",
      },
    ];
  }

  const description = field(fallback, "description");
  const prose = field(fallback, "prose");
  if (!isNonEmptyString(description) || !isNonEmptyString(prose)) {
    return [
      {
        code: "ERR_PROCEDURE_MISSING_FALLBACK",
        message:
          "M3LProcedure: the fallback must declare non-empty 'description' and 'prose' strings",
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// 8 / 9 / 10 / 11 (condition-tree portion). Pattern safety, depth, unknown
// references, and declaration issues discovered while walking every case's
// condition tree.
// ---------------------------------------------------------------------------

/** The scan's two flags: whether the previous character was an unconsumed `\\`, and whether the scan is inside a `[...]` character class. */
interface PatternScanState {
  readonly inEscape: boolean;
  readonly inClass: boolean;
}

/** Whether `char` would repeat a preceding group - the four quantifier starts this scan treats as "quantified". */
function isQuantifierChar(char: string | undefined): boolean {
  return char === "+" || char === "*" || char === "?" || char === "{";
}

/**
 * Advances the scan by one character, returning the next state and whether
 * THIS character is an unescaped, out-of-class `)` immediately followed by a
 * quantifier - the one signal {@link hasQuantifiedGroup} looks for.
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
 * flags - "in escape" and "in character class" - so an escaped `\\)` and a
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

interface ConditionWalkAccumulator {
  readonly caseId: string;
  readonly knownStepIds: ReadonlySet<string>;
  readonly knownParameterNames: ReadonlySet<string>;
  readonly patternProblems: M3LProcedureValidationProblem[];
  readonly tooDeepProblems: M3LProcedureValidationProblem[];
  readonly unknownReferenceProblems: M3LProcedureValidationProblem[];
  readonly declarationProblems: M3LProcedureValidationProblem[];
}

/** A non-finite numeric `literal` is `ERR_PROCEDURE_INVALID_DECLARATION` - see the module doc on ordering relative to `canonicalJsonHash`. */
function walkLiteralReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): void {
  const literal = field(reference, "literal");
  if (typeof literal !== "number" || Number.isFinite(literal)) return;
  acc.declarationProblems.push({
    code: "ERR_PROCEDURE_INVALID_DECLARATION",
    message: `M3LProcedure: case '${acc.caseId}' has a non-finite condition literal (${String(literal)})`,
    caseId: acc.caseId,
  });
}

/** A `step` reference naming an undeclared step is `ERR_PROCEDURE_UNKNOWN_REFERENCE`. */
function walkStepReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): void {
  const step = field(reference, "step");
  if (typeof step !== "string" || acc.knownStepIds.has(step)) return;
  acc.unknownReferenceProblems.push({
    code: "ERR_PROCEDURE_UNKNOWN_REFERENCE",
    message: `M3LProcedure: case '${acc.caseId}' references a step '${step}' that was never declared`,
    caseId: acc.caseId,
  });
}

/**
 * A dangerous `value` key (`__proto__`/`constructor`/`prototype`) is
 * `ERR_PROCEDURE_INVALID_DECLARATION`. No build-time manifest of declared
 * `values` keys exists - there is no `.values()` builder method (only
 * `.parameters()`) - so an ordinary value key can never be flagged unknown
 * here.
 */
function walkValueReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): void {
  const key = field(reference, "key");
  if (typeof key !== "string" || !DANGEROUS_KEYS.has(key)) return;
  acc.declarationProblems.push({
    code: "ERR_PROCEDURE_INVALID_DECLARATION",
    message: `M3LProcedure: case '${acc.caseId}' references a dangerous value key '${key}'`,
    caseId: acc.caseId,
  });
}

/**
 * A dangerous `parameter` key is `ERR_PROCEDURE_INVALID_DECLARATION`
 * (exclusive of the unknown-reference check below); otherwise a key absent
 * from the declared `.parameters()` set is `ERR_PROCEDURE_UNKNOWN_REFERENCE`.
 */
function walkParameterReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): void {
  const key = field(reference, "key");
  if (typeof key !== "string") return;

  if (DANGEROUS_KEYS.has(key)) {
    acc.declarationProblems.push({
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: `M3LProcedure: case '${acc.caseId}' references a dangerous parameter key '${key}'`,
      caseId: acc.caseId,
    });
    return;
  }

  if (acc.knownParameterNames.has(key)) return;
  acc.unknownReferenceProblems.push({
    code: "ERR_PROCEDURE_UNKNOWN_REFERENCE",
    message: `M3LProcedure: case '${acc.caseId}' references parameter '${key}', which was never declared via .parameters()`,
    caseId: acc.caseId,
  });
}

function walkReference(
  reference: unknown,
  acc: ConditionWalkAccumulator,
): void {
  if (reference === null || typeof reference !== "object") return;
  const source = field(reference, "source");

  switch (source) {
    case "literal":
      walkLiteralReference(reference, acc);
      return;
    case "step":
      walkStepReference(reference, acc);
      return;
    case "value":
      walkValueReference(reference, acc);
      return;
    case "parameter":
      walkParameterReference(reference, acc);
      return;
    default:
      return;
  }
}

/** Reports the too-deep problem at most once per case, regardless of how many branches independently trip the depth bound. */
function reportConditionTooDeep(acc: ConditionWalkAccumulator): void {
  if (acc.tooDeepProblems.length > 0) return;
  acc.tooDeepProblems.push({
    code: "ERR_PROCEDURE_CONDITION_TOO_DEEP",
    message: `M3LProcedure: case '${acc.caseId}' condition nests past the max depth`,
    caseId: acc.caseId,
  });
}

function walkMatchesNode(
  condition: unknown,
  acc: ConditionWalkAccumulator,
): void {
  walkReference(field(condition, "subject"), acc);
  const pattern = field(condition, "pattern");
  if (typeof pattern !== "string" || isPatternSafe(pattern)) return;
  acc.patternProblems.push({
    code: "ERR_PROCEDURE_INVALID_PATTERN",
    message: `M3LProcedure: case '${acc.caseId}' has an unsafe 'matches' pattern`,
    caseId: acc.caseId,
  });
}

/** Dispatches one already-depth-checked condition node by its `kind`. */
function walkConditionNode(
  condition: unknown,
  kind: unknown,
  acc: ConditionWalkAccumulator,
  depth: number,
): void {
  switch (kind) {
    case "compare":
      walkReference(field(condition, "left"), acc);
      walkReference(field(condition, "right"), acc);
      return;
    case "matches":
      walkMatchesNode(condition, acc);
      return;
    case "contains":
      walkReference(field(condition, "subject"), acc);
      walkReference(field(condition, "item"), acc);
      return;
    case "exists":
      walkReference(field(condition, "subject"), acc);
      return;
    case "and":
    case "or": {
      const operands = field(condition, "operands");
      if (Array.isArray(operands)) {
        for (const operand of operands) {
          walkCondition(operand, acc, depth + 1);
        }
      }
      return;
    }
    case "not":
      walkCondition(field(condition, "operand"), acc, depth + 1);
      return;
    default:
      return;
  }
}

function walkCondition(
  condition: unknown,
  acc: ConditionWalkAccumulator,
  depth: number,
): void {
  if (depth > M3L_PROCEDURE_CONDITION_MAX_DEPTH) {
    reportConditionTooDeep(acc);
    return;
  }
  if (condition === null || typeof condition !== "object") return;
  walkConditionNode(condition, field(condition, "kind"), acc, depth);
}

interface ConditionWalkResults {
  readonly patternProblems: readonly M3LProcedureValidationProblem[];
  readonly tooDeepProblems: readonly M3LProcedureValidationProblem[];
  readonly unknownReferenceProblems: readonly M3LProcedureValidationProblem[];
  readonly declarationProblems: readonly M3LProcedureValidationProblem[];
}

function walkAllConditions(
  cases: readonly NormalizedCase[],
  knownStepIds: ReadonlySet<string>,
  knownParameterNames: ReadonlySet<string>,
): ConditionWalkResults {
  const patternProblems: M3LProcedureValidationProblem[] = [];
  const tooDeepProblems: M3LProcedureValidationProblem[] = [];
  const unknownReferenceProblems: M3LProcedureValidationProblem[] = [];
  const declarationProblems: M3LProcedureValidationProblem[] = [];

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
    const condition = field(entry.raw, "condition");
    walkCondition(condition, acc, 0);

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
  };
}

// ---------------------------------------------------------------------------
// 11 (non-condition portion). Procedure name, parameter name declarations.
// ---------------------------------------------------------------------------

function checkProcedureName(
  rawName: unknown,
): readonly M3LProcedureValidationProblem[] {
  if (isNonEmptyString(rawName)) return [];
  return [
    {
      code: "ERR_PROCEDURE_INVALID_DECLARATION",
      message: "M3LProcedure: the procedure name must be a non-empty string",
    },
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
      problems.push({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message:
          "M3LProcedure: a declared parameter name must be a non-empty string",
      });
      continue;
    }
    if (DANGEROUS_KEYS.has(name)) {
      problems.push({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: '${name}' is not a safe parameter name`,
      });
      continue;
    }
    if (seen.has(name) && !duplicatesReported.has(name)) {
      duplicatesReported.add(name);
      problems.push({
        code: "ERR_PROCEDURE_INVALID_DECLARATION",
        message: `M3LProcedure: parameter name '${name}' is declared more than once via .parameters()`,
      });
    }
    seen.add(name);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Message rendering - the shape `internal/pipeline/validate.ts`'s
// `renderMessage` established: a single problem renders inline; several
// render as a numbered list, one line per problem in declaration order.
// ---------------------------------------------------------------------------

/**
 * Renders the collected problems into the message the thrown error carries:
 * with exactly one problem the error's own message IS that problem's
 * message; with several it is a summary line followed by each problem's
 * message, 1-based and numbered.
 */
export function renderProcedureProblemsMessage(
  problems: readonly M3LProcedureValidationProblem[],
): string {
  if (problems.length === 1) {
    return problems.map((problem) => problem.message).join("");
  }
  const lines = problems.map(
    (problem, index) => `  ${index + 1}. ${problem.message}`,
  );
  return [
    `M3LProcedureBuilder.build(): ${problems.length} invalid findings:`,
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validates a raw, not-yet-type-checked procedure declaration in the
 * documented table order, collecting every {@link
 * M3LProcedureValidationProblem} rather than short-circuiting on the first
 * violation found.
 *
 * Type-level exhaustiveness (`M3LProcedureBuilder.step`/`.case`'s
 * `Exclude`-based narrowing, `build()`'s required positional `fallback`)
 * makes most of these checks unreachable from well-typed TypeScript; this
 * runtime pass exists to guard a JavaScript caller or a dynamically
 * assembled procedure.
 *
 * @param input - The raw name, steps, cases, fallback, declared parameter
 *   names, and revision `M3LProcedureBuilder.build()` collected.
 * @returns Every problem found, in the documented table order; empty when
 *   the declaration is valid.
 */
export function collectProcedureProblems(
  input: RawProcedureInput,
): readonly M3LProcedureValidationProblem[] {
  const problems: M3LProcedureValidationProblem[] = [];

  // 1. EMPTY_STEPS
  problems.push(...checkEmptySteps(input.steps));

  const steps = input.steps.map((raw, index) => normalizeStep(raw, index));
  const cases = input.cases.map((raw, index) => normalizeCase(raw, index));

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
  problems.push(...checkFallback(input.fallback));

  const knownParameterNames = new Set(input.declaredParameters);
  const conditionResults = walkAllConditions(
    cases,
    knownStepIds,
    knownParameterNames,
  );

  // 8. INVALID_PATTERN
  problems.push(...conditionResults.patternProblems);
  // 9. CONDITION_TOO_DEEP
  problems.push(...conditionResults.tooDeepProblems);
  // 10. UNKNOWN_REFERENCE
  problems.push(...conditionResults.unknownReferenceProblems);

  // 11. INVALID_DECLARATION (name, per-step, per-case, per-parameter-name,
  // condition-derived - combined, in that order).
  problems.push(...checkProcedureName(input.name));
  for (const step of steps) problems.push(...step.declarationProblems);
  for (const entry of cases) problems.push(...entry.declarationProblems);
  problems.push(...checkParameterNameDeclarations(input.declaredParameters));
  problems.push(...conditionResults.declarationProblems);

  return problems;
}
