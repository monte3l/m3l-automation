/**
 * `core/orchestration/shape` — caller-supplied-shape validation for a
 * {@link M3LStepReference}.
 *
 * This module answers a single boundary question — "is this caller-supplied
 * `unknown` value even SHAPED like a parsed step reference?" — which is
 * distinct from the grammar concern owned by
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
 * Narrows one element of a `segments` array to a well-formed {@link
 * M3LStepReferenceSegment}, or throws {@link M3LStepReferenceError} naming
 * the bad index. Called once per element from {@link
 * assertStepReferenceShape}, so segment-element validation happens exactly
 * once, at the entry-point boundary — never scattered through the later
 * walk/format logic, which can therefore trust every segment it's handed.
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
 *   has an unrecognised `kind`, or carries a `name`/`index` of the wrong
 *   type for its `kind`.
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
  const kind = value["kind"];
  if (kind === "property") {
    const name = value["name"];
    if (typeof name !== "string") {
      throw new M3LStepReferenceError(
        `${paramName}.segments[${String(index)}] is a property segment but "name" must be a string, got ${typeof name}`,
      );
    }
    return Object.freeze({ kind: "property", name });
  }
  if (kind === "index") {
    const segmentIndex = value["index"];
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
 * {@link M3LStepReference} — a plain object with a numeric `ordinal` and an
 * array `segments` whose every ELEMENT is itself a well-formed {@link
 * M3LStepReferenceSegment} (see {@link assertSegmentShape}) — or throws
 * {@link M3LStepReferenceError}. Used at the public entry points
 * (`formatStepReference`, `resolveStepReference`) that accept an
 * already-parsed reference rather than raw caller text, so a non-object/
 * malformed argument, or a malformed segment nested inside an otherwise
 * well-formed one, is classified as a caller error rather than reaching a
 * raw `TypeError` (or, worse, silently resolving to `undefined`) deeper in
 * the function.
 *
 * `ordinal` is read exactly once and returned in a fresh object alongside
 * the per-element snapshots from {@link assertSegmentShape}, so downstream
 * logic never re-reads a caller-supplied accessor.
 *
 * @param value - The raw, unvalidated candidate reference.
 * @param paramName - The name of the parameter being validated, used only to
 *   compose a caller-facing error message.
 * @returns A fresh {@link M3LStepReference} holding the validated `ordinal`
 *   and the validated segment snapshots.
 * @throws {@link M3LStepReferenceError} when `value` is not a plain object,
 *   its `ordinal` is not a number, its `segments` is not an array, or any
 *   element of `segments` fails {@link assertSegmentShape}.
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
  const ordinal = value["ordinal"];
  const rawSegments = value["segments"];
  if (typeof ordinal !== "number" || !Array.isArray(rawSegments)) {
    throw new M3LStepReferenceError(
      `${paramName} must be a parsed M3LStepReference object, got ${typeof value}`,
    );
  }
  const segments = rawSegments.map((segment, index) =>
    assertSegmentShape(segment, index, paramName),
  );
  return { ordinal, segments };
}
