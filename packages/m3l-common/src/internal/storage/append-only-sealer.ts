/**
 * `internal/storage/append-only-sealer` — the append-only stream's writer-side
 * half of the sealed-segment manifest: WHEN a segment is sealed, and what
 * happens when sealing fails (ADR-0102, X8b slice 5).
 *
 * Library-internal; never re-exported through a public barrel. It owns no I/O
 * primitive of its own — not one `open`, `readdir`, `stat` or `appendFile`
 * call is issued here. The measurement is `./append-only-digest.js`'s, the
 * manifest read and both record appends are `./append-only-manifest.js`'s, and
 * the inventory is `./append-only-segments.js`'s. That is deliberate: every
 * refusal those modules apply (`O_NOFOLLOW`, the post-open `nlink`/`isFile`
 * check, the bounded chunked read, the torn-tail policy) is inherited rather
 * than re-implemented, and a proof path with weaker guarantees than the read
 * path it vouches for would prove nothing.
 *
 * **The central claim: this module NEVER throws.** ADR-0061's loud-write rule
 * governs an ENTRY; a seal is metadata about bytes that are already durably
 * appended. Failing the append to protect a proof about older bytes would
 * discard a new auditable record in order to defend an old one, so every
 * failure — a digest that cannot run, a manifest that cannot be read, an
 * append that cannot be written, a `buildError` port or an `onSealFailed`
 * handler that itself throws — is REPORTED and never propagated. Loudness
 * relocates rather than disappearing: bounded in-process retry, the
 * {@link "./append-only-sealer-types.js".AppendOnlySealerOptions.onSealFailed} handler, and (later) the
 * `unsealed` verdict `verify()` returns.
 *
 * That claim is held by ONE total guard in
 * {@link AppendOnlySealer.sealAfterAppend} rather than by a `catch` at each
 * call site, because the paths a test can construct are never all the paths
 * there are: a synchronous `TypeError` from a name no writer renders, an
 * errno class unique to another filesystem, a throw after the last `await`
 * under concurrency. A guard scoped to the calls someone thought of leaves
 * exactly those bare. `./append-only-seal-report.js` carries a further `try`
 * of its own, subordinate to that guard — see that module for why.
 *
 * **Two date rules, and they genuinely differ.** A ROTATION seal ignores the
 * at-or-before-baseline filter; the cold-start SWEEP obeys it. The baseline
 * says nothing at or before it was verified *when written*; a seal says what
 * the bytes were *at seal time*. Both are true together, and the pair is
 * strictly more precise than either alone — after sealing, later tampering
 * with that segment is detectable even though its original contents never
 * were. Under the other reading, the first rotation after an upgrade produces
 * no seal at all and the feature reads as broken to the operator who upgraded
 * to get it.
 *
 * @packageDocumentation
 */

import type { M3LAppendOnlySegment } from "../../core/storage/append-only-read-types.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type { ManifestContents } from "./append-only-manifest.js";
import { loadOrInitializeManifest } from "./append-only-manifest.js";
import { reportSealFailure } from "./append-only-seal-report.js";
import {
  appendClaim,
  corroborateClaim,
  measureSegment,
} from "./append-only-seal-attempt.js";
import type {
  AppendOnlyRotatedSegment,
  AppendOnlySealFailure,
  AppendOnlySealerOptions,
  AppendOnlySealRequest,
} from "./append-only-sealer-types.js";
import {
  currentDatePrefix,
  listSegmentFiles,
  parseSegmentName,
} from "./append-only-segments.js";
import {
  baselineBoundaryKey,
  isAtOrBeforeBaseline,
} from "./append-only-sweep-policy.js";

/**
 * How many segments one instance's cold-start sweep may seal. A pathological
 * directory — a crashed process's whole backlog, or a trail nobody has run
 * the sealer against since an upgrade — must not turn one cold start into an
 * unbounded read on the append path.
 */
const DEFAULT_MAX_SWEEP_SEALS = 64;

/**
 * How many times one segment's seal is attempted before it is reported. More
 * than one because a transient `EIO`/`EAGAIN` on a single read should not cost
 * a proof; bounded because the append path is not the place to wait out a
 * filesystem that is genuinely down.
 */
const DEFAULT_MAX_SEAL_ATTEMPTS = 3;

/** Reported when a segment's directory inventory cannot be taken. */
const LISTING_FAILURE_MESSAGE =
  "append-only stream: failed to list segments while sealing";

/** Reported when a rotation names something this writer would not render. */
const FOREIGN_NAME_MESSAGE =
  "append-only stream: refused to seal a name this writer would not produce";

