/**
 * `internal/storage/append-only-manifest-fields` — the sealed-segment
 * manifest's untrusted-field readers: the record-agnostic primitives that
 * read ONE property off an already-parsed JSON object, shape-check it, and
 * hand back a validated local or `undefined` (ADR-0102, X8b slice 4).
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * `./append-only-manifest-records.js`, which owns the record SHAPES (`seal`,
 * `baseline`) and the fold of many lines into what one manifest states —
 * that module keeps the parsing and folding, this one keeps the primitives
 * neither needs to know which record kind it is serving to apply. The two
 * concerns had grown past what one file can hold under `check:file-budget`'s
 * ratchet.
 *
 * Every reader here follows the same rule: `Object.hasOwn` gates presence
 * (never a bracket read, which would walk the prototype chain and could
 * answer with a gadget planted on `Object.prototype`), and each field is
 * read exactly ONCE into a local, validated there, and never read again —
 * there is no window in which a second read could answer differently from
 * the one that was checked. The dependency runs one way: the record module
 * imports these readers, and nothing here imports back from it.
 */

/**
 * Reads one OWN property into a value, or `undefined` when the object does
 * not itself carry it.
 *
 * The `Object.hasOwn` gate is a security control, not tidiness. A gadget
 * planted on `Object.prototype` is inherited by every object `JSON.parse`
 * produces, so an implementation reading `record.sha256` directly would find
 * the gadget's value and accept a seal that claims nothing — a forged proof
 * assembled out of a record that never stated it. Each field is read exactly
 * once, into a local, and validated there; the property is never read again
 * afterwards, so there is no window in which a second read could answer
 * differently from the one that was checked.
 */
export function ownProperty(record: object, property: string): unknown {
  return Object.hasOwn(record, property)
    ? Reflect.get(record, property)
    : undefined;
}

/** The own `property` of `record` when it is a string, else `undefined`. */
export function ownString(
  record: object,
  property: string,
): string | undefined {
  const value = ownProperty(record, property);
  return typeof value === "string" ? value : undefined;
}

/** The own `property` of `record` when it is an integer, else `undefined`. */
export function ownInteger(
  record: object,
  property: string,
): number | undefined {
  const value = ownProperty(record, property);
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * The own `property` of `record` when it is a MEASUREMENT count — an integer
 * that is not negative — else `undefined`.
 *
 * `./append-only-digest.js` counts newline bytes and sums chunk lengths, so
 * neither an entry count nor a byte length it produced can be below zero. A
 * negative one was written by something else, and admitting it would parse a
 * record no honest writer could have produced into a well-formed seal. The
 * bound is checked on the local {@link ownInteger} already read, never by
 * reading the property a second time.
 */
export function ownMeasurement(
  record: object,
  property: string,
): number | undefined {
  const value = ownInteger(record, property);
  return value !== undefined && value >= 0 ? value : undefined;
}

/**
 * The shape `createHash("sha256").digest("hex")` produces, and the shape
 * `sha256sum` reproduces off-host: exactly 64 LOWERCASE hex characters.
 *
 * Anchored and fixed-length, so it has no backtracking behaviour to reason
 * about. Uppercase is refused rather than folded: a digest this family wrote
 * is lowercase by construction, and normalising instead of refusing would
 * admit a value under a shape the manifest never states.
 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The own `property` of `record` when it is a sha256 digest, else
 * `undefined`.
 *
 * The manifest is the validation boundary for its own bytes, and a `seal`'s
 * whole worth is that its digest is one `./append-only-digest.js` could have
 * produced. Accepting any string at all would parse `""` into a well-formed
 * seal that proves nothing while reading as proof. Checked on the local
 * {@link ownString} already read, never by reading the property again.
 */
export function ownDigest(
  record: object,
  property: string,
): string | undefined {
  const value = ownString(record, property);
  return value !== undefined && SHA256_HEX_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * The own `property` of `record` when it is an instant in exactly the shape
 * `Date.prototype.toISOString` renders AND naming a real calendar moment,
 * else `undefined`.
 *
 * **A sanitization boundary, not a correctness nicety — do not relax it back
 * to {@link ownString} as a redundant type check.** An `at` is the one field
 * of this format that reaches a CALLER verbatim: it travels in the payload
 * {@link "../../core/storage/append-only-read-types.js".M3LAppendOnlyReadOptions}'s
 * `onArchivedSegment` is handed, and that option's own `@example` tells
 * callers to log the payload. Admitted on type alone, it carries bytes
 * whoever wrote the manifest chose — terminal control sequences that erase
 * the line they land on, and carriage returns and newlines that let the rest
 * of the value pose as further lines this library wrote — straight into an
 * operator's log, where they read as library-generated. The check has to live
 * here, at the parse boundary: nothing downstream can still tell that the
 * value came off disk rather than out of the writer's own clock. An `at`'s
 * three siblings on a seal are all admitted on their SHAPE already —
 * `segment` through this format's own segment parser, `sha256` through
 * {@link ownDigest}, both counts through {@link ownMeasurement} — so an `at`
 * admitted on type alone was the single gap left in an otherwise closed
 * record.
 *
 * The shape is allowlisted by RE-RENDERING rather than by matching a lexical
 * pattern: the value is admitted only when re-rendering the moment it parsed
 * to reproduces the value byte for byte, so the admitted set is precisely the
 * range of `toISOString` — which is precisely what a writer of this format
 * stamps, since that call is the only thing that ever writes the field. That
 * makes it an allowlist of the writer's own rendering, the house rule at a
 * sanitization boundary, where a denylist over unbounded input never
 * converges. The property the boundary actually needs follows from the range
 * itself: every string `toISOString` can return is digits and the `+-:.TZ`
 * delimiters, so no admitted value holds a control byte or a line break, and
 * no length but its own.
 *
 * One check, not two, and deliberately this one. An anchored digit-group
 * pattern over `YYYY-MM-DDTHH:mm:ss.sssZ` looks like the cheaper spelling of
 * the same rule and is strictly weaker where it counts: it ACCEPTS
 * `2026-13-45T99:99:99.999Z`, whose every counted group is satisfied and
 * which names no moment at all, and it accepts an hour of `24`, a spelling
 * this format never states. The re-render refuses both — `Date.parse` answers
 * `NaN` for the first, and the second re-renders as the next day's midnight
 * and so fails the identity — on the same reasoning that makes
 * {@link ownDigest} refuse an uppercase digest instead of folding its case.
 * Adding the pattern in front of it would buy nothing this boundary is for
 * and leave two spellings of "the shape the writer stamps" to keep in step,
 * the laxer of which reads as the authority.
 *
 * Checked on the local {@link ownString} already read, never by reading the
 * property a second time: a getter may answer differently for the read that
 * gets validated and the read that gets returned.
 */
export function ownInstant(
  record: object,
  property: string,
): string | undefined {
  const value = ownString(record, property);
  if (value === undefined) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? value
    : undefined;
}
