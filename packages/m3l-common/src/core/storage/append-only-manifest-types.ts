/**
 * `core/storage/append-only-manifest-types` — the public type surface for
 * the append-only stream's manifest sidecar: the payload a caller-supplied
 * seal-failure handler receives when a segment (or the manifest itself)
 * could not be sealed. Verification types for the manifest join this module
 * in a later slice.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../errors/index.js";

/**
 * Reported to a caller-supplied `onSealFailed` handler when
 * {@link M3LAppendOnlyStream}'s best-effort sealing could not write an entry
 * to the directory's `manifest.jsonl` sidecar.
 *
 * Sealing is deliberately best-effort: a seal is metadata *about* bytes that
 * are already durably appended, and failing the append that produced them
 * would discard a new auditable record to protect a proof about an older
 * one. Receiving one of these means a seal was **attempted** and could not
 * be written — not that a segment simply hasn't been sealed yet — and that
 * the entry itself is unaffected: it is already appended and durable. The
 * raw filesystem detail that explains the failure survives on
 * `error.cause`.
 *
 * The handler this is reported to is called synchronously and its return
 * value is never awaited, so it should not be declared `async` — the type
 * permits it, but the library neither waits for nor observes the result. A
 * rejection it produces is discarded rather than surfaced as an unhandled
 * rejection, so a caller whose own reporting can fail must handle that
 * failure inside the handler itself.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlySealFailure } from "@monte3l/m3l-common/core";
 *
 * function onSealFailed(failure: M3LAppendOnlySealFailure): void {
 *   console.warn(
 *     `manifest seal failed for ${failure.segment ?? "(no segment)"}`,
 *     failure.error,
 *   );
 * }
 * ```
 */
export interface M3LAppendOnlySealFailure {
  /**
   * The segment file name the seal was attempted for, or `undefined`.
   *
   * A bare segment name is sanctioned here even though this module's
   * siblings refuse to put caller data on a public error: a segment name is
   * derived entirely from the writer's own clock and its own rotation
   * counter, carries zero bytes read out of the caller's input (unlike a
   * directory path, which can carry tenant or customer identifiers), and is
   * already public through {@link M3LAppendOnlyStream.listSegments}. The one
   * exception is a name the library's own segment-name parser declines to
   * accept — such a name provably did not come from the writer's counter or
   * from a directory inventory, so it can only have arrived from outside,
   * and a failure channel is not the place to hand an attacker-shaped
   * string back; it is reported as `undefined` instead.
   *
   * `undefined` also carries a second, distinct meaning: a manifest-level
   * failure that stopped the whole sealing operation before, or instead of,
   * any one segment — for example a manifest file that cannot be read. A
   * caller must not read `undefined` as "no segment was involved"; it means
   * either "an untrusted name" or "no single segment applies", and the two
   * are not distinguishable from this field alone.
   */
  readonly segment: string | undefined;
  /** The failure, with the raw filesystem detail on `error.cause`. */
  readonly error: M3LError;
}
