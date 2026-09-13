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
