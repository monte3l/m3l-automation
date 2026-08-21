/**
 * `internal/procedure/validate/condition-literals` — the leaf-level,
 * non-recursive validation helpers `conditions.ts`'s walk calls at each node
 * it visits: compare-operator membership, the regex pattern-safety scan
 * (ReDoS-shaped-pattern rejection), and condition-literal/scalar validation.
 *
 * None of these functions carry or consume walk state (no depth counter, no
 * accumulator, no case id) — each is a pure, single-value check reusable from
 * any point in the walk. `conditions.ts` owns the recursive
 * walk-and-project orchestration and the {@link ConditionWalkAccumulator}
 * shape these helpers' callers report problems into; this file owns only the
 * checks themselves.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { M3L_PROCEDURE_MAX_PATTERN_LENGTH } from "../../../core/procedure/types.js";

import type {
  M3LProcedureCompareOperator,
  M3LProcedureScalar,
} from "../../../core/procedure/types.js";

/** The six comparison operators {@link M3LProcedureCompareOperator} admits, as a plain string set for membership testing against an untyped caller's `unknown` operator. */
const COMPARE_OPERATORS: ReadonlySet<string> =
  new Set<M3LProcedureCompareOperator>(["==", "!=", ">", ">=", "<", "<="]);

/** Whether `value` is one of the six recognized compare operators. */
export function isValidCompareOperator(
  value: unknown,
): value is M3LProcedureCompareOperator {
  return typeof value === "string" && COMPARE_OPERATORS.has(value);
}

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

/**
 * Finds the index just past the `}` that closes a `{...}` quantifier
 * starting at `start` (the index of `{`), or `start + 1` — treating the `{`
 * as a lone literal character, per how a regex engine treats an unclosed
 * `{` — when no closing `}` follows.
 */
function skipBraceQuantifier(pattern: string, start: number): number {
  const close = pattern.indexOf("}", start + 1);
  return close === -1 ? start + 1 : close + 1;
}

/**
 * Skips one `+`/`*`/`?`/`{...}` quantifier starting at `quantifierStart`
 * (already confirmed to be a quantifier char), also consuming a trailing
 * lazy `?` — which makes the quantifier non-greedy without changing the
 * quantified atom's identity.
 */
function skipQuantifier(pattern: string, quantifierStart: number): number {
  const quantifierChar = pattern[quantifierStart];
  let index =
    quantifierChar === "{"
      ? skipBraceQuantifier(pattern, quantifierStart)
      : quantifierStart + 1;
  if (pattern[index] === "?") index += 1;
  return index;
}

/** The length of a backslash-escape atom (`\d`, `\)`, ...) — always the backslash plus exactly one following character. */
const ESCAPE_ATOM_LENGTH = 2;

/**
 * Skips a `[...]` character class starting at `start` (the index of `[`),
 * honoring an escaped member and a leading `]`/`^]` (a `]` as the first
 * class member, optionally after a negating `^`, is a literal rather than
 * the closer) — returning the index just past the closing `]`, or
 * `pattern.length` when the class is never closed.
 */
function skipCharacterClass(pattern: string, start: number): number {
  let index = start + 1;
  if (pattern[index] === "^") index += 1;
  if (pattern[index] === "]") index += 1;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      index += ESCAPE_ATOM_LENGTH;
      continue;
    }
    if (char === "]") return index + 1;
    index += 1;
  }
  return pattern.length;
}

/** One step of {@link hasRepeatedQuantifiedAtom}'s scan: where to resume, what atom identity (if any) carries into the next step, and whether this step just found a repeat. */
interface AtomScanStep {
  readonly index: number;
  readonly lastAtom: string | undefined;
  readonly repeated: boolean;
}

/**
 * Skips a `[...]` class, or a single `(`/`)`/`|` structural character,
 * neither of which is trackable as a repeatable atom — both reset the
 * "immediately following" run rather than participating in it.
 */