/** Reported when {@link AppendOnlySealer.#sealSegment}'s `expectedByteLength` guard defers a rotation seal. */
const ROTATION_DISAGREEMENT_MESSAGE =
  "append-only stream: deferred a rotation seal — segment size disagrees with the writer's count";

/** Re-exported for existing importers — see `./append-only-sealer-types.js`. */
export type { AppendOnlySealFailure, AppendOnlySealerOptions };

/**
 * Resolves one of the sealer's caller-overridable bounds: `override` when
 * it is a finite number, clamped up to `floor`; `fallback` when `override`
 * is `undefined` or not finite.
 *
 * **A malformed override must not silently disable what it bounds.**
 * `Math.max(floor, NaN)` is `NaN`, and a `NaN` reaching
 * `Array.prototype.slice(0, …)` yields an EMPTY list — the sweep silently
 * off — or a zero-iteration `for` loop bound, indistinguishable from
 * "already sealed". Once these two options reach the public surface a later
 * slice adds, the value is no longer library-controlled, so this is what
 * keeps a caller's typo from reading as success.
 */
function resolveSealerBound(
  override: number | undefined,
  fallback: number,
  floor: number,
): number {
  return override !== undefined && Number.isFinite(override)
    ? Math.max(floor, override)
    : fallback;
}

/**
 * Seals segments on the writer's behalf: the one the writer just rotated away
 * from, plus — once per instance — the backlog a crashed predecessor left
 * behind.
 *
 * **The digest bound is `maxSegmentBytes + maxLineBytes`, not
 * `maxSegmentBytes`.** `shouldRotate` tests `segment.size >= maxSegmentBytes`
 * BEFORE the append, so the line that crosses the ceiling lands in the
 * OUTGOING segment. A sealer sized at `maxSegmentBytes` would therefore
 * truncate its read of exactly the segments that rotated on size — the common
 * case — and refuse to seal them (ADR-0102).
 *
 * **The sweep admits only a STRICTLY OLDER date prefix than
 * {@link "./append-only-segments.js".currentDatePrefix}.** The looser-looking
 * rule "today's segments below the highest sequence" is rejected outright:
 * writer A can sit at sequence 3 while writer B creates sequence 4, so B's
 * sweep would digest a prefix of a file A is still appending to — a false
 * positive on a tamper guard, the worst failure this design can have. The
 * strict rule is airtight instead, because `shouldRotate`'s date check forces
 * any conforming writer off a non-today segment on its next write and
 * `discoverActiveSegment` only ever adopts today's prefix.
 *
 * The sweep set is the on-disk inventory minus manifest-named, minus
 * at-or-before-baseline, minus today's date, oldest first and capped by
 * {@link "./append-only-sealer-types.js".AppendOnlySealerOptions.maxSweepSeals}. On a healthy trail that is
 * one manifest read and ZERO segment bytes re-read — a performance contract
 * the writer depends on, since this runs on the append path.
 *
 * Sealing NEVER throws; see this module's header for why, and
 * {@link AppendOnlySealer.sealAfterAppend} for the guard that holds it.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * const sealer = new AppendOnlySealer({
 *   directory,
 *   maxSegmentBytes,
 *   maxLineBytes,
 *   maxManifestBytes,
 *   buildError: (message, options) =>
 *     new M3LError(message, { code: "ERR_STORAGE_WRITE", ...options }),
 *   onSealFailed: ({ segment }) => {
 *     unsealed.add(segment);
 *   },
 * });
 * await sealer.sealAfterAppend({ rotatedFrom });
 * ```
 */
export class AppendOnlySealer {
  /** The stream directory; never named in a message or a `context`. */
  readonly #directory: string;

  /** `maxSegmentBytes + maxLineBytes` — see this class's TSDoc. */
  readonly #maxDigestBytes: number;

  /** The ceiling the manifest is read under. */
  readonly #maxManifestBytes: number;

  /** The owner's error vocabulary. Caller code: may itself throw. */
  readonly #buildError: AppendOnlyReadFailure;

  /** The owner's failure handler, if any. Caller code: may itself throw. */
  readonly #onSealFailed:
    ((failure: AppendOnlySealFailure) => void) | undefined;

  /** The cold-start sweep's per-instance ceiling. */
  readonly #maxSweepSeals: number;

  /** Attempts per segment before its failure is reported once. */
  readonly #maxSealAttempts: number;

