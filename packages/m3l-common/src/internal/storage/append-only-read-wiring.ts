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
 * everything the reader needs to run: the directory and the ceilings the
 * stream chose at construction, the tolerances, and the error vocabulary every
 * refusal is raised through. Translating between them is a real job with its
 * own rules (see {@link buildReaderOptions}), and holding it here keeps
 * `read()` down to a public-boundary check plus a delegation.
 *
 * **Why the error builders live on this side.** `./append-only-reader.js` is
 * deliberately ignorant of which error class a failure should wear: it raises
 * everything through the `buildError` / `buildManifestError` callables its
 * options carry, so the OWNER of the trail names its own failures. The stream
 * owns `M3LAppendOnlyStreamReadError` and `M3LAppendOnlyStreamManifestError`,
 * and this module is where that ownership is spent — one place the pairing is
 * decided, rather than a choice each call site into the reader could make
 * differently. A second reader entry point wired up somewhere else with only
 * `buildError` would silently downgrade every manifest-level refusal.
 *
 * This is a seam rather than a dodge: read-time wiring is expected to grow
 * (inline digest verification brings its own), and it lands here rather than
 * back inside `read()`.
 */

import { isFunction } from "../../core/utils/guards.js";
import type { M3LAppendOnlyReadOptions } from "../../core/storage/append-only-read-types.js";
import type { AppendOnlyReaderOptions } from "./append-only-reader.js";
import {
  buildAppendOnlyStreamManifestError,
  buildAppendOnlyStreamReadError,
} from "./append-only-stream-errors.js";

/**
 * Builds the reader's options from the stream's own configuration plus the
 * caller's read policy, pairing the stream's two error vocabularies with the
 * two kinds of refusal the reader can raise.
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
 * @param directory - The stream's directory, as chosen at construction.
 * @param maxLineBytes - The ceiling an unterminated trailing fragment is
 *   measured against, as chosen at construction.
 * @param maxManifestBytes - The hard ceiling the directory's `manifest.jsonl`
 *   sidecar is read under.
 * @param options - The caller's validated read policy, or `undefined` when
 *   `read()` was called with no argument at all.
 * @returns Options the reader can run from, with `onTruncatedTail` and
 *   `onArchivedSegment` present only when the caller supplied a callable one.
 */
export function buildReaderOptions(
  directory: string,
  maxLineBytes: number,
  maxManifestBytes: number,
  options: M3LAppendOnlyReadOptions | undefined,
): AppendOnlyReaderOptions {
  return {
    directory,
    maxLineBytes,
    maxManifestBytes,
    ...(isFunction(options?.onTruncatedTail) && {
      onTruncatedTail: options.onTruncatedTail,
    }),
    ...(isFunction(options?.onArchivedSegment) && {
      onArchivedSegment: options.onArchivedSegment,
    }),
    buildError: buildAppendOnlyStreamReadError,
    buildManifestError: buildAppendOnlyStreamManifestError,
  };
}
