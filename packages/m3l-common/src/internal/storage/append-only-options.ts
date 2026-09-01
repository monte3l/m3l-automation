/**
 * `internal/storage/append-only-options` — `M3LAppendOnlyStream`'s
 * constructor- and read-option validation cluster (ADR-0061, X7 slice 2;
 * widened to the read path in X7b).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * `core/storage/M3LAppendOnlyStream.ts` under ADR-0072's file-size ceiling:
 * the validation cluster is pure internal plumbing — none of the symbols here
 * are part of the public surface — and moving it here leaves the public class
 * module under the ceiling without touching any exported signature or
 * behaviour. `validateReadOptions` joined it from
 * `./append-only-reader.ts` for the same two reasons: it is the same kind of
 * boundary check over the same owner's options, and it shares this module's
 * `invalidArgument` vocabulary byte for byte.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";
import {
  isFunction,
  isNumber,
  isPlainObject,
  isString,
} from "../../core/utils/guards.js";
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
 * The only own keys `M3LAppendOnlyReadOptions` may carry.
 *
 * Deliberately a SECOND set rather than a union with
 * {@link STREAM_OPTIONS_KEYS}: the two bags are validated at different
 * boundaries and share no key. Merging them to save four lines would make
 * `read({ directory: "…" })` a silently accepted no-op — the caller would
 * believe they had redirected the read, and get the constructor's directory
 * back instead.
 */
const READ_OPTIONS_KEYS: ReadonlySet<string> = new Set(["onTruncatedTail"]);

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
 * Rejects any own key of `bag` that `allowed` does not list.
 *
 * The reported `field` is `"options"`, never the offending key: an
 * unrecognised key is caller input, and {@link invalidArgument}'s contract
 * is that neither the message nor `context` may echo caller input back.
 * That costs the caller some precision, which is why the violation is the
 * self-explanatory `"unknown-key"` — the caller is holding the bag they
 * passed and can diff it against the documented type.
 *
 * @param bag - The caller's options object, already proven a plain object.
 * @param allowed - The exhaustive set of own keys that bag may carry.
 * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` on the first unknown key.
 */
function assertNoUnknownKeys(
  bag: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(bag)) {
    if (!allowed.has(key)) {
      throw invalidArgument("options", "unknown-key");
    }
  }
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
  assertNoUnknownKeys(options, STREAM_OPTIONS_KEYS);
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

/**
 * Validates the read-options bag at the public boundary: rejects a
 * non-object, rejects an unknown own key, and rejects a truthy
 * non-callable `onTruncatedTail`.
 *
 * `undefined` is the documented "no options" call (`read()`) and returns
 * without complaint. Anything else non-object throws, matching
 * {@link validateStreamOptions}: `read("nonsense")` is a caller mistake, and
 * returning silently would let it read under the default torn-tail policy —
 * the throwing one — while the caller believed they had set a callback.
 *
 * The `onTruncatedTail` check exists because `options` is typed but a JS
 * caller (or one bypassing the type) can still hand `read()` a truthy
 * non-function there. Left unchecked, that value silently disables the
 * torn-tail throw at the exact call site meant to invoke it
 * (`context.onTruncatedTail?.(tornTail)`), which is too close to the
 * invariant the whole feature exists to enforce to fail any way but loudly
 * and immediately. Only a TRUTHY non-function throws: a falsy one (`null`,
 * `0`) degrades to the absent-callback path, which still throws on a torn
 * tail and so cannot hide one.
 *
 * @param options - The read options bag exactly as the caller supplied it,
 *   `unknown` because a public method's own static parameter type is never a
 *   runtime guarantee.
 * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` — `"not-an-object"` for a
 *   non-object non-`undefined` bag, `"unknown-key"` for an unrecognised own
 *   key, `"not-a-function"` for a truthy non-callable `onTruncatedTail`.
 */
export function validateReadOptions(options: unknown): void {
  if (options === undefined) {
    return;
  }
  if (!isPlainObject(options)) {
    throw invalidArgument("options", "not-an-object");
  }
  assertNoUnknownKeys(options, READ_OPTIONS_KEYS);
  const onTruncatedTail = options["onTruncatedTail"];
  if (onTruncatedTail && !isFunction(onTruncatedTail)) {
    throw invalidArgument("onTruncatedTail", "not-a-function");
  }
}
