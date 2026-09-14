/**
 * `core/storage/M3LAppendOnlyStreamManifestError` — typed failure for the
 * append-only stream's directory-wide `manifest.jsonl` sidecar, raised when
 * that sidecar could not be read or appended to, or when what it says cannot
 * be reconciled with the segments on disk — while sealing a segment
 * (ADR-0102, X8b slice 4a) and while planning a read (X8b slice 4c).
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * Constructor options for {@link M3LAppendOnlyStreamManifestError}.
 *
 * `cause` is optional; the error code is always
 * `"ERR_APPEND_ONLY_STREAM_MANIFEST"` and is set automatically — callers
 * must not supply it.
 */
interface M3LAppendOnlyStreamManifestErrorOptions {
  /**
   * Structured detail about the failure — byte counts and similar
   * operational facts the library computed itself. **Never** caller data:
   * no directory path, no entry key, no entry value.
   */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, when this failure wraps another error. */
  readonly cause?: unknown;
}

/**
 * Raised when the stream directory's `manifest.jsonl` sidecar — the proof
 * that whole-date archival has not silently skipped a sealed segment — could
 * not be read or appended to, or when what it states cannot be reconciled
 * with the segments actually on disk.
 *
 * The entries the stream appends are **unaffected**: they are already
 * appended and durable by the time sealing runs, regardless of whether the
 * seal itself succeeds. So this is not "my trail is unwritable" and not "my
 * trail is corrupt" either — it is a third, narrower incident: the trail can
 * no longer be **proven** over the segment(s) the failing proof covers.
 * `instanceof` is how a caller tells these apart without parsing a message
 * string:
 *
 * - {@link M3LAppendOnlyStreamError} — "my trail is unwritable" (a 503,
 *   retry elsewhere).
 * - `M3LAppendOnlyStreamReadError` — "my trail is corrupt" (an operator
 *   page).
 * - `M3LAppendOnlyStreamManifestError` (this class) — "my trail can no
 *   longer be proven" (a compliance escalation, not an outage).
 * - {@link "./M3LAppendOnlyStreamIntegrityError.js".M3LAppendOnlyStreamIntegrityError}
 *   — "these are not the bytes I sealed", for a sealed segment still on disk
 *   whose re-digest disagrees with its seal. That class states its own
 *   rationale; the distinction from this one is only that a missing proof
 *   and a contradicted proof are not the same incident.
 *
 * Collapsing these into one shared `code` would force every caller back to
 * inspecting a message string to recover the distinction.
 *
 * This error is **never thrown** out of `append()`/`write()`. Sealing is
 * best-effort by construction — a seal is metadata about bytes already
 * durably appended, and failing the append that produced them in order to
 * protect a proof about an *older* entry would discard a new auditable
 * record.
 *
 * **The write path is not the only way it reaches a caller, and the three
 * channels differ in whether it is thrown.** A `catch` written for one of
 * them does not cover the others:
 *
 * - The sealer REPORTS it, through the optional `onSealFailed` handler on
 *   `M3LAppendOnlyStreamOptions` and `M3LAgentDecisionLogOptions`, carried on
 *   `M3LAppendOnlySealFailure.error`.
 * - `M3LAppendOnlyStream.read()` THROWS it, in two distinct cases, both
 *   raised while planning the read — so the failure surfaces on the
 *   consumer's first `next()`, with no entry yielded: the directory's
 *   `manifest.jsonl` states a seal for a segment that is no longer on disk
 *   and no `onArchivedSegment` handler was supplied, or a `manifest.jsonl`
 *   that IS present cannot be read or parsed at all. An ABSENT manifest is
 *   neither case — a stream that has never sealed anything is a legitimate
 *   state and reads clean.
 * - `M3LAppendOnlyStream.verify()` CARRIES it without throwing: that method
 *   never rejects, so a manifest it could not read becomes an entry in the
 *   returned report's `failures` array instead of a rejection.
 *
 * Code between those channels and an eventual caller can turn a throw into a
 * chained `cause`: a handler bound by a never-throws contract — an
 * `onSealFailed` implementation, for instance — can only wrap this error in
 * one of its own, so a caller may have to walk `cause` to find it.
 *
 * Its message and `context` carry only operational facts the library
 * computed itself — never a path, never entry keys or values. The chained
 * `cause` is the documented exception, in the same register as
 * {@link M3LAppendOnlyStreamError}: a filesystem failure arrives as Node's
 * own `ENOENT` / `EACCES` / `ELOOP` error, which quotes the path it failed
 * on. Code forwarding one of these to a log sink should report `message`
 * and `context`, and walk `cause` only where a caller-supplied path is
 * acceptable to record.
 *
 * @example
 * ```ts
 * import {
 *   M3LAppendOnlyStream,
 *   M3LAppendOnlyStreamManifestError,
 * } from "@monte3l/m3l-common/core";
 *
 * const stream = new M3LAppendOnlyStream({
 *   directory: "data/output/audit",
 *   onSealFailed: (failure) => {
 *     if (failure.error instanceof M3LAppendOnlyStreamManifestError) {
 *       // The entry itself is durable; only the proof of sealing is at risk.
 *       console.warn("audit trail seal unprovable", failure.error.message);
 *     }
 *   },
 * });
 *
 * // …and the same class is THROWN out of `read()`, so a reader that only
 * // handles `M3LAppendOnlyStreamReadError` would let this one escape.
 * try {
 *   for await (const entry of stream.read()) console.log(entry);
 * } catch (error) {
 *   if (error instanceof M3LAppendOnlyStreamManifestError) {
 *     // Compliance escalation, not an outage: the trail can no longer be
 *     // proven complete, and nothing was yielded.
 *     console.warn("audit trail unprovable", error.message);
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 */
export class M3LAppendOnlyStreamManifestError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_APPEND_ONLY_STREAM_MANIFEST"`. */
  override readonly code: "ERR_APPEND_ONLY_STREAM_MANIFEST";

  /**
   * Creates a new `M3LAppendOnlyStreamManifestError`.
   *
   * @param message - Human-readable description of the manifest failure.
   * @param options - Optional options bag; `context` carries operational
   *   detail only (never caller data), and `cause` carries the underlying
   *   error if applicable. The error code is always
   *   `"ERR_APPEND_ONLY_STREAM_MANIFEST"` — it cannot be overridden.
   */
  constructor(
    message: string,
    options?: M3LAppendOnlyStreamManifestErrorOptions,
  ) {
    super(message, {
      code: "ERR_APPEND_ONLY_STREAM_MANIFEST",
      ...(options?.context !== undefined && { context: options.context }),
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
    this.code = "ERR_APPEND_ONLY_STREAM_MANIFEST";
  }
}
