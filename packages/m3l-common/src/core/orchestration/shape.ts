/**
 * `core/orchestration/shape` — caller-supplied-shape validation for a
 * {@link M3LStepReference}.
 *
 * This module answers a single boundary question — "is this caller-supplied
 * `unknown` value even SHAPED like a parsed step reference?", where "shaped
 * like" means it OWNS the fields rather than merely presenting them: every
 * field read here is gated on {@link Object.hasOwn} (see {@link readOwnField})
 * because `isPlainObject` admits `Object.prototype` as a prototype, so under
 * prototype pollution an absent field and an inherited one are otherwise
 * indistinguishable. The question is distinct from the grammar concern owned
 * by
 * `core/orchestration/step-reference`: "given a well-formed reference, how do
 * we walk/emit it?". Every public entry point that accepts an
 * already-parsed reference (rather than raw caller text) narrows through
 * {@link assertStepReferenceShape} exactly once, at the boundary, so the
 * grammar logic downstream can trust the shape of whatever it's handed and
 * never re-check it.
 *
 * @packageDocumentation
 */

import { isPlainObject } from "../utils/index.js";

import { M3LStepReferenceError } from "./M3LStepReferenceError.js";
import type {
  M3LStepReference,
  M3LStepReferenceSegment,
} from "./step-reference.js";

/**
 * Reads `key` off `value` exactly once, but only when `value` OWNS it —
 * an inherited field reads back as `undefined`, i.e. as ABSENT.
 *
 * Every field read in this module goes through here. `isPlainObject` accepts
 * `proto === Object.prototype` (a plain object literal's prototype), so a
 * bare `{}` presents whatever has been written onto `Object.prototype`: an
 * ungated `value["kind"]` would let a polluted prototype forge a whole
 * segment (`{}` inheriting `kind: "property"` plus a `name`), or a whole
 * reference (`{}` inheriting an `ordinal`/`segments` pair), and the forgery
 * would then be trusted by every downstream consumer of the validated
 * snapshot. Treating an inherited field as absent collapses that case onto
 * the already-rejected "field missing" case, so no new error wording is
 * needed and the caller gets the same message either way.
 *
 * `Object.hasOwn` — not `value.hasOwnProperty(key)` — because a
 * null-prototype bag (`Object.create(null)`) is a legitimate caller shape
 * that `isPlainObject` accepts and that has no `hasOwnProperty` method to
 * call.
 *
 * @param value - The plain object to read from.
 * @param key - The field name to read.
 * @returns The own value at `key`, or `undefined` when `value` does not own it.
 */
