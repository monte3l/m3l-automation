/**
 * `internal/step-reference` — builds caller-facing step-output reference
 * text (`step-<ordinal>.output(...)`) for a tree path the JSON tree viewer
 * has navigated to, by thin-wrapping `@m3l-automation/m3l-common/core`'s
 * `formatStepReference`. Private to this package: never re-exported from a
 * public entry point.
 *
 * All parsing/escaping/validation — the ident-safe vs bracket-quoted segment
 * choice, the prototype-pollution guard on property names, the ordinal/index
 * range checks — already lives in `core/orchestration/step-reference`; this
 * module only maps the tree viewer's path-segment shape onto the library's
 * segment shape and forwards.
 *
 * @packageDocumentation
 */

import type { M3LStepReferenceSegment } from "@m3l-automation/m3l-common/core";
import { formatStepReference } from "@m3l-automation/m3l-common/core";

/** One path segment into a JSON value: an object property key (string) or an array index (number). */
export type M3LTreePathSegment = string | number;

/** Maps one tree path segment onto the library's tagged segment shape. */
function toStepReferenceSegment(
  segment: M3LTreePathSegment,
): M3LStepReferenceSegment {
  return typeof segment === "number"
    ? { kind: "index", index: segment }
    : { kind: "property", name: segment };
}

/**
 * Builds the caller-facing step-output reference text naming the value at
 * `path` inside step `ordinal`'s recorded output.
 *
 * Delegates entirely to `formatStepReference` for the reference grammar
 * (ident-safe `.name` segments vs. bracket-quoted `["name"]` segments,
 * `[index]` segments, and every validation it performs) — this function only
 * translates the tree viewer's `M3LTreePathSegment[]` shape into the
 * library's tagged `M3LStepReferenceSegment[]` shape. Any error
 * `formatStepReference` throws (e.g. `M3LStepReferenceError` for a
 * non-positive ordinal or a dangerous property name) propagates unchanged.
 *
 * @param ordinal - The 1-based ordinal of the step whose output the path is
 *   relative to.
 * @param path - The path segments walked from the step's output value to the
 *   target value.
 * @returns The formatted step reference text.
 * @throws {@link M3LStepReferenceError} propagated unchanged from
 *   `formatStepReference` when `ordinal` or `path` do not describe a
 *   well-formed reference.
 * @example
 * ```ts
 * buildStepReference(1, ["Queues", 0, "QueueUrl"]);
 * // => "step-1.output.Queues[0].QueueUrl"
 * ```
 */
export function buildStepReference(
  ordinal: number,
  path: readonly M3LTreePathSegment[],
): string {
  return formatStepReference({
    ordinal,
    segments: path.map(toStepReferenceSegment),
  });
}
