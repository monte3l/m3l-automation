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
 * One segment a writer rotated away from, as the writer itself believes it
 * to be at the moment of rotation.
 *
 * `name` and `byteLength` are bundled into one object, rather than passed as
 * two independently-optional parameters, so "a rotation always carries its
 * believed byte count" is true BY CONSTRUCTION. A bare
 * `rotatedFromBytes?: number` alongside a bare `rotatedFrom?: string` would
 * let a caller supply one without the other — exactly the state
 * {@link "./append-only-sealer.js".AppendOnlySealer}'s rotation guard cannot
 * tolerate: with no believed byte count there is nothing to compare the
 * freshly measured segment against, and that comparison is the whole guard.
 */
export interface AppendOnlyRotatedSegment {
  /**
   * The segment's file name, exactly as the writer's own rotation logic
   * produced it.
   */
  readonly name: string;
  /**
   * What the rotating writer believes `name` holds, in bytes, at the moment
   * it rotates away from it — its own local running counter, seeded from the
   * segment's real size on cold start and incremented only by the bytes this
   * writer itself appended. Never a fresh `stat`.
   *
   * **This is the second-writer guard.** `M3LAppendOnlyStream` supports two
   * writers over one directory: `O_APPEND` lets them interleave whole lines
   * without corrupting each other, but each still tracks `segment.size` as
   * its own LOCAL counter and never re-`stat`s. So writer A's counter can
   * cross `maxSegmentBytes` and rotate A off a segment writer B is still
   * appending to. `AppendOnlySealer`'s rotation seal — unlike its cold-start
   * sweep, which is protected by `datePrefix < today` ruling out any
   * conforming writer still being on the segment — has no such guarantee to
   * lean on, so it re-measures the segment at seal time and compares that
   * measurement against `byteLength`.
   *
   * **Equal → seal as normal. Disagrees, in EITHER direction → defer, and do
   * not claim.** A larger-than-believed measurement is B's bytes, present
   * where this rotation never accounted for them; sealing anyway would
   * durably claim a digest over a PREFIX of what the segment eventually
   * holds — unreproducible by `sha256sum` ever after, and a future false
   * `mismatched` verdict from `verify()` on an untampered trail, which is
   * the worst failure this design can produce. A SMALLER-than-believed
   * measurement defers for the same reason, not a different one: this
   * writer's own accounting and a fresh measurement disagreeing at all
   * means one of the two is wrong, and there is no way from inside the
   * guard to tell a truncated read from a genuinely shorter file — sealing
   * on a count that cannot be reconciled is exactly what this guard exists
   * to prevent, regardless of which side of `byteLength` the disagreement
   * falls on. A deferred segment is picked up by a later cold-start
   * sweep — but only when BOTH conditions hold: a NEW instance starts
   * (the sweep is per-instance state, attempted at most once per process —
   * see `./append-only-sealer.js`'s `#swept` — so the instance that
   * deferred will not revisit this segment itself, no matter how long it
   * keeps running), AND that instance's sweep observes `datePrefix < today`
   * for the segment. So the honest bound is not "unsealed for up to a day"
   * — it is "unsealed until some later instance cold-starts and sweeps it,
   * which a long-lived process that never restarts may never do." Deferring
   * is still the right call anyway, because an unsealed segment is
   * HONESTLY unsealed and visible through two independent channels: a
   * later `verify()` reports it `unsealed` (the "not sealed yet" verdict,
   * not a failure), and `onSealFailed` already fired at the moment of
   * deferral. A seal over a prefix would instead be a confident false
   * claim — unreproducible by `sha256sum` once the rest of the segment is
   * written, and a future `mismatched` verdict from `verify()` on an
   * otherwise-untampered trail. A late-or-absent seal is recoverable by a
   * later sweep or an operator's own re-run; a wrong one is not recoverable
   * at all.
   *
   * **No cross-process coordination is needed** — deliberately, since
   * ADR-0102 has none — because the rotating writer's OWN accounting is
   * already sufficient evidence someone else wrote: no lock, lease, or IPC
   * has to tell A that B exists, A's own counter disagreeing with reality is
   * proof enough.
   *
   * **A mismatch is reported through `onSealFailed`, not silent** — unlike
   * the sweep's own cap-cut case (see
   * `./append-only-sealer.js`'s `#sweep`), which fires on every cold start
   * of a large healthy directory and is therefore expected noise. This
   * guard should never fire at all on a healthy single-writer trail, so
   * when it does fire it is either genuine two-writer contention (worth an
   * operator knowing their directory is shared) or this writer's own
   * counter having drifted stale for some unrelated reason — indistinguishable
   * from inside the guard, but deferring is the correct response to EITHER
   * cause, so the report exists purely to surface the rare event, not to
   * change what happens next.
   */
  readonly byteLength: number;
}

/**
 * What {@link "./append-only-sealer.js".AppendOnlySealer.sealAfterAppend}
 * needs on every append: whether this append rotated, and — when it did —
 * what the writer believes the segment it left behind holds.
 */
export interface AppendOnlySealRequest {
  /**
   * The segment this append rotated away from, or `undefined` when it did
   * not rotate.
   */
  readonly rotatedFrom: AppendOnlyRotatedSegment | undefined;
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
