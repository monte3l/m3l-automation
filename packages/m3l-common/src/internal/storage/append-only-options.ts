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
import type { M3LAppendOnlySealFailure } from "../../core/storage/append-only-manifest-types.js";

/** The only own keys {@link M3LAppendOnlyStreamOptions} may carry. */
const STREAM_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "directory",
  "maxSegmentBytes",
  "maxSegmentAgeMs",
  "maxLineBytes",
  "onSealFailed",
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
const READ_OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "onTruncatedTail",
  "onArchivedSegment",
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
  readonly onSealFailed:
    ((failure: M3LAppendOnlySealFailure) => void) | undefined;
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
 * The shape of a caller-side boundary error builder a shared validator can
 * be parameterised by, matching how `internal/agent/validation.ts`'s
 * `assertAllowedKeys` already takes one — every owner supplies its own
 * builder so the message and `context` it produces stay that owner's,
 * while the validation logic itself is written once.
 */
type InvalidArgumentBuilder = (field: string, violation: string) => M3LError;

/**
 * Rejects a TRUTHY non-function handler, the one shape every optional
 * handler on this module's option bags shares — `onSealFailed` on the
 * constructor bag, `onTruncatedTail` and `onArchivedSegment` on the read
 * bag. Written once here because a fourth handler would otherwise be a
 * fourth verbatim copy of the same three lines and the same rationale.
 *
 * **Only a truthy non-function throws, and that polarity is load-bearing.**
 * A falsy value (`null`, `0`, `""`, `false`) is deliberately refused the
 * throw: it degrades to the same state as omitting the key entirely, which
 * is each owner's safe direction. For `onTruncatedTail` and
 * `onArchivedSegment` that absent-handler path is the THROWING one — the
 * reader refuses a torn tail, and refuses a sealed segment that is no longer
 * on disk — so a caller's slip escalates rather than hides. For
 * `onSealFailed` it is "the seal failure goes unreported", exactly as if the
 * option had never been supplied, while the entries themselves stay durable.
 * Do NOT "tighten" this to `value !== undefined && !isFunction(value)`: that
 * form would reject `null`, `0`, `""` and `false`, and — worse — accept
 * `null` as a PRESENT handler at the `?.()` call sites that consume these,
 * where an archived (or wholly deleted) date would then read back clean and
 * silent.
 *
 * **Takes the already-read value, not the bag and a key.** Each owner's
 * presence rule is its own (`Object.hasOwn` for `onSealFailed`, a direct
 * property read for the read bag — see {@link readOnSealFailed} and
 * {@link validateReadOptions}), and a caller that also needs the value reads
 * the property exactly once and hands that local here; a helper reading the
 * property itself would let an accessor answer the check and the use
 * differently.
 *
 * @param value - The handler exactly as read out of the caller's bag, once.
 * @param field - The option's name, reported as the error's `field`.
 * @param invalidArgument - The owner's own boundary-error builder, so the
 *   message and `context` still read as that owner's.
 * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` `"not-a-function"` when
 *   `value` is truthy but not callable.
 */
function assertOptionalHandler(
  value: unknown,
  field: string,
  invalidArgument: InvalidArgumentBuilder,
): void {
  if (value && !isFunction(value)) {
    throw invalidArgument(field, "not-a-function");
  }
}

