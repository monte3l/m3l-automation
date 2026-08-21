/**
 * `internal/procedure/resolve` — reference resolution, bounded path walking,
 * and the bounded `matches` pattern application. This is the one module in
 * `core/procedure` that walks or scans a resolved caller value directly, so
 * every place a hostile object graph or an oversized string could do damage
 * is co-located here for review.
 *
 * Private to `core/procedure`; never re-exported through a public barrel.
 */

import { isArray, isObject } from "../../core/utils/guards.js";

import type {
  M3LProcedureConditionScope,
  M3LProcedurePath,
  M3LProcedureReference,
  M3LProcedureResolvedReference,
  M3LProcedureScalar,
  M3LProcedureShape,
  M3LProcedureValue,
} from "../../core/procedure/types.js";
import {
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH,
} from "../../core/procedure/types.js";

/**
 * Segments that never resolve, even as an own enumerable property — a path
 * is caller-declared data, not a trusted accessor chain, so a `__proto__`,
 * `constructor` or `prototype` step is refused unconditionally rather than
 * only when it would resolve to the prototype's own copy.
 */
const DANGEROUS_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** A canonical decimal array index: `"0"`, `"12"` — never `"01"`, `"-1"`, `"1.0"`. */
function isCanonicalIndex(segment: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(segment);
}

/**
 * `true` only for an own, enumerable, string-keyed property — never an
 * inherited one, and never a non-enumerable own property (e.g. one attached
 * via `Object.defineProperty(obj, key, { enumerable: false })`). Correct for
 * array indices too, so both segment resolvers below share this one check
 * rather than each re-deriving "own enumerable" from `hasOwnProperty` (which
 * is `true` for a non-enumerable own property too, and would silently
 * resolve it).
 */
function isOwnEnumerable(current: unknown, segment: string): boolean {
  return (
    isObject(current) &&
    Object.prototype.propertyIsEnumerable.call(current, segment)
  );
}

/** An array segment resolves only a canonical in-range decimal index; never `"length"`. */
function resolveArraySegment(
  current: readonly unknown[],
  segment: string,
): unknown {
  if (!isCanonicalIndex(segment) || !isOwnEnumerable(current, segment)) {
    return undefined;
  }
  const index = Number(segment);
  return index < current.length ? current[index] : undefined;
}

/** A non-array object segment resolves only an own enumerable property. */
function resolveObjectSegment(current: unknown, segment: string): unknown {
  if (!isOwnEnumerable(current, segment)) return undefined;
  return (current as Record<string, unknown>)[segment];
}

/**
 * Walks `path` into `root`, honouring every rule
 * `docs/reference/core/procedure.md` § Values and references pins: only an
 * own enumerable property resolves; `__proto__`/`constructor`/`prototype`
 * never resolve; an array resolves only a canonical in-range decimal index
 * (`"length"` never resolves); a string resolves no segment at all; walking
 * stops at the first unresolved segment; segment count is bounded by
 * {@link M3L_PROCEDURE_CONDITION_MAX_DEPTH} (inclusive — a path of exactly
 * that many segments may still resolve).
 */
function walkPath(root: unknown, path: M3LProcedurePath): unknown {
  if (path.length > M3L_PROCEDURE_CONDITION_MAX_DEPTH) return undefined;
  let current: unknown = root;
  for (const segment of path) {
    if (DANGEROUS_PATH_SEGMENTS.has(segment) || typeof current === "string") {
      return undefined;
    }
    current = isArray(current)
      ? resolveArraySegment(current, segment)
      : resolveObjectSegment(current, segment);
    // `M3LProcedureValue` never itself holds `undefined`, so an intermediate
    // `undefined` unambiguously means "unresolved" — stop the walk now
    // rather than continuing to probe past it.
    if (current === undefined) return undefined;
  }
  return current;
}

/** Renders a scalar the way a literal reference names it: no quoting, `"null"` for `null`. */
function renderScalar(value: M3LProcedureScalar): string {
  return value === null ? "null" : String(value);
}

/** Appends a dotted path suffix to a rendered `source:name` base, when present. */
function joinWithPath(
  base: string,
  path: M3LProcedurePath | undefined,
): string {
  return path === undefined ? base : `${base}.${path.join(".")}`;
}

/**
 * Renders the canonical form of a reference, e.g. `"step:count-errors.count"`
 * or `"literal:5"` — the same string every evaluation of the same reference
 * produces, since nothing here depends on the resolved value.
 */
