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
 * - `"ERR_CHECKPOINT_CORRUPT"` — `read()` found a well-formed
 *   content-addressed envelope (see {@link M3LCheckpointStore.write}) whose
 *   stored `checksum` does not match the recomputed `canonicalJsonHash` of
 *   its `payload` — the file was hand-edited or corrupted after being
 *   written, even though it remains valid JSON and its payload would
 *   otherwise pass `validate`. Does **not** chain a `cause`: there is no
 *   underlying thrown error to chain, unlike `"ERR_CHECKPOINT_IO"` and
 *   `"ERR_CHECKPOINT_MISSING"` above. Only the resolved `path` reaches
 *   `context`; `message` never includes file content.
 * - `"ERR_CHECKPOINT_IO"` — a read, write, or delete failed for a reason
 *   other than the file being absent (`EACCES`, `EPERM`, `ENOSPC`, a
 *   rejected `rename`, an `ENOENT` from a missing *parent* directory on
 *   `write()`, …). Chains the underlying errno `Error` as `cause` — an errno
 *   carries no file content, so chaining it is safe and useful.
 * - `"ERR_CHECKPOINT_MISSING"` — `read()` was called under a
 *   `{ kind: "error" }` missing policy and no checkpoint file exists. Chains
 *   the `ENOENT` as `cause` (safe and useful for the same reason as above).
 * - `"ERR_CHECKPOINT_PARSE"` — the file is not valid JSON, or `validate`
 *   returned `false`. **Never chains the underlying `SyntaxError` as
 *   `cause`**: its message embeds a snippet of the malformed file, and a
 *   checkpoint may hold caller data (a scan cursor, a `LastEvaluatedKey`, a
 *   log row). Only the resolved `path` reaches `context`; `message` never
 *   includes a snippet of the raw content.
 */
export type M3LCheckpointErrorCode =
  | "ERR_CHECKPOINT_CORRUPT"
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