  /**
   * Whether this instance has already ATTEMPTED its one sweep.
   *
   * Per-INSTANCE state, deliberately not a latch written into the directory:
   * a crashed process's successor must sweep the backlog it left, and it can
   * only know to do so by being a new instance. Set at the top of
   * {@link AppendOnlySealer.#sealAndSweep}, before the manifest is even
   * loaded — marking the ATTEMPT, not the outcome, is the point. A manifest
   * that cannot be read (a symlink planted over it, a permissions change)
   * must still flip this to `true`, or every later no-rotation append
   * re-enters `#sealAndSweep`, re-opens the unreadable manifest, fails again,
   * and reports again — one extra open and one report per append for the
   * life of the instance, the unbounded append-path cost this module exists
   * not to impose.
   *
   * The trade this makes is real: an instance whose first load fails will
   * not sweep later even if the manifest becomes readable again. That is
   * deliberate — the sweep is best-effort recovery that every NEW instance
   * repeats, so the cost of never marking the attempt is one deferred
   * backlog per unlucky instance, which is bounded, against unbounded work
   * on the append path, which is not. A ROTATION seal is unaffected: it
   * re-attempts the manifest load on every rotation regardless of this
   * flag, which is correct (a rotation is about bytes this process itself
   * just wrote) and rare (bounded by how often the writer rotates).
   */
  #swept: boolean = false;

