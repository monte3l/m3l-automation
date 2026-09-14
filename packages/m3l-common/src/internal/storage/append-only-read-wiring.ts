/**
 * `internal/storage/append-only-read-wiring` — the adapter that turns
 * `../../core/storage/M3LAppendOnlyStream.js`'s PUBLIC read vocabulary into
 * `./append-only-reader.js`'s INTERNAL one (ADR-0102, X8b slice 4c).
 *
 * Library-internal; never re-exported through a public barrel. Reached only by
 * `../../core/storage/M3LAppendOnlyStream.js`'s public `read()`.
 *
 * **Why an adapter at all.** The two option bags describe the same read from
 * opposite sides. The public one is a caller's policy — which tolerances it is
 * willing to write down — and carries nothing else. The internal one is
 * everything the reader needs to run: the directory and the per-line ceiling
 * the stream chose at construction, the manifest ceiling the sidecar is read
 * under — the library-wide `DEFAULT_MAX_MANIFEST_BYTES`, NOT a construction
 * -time choice, and deliberately the same constant `./append-only-sealer.js`
 * writes the sidecar under — the tolerances, and the error vocabulary every
 * refusal is raised through. Translating between them is a real job with its
 * own rules (see {@link buildReaderOptions}), and holding it here keeps
 * `read()` down to a public-boundary check plus a delegation.
 *
 * **Why the error builders live on this side.** `./append-only-reader.js` is
 * deliberately ignorant of which error class a failure should wear: it raises
 * everything through the `buildError` / `buildManifestError` /
 * `buildIntegrityError` callables its options carry, so the OWNER of the trail
 * names its own failures. The stream owns `M3LAppendOnlyStreamReadError`,
 * `M3LAppendOnlyStreamManifestError` and
 * `M3LAppendOnlyStreamIntegrityError`, and this module is where that
 * ownership is spent — one place the pairing is decided, rather than a choice
 * each call site into the reader could make differently. A second reader entry
 * point wired up somewhere else with only `buildError` would silently
 * downgrade every manifest-level and every integrity-level refusal.
 *
 * This is a seam rather than a dodge, and it has already earned it: X8b slice
 * 4d's inline digest verification brought a third error vocabulary, and it
 * landed here rather than back inside `read()`.
 */

import { isFunction } from "../../core/utils/guards.js";
import type { M3LAppendOnlyReadOptions } from "../../core/storage/append-only-read-types.js";
import type { AppendOnlyReaderOptions } from "./append-only-reader-types.js";
import {
  buildAppendOnlyStreamIntegrityError,
  buildAppendOnlyStreamManifestError,
  buildAppendOnlyStreamReadError,
} from "./append-only-stream-errors.js";

/**
 * What {@link buildReaderOptions} needs in order to wire one read: the
 * stream's own configuration, plus the caller's validated read policy.
 *
 * A single bag rather than positional arguments, matching every other options
 * type in this layer, because {@link AppendOnlyReadWiringRequest.maxLineBytes}
 * and {@link AppendOnlyReadWiringRequest.maxManifestBytes} are adjacent
 * `number`s: passed positionally they could be transposed with no type error,
 * silently measuring a torn tail against the manifest ceiling and the sidecar
 * against the per-line one. That is precisely the class of mis-wiring this
 * module exists to make impossible, so it may not be reintroduced by its own
 * signature. Named fields make the swap a visible mistake at the call site.
 */
export interface AppendOnlyReadWiringRequest {
  /** The stream's directory, as chosen at construction. */
  readonly directory: string;
  /**
   * The ceiling an unterminated trailing fragment is measured against, as
   * chosen at construction.
   */
  readonly maxLineBytes: number;
  /**
   * The hard ceiling the directory's `manifest.jsonl` sidecar is read under —
   * the library constant, not a per-stream setting (see this module's header).
   */
  readonly maxManifestBytes: number;
  /**
   * The caller's validated read policy, or `undefined` when `read()` was
   * called with no argument at all. REQUIRED but nullable: under
   * `exactOptionalPropertyTypes` an optional field could not carry the
   * explicit `undefined` the no-argument call produces, and making the caller
   * state the absent case beats letting a forgotten field read as one.
   */
  readonly readOptions: M3LAppendOnlyReadOptions | undefined;
}

/**
 * Builds the reader's options from the stream's own configuration plus the
 * caller's read policy, pairing each of the reader's three error ports —
 * `buildError`, `buildManifestError`, `buildIntegrityError` — with the stream
 * class that names that kind of refusal. Why that pairing is decided here
 * rather than at each call site is this module's header's argument.
 *
 * Each tolerance is carried by a CONDITIONAL SPREAD, not a direct assignment,
 * for two separate reasons:
 *
 * - `exactOptionalPropertyTypes` forbids setting an optional property to a
 *   value typed `T | undefined`, so the absent case cannot simply be assigned
 *   through.
 * - The spread fires only when the value is actually callable. Validation
 *   (`./append-only-options.js`'s `validateReadOptions`, run at the public
 *   boundary before this is reached) rejects truthy non-functions, so any
 *   falsy non-function that survives it — `null`, `0`, `""` — must degrade to
 *   the absent-callback path rather than being passed through as a
 *   present-but-uncallable callback. That reasoning covers both handlers
 *   equally: such a value would silently swallow a torn tail at one `?.()`
 *   call site, and a sealed-but-absent segment at the other, which is the
 *   opposite of what an absent handler means here — with no handler the reader
 *   THROWS rather than reading short in silence.
 *
 * @param request - The stream's directory and ceilings, plus the caller's
 *   validated read policy.
 * @returns Options the reader can run from, with `onTruncatedTail` and
 *   `onArchivedSegment` present only when the caller supplied a callable one.
 */
export function buildReaderOptions(
  request: AppendOnlyReadWiringRequest,
): AppendOnlyReaderOptions {
  const { readOptions } = request;
  return {
    directory: request.directory,
    maxLineBytes: request.maxLineBytes,
    maxManifestBytes: request.maxManifestBytes,
    ...(isFunction(readOptions?.onTruncatedTail) && {
      onTruncatedTail: readOptions.onTruncatedTail,
    }),
    ...(isFunction(readOptions?.onArchivedSegment) && {
      onArchivedSegment: readOptions.onArchivedSegment,
    }),
    buildError: buildAppendOnlyStreamReadError,
    buildManifestError: buildAppendOnlyStreamManifestError,
    buildIntegrityError: buildAppendOnlyStreamIntegrityError,
  };
}
