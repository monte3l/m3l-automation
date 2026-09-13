/**
 * `internal/storage/append-only-seal-report` — the sealer's OWNER-REPORTING
 * step: turning one seal failure into the owner's own error vocabulary and
 * handing it to the owner's optional handler, factored out of
 * `./append-only-sealer.js` so that module's sealing machinery stays within
 * the per-file size ratchet (ADR-0072) without trimming the reasoning either
 * module carries.
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * @packageDocumentation
 */

import { M3LError } from "../../core/errors/index.js";
import type { AppendOnlyReadFailure } from "./append-only-lines.js";
import type { AppendOnlySealFailure } from "./append-only-sealer-types.js";

/**
 * Reported for a failure that reached {@link reportSealFailure} as something
 * other than the caller's own typed error — a raw throw from the failure port
 * itself, or a defect on a path no `node:fs` call classified.
 */
const SEAL_FAILURE_MESSAGE = "append-only stream: failed to seal a segment";

/**
 * Hands one failure to the owner, in the owner's own vocabulary.
 *
 * A failure that is already an {@link M3LError} came out of the port already
 * and is passed through unchanged rather than double-wrapped, so `cause`
 * still carries the raw filesystem error underneath it.
 *
 * Subordinate to
 * {@link "./append-only-sealer.js".AppendOnlySealer.sealAfterAppend}'s total
 * guard, and needed even so: the port and the handler are the OWNER's code,
 * called from inside the sealer, so a port that cannot build an error or a
 * handler that cannot handle one would otherwise abandon a backlog the
 * sealer could still have worked through. Nothing is left to report a
 * reporting failure to, which is precisely why it ends here.
 *
 * @param handler - The owner's optional failure handler, called with the
 *   built failure. Caller code: may itself throw, and that throw is
 *   swallowed rather than propagated — see this function's TSDoc.
 * @param buildError - The owner's error vocabulary. Caller code: may itself
 *   throw, swallowed the same way as `handler`.
 * @param segment - The segment that could not be sealed, or `undefined` for
 *   a manifest-level failure — see
 *   {@link "./append-only-sealer-types.js".AppendOnlySealFailure.segment}.
 * @param cause - The underlying failure: either an already-typed
 *   {@link M3LError} (passed through unchanged) or raw detail to wrap via
 *   `buildError`.
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * reportSealFailure(
 *   ({ segment, error }) => {
 *     console.error(segment, error);
 *   },
 *   (message, options) => new M3LError(message, options),
 *   "2024-01-01-000001.log",
 *   new Error("EIO"),
 * );
 * ```
 */
export function reportSealFailure(
  handler: ((failure: AppendOnlySealFailure) => void) | undefined,
  buildError: AppendOnlyReadFailure,
  segment: string | undefined,
  cause: unknown,
): void {
  try {
    const error =
      cause instanceof M3LError
        ? cause
        : buildError(SEAL_FAILURE_MESSAGE, { cause });
    handler?.({ segment, error });
  } catch {
    // Best-effort by construction: see this function's TSDoc.
  }
}
