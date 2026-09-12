/**
 * `core/storage/append-only-write-types` — the public constructor options
 * `M3LAppendOnlyStream`'s constructor takes, the write-side counterpart to
 * `append-only-read-types.ts`'s read-side option and payload types
 * (ADR-0061, X7 slice 2).
 *
 * Split out of `M3LAppendOnlyStream.ts` itself under ADR-0072's per-file
 * ratchet (`check:file-budget`): that module sits at the 25,000-byte
 * ceiling, and `M3LAppendOnlyStreamOptions`'s full TSDoc — including the long
 * `onSealFailed` block — does not fit in the remaining headroom alongside
 * the class it configures. Moving it here changes nothing about the
 * exported surface: the type still reaches consumers through the same
 * `core/storage` barrel it always has.
 *
 * @packageDocumentation
 */

import type { M3LAppendOnlySealFailure } from "./append-only-manifest-types.js";

/**
 * Constructor options for
 * {@link "./M3LAppendOnlyStream.js".M3LAppendOnlyStream}.
 *
 * `directory` is required — the stream owns no default location, because the
 * artifact it records (and therefore where that artifact belongs) is the
 * caller's decision. Every ceiling is optional and falls back to the
 * documented default.
 *
 * @example
 * ```ts
 * import type { M3LAppendOnlyStreamOptions } from "@monte3l/m3l-common/core";
 *
 * const options: M3LAppendOnlyStreamOptions = {
 *   directory: "data/output/human-actions",
 *   maxSegmentAgeMs: 3_600_000,
 * };
 * ```
 */
export interface M3LAppendOnlyStreamOptions {
  /** The directory the segments live in; created on the first append. */
  readonly directory: string;
  /**
   * Rotate once the active segment has reached this many bytes. Defaults to
   * {@link M3L_APPEND_ONLY_MAX_SEGMENT_BYTES}.
   *
   * A value below `maxLineBytes` is legal but degenerate: every append finds
   * the ceiling already crossed and rotates first, so the stream writes one
   * entry per segment. Nothing is lost or truncated — it is simply wasteful,
   * and it is left legal so rotation stays testable at sizes a test can
   * reach in a handful of writes.
   */
  readonly maxSegmentBytes?: number;
  /**
   * Rotate once the active segment has been open this many milliseconds.
   * Defaults to {@link M3L_APPEND_ONLY_MAX_SEGMENT_AGE_MS}.
   */
  readonly maxSegmentAgeMs?: number;
  /**
   * The largest line, newline included, one append may carry. Defaults to
   * — and may not exceed — {@link M3L_APPEND_ONLY_MAX_LINE_BYTES}.
   *
   * Lowering it is a caller's business; raising it is refused. The ceiling
   * exists *because* `O_APPEND`'s whole-line atomicity does not cover a write
   * larger than the operating system's write buffer, so raising it to, say,
   * 8 MiB would silently void the "two writers interleave whole lines rather
   * than corrupting one another" guarantee this same class advertises.
   */
  readonly maxLineBytes?: number;
  /**
   * Told about a segment's manifest seal that was **attempted** and could
   * not be written to the directory's `manifest.jsonl` sidecar.
   *
   * Sealing is deliberately best-effort: the seal is metadata *about* bytes
   * that are already durably appended, so a seal that cannot be written
   * never fails the `append()` call it follows. Failing that append to
   * protect a proof about older bytes would discard a new auditable record
   * in order to defend an old one. This handler is therefore the **only**
   * channel a seal failure is reported on — there is no throw, no rejected
   * promise, nothing else to observe it by.
   *
   * Receiving one call means a seal was attempted and failed, which is
   * **not** the same as a segment simply not having been sealed yet (a
   * cold-start sweep that has not reached it, or one still bounded by its
   * per-instance cap, calls this for neither). Either way, the entry the
   * caller just appended is unaffected: it is already appended and durable
   * regardless of whether its segment could be sealed.
   *
   * Called from inside the library's own serialized append chain, so it
   * must not throw and must not block — a slow or blocking handler delays
   * every subsequent `append()` on this instance, and a throwing one is
   * absorbed here rather than being allowed to reach the caller of
   * `append()`.
   *
   * A truthy non-function is rejected at construction with
   * `ERR_INVALID_ARGUMENT`; a falsy value (including omitting the key)
   * degrades to "no handler" — see
   * `internal/storage/append-only-options.js`'s `readOnSealFailed` for the
   * validation.
   */
  readonly onSealFailed?: (failure: M3LAppendOnlySealFailure) => void;
}
