/**
 * `internal/storage/append-only-sealer-types` — the sealer's VOCABULARY:
 * what its owner supplies ({@link AppendOnlySealerOptions}) and what it is
 * told when a seal could not be written
 * ({@link AppendOnlySealFailure}), stated apart from
 * `./append-only-sealer.js`'s machinery that acts on them. Split out purely
 * for size (ADR-0072's per-file ratchet) — see
 * `./append-only-manifest.js`/`./append-only-manifest-records.js` for the
 * same split applied to that module's record types.
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../../core/errors/index.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";

/** One seal that could not be written, as reported to the owner. */
export interface AppendOnlySealFailure {
  /**
   * The segment that could not be sealed, or `undefined` for a MANIFEST-level
   * failure — one that stopped the whole operation before (or instead of) any
   * one segment, such as a manifest that cannot be read.
   *
   * A segment NAME is sanctioned here where a directory path is not: it
   * derives from the writer's own clock and counter, carries zero caller
   * bytes, and is already public through `listSegments()`. The one exception
   * is a name {@link "./append-only-segments.js".parseSegmentName} declines:
   * see `./append-only-sealer.js`'s `AppendOnlySealer` (its private
   * `#sealSegment`) for why that name is exactly the one this carve-out's
   * reasoning does not cover, and reports `undefined`.
   */
  readonly segment: string | undefined;
  /**
   * The failure, built through {@link AppendOnlySealerOptions.buildError} so
   * the owner sees its own error vocabulary rather than a class this module
   * does not own. Raw filesystem detail survives on `cause`.
   */
  readonly error: M3LError;
}

/**
 * Everything {@link "./append-only-sealer.js".AppendOnlySealer} needs; it
 * holds no defaults of its own.
 */
export interface AppendOnlySealerOptions {
  /** The stream directory holding the segments and the manifest. */
  readonly directory: string;
  /**
   * The writer's segment ceiling. Half of the digest bound — see
   * {@link "./append-only-sealer.js".AppendOnlySealer} for why the sum, and
   * never this alone, is it.
   */
  readonly maxSegmentBytes: number;
  /** The writer's line ceiling, the other half of the digest bound. */
  readonly maxLineBytes: number;
  /** The ceiling the manifest is read under, enforced on bytes read. */
  readonly maxManifestBytes: number;
  /** The owner's error vocabulary for every failure raised while sealing. */
  readonly buildError: AppendOnlyReadFailure;
  /**
   * Told about every seal that could not be written. Optional: the sealer
   * never depends on a handler being there to absorb a failure, and a handler
   * that throws cannot break it either.
   */
  readonly onSealFailed?: (failure: AppendOnlySealFailure) => void;
  /**
   * Overrides the sealer's default sweep cap. A non-finite value (`NaN`,
   * `±Infinity`) falls back to the default instead — see
   * `./append-only-sealer.js`'s `resolveSealerBound`.
   */
  readonly maxSweepSeals?: number;
  /**
   * Overrides the sealer's default per-segment attempt count. Same
   * non-finite fallback as {@link maxSweepSeals} — see
   * `./append-only-sealer.js`'s `resolveSealerBound`.
   */
  readonly maxSealAttempts?: number;
}
