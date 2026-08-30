/**
 * `internal/agent/validation` — the allowlist primitives `core/agent`'s
 * boundary validators share: the non-blank string predicate, the own-key
 * allowlist walk, the bounded string-list projection, and the single-field
 * readers (required / optional / required-holding-`undefined` strings, a
 * closed-vocabulary member, an integer, a non-negative finite number).
 *
 * Private to `core/agent`; never re-exported through a public barrel. Every
 * validator built on these is an allowlist — prove the shape valid, never try
 * to recognise it as invalid — and every read here is `Object.hasOwn`, so a
 * non-own `"__proto__"` on a parsed JSON document resolves as absent.
 *
 * The boundaries throw different error classes — `evaluateAgentAction` and
 * `agentDecisionLogEntry` throw `M3LAgentActionValidationError`, the decision
 * log's writer throws a bare `M3LError` with `ERR_INVALID_ARGUMENT` — so
 * every helper here takes a failure **factory** and throws what the factory
 * builds. The factory composes the `context` that names the offending field
 * and the violation kind — never a value.
 */

import type { M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/DangerousKeys.js";
import { isArray, isString } from "../../core/utils/guards.js";

/**
 * Builds the typed error one boundary throws for a named field and violation
 * kind. `detail` carries structural locators only (a grant index, an
 * offending key name) — never a value read out of the caller's input.
 */
export type M3LAgentValidationFailureFactory = (
  field: string,
  violation: string,
  detail?: Readonly<Record<string, unknown>>,
) => M3LError;

/**
 * `true` when `value` is a string with at least one non-whitespace character.
 *
 * "Non-blank" is used uniformly for every string in an agent declaration and
 * in an agent action: `"   "` is a caller mistake, not a name.
 */
export function isNonBlankString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

/**
 * Rejects every own key of `record` that is dangerous or is not in `allowed`.
 *
 * In an authorization input an unrecognised key is overwhelmingly a typo'd
 * known one — an accidental widening — so it is rejected, never ignored. The
 * dangerous-key sweep is defence in depth on top of that.
 */
export function assertAllowedKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  field: string,
  failure: M3LAgentValidationFailureFactory,
  detail?: Readonly<Record<string, unknown>>,
): void {
  for (const key of Object.keys(record)) {
    if (isDangerousKey(key)) {
      throw failure(field, "dangerous-key", { ...detail, key });
    }
    if (!allowed.has(key)) {
      throw failure(field, "unknown-key", { ...detail, key });
    }
  }
}

/** The bounds one string list is validated against. */
export interface M3LAgentStringListRules {
  /** Whether a zero-length list is legal (a declared list is never empty). */
  readonly allowEmpty: boolean;
  /** The reject-above ceiling: `length > maxEntries` throws. */
  readonly maxEntries: number;
  /** Whether a repeated entry is a violation (it is in a declaration). */
  readonly rejectDuplicates: boolean;
}

/**
 * Validates `value` as a bounded list of non-blank strings and returns a
 * fresh **frozen copy** — never the caller's array, so a later `push` cannot
 * rewrite what was validated.
 */
export function projectStringList(
  value: unknown,
  field: string,
  rules: M3LAgentStringListRules,
  failure: M3LAgentValidationFailureFactory,
  detail?: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (!isArray(value)) {
    throw failure(field, "not-an-array", detail);
  }
  if (!rules.allowEmpty && value.length === 0) {
    throw failure(field, "empty-list", detail);
  }
  // Captured ONCE. `value.length` is a `Proxy` trap surface too: a
  // `length` getter can return a small value here and the real (huge) one on
  // every subsequent read, so checking the bound against one read and
  // driving the loop off a second (or per-iteration) read lets a hostile
  // proxy walk straight past the ceiling this line exists to enforce. Both
  // the bound check and the loop below must derive from this single capture
  // — this is a latent defect from this file's original slice-1 shape, not
  // new in this change.
  const length = value.length;
  if (length > rules.maxEntries) {
    throw failure(field, "too-many-entries", detail);
  }

  const seen = new Set<string>();
  const projected: string[] = [];
  // Indexed, NOT `for...of`. `Array.isArray` passes for a real array whose
  // own `Symbol.iterator` has been overridden, so an iterator-driven walk can
  // yield an arbitrary number of entries after `length` was checked against
  // the ceiling above — projecting thousands of names past a 256 bound. The
  // loop must read the same `length` the bound was checked on (captured
  // above, not re-read from `value.length`).
  for (let index = 0; index < length; index++) {
    const entry = value[index];
    if (!isNonBlankString(entry)) {
      throw failure(field, "blank-or-non-string-entry", detail);
    }
    if (rules.rejectDuplicates && seen.has(entry)) {
      throw failure(field, "duplicate-entry", detail);
    }
    seen.add(entry);
    projected.push(entry);
  }
  return Object.freeze(projected);
}

/**
 * Reads a required non-blank string field. Presence is `Object.hasOwn`;
 * absent, blank, or non-string all throw the same `"blank-or-non-string"`
 * violation for `field` — neither boundary has a notion of "absent is fine"
 * for a required string.
 */
export function requireNonBlankString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  failure: M3LAgentValidationFailureFactory,
): string {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (!isNonBlankString(value)) {
    throw failure(field, "blank-or-non-string");
  }
  return value;
}

/**
 * Reads an optional non-blank string field. Presence is `Object.hasOwn`, so a
 * non-own `"__proto__"` resolves as absent; a present-but-blank or
 * non-string value is malformed input, not "absent", and throws.
 */
export function readOptionalNonBlankString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  failure: M3LAgentValidationFailureFactory,
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isNonBlankString(value)) {
    throw failure(field, "blank-or-non-string");
  }
  return value;
}

/**
 * Reads a non-blank string field whose declared type is "required, holding
 * `undefined`" rather than optional — the shape `M3LAgentActionRecord` and
 * `M3LAgentDecisionLogEntry` both use for a field the library always emits as
 * an own key (`operation`, `target.region`, `target.accountId`). An absent
 * key and an own key holding `undefined` both read as `undefined`; a
 * present-but-blank or present-non-string value is malformed and throws.
 */
export function readRequiredHoldingUndefinedString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  failure: M3LAgentValidationFailureFactory,
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isNonBlankString(value)) {
    throw failure(field, "blank-or-non-string");
  }
  return value;
}

/**
 * Requires a non-blank string field that is also a member of a closed
 * vocabulary, narrowing to that vocabulary's type. Distinguishes "not a
 * string at all" (`blank-or-non-string`, from {@link requireNonBlankString})
 * from "a string, but not a recognised member" (`notInUnionLabel`), so the
 * two failures stay distinguishable — the failure carries neither value.
 *
 * `isMember` is a type predicate rather than a plain boolean check so the
 * narrowed member can be returned as its own union type, with no cast at the
 * call site.
 */
export function requireStringInUnion<T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  isMember: (value: string) => value is T,
  notInUnionLabel: string,
  failure: M3LAgentValidationFailureFactory,
): T {
  const value = requireNonBlankString(record, key, field, failure);
  if (!isMember(value)) {
    throw failure(field, notInUnionLabel);
  }
  return value;
}

/** Reads an optional integer field. A present-but-non-integer value throws. */
export function readOptionalInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  failure: M3LAgentValidationFailureFactory,
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw failure(field, "not-an-integer");
  }
  return value;
}

/** A negative or non-finite `tokens` / `cost` is malformed input. */
export function readOptionalNonNegativeFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  failure: M3LAgentValidationFailureFactory,
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw failure(field, "negative-or-non-finite");
  }
  return value;
}