function skipStructuralAtom(pattern: string, index: number): AtomScanStep {
  if (pattern[index] !== "[") {
    return { index: index + 1, lastAtom: undefined, repeated: false };
  }
  const classEnd = skipCharacterClass(pattern, index);
  const next = isQuantifierChar(pattern[classEnd])
    ? skipQuantifier(pattern, classEnd)
    : classEnd;
  return { index: next, lastAtom: undefined, repeated: false };
}

/**
 * Scans one plain atom — `char` itself, or a backslash-escape pair starting
 * at `index` — advancing past its quantifier when one immediately follows,
 * and reporting whether that quantified atom repeats `lastAtom`.
 */
function scanQuantifiedAtom(
  pattern: string,
  index: number,
  char: string,
  lastAtom: string | undefined,
): AtomScanStep {
  const isEscape = char === "\\" && index + 1 < pattern.length;
  const atom = isEscape
    ? pattern.slice(index, index + ESCAPE_ATOM_LENGTH)
    : char;
  const atomEnd = isEscape ? index + ESCAPE_ATOM_LENGTH : index + 1;

  if (!isQuantifierChar(pattern[atomEnd])) {
    return { index: atomEnd, lastAtom: undefined, repeated: false };
  }

  const next = skipQuantifier(pattern, atomEnd);
  return { index: next, lastAtom: atom, repeated: lastAtom === atom };
}

/**
 * Detects two or more quantifiers in immediate succession, each quantifying
 * the EXACT SAME single character or the exact same two-character shorthand
 * escape (`\d`, `\w`, `\s`, ...) — the specific "repeated self-identical
 * quantified atom" mechanism behind catastrophic backtracking on a pattern
 * like `a*a*a*...a*b`, which {@link hasQuantifiedGroup}'s group-only rule
 * cannot see at all (no parentheses are involved). Follows the same
 * detection principle established static ReDoS checkers use: a quantified
 * atom immediately followed by another quantified occurrence of the SAME
 * atom. A `[...]` character class or a `(`/`)`/`|` between two quantified
 * atoms breaks the run — resetting what counts as "immediately following" —
 * so a pattern with distinct atoms and literal/class separators (e.g. a
 * phone-number pattern like `^\+?\d{1,3}[- ]?\d{3}[- ]?\d{4}$`) is
 * unaffected: its `\d`-quantified runs are never adjacent to one another.
 */
function hasRepeatedQuantifiedAtom(pattern: string): boolean {
  let index = 0;
  let lastAtom: string | undefined;

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === undefined) break;

    const step =
      char === "[" || char === "(" || char === ")" || char === "|"
        ? skipStructuralAtom(pattern, index)
        : scanQuantifiedAtom(pattern, index, char, lastAtom);

    if (step.repeated) return true;
    index = step.index;
    lastAtom = step.lastAtom;
  }

  return false;
}

/**
 * Whether `pattern` is safe to compile into a `RegExp`: within the documented
 * length ceiling, free of the two catastrophic-backtracking shapes this
 * module detects (a quantified group, a run of repeated quantified atoms),
 * and itself compiles without throwing.
 */
export function isPatternSafe(pattern: string): boolean {
  if (pattern.length > M3L_PROCEDURE_MAX_PATTERN_LENGTH) return false;
  if (hasQuantifiedGroup(pattern)) return false;
  if (hasRepeatedQuantifiedAtom(pattern)) return false;
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
export function isValidScalarLiteral(
  value: unknown,
): value is M3LProcedureScalar {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean" ||
    value === null
  );
}

/** A short, safe-to-interpolate description of a rejected literal's shape — never calls `String()` on the value itself, since a hostile `Symbol` or object could throw or leak content. */
export function describeInvalidLiteral(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return "a non-finite number";
  return `a value of type '${typeof value}'`;
}

/**
 * Renders an unrecognized `source`/`kind` discriminant for a message or a
 * projected placeholder without ever calling `.toString()`/`String()` on an
 * object or symbol — both could stringify to `"[object Object]"` or throw.
 */
export function describeUnknownDiscriminant(value: unknown): string {
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
