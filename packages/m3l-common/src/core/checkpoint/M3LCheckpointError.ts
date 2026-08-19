/**
 * `core/checkpoint/M3LCheckpointError` — typed failure for
 * {@link M3LCheckpointStore}.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * The set of machine-readable codes carried by an {@link M3LCheckpointError}.
 *
 * - `"ERR_CHECKPOINT_CORRUPT"` — thrown from **two distinct sites**, both
 *   inside envelope verification and both before `validate` ever sees the
 *   payload. (1) `read()` detected a content-addressed envelope (see
 *   {@link M3LCheckpointStore.write}) whose stored `checksum` does not match
 *   the recomputed `canonicalJsonHash` of its `payload` — the file was
 *   hand-edited or corrupted after being written, even though it remains
 *   valid JSON and its payload would otherwise pass `validate`. (2) The
 *   envelope's `fingerprint` field is **present but not a string**, which is
 *   a corrupt envelope rather than a legacy file (see the spec note on why
 *   the envelope guard is not widened to cover this). Arm (2) is
 *   unconditional — it fires whether or not a `definition` was supplied.
 *   Does **not** chain a `cause` on either arm (there is no underlying thrown
 *   error to chain — both are direct comparisons, not caught exceptions) and
 *   `context` carries only the resolved `path`, never file content, matching
 *   `"ERR_CHECKPOINT_PARSE"`'s rationale.
 * - `"ERR_CHECKPOINT_DEFINITION"` — the `definition` value supplied to the
 *   {@link M3LCheckpointStore} constructor was rejected for one of three
 *   reasons: (1) it is a `function` or `symbol` (both canonicalise to `null`
 *   and cannot produce a meaningful fingerprint); (2) it is a non-array
 *   object with no `toJSON` method and no own enumerable properties (e.g.
 *   `Map`, `Set`, `WeakMap`, `RegExp`) — such a value canonicalises
 *   identically to `{}` regardless of its internal state, yielding a
 *   fingerprint that can never mismatch; (3) `canonicalJsonHash` could not
 *   hash the value (a circular reference, a `BigInt`, a non-finite number).
 *   Thrown **from the constructor**, so an unusable definition surfaces at
 *   composition time rather than on the first `read()` or `write()`. Does
 *   **not** chain a `cause`: the underlying error's message can embed the
 *   caller's actual definition value, which is resolved configuration that
 *   must not appear in logs or error chains. Only the resolved `path`
 *   reaches `context`.
 * - `"ERR_CHECKPOINT_FINGERPRINT_MISMATCH"` — `read()` found an envelope
 *   whose stored `fingerprint` does not match the fingerprint the store's
 *   current `definition` produces: the checkpoint is intact, but it was
 *   written under a different configuration, so its offsets no longer mean
 *   what they meant. Thrown **after** the `checksum` check succeeds, so a
 *   file that is both corrupt and stale reports `"ERR_CHECKPOINT_CORRUPT"`.
 *   Does **not** chain a `cause`: the mismatch is a direct comparison, not a
 *   caught exception. Neither the definition nor either fingerprint reaches the
 *   `message` or `context` — only the resolved `path` does.
 * - `"ERR_CHECKPOINT_IO"` — thrown from **two distinct sites**, with
 *   different `cause` handling and different messages. (1) A read, write, or
 *   delete failed for a reason other than the file being absent (`EACCES`,
 *   `EPERM`, `ENOSPC`, a rejected `rename`, an `ENOENT` from a missing
 *   *parent* directory on `write()`, …) — chains the underlying errno `Error`
 *   as `cause` (an errno carries no file content, so chaining it is safe and
 *   useful). (2) `write()` could not compute the envelope checksum for the
 *   supplied `checkpoint` (e.g. a circular reference, a `BigInt`, or a
 *   non-finite number) — **never chains a `cause`**, since the underlying
 *   error's message can embed the caller's actual checkpoint value. The two
 *   arms have distinct messages so a caller logging `code + message` can
 *   distinguish a hash failure from an I/O failure.
 * - `"ERR_CHECKPOINT_MISSING"` — `read()` was called under a
 *   `{ kind: "error" }` missing policy and no checkpoint file exists. Chains
 *   the `ENOENT` as `cause` (safe and useful for the same reason as above).
 * - `"ERR_CHECKPOINT_PARSE"` — thrown on three paths: the file is not valid
 *   JSON; `validate` returned `false`; or (for an enveloped file) the
 *   checksum recomputation over `payload` itself failed (e.g. a `RangeError`
 *   from an adversarially or accidentally deeply-nested payload). **Never
 *   chains the underlying error as `cause`** on any of these three paths: a
 *   `SyntaxError`'s message embeds a snippet of the malformed file, and a
 *   checkpoint may hold caller data (a scan cursor, a `LastEvaluatedKey`, a
 *   log row). Only the resolved `path` reaches `context`; `message` never
 *   includes a snippet of the raw content.
 */
export type M3LCheckpointErrorCode =
  | "ERR_CHECKPOINT_CORRUPT"
  | "ERR_CHECKPOINT_DEFINITION"
  | "ERR_CHECKPOINT_FINGERPRINT_MISMATCH"
  | "ERR_CHECKPOINT_IO"
  | "ERR_CHECKPOINT_MISSING"
  | "ERR_CHECKPOINT_PARSE";

/**
 * Constructor options for {@link M3LCheckpointError}.
 *
 * Unlike the base {@link M3LError}, `code` is narrowed to the
 * {@link M3LCheckpointErrorCode} union so callers can switch exhaustively on
 * it.
 */
interface M3LCheckpointErrorOptions {
  /** The specific checkpoint failure that occurred. */
  readonly code: M3LCheckpointErrorCode;
  /** Structured diagnostic context (never carries raw checkpoint content). */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, when this error wraps another. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LCheckpointStore} on every read/write/delete failure
 * path.
 *
 * @example
 * ```ts
 * import {
 *   M3LCheckpointStore,
 *   M3LCheckpointError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * declare const store: M3LCheckpointStore<{ readonly cursor?: string }>;
 *
 * try {
 *   await store.read();
 * } catch (e) {
 *   if (e instanceof M3LCheckpointError && e.code === "ERR_CHECKPOINT_MISSING") {
 *     // no checkpoint on disk under a { kind: "error" } missing policy
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LCheckpointError extends M3LError {
  /** Narrows the inherited `code` to the {@link M3LCheckpointErrorCode} union. */
  override readonly code: M3LCheckpointErrorCode;

  /**
   * Creates a new `M3LCheckpointError`.
   *
   * @param message - Human-readable description of the failure. Must never
   *   embed raw checkpoint file content (see {@link M3LCheckpointErrorCode}'s
   *   `"ERR_CHECKPOINT_PARSE"` note).
   * @param options - Options bag carrying the narrowed `code`, optional
   *   `context`, and optional `cause`.
   */
  constructor(message: string, options: M3LCheckpointErrorOptions) {
    super(message, {
      code: options.code,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.code = options.code;
  }
}
