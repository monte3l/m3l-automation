/**
 * `internal/agent/validation` — the allowlist primitives both `core/agent`
 * boundary validators share: the non-blank string predicate, the own-key
 * allowlist walk, and the bounded string-list projection.
 *
 * Private to `core/agent`; never re-exported through a public barrel. Both
 * validators are allowlists — prove the shape valid, never try to recognise
 * it as invalid — and both read presence with `Object.hasOwn`, so a non-own
 * `"__proto__"` on a parsed JSON document resolves as absent.
 *
 * The two boundaries throw different error classes, so every helper here
 * takes a failure **factory** and throws what the factory builds. The factory
 * composes the `context` that names the offending field and the violation
 * kind — never a value.
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
  if (value.length > rules.maxEntries) {
    throw failure(field, "too-many-entries", detail);
  }

  const seen = new Set<string>();
  const projected: string[] = [];
  // Indexed, NOT `for...of`. `Array.isArray` passes for a real array whose
  // own `Symbol.iterator` has been overridden, so an iterator-driven walk can
  // yield an arbitrary number of entries after `length` was checked against
  // the ceiling above — projecting thousands of names past a 256 bound. The
  // loop must read the same `length` the bound was checked on.
  for (let index = 0; index < value.length; index++) {
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
