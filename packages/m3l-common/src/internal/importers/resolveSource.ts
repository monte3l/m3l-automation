/**
 * `internal/importers/resolveSource` — shared source-resolution and
 * source-level read helpers for the `core/importers` submodule.
 *
 * Private to `core/importers`; never re-exported through a public barrel.
 */

import { readFile, stat } from "node:fs/promises";

import { M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/index.js";

/**
 * Error code used for every unreadable/missing/undetectable/no-source
 * failure, including a source that exceeds a configured `maxBytes` bound.
 */
export const ERR_IMPORT_SOURCE = "ERR_IMPORT_SOURCE";

/** Error code used for every malformed-content parse failure. */
export const ERR_IMPORT_PARSE = "ERR_IMPORT_PARSE";

/**
 * Error code used for a validation failure escalated to a throw: an import
 * run that exceeds its configured `maxRows` bound, or a single row/record
 * that fails per-row validation (reported through `import:error`/`errors[]`
 * without throwing).
 */
export const ERR_IMPORT_VALIDATION = "ERR_IMPORT_VALIDATION";

/**
 * Resolves the effective source for a single import call: the per-call
 * `source` argument takes precedence over the importer's configured default
 * `filePath`.
 *
 * @param source - The per-call `source` argument, if supplied.
 * @param filePath - The importer's configured default source, if any.
 * @returns The effective source to read from.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when neither `source`
 *   nor `filePath` is supplied.
 */
export function resolveSource(
  source: string | Buffer | undefined,
  filePath: string | undefined,
): string | Buffer {
  const effective = source ?? filePath;
  if (effective === undefined) {
    throw new M3LError(
      "no import source supplied: neither a per-call source nor options.filePath was provided",
      { code: ERR_IMPORT_SOURCE },
    );
  }
  return effective;
}

/**
 * A human-readable label for `source`, used in `import:started` payloads and
 * error messages: the path string itself, or a fixed label for a `Buffer`.
 *
 * @param source - The resolved source.
 * @returns `source` unchanged when it is a string, otherwise `"<buffer>"`.
 */
export function sourceLabel(source: string | Buffer): string {
  return typeof source === "string" ? source : "<buffer>";
}

/**
 * Throws when `source` (as a `Buffer`) exceeds `maxBytes`.
 *
 * @param length - The byte length of the in-memory source.
 * @param maxBytes - The configured maximum byte count, if any.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `maxBytes` is
 *   supplied and `length` exceeds it.
 */
function assertBufferByteBudget(length: number, maxBytes: number): void {
  if (length > maxBytes) {
    throw new M3LError(
      `import source of ${String(length)} bytes exceeds maxBytes (${String(maxBytes)})`,
      { code: ERR_IMPORT_SOURCE },
    );
  }
}

/**
 * Validates a file-path source's on-disk size against `maxBytes` via
 * `stat`, without reading its contents.
 *
 * @param source - The file path to check.
 * @param maxBytes - The configured maximum byte count, if any.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `stat` fails
 *   (chaining the underlying filesystem error as `cause`) or the file's size
 *   exceeds `maxBytes`.
 */
async function assertFileByteBudget(
  source: string,
  maxBytes: number,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(source)).size;
  } catch (cause) {
    throw new M3LError(`failed to read import source: ${source}`, {
      code: ERR_IMPORT_SOURCE,
      cause,
    });
  }
  if (size > maxBytes) {
    throw new M3LError(
      `import source ${source} (${String(size)} bytes) exceeds maxBytes (${String(maxBytes)})`,
      { code: ERR_IMPORT_SOURCE },
    );
  }
}

/**
 * Reads `source` as raw bytes: `Buffer` sources are returned as-is; `string`
 * sources are read from disk via `readFile`.
 *
 * When `maxBytes` is supplied, the source's size is validated twice: a
 * pre-read `stat` fast-path (a `Buffer` source is checked against its
 * `.length` directly, a file-path source via `stat`) avoids buffering an
 * obviously-oversized regular file — `readFile` is never called once that
 * check has failed — and a post-read length assertion against the bytes
 * `readFile` actually returned then acts as a backstop, since a FIFO, a
 * procfs entry, or a file that grows between `stat` and `readFile` (TOCTOU)
 * can report a size that understates its actual content and would otherwise
 * bypass the pre-read check entirely.
 *
 * @param source - A file path or an in-memory `Buffer`.
 * @param maxBytes - An optional maximum byte count the source must not
 *   exceed. When omitted, no size check runs (unbounded, matching prior
 *   behavior).
 * @returns The raw bytes of `source`.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
 *   path that cannot be read (chaining the underlying filesystem error), or
 *   when `source` exceeds `maxBytes` (whether caught by the pre-read `stat`
 *   fast-path or the post-read backstop).
 */