  /**
   * @param options - The directory, the two ceilings, the error vocabulary,
   *   and the optional reporting handler and bounds.
   */
  constructor(options: AppendOnlySealerOptions) {
    this.#directory = options.directory;
    this.#maxDigestBytes = options.maxSegmentBytes + options.maxLineBytes;
    this.#maxManifestBytes = options.maxManifestBytes;
    this.#buildError = options.buildError;
    this.#onSealFailed = options.onSealFailed;
    this.#maxSweepSeals = resolveSealerBound(
      options.maxSweepSeals,
      DEFAULT_MAX_SWEEP_SEALS,
      0,
    );
    this.#maxSealAttempts = resolveSealerBound(
      options.maxSealAttempts,
      DEFAULT_MAX_SEAL_ATTEMPTS,
      1,
    );
  }

  /**
   * Seals what this append made sealable, and sweeps once per instance.
   *
   * **This promise never rejects.** The whole operation sits under one total
   * guard — the manifest load, the rotation seal, the inventory, every swept
   * segment, and the reporting of all of them — because the failures anyone
   * can enumerate are never all the failures there are. Deleting the guard is
   * the mutation that must turn the sealer's failure suite red.
   *
   * An append that did not rotate, on an instance that has already swept,
   * returns without touching the filesystem at all: the common case on the
   * append path is that there is nothing whatsoever to do.
   *
   * @param request - Whether this append rotated, and if so, the rotated
   *   segment plus what the writer believes it holds — see
   *   {@link "./append-only-sealer-types.js".AppendOnlySealRequest}. Ignores the sweep's
   *   at-or-before-baseline filter (this module's header); guarded instead
   *   by {@link AppendOnlySealer.#sealSegment}'s `expectedByteLength` check.
   */
  async sealAfterAppend(request: AppendOnlySealRequest): Promise<void> {
    const { rotatedFrom } = request;
    if (rotatedFrom === undefined && this.#swept) {
      return;
    }
    try {
      await this.#sealAndSweep(rotatedFrom);
    } catch (cause) {
      // Manifest-level: nothing that reaches here is attributable to one
      // segment, and a single fault must not fan out into one report per
      // candidate.
      this.#report(undefined, cause);
    }
  }

  /**
   * The operation the total guard wraps: read (or initialize) the manifest,
   * seal the rotated segment, then sweep.
   *
   * Ordered so the rotation seal — about bytes this process itself just
   * wrote — is attempted before any backlog work that could fail, and so the
   * sweep's per-instance budget can never be consumed by it.
   *
   * `#swept` is captured into `alreadySwept` and flipped to `true` BEFORE the
   * manifest load, not after — see `#swept`'s own TSDoc for why the attempt,
   * not the outcome, is what must be marked. The local capture is what lets
   * this method still tell "already swept before this call" from "swept for
   * the first time just now": both read `true` off the field by the time the
   * sweep step is reached, and only the local remembers which.
   */
  async #sealAndSweep(
    rotatedFrom: AppendOnlyRotatedSegment | undefined,
  ): Promise<void> {
    const alreadySwept = this.#swept;
    this.#swept = true;
    const contents = await loadOrInitializeManifest(
      this.#directory,
      this.#maxManifestBytes,
      this.#buildError,
    );
    // Mutable, and seeded from the manifest just read: a segment sealed by
    // this call is a segment the sweep must not seal again — which is also
    // how a rotation across UTC midnight avoids being swept a second time.
    const sealed = new Set(contents.seals.keys());
    if (rotatedFrom !== undefined) {
      await this.#sealRotatedSegment(rotatedFrom, contents, sealed);
    }
    if (alreadySwept) {
      return;
    }
    await this.#sweep(contents, sealed);
  }

  /**
   * Seals every segment a crashed predecessor left behind, oldest first and
   * capped at {@link "./append-only-sealer-types.js".AppendOnlySealerOptions.maxSweepSeals}.
   *
   * The cap bounds the READS and not merely the manifest lines written, which
   * is what actually stops a pathological directory from turning one cold
   * start into an unbounded read: candidates are cut to the budget before any
   * of them is opened.
   *
   * The inventory is `./append-only-segments.js`'s, whose per-entry `lstat`
   * refusals already exclude a symlink or a hardlink planted at a segment
   * name, and whose failures propagate raw — wrapped here into the owner's
   * vocabulary, then out to the total guard, since a directory that cannot be
   * listed is not attributable to any one segment.
   *
   * **A candidate cut by the cap reaches no reporter at all** — it is neither
   * sealed nor passed to `#sealSegment`, so `onSealFailed` never fires for it.
   * This is deliberate, not an oversight: a directory holding more backlog
   * than one instance's budget is not a failure of any one segment, and
   * routing the excess to `onSealFailed` would fire on every cold start of a
   * large healthy trail, exactly the sort of alarm an operator learns to
   * ignore. The backlog still converges: candidates are taken oldest-first,
   * so each new instance's sweep works down from where the last one's cap
   * cut off, and the same-instance rotation seal keeps pace with newly
   * created segments regardless. The excess becomes observable another way —
   * as `verify()`'s `unsealed` verdict for whatever a sweep has not yet
   * reached — which is the intended channel for "not sealed yet", as opposed
   * to `onSealFailed`'s "tried and failed to seal".
   */
  async #sweep(contents: ManifestContents, sealed: Set<string>): Promise<void> {
    let segments: readonly M3LAppendOnlySegment[];
    try {
      ({ segments } = await listSegmentFiles(this.#directory));
    } catch (cause) {
      throw this.#buildError(LISTING_FAILURE_MESSAGE, { cause });
    }
    const today = currentDatePrefix();
    const boundaryKey = baselineBoundaryKey(contents);
    const candidates = segments
      .filter(
        (segment) =>
          segment.datePrefix < today &&
          !sealed.has(segment.name) &&
          !isAtOrBeforeBaseline(segment, boundaryKey),
      )
      .slice(0, this.#maxSweepSeals);
    for (const candidate of candidates) {
      // Serially, and each one self-contained: one segment nobody can digest
      // is reported and skipped, never a reason to abandon the backlog.
      await this.#sealSegment(candidate.name, sealed);
    }
  }

  /**
   * Seals the just-rotated segment by CORROBORATING any manifest claim
   * already on record for it, via
   * {@link "./append-only-seal-attempt.js".corroborateClaim}, rather than
   * trusting membership: a claim forged before any genuine seal exists is
   * otherwise never contradicted. Both outcomes write nothing; disagreement
   * is reported, since two seals per segment are fatal to read. Delegates
   * to {@link AppendOnlySealer.#sealSegment} when nothing is recorded yet —
   * carrying `rotated.byteLength` along, which is where the second-writer
   * guard actually lives. The sweep stays membership-only (corroborating its
   * backlog would make cold start unbounded), so a forgery on a SWEPT
   * segment stays undetected until `verify()`.
   */
  async #sealRotatedSegment(
    rotated: AppendOnlyRotatedSegment,
    contents: ManifestContents,
    sealed: Set<string>,
  ): Promise<void> {
    const { name: segment, byteLength: expectedByteLength } = rotated;
    const existing = contents.seals.get(segment);
    if (existing === undefined) {
      await this.#sealSegment(segment, sealed, expectedByteLength);
      return;
    }
    if (parseSegmentName(segment) === undefined) {
      this.#report(undefined, this.#buildError(FOREIGN_NAME_MESSAGE));
      return;
    }
    const outcome = await corroborateClaim({
      directory: this.#directory,
      segment,
      existing,
      maxDigestBytes: this.#maxDigestBytes,
      maxSealAttempts: this.#maxSealAttempts,
      buildError: this.#buildError,
    });
    if (!outcome.ok) {
      this.#report(segment, outcome.failure);
    }
  }

  /**
   * Measures one segment and appends its seal, retrying each half a bounded
   * number of times before reporting the LAST failure exactly once.
   *
   * **The measurement is taken at most once; the claim it produces is what
   * every retried append carries.** Retrying digest-and-append as one whole
   * used to re-run the digest on every attempt too, so an `appendSeal` that
   * failed AFTER its line already reached the manifest — a write that lands
   * but whose confirmation is lost — would be retried with a FRESH digest. If
   * the segment changed between attempts (a rotation, a concurrent writer),
   * the retry's line would disagree with the one already on disk, and
   * `./append-only-manifest.js` documents that a segment named by two
   * disagreeing seals throws at read time — a best-effort path that must
   * never fail an append would have made the whole trail unreadable. Splitting
   * measurement from append and holding the claim fixed across the second
   * loop makes a retry-born duplicate agree with the original by
   * construction, never merely by chance.
   *
   * Retry is in-process and immediate in both halves: the failure worth
   * surviving here is a transient read/write error on an otherwise healthy
   * file, and waiting is not something an append path may do. A segment the
   * manifest already names is not re-sealed — an agreeing duplicate is
   * tolerated at read time, but measuring a file again to write a line that
   * says what is already said is work the append path should not pay for.
   *
   * A name {@link parseSegmentName} declines is refused rather than digested.
   * Whatever such a name reached the writer by, joining it onto the stream
   * directory and hashing whatever comes back would seal bytes that are not
   * this trail's, under a name no reader will ever look for. It is also
   * reported with `segment: undefined`, not the rejected name — see
   * {@link "./append-only-sealer-types.js".AppendOnlySealFailure.segment} for the general carve-out and why
   * THIS path is its one exception. Every other caller of `#sealSegment`
   * passes a name the inventory already accepted or the writer's own
   * rotation counter produced; a name this check declines can only have
   * arrived through `sealAfterAppend`'s caller-supplied `rotatedFrom`, and
   * provably did NOT come from either trusted source —
   * `"../../../../etc/passwd"` parses as declined precisely because it is
   * attacker-shaped, and a failure channel is not the place to hand it back.
   *
   * **`expectedByteLength`, when given, is the second-writer guard**: only
   * `#sealRotatedSegment` supplies it, and a mismatch against the fresh
   * measurement DEFERS this seal (no claim appended) rather than risk one
   * over a prefix — see
   * {@link "./append-only-sealer-types.js".AppendOnlyRotatedSegment.byteLength} for the full reasoning, why no
   * cross-process coordination is needed, and why this is reported through
   * `onSealFailed` rather than silent.
   */
  async #sealSegment(
    segment: string,
    sealed: Set<string>,
    expectedByteLength?: number,
  ): Promise<void> {
    if (sealed.has(segment)) {
      return;
    }
    if (parseSegmentName(segment) === undefined) {
      // `undefined`, not `segment`: this is the one path where the name is
      // provably NOT writer-derived — see this method's TSDoc for why that
      // makes it the exception to `AppendOnlySealFailure.segment`'s own
      // carve-out.
      this.#report(undefined, this.#buildError(FOREIGN_NAME_MESSAGE));
      return;
    }
    const measurement = await measureSegment({
      directory: this.#directory,
      segment,
      maxDigestBytes: this.#maxDigestBytes,
      maxSealAttempts: this.#maxSealAttempts,
      buildError: this.#buildError,
    });
    if (!measurement.ok) {
      this.#report(segment, measurement.failure);
      return;
    }
    if (
      expectedByteLength !== undefined &&
      measurement.value.byteLength !== expectedByteLength
    ) {
      // Second writer detected (or a stale counter for some other reason) —
      // see this method's TSDoc. Defer: append no claim, leave the segment
      // for the next cold-start sweep once its date has passed.
      this.#report(segment, this.#buildError(ROTATION_DISAGREEMENT_MESSAGE));
      return;
    }
    const append = await appendClaim({
      directory: this.#directory,
      claim: measurement.value,
      maxSealAttempts: this.#maxSealAttempts,
      buildError: this.#buildError,
    });
    if (!append.ok) {
      this.#report(segment, append.failure);
      return;
    }
    sealed.add(segment);
  }

  /** Delegates to {@link "./append-only-seal-report.js".reportSealFailure}. */
  #report(segment: string | undefined, cause: unknown): void {
    reportSealFailure(this.#onSealFailed, this.#buildError, segment, cause);
  }
}
