/**
 * `core/storage/append-only-stream-errors` — `M3LAppendOnlyStream`'s error
 * vocabulary: one named builder for each port the class hands to its
 * collaborators (the generic writer, the reader, the sealer, and the verify
 * engine), collected here so the mapping from failure to error class is a
 * single readable table instead of four separate construction sites scattered
 * across the class.
 *
 * Three classes, three incidents, told apart by `instanceof` rather than by
 * parsing a message string:
 *
 * - {@link M3LAppendOnlyStreamError} — the trail is **unwritable**: a
 *   filesystem or ceiling failure on `append()`.
 * - `M3LAppendOnlyStreamReadError` — the trail is **corrupt**: a malformed or
 *   oversized line, an intolerable torn tail, or a segment I/O failure on
 *   `read()` or `listSegments()`.
 * - `M3LAppendOnlyStreamManifestError` — the trail is **unprovable**: the
 *   `manifest.jsonl` sidecar itself could not be read or appended to, while
 *   the entries it would have covered are already durable.
 *
 * This module exists so that mapping is decided in one place: every port the
 * class hands out — to `AppendOnlyWriter`, to `AppendOnlySealer`, to
 * `readAppendOnlySegments`, and to `verifyAppendOnlySegments` — is wired to
 * one of the builders below, named for the incident it reports rather than
 * for the call site that happens to use it. A future change that points one
 * port at the wrong class is then visible by inspection, rather than hiding
 * next to the method that uses it — which is exactly how an earlier slice in
 * this wave shipped a sealer whose `buildError` built the *read* class for a
 * *manifest* failure, so "the trail is corrupt" and "the trail is unprovable"
 * became indistinguishable for that path.
 *
 * No error message, and no `context` built by a builder below, ever carries a
 * value read out of the caller's input: they name the field and the
 * violation kind only. A directory path can carry tenant or customer
 * identifiers, and an entry carries payload — its own key names included. The
 * one path by which a caller-supplied string can still be reached from an
 * error built here is a **chained filesystem `cause`** — Node's own
 * `ENOENT`/`EACCES`/`ELOOP` errors quote the path they failed on. That cause
 * is deliberately kept: it is the only diagnostic an operator has for a
 * broken stream directory, it is Node's error rather than one composed here,
 * and it is reached only by code that walks `error.cause` explicitly.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../errors/index.js";
import type { AppendOnlyReadFailure } from "../../internal/storage/append-only-lines.js";
import type { AppendOnlyWriterErrors } from "../../internal/storage/append-only-writer.js";
import { M3LAppendOnlyStreamError } from "./M3LAppendOnlyStreamError.js";
import { M3LAppendOnlyStreamManifestError } from "./M3LAppendOnlyStreamManifestError.js";
import { M3LAppendOnlyStreamReadError } from "./M3LAppendOnlyStreamReadError.js";

/**
 * This stream's half of the generic writer's error port: it turns the two
 * failures `AppendOnlyWriter` can report into {@link M3LAppendOnlyStreamError}
 * — the trail is unwritable.
 *
 * Only byte counts and a chained `cause` cross this boundary, so neither
 * error can carry a value read out of the caller's input — see this module's
 * header.
 */
export const APPEND_ONLY_STREAM_WRITE_ERRORS: AppendOnlyWriterErrors = {
  oversize(lineBytes: number, maxLineBytes: number): M3LError {
    return new M3LAppendOnlyStreamError(
      "append-only stream: serialized entry exceeds the maximum line size",
      { context: { lineBytes, maxLineBytes } },
    );
  },
  appendFailed(cause: unknown): M3LError {
    // No `context`: everything worth naming here is the directory path,
    // which is caller input. The chained `cause` is Node's own error and
    // carries the operational detail — see this module's header.
    return new M3LAppendOnlyStreamError(
      "append-only stream: failed to append an entry",
      { cause },
    );
  },
};

/**
 * Builds {@link M3LAppendOnlyStreamManifestError} — the trail is unprovable —
 * for every port that reports a failure of the `manifest.jsonl` sidecar
 * itself: {@link "../../internal/storage/append-only-sealer.js".AppendOnlySealer}'s
 * `buildError` (sealing a segment) and
 * {@link "../../internal/storage/append-only-verify.js".verifyAppendOnlySegments}'s
 * `buildManifestError` (reading the sidecar back while verifying).
 *
 * The manifest is a storage-layer artifact shared by both owners of the
 * append-only writer, so one direction-neutral builder makes a seal failure
 * mean the same thing wherever it surfaces — the sealer's port previously
 * built `M3LAppendOnlyStreamReadError` here, so a failed manifest *write* was
 * reported as a read error. That port reaches a caller only through
 * `onSealFailed` (still-unreleased 4.8.0), so no released behaviour changed
 * when it was corrected to build this class instead.
 */
export const buildAppendOnlyStreamManifestError: AppendOnlyReadFailure = (
  message,
  options,
) => new M3LAppendOnlyStreamManifestError(message, options);

/**
 * Builds {@link M3LAppendOnlyStreamReadError} — the trail is corrupt — for
 * every port that reports a failure reading segments back:
 * `M3LAppendOnlyStream.read`'s `buildError` and
 * {@link "../../internal/storage/append-only-verify.js".verifyAppendOnlySegments}'s
 * `buildSegmentError` (re-digesting a claimed segment while verifying).
 */
export const buildAppendOnlyStreamReadError: AppendOnlyReadFailure = (
  message,
  options,
) => new M3LAppendOnlyStreamReadError(message, options);