export async function readSourceBytes(
  source: string | Buffer,
  maxBytes?: number,
): Promise<Buffer> {
  if (Buffer.isBuffer(source)) {
    if (maxBytes !== undefined) assertBufferByteBudget(source.length, maxBytes);
    return source;
  }
  if (maxBytes !== undefined) await assertFileByteBudget(source, maxBytes);
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch (cause) {
    throw new M3LError(`failed to read import source: ${source}`, {
      code: ERR_IMPORT_SOURCE,
      cause,
    });
  }
  if (maxBytes !== undefined) assertBufferByteBudget(bytes.length, maxBytes);
  return bytes;
}

/**
 * Reads `source` as decoded UTF-8 text: `Buffer` sources are decoded in
 * memory; `string` sources are read from disk via `readFile` (as raw bytes,
 * so the post-read `maxBytes` backstop below has a byte length to check
 * before decoding).
 *
 * When `maxBytes` is supplied, the source's size is validated twice: a
 * pre-read `stat` fast-path (a `Buffer` source is checked against its
 * `.length` directly, a file-path source via `stat`) avoids buffering an
 * obviously-oversized regular file — `readFile` is never called once that
 * check has failed — and a post-read length assertion against the bytes
 * `readFile` actually returned then acts as a backstop, since a FIFO, a
 * procfs entry, or a file that grows between `stat` and `readFile` (TOCTOU)
 * can report a size that understates its actual content and would otherwise
 * bypass the pre-read check entirely.
 *
 * @param source - A file path or an in-memory `Buffer`.
 * @param maxBytes - An optional maximum byte count the source must not
 *   exceed. When omitted, no size check runs (unbounded, matching prior
 *   behavior).
 * @returns The decoded UTF-8 text of `source`.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
 *   path that cannot be read (chaining the underlying filesystem error), or
 *   when `source` exceeds `maxBytes` (whether caught by the pre-read `stat`
 *   fast-path or the post-read backstop).
 */
export async function readSourceText(
  source: string | Buffer,
  maxBytes?: number,
): Promise<string> {
  if (Buffer.isBuffer(source)) {
    if (maxBytes !== undefined) assertBufferByteBudget(source.length, maxBytes);
    return source.toString("utf8");
  }
  if (maxBytes !== undefined) await assertFileByteBudget(source, maxBytes);
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch (cause) {
    throw new M3LError(`failed to read import source: ${source}`, {
      code: ERR_IMPORT_SOURCE,
      cause,
    });
  }
  if (maxBytes !== undefined) assertBufferByteBudget(bytes.length, maxBytes);
  return bytes.toString("utf8");
}

/**
 * Validates that an optional numeric constructor option, if supplied, is a
 * positive integer.
 *
 * @param value - The option value to validate, or `undefined` when the
 *   caller omitted it (unbounded, no validation runs).
 * @param optionName - The option's name, embedded in the thrown message.
 * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when `value` is
 *   supplied and is not a positive integer.
 */
export function validatePositiveIntegerOption(
  value: number | undefined,
  optionName: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new M3LError(
      `${optionName} must be a positive integer, got ${String(value)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
}

/**
 * Enforces a configured `maxRows` bound against the current row/record
 * index, throwing before the row at `rowIndex` is processed once the bound
 * has been reached.
 *
 * @param rowIndex - The zero-based index of the row/record about to be
 *   processed (counts every attempt, including one that is later skipped as
 *   invalid).
 * @param maxRows - The configured maximum row/record count, if any. When
 *   omitted, no bound is enforced.
 * @throws {@link M3LError} with code `ERR_IMPORT_VALIDATION` when `maxRows`
 *   is supplied and `rowIndex` has reached it.
 */
export function assertRowBudget(
  rowIndex: number,
  maxRows: number | undefined,
): void {
  if (maxRows !== undefined && rowIndex >= maxRows) {
    throw new M3LError(`import exceeded maxRows (${String(maxRows)})`, {
      code: ERR_IMPORT_VALIDATION,
      context: { maxRows, rowIndex },
    });
  }
}

/**
 * Returns `true` when `value` is a non-null object carrying a
 * prototype-pollution vector as an OWN key (`__proto__`, `constructor`, or
 * `prototype` — see {@link isDangerousKey}).
 *
 * Used as a final backstop right before a list importer emits an item: every
 * emitted item is screened here regardless of which pipeline path produced
 * it (mapped, defaulted, transformed, field-path-extracted, or passed
 * through verbatim), so no single path can be the one that forgets the
 * check. Non-object values (string, number, boolean, `null`, `undefined`)
 * are never dangerous and return `false`.
 *
 * @param value - The candidate item to screen.
 * @returns `true` iff `value` is a non-null object with a dangerous own key.
 */
export function hasDangerousOwnKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).some((key) => isDangerousKey(key))
  );
}
