/**
 * `core/storage/M3LFtsIndexError` — typed validation error for
 * {@link M3LFtsIndex}.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/**
 * The set of machine-readable codes carried by an {@link M3LFtsIndexError}.
 *
 * - `"ERR_FTS_INVALID_TOKENIZER"` — the tokenizer directive is not one or more
 *   whitespace-separated bare identifiers.
 * - `"ERR_FTS_INVALID_IDENTIFIER"` — a table name or metadata column is not a
 *   bare SQL identifier.
 * - `"ERR_FTS_INVALID_LIMIT"` — `options.limit` is not a positive integer.
 * - `"ERR_FTS_INVALID_DOCUMENT"` — a document has an empty-string id.
 * - `"ERR_FTS_UNKNOWN_FILTER_COLUMN"` — a filter key is not a declared metadata
 *   column.
 * - `"ERR_FTS_INVALID_MODE"` — `options.mode` is neither `"full-text"` nor
 *   `"literal"` (only reachable from untyped JS callers).
 * - `"ERR_FTS_CORRUPT_METADATA"` — a stored metadata row is missing or could not
 *   be parsed as JSON; the side table is corrupt or was tampered with
 *   externally.
 */
export type M3LFtsIndexErrorCode =
  | "ERR_FTS_INVALID_TOKENIZER"
  | "ERR_FTS_INVALID_IDENTIFIER"
  | "ERR_FTS_INVALID_LIMIT"
  | "ERR_FTS_INVALID_DOCUMENT"
  | "ERR_FTS_UNKNOWN_FILTER_COLUMN"
  | "ERR_FTS_INVALID_MODE"
  | "ERR_FTS_CORRUPT_METADATA";

/**
 * Constructor options for {@link M3LFtsIndexError}.
 *
 * Unlike the base {@link M3LError}, `code` is narrowed to the
 * {@link M3LFtsIndexErrorCode} union so callers can switch exhaustively on it.
 */
interface M3LFtsIndexErrorOptions {
  /** The specific validation failure that occurred. */
  readonly code: M3LFtsIndexErrorCode;
  /** Structured diagnostic context (never carries the DB path or secrets). */
  readonly context?: Record<string, unknown>;
  /** The underlying cause, when this error wraps another. */
  readonly cause?: unknown;
}

/**
 * Thrown by {@link M3LFtsIndex} when caller-supplied configuration or search
 * input fails validation at the public boundary — before any DDL/DML runs.
 *
 * Raw SQLite/engine errors (bad `dbPath`, disk, corruption, a mid-batch
 * constraint failure inside `upsertMany`) are **not** wrapped in this type;
 * they propagate unchanged so callers can react to them directly.
 *
 * @example
 * ```ts
 * import {
 *   M3LFtsIndex,
 *   M3LFtsIndexError,
 * } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   const index = new M3LFtsIndex({ dbPath: ":memory:", table: "bad name" });
 * } catch (e) {
 *   if (e instanceof M3LFtsIndexError && e.code === "ERR_FTS_INVALID_IDENTIFIER") {
 *     // the table name was not a bare SQL identifier
 *   }
 *   throw e;
 * }
 * ```
 */
export class M3LFtsIndexError extends M3LError {
  /** Narrows the inherited `code` to the {@link M3LFtsIndexErrorCode} union. */
  override readonly code: M3LFtsIndexErrorCode;

  /**
   * Creates a new `M3LFtsIndexError`.
   *
   * @param message - Human-readable description of the validation failure.
   * @param options - Options bag carrying the narrowed `code`, optional
   *   `context`, and optional `cause`.
   */
  constructor(message: string, options: M3LFtsIndexErrorOptions) {
    super(message, {
      code: options.code,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.code = options.code;
  }
}