/**
 * Reads the optional `onSealFailed` handler: rejects a truthy non-function
 * through {@link assertOptionalHandler}, degrades any falsy value to
 * `undefined` — "no handler". Shared by every owner of an `onSealFailed`
 * option — `validateStreamOptions` below and
 * `internal/agent/decision-log-writer.ts`'s
 * `validateAgentDecisionLogOptions` — each supplying its own
 * `invalidArgument` builder so the thrown error's message and `context`
 * still read as that owner's.
 *
 * `onSealFailed` is the only channel that tells a caller a best-effort
 * manifest seal has just failed — `M3LAppendOnlyStream.verify()` can report
 * on a directory after the fact, but nothing else reports the failure as it
 * happens. `options` is typed, but a JS caller — or one bypassing the type —
 * can still hand the constructor a truthy non-function there. Left
 * unchecked, that value would silently disable the reporting channel at the
 * one call site that would have used it, which is too close to the failure
 * it exists to report to fail any way but loudly and immediately at
 * construction. What a FALSY value degrades to, and why that is the safe
 * direction, is {@link assertOptionalHandler}'s to state.
 *
 * Reads `bag["onSealFailed"]` into a local exactly once and hands THAT local
 * to the guard: re-reading the property to decide, then again to return,
 * would let an accessor answer the check and the use differently. Presence
 * is `Object.hasOwn`, so a non-own `onSealFailed` resolves as absent — the
 * read bag deliberately differs, see {@link validateReadOptions}.
 */
export function readOnSealFailed(
  bag: Readonly<Record<string, unknown>>,
  invalidArgument: InvalidArgumentBuilder,
): ((failure: M3LAppendOnlySealFailure) => void) | undefined {
  const value = Object.hasOwn(bag, "onSealFailed")
    ? bag["onSealFailed"]
    : undefined;
  assertOptionalHandler(value, "onSealFailed", invalidArgument);
  return isFunction(value) ? value : undefined;
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
    onSealFailed: readOnSealFailed(options, invalidArgument),
  };
}

/**
 * Validates the read-options bag at the public boundary: rejects a
 * non-object, rejects an unknown own key, and rejects a truthy
 * non-callable `onTruncatedTail` or `onArchivedSegment`.
 *
 * `undefined` is the documented "no options" call (`read()`) and returns
 * without complaint. Anything else non-object throws, matching
 * {@link validateStreamOptions}: `read("nonsense")` is a caller mistake, and
 * returning silently would let it read under the default torn-tail policy —
 * the throwing one — while the caller believed they had set a callback.
 *
 * Both handler checks exist because `options` is typed but a JS caller (or
 * one bypassing the type) can still hand `read()` a truthy non-function
 * there. Left unchecked, that value silently disables the escalation at the
 * exact call site meant to invoke it — `context.onTruncatedTail?.(tornTail)`
 * for a torn tail, the equivalent optional call for a sealed-but-absent
 * segment — which is too close to the invariant each feature exists to
 * enforce to fail any way but loudly and immediately. Both run through
 * {@link assertOptionalHandler}, which holds the polarity rationale for
 * every optional handler here: only a TRUTHY non-function throws, and a
 * falsy one degrades to the absent-handler path — which for BOTH of these is
 * the throwing one, so a slip escalates instead of hiding.
 *
 * Each value is read straight off the bag rather than through
 * `Object.hasOwn`, unlike {@link readOnSealFailed}: the read path's own
 * `internal/storage/append-only-read-wiring.ts` reads
 * `options?.onTruncatedTail` the same direct way, so an own-key-only check
 * here would wave through a non-own handler the consumer will still see.
 * Nothing is handed back either, so there is no second read for an accessor
 * to answer differently.
 *
 * @param options - The read options bag exactly as the caller supplied it,
 *   `unknown` because a public method's own static parameter type is never a
 *   runtime guarantee.
 * @throws {@link M3LError} `ERR_INVALID_ARGUMENT` — `"not-an-object"` for a
 *   non-object non-`undefined` bag, `"unknown-key"` for an unrecognised own
 *   key, `"not-a-function"` for a truthy non-callable `onTruncatedTail` or
 *   `onArchivedSegment`.
 */
export function validateReadOptions(options: unknown): void {
  if (options === undefined) {
    return;
  }
  if (!isPlainObject(options)) {
    throw invalidArgument("options", "not-an-object");
  }
  assertNoUnknownKeys(options, READ_OPTIONS_KEYS);
  assertOptionalHandler(
    options["onTruncatedTail"],
    "onTruncatedTail",
    invalidArgument,
  );
  assertOptionalHandler(
    options["onArchivedSegment"],
    "onArchivedSegment",
    invalidArgument,
  );
}
