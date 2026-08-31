/**
 * `internal/storage/append-only-options` — `M3LAppendOnlyStream`'s
 * constructor-option validation cluster (ADR-0061, X7 slice 2).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * `core/storage/M3LAppendOnlyStream.ts` under ADR-0072's file-size ceiling:
 * the validation cluster is pure internal plumbing — none of the symbols here
 * are part of the public surface — and moving it here leaves the public class
 * module under the ceiling without touching any exported signature or
 * behaviour.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";
import { isNumber, isPlainObject, isString } from "../../core/utils/guards.js";
import {
  M3L_APPEND_ONLY_MAX_LINE_BYTES,
  M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS,
  M3L_APPEND_ONLY_MAX_SEGMENT_BYTES,
} from "../../core/storage/append-only-read-types.js";

/** The only own keys {@link M3LAppendOnlyStreamOptions} may carry. */
const STREAM_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "directory",
  "maxSegmentBytes",
  "maxSegmentAgeMs",
  "maxLineBytes",
]);

/**
 * Builds the caller-side boundary error: a bare {@link M3LError} carrying
 * `code: "ERR_INVALID_ARGUMENT"` (already classified `origin: "caller"` in
 * the error catalog). `context` names the field and the violation kind only —
 * never a value read out of the caller's input, and never an entry's own key
 * name, which is caller input too.
 */
export function invalidArgument(field: string, violation: string): M3LError {
  return new M3LError(
    `append-only stream: "${field}" is invalid (${violation})`,
    { code: "ERR_INVALID_ARGUMENT", context: { field, violation } },
  );
}

/**
 * Reads the required `directory`. Presence is `Object.hasOwn`, so a non-own
 * `"__proto__"` resolves as absent; an absent, blank or non-string value is
 * malformed input and throws.
 *
 * "Non-blank" is deliberate: `"   "` names a directory only by accident, and
 * resolving it would silently write the audit trail into the process's
 * working directory.
 */
function readDirectory(bag: Readonly<Record<string, unknown>>): string {
  const value = Object.hasOwn(bag, "directory") ? bag["directory"] : undefined;
  if (!isString(value) || value.trim().length === 0) {
    throw invalidArgument("directory", "not-a-non-blank-string");
  }
  return value;
}

/**
 * Reads one optional ceiling. A ceiling is a count — of bytes or of
 * milliseconds — so only a finite positive integer is meaningful: `0` and a
 * negative would rotate on (or before) every write, and `NaN`/`Infinity`/a
 * fractional value would make the comparison that enforces it silently never
 * fire.
 */
function readOptionalCeiling(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  if (!Object.hasOwn(bag, key)) {
    return fallback;
  }
  const value = bag[key];
  if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw invalidArgument(key, "not-a-positive-integer");
  }
  return value;
}

/** The fully resolved settings one {@link M3LAppendOnlyStream} runs under. */
export interface ResolvedStreamOptions {
  readonly directory: string;
  readonly maxSegmentBytes: number;
  readonly maxSegmentAgeMs: number;
  readonly maxLineBytes: number;
}

/**
 * Reads the optional line ceiling, which is bounded **above** as well as
 * below — see {@link M3LAppendOnlyStreamOptions.maxLineBytes}. Every other
 * ceiling is a caller's own business at any positive size; this one is the
 * reason the stream may claim whole-line atomicity at all, so raising it is
 * refused where it is made rather than discovered as a torn line later.
 */
function readLineCeiling(bag: Readonly<Record<string, unknown>>): number {
  const value = readOptionalCeiling(
    bag,
    "maxLineBytes",
    M3L_APPEND_ONLY_MAX_LINE_BYTES,
  );
  if (value > M3L_APPEND_ONLY_MAX_LINE_BYTES) {
    throw invalidArgument("maxLineBytes", "above-the-maximum-line-size");
  }
  return value;
}

/**
 * Validates the options bag at the public boundary and resolves every
 * omitted ceiling to its documented default.
 *
 * Unknown keys are rejected rather than ignored, following this library's
 * allowlist precedent (`validateAgentDecisionLogOptions`, `validateAgentPolicy`)
 * — an unrecognised key in a bag like this one is overwhelmingly a typo'd
 * known one, and silently ignoring it would leave a caller who wrote
 * `maxSegmentByte` believing they had raised a ceiling.
 */
export function validateStreamOptions(options: unknown): ResolvedStreamOptions {
  if (!isPlainObject(options)) {
    throw invalidArgument("options", "not-an-object");
  }
  for (const key of Object.keys(options)) {
    if (!STREAM_OPTIONS_KEYS.has(key)) {
      throw invalidArgument("options", "unknown-key");
    }
  }
  return {
    directory: readDirectory(options),
    maxSegmentBytes: readOptionalCeiling(
      options,
      "maxSegmentBytes",
      M3L_APPEND_ONLY_MAX_SEGMENT_BYTES,
    ),
    maxSegmentAgeMs: readOptionalCeiling(
      options,
      "maxSegmentAgeMs",
      M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS,
    ),
    maxLineBytes: readLineCeiling(options),
  };
}