function readOwnField(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * Narrows one element of a `segments` array to a well-formed {@link
 * M3LStepReferenceSegment}, or throws {@link M3LStepReferenceError} naming
 * the bad index. Called once per in-bounds POSITION of that array from
 * {@link assertStepReferenceShape} — a hole arrives here as `undefined` and
 * is rejected below like any other non-plain-object — so segment-element
 * validation happens exactly once, at the entry-point boundary, never
 * scattered through the later walk/format logic, which can therefore trust
 * every segment it's handed.
 *
 * Every field is read through {@link readOwnField}, so a field the element
 * merely INHERITS is treated as absent: a bare `{}` cannot borrow a
 * `kind`/`name` pair from a polluted `Object.prototype` and pass as a real
 * segment, and such an element is rejected with the same message a
 * genuinely missing field produces.
 *
 * Returns a FRESH frozen own-property snapshot built from the single
 * validated read of each field, never the caller's live object. This is what
 * closes the check-read/use-read (TOCTOU) gap: `kind` and `name`/`index` are
 * each read exactly once, and every downstream consumer sees only the inert
 * snapshot, so a getter cannot present a safe value to the validator and a
 * hostile one (a `"__proto__"`-coercing object, a divergent `kind` that
 * routes an unvalidated field into the wrong resolver) to the walk/format
 * logic afterwards. A well-behaved getter is unaffected — its value is
 * simply captured.
 *
 * The caller's own object is neither frozen nor mutated; only the returned
 * snapshot is frozen, so a later call legitimately re-validates from scratch
 * and observes whatever the caller has since changed.
 *
 * @param value - The raw, unvalidated segment element.
 * @param index - The element's position in the `segments` array, used only
 *   to name the offending element in a thrown error.
 * @param paramName - The name of the top-level parameter being validated,
 *   used only to compose a caller-facing error message.
 * @returns A frozen {@link M3LStepReferenceSegment} snapshot of `value`.
 * @throws {@link M3LStepReferenceError} when `value` is not a plain object,
 *   has an unrecognised or merely inherited `kind`, or carries a
 *   `name`/`index` of the wrong type for its `kind` (an inherited one
 *   counting as absent).
 */
function assertSegmentShape(
  value: unknown,
  index: number,
  paramName: string,
): M3LStepReferenceSegment {
  if (!isPlainObject(value)) {
    throw new M3LStepReferenceError(
      `${paramName}.segments[${String(index)}] must be a plain object, got ${typeof value}`,
    );
  }
  const kind = readOwnField(value, "kind");
  if (kind === "property") {
    const name = readOwnField(value, "name");
    if (typeof name !== "string") {
      throw new M3LStepReferenceError(
        `${paramName}.segments[${String(index)}] is a property segment but "name" must be a string, got ${typeof name}`,
      );
    }
    return Object.freeze({ kind: "property", name });
  }
  if (kind === "index") {
    const segmentIndex = readOwnField(value, "index");
    if (typeof segmentIndex !== "number") {
      throw new M3LStepReferenceError(
        `${paramName}.segments[${String(index)}] is an index segment but "index" must be a number, got ${typeof segmentIndex}`,
      );
    }
    return Object.freeze({ kind: "index", index: segmentIndex });
  }
  throw new M3LStepReferenceError(
    `${paramName}.segments[${String(index)}] has an unrecognised "kind": ${String(kind)}`,
  );
}

/**
 * Narrows an arbitrary `unknown` value to the well-formed shape of a
 * {@link M3LStepReference} — a plain object OWNING a numeric `ordinal` and
 * an array `segments` whose every ELEMENT is itself a well-formed {@link
 * M3LStepReferenceSegment} (see {@link assertSegmentShape}) — or throws
 * {@link M3LStepReferenceError}. Used at the public entry points
 * (`formatStepReference`, `resolveStepReference`) that accept an
 * already-parsed reference rather than raw caller text, so a non-object/
 * malformed argument, or a malformed segment nested inside an otherwise
 * well-formed one, is classified as a caller error rather than reaching a
 * raw `TypeError` (or, worse, silently resolving to `undefined`) deeper in
 * the function.
 *
 * `ordinal` is read exactly once — and, like `segments`, through {@link
 * readOwnField}, so a bare `{}` inheriting an `ordinal`/`segments` pair from
 * a polluted `Object.prototype` is rejected exactly like a `{}` that carries
 * neither — then returned in a fresh object alongside the per-element
 * snapshots from {@link assertSegmentShape}, so downstream logic never
 * re-reads a caller-supplied accessor.
 *
 * A SPARSE `segments` array (one with holes) fails closed rather than
 * smuggling an unvalidated element past the boundary: every position from
 * `0` to `length` is validated explicitly, so a hole is rejected exactly
 * like an element that legitimately held `undefined`.
 *
 * @param value - The raw, unvalidated candidate reference.
 * @param paramName - The name of the parameter being validated, used only to
 *   compose a caller-facing error message.
 * @returns A fresh {@link M3LStepReference} holding the validated `ordinal`
 *   and the validated segment snapshots.
 * @throws {@link M3LStepReferenceError} when `value` is not a plain object,
 *   its own `ordinal` is not a number, its own `segments` is not an array
 *   (an inherited `ordinal`/`segments` counting as absent), or any in-bounds
 *   position of `segments` — including a hole — fails
 *   {@link assertSegmentShape}.
 */
export function assertStepReferenceShape(
  value: unknown,
  paramName: string,
): M3LStepReference {
  if (!isPlainObject(value)) {
    throw new M3LStepReferenceError(
      `${paramName} must be a parsed M3LStepReference object, got ${typeof value}`,
    );
  }
  const ordinal = readOwnField(value, "ordinal");
  const rawSegments = readOwnField(value, "segments");
  if (typeof ordinal !== "number" || !Array.isArray(rawSegments)) {
    throw new M3LStepReferenceError(
      `${paramName} must be a parsed M3LStepReference object, got ${typeof value}`,
    );
  }
  // Deliberately NOT `rawSegments.map(...)` — `Array.prototype.map` never
  // invokes its callback for a hole in a sparse array AND preserves the hole
  // in the result, so `assertSegmentShape` would never run for it and the
  // first downstream read of `segment.kind` would throw a raw `TypeError`,
  // outside this function's documented `M3LStepReferenceError` contract.
  // Indexing every position from `0` to `length` instead hands a hole to
  // `assertSegmentShape` as `undefined`, which rejects it as a non-plain
  // object naming the offending index. Same reason `validateBindingValue` in
  // `./binding.js` indexes by `length` rather than using
  // `Array.prototype.every`.
  const rawElements: readonly unknown[] = rawSegments;
  const segments: M3LStepReferenceSegment[] = [];
  for (let index = 0; index < rawElements.length; index++) {
    segments.push(assertSegmentShape(rawElements[index], index, paramName));
  }
  return { ordinal, segments };
}