function renderReferenceString<TShape extends M3LProcedureShape>(
  reference: M3LProcedureReference<TShape>,
): string {
  switch (reference.source) {
    case "literal":
      return `literal:${renderScalar(reference.literal)}`;
    case "step":
      return joinWithPath(`step:${reference.step}`, reference.path);
    case "value":
      return joinWithPath(`value:${reference.key}`, reference.path);
    case "parameter":
      return joinWithPath(`parameter:${reference.key}`, reference.path);
    default: {
      /* istanbul ignore next -- unreachable: every M3LProcedureReference
         source is handled above; this arm exists only to fail loud if a new
         source is ever added without a matching case. */
      const exhaustive: never = reference;
      return String(exhaustive);
    }
  }
}

/** The root value a non-literal reference addresses, before any `path` walk. */
function rootValueFor<TShape extends M3LProcedureShape>(
  reference: Exclude<
    M3LProcedureReference<TShape>,
    { readonly source: "literal" }
  >,
  scope: M3LProcedureConditionScope<TShape>,
): unknown {
  switch (reference.source) {
    case "step":
      return scope.results[reference.step]?.output;
    case "value":
      return scope.values[reference.key];
    case "parameter":
      return scope.parameters[reference.key];
    default: {
      /* istanbul ignore next -- unreachable: every non-literal
         M3LProcedureReference source is handled above; this arm exists only
         to fail loud if a new source is ever added without a matching case. */
      const exhaustive: never = reference;
      return exhaustive;
    }
  }
}

/**
 * Resolves one {@link M3LProcedureReference} against `scope`: dispatches on
 * `source`, walks `path` when present, and renders the canonical `reference`
 * string. Total — an absent step record, an out-of-range path, or a source
 * that simply has nothing there all yield `present: false`, never a throw.
 */
export function resolveReference<TShape extends M3LProcedureShape>(
  reference: M3LProcedureReference<TShape>,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureResolvedReference {
  const referenceString = renderReferenceString(reference);
  const resolved =
    reference.source === "literal"
      ? reference.literal
      : resolveNonLiteral(reference, scope);
  if (resolved === undefined) {
    return { reference: referenceString, present: false };
  }
  return {
    reference: referenceString,
    present: true,
    resolved: resolved as M3LProcedureValue,
  };
}

function resolveNonLiteral<TShape extends M3LProcedureShape>(
  reference: Exclude<
    M3LProcedureReference<TShape>,
    { readonly source: "literal" }
  >,
  scope: M3LProcedureConditionScope<TShape>,
): unknown {
  const root = rootValueFor(reference, scope);
  return reference.path === undefined ? root : walkPath(root, reference.path);
}

/** The result of applying a `matches` pattern to an already-resolved subject. */
export interface MatchesApplicationResult {
  readonly satisfied: boolean;
  /**
   * The subject's resolved reference, `refused: "oversized"` or
   * `refused: "invalid-pattern"` when a resolved value was declined rather
   * than scanned.
   */
  readonly reference: M3LProcedureResolvedReference;
}

/**
 * Applies a `matches` pattern to an already-resolved subject, honouring the
 * input-length bound: a string longer than
 * {@link M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH} is refused, not scanned — the
 * arm is `false` and the returned reference is marked `refused: "oversized"`,
 * so "no match" is never silently indistinguishable from "not checked". A
 * pattern that fails to compile degrades the same way, marked
 * `refused: "invalid-pattern"` — `matches` patterns are validated at
 * `build()` time (a later pass), but this evaluator is public and documented
 * as callable directly, bypassing `build()`, so a malformed pattern reaching
 * it here must stay distinguishable from a genuine no-match rather than
 * collapsing to the same unmarked `false`. Total: a non-string subject
 * degrades to `false` with no refusal marker, since there was nothing to
 * refuse — the subject was simply never a candidate for scanning.
 */
export function applyMatchesPattern(
  subject: M3LProcedureResolvedReference,
  pattern: string,
  ignoreCase: boolean,
): MatchesApplicationResult {
  if (typeof subject.resolved !== "string") {
    return { satisfied: false, reference: subject };
  }
  if (subject.resolved.length > M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH) {
    return {
      satisfied: false,
      reference: { ...subject, refused: "oversized" },
    };
  }
  try {
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");
    return { satisfied: regex.test(subject.resolved), reference: subject };
  } catch {
    // A malformed pattern is a build-time `ERR_PROCEDURE_INVALID_PATTERN`
    // problem elsewhere; this evaluator stays total even if called directly
    // with one that was never validated, and marks the refusal so a
    // malformed pattern is never indistinguishable from a genuine no-match.
    return {
      satisfied: false,
      reference: { ...subject, refused: "invalid-pattern" },
    };
  }
}
