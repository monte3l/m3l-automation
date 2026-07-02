/**
 * `internal/importers/resolveSource` — shared source-resolution and
 * source-level read helpers for the `core/importers` submodule.
 *
 * Private to `core/importers`; never re-exported through a public barrel.
 */

import { readFile } from "node:fs/promises";

import { M3LError } from "../../core/errors/index.js";
import { isDangerousKey } from "../../core/security/index.js";

/** Error code used for every unreadable/missing/undetectable/no-source failure. */
export const ERR_IMPORT_SOURCE = "ERR_IMPORT_SOURCE";

/** Error code used for every malformed-content parse failure. */
export const ERR_IMPORT_PARSE = "ERR_IMPORT_PARSE";

/** Error code used for a validation failure escalated to a throw (reserved). */
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
 * Reads `source` as raw bytes: `Buffer` sources are returned as-is; `string`
 * sources are read from disk via `readFile`.
 *
 * @param source - A file path or an in-memory `Buffer`.
 * @returns The raw bytes of `source`.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
 *   path that cannot be read, chaining the underlying filesystem error.
 */
export async function readSourceBytes(
  source: string | Buffer,
): Promise<Buffer> {
  if (Buffer.isBuffer(source)) return source;
  try {
    return await readFile(source);
  } catch (cause) {
    throw new M3LError(`failed to read import source: ${source}`, {
      code: ERR_IMPORT_SOURCE,
      cause,
    });
  }
}

/**
 * Reads `source` as decoded UTF-8 text: `Buffer` sources are decoded in
 * memory; `string` sources are read from disk via `readFile` with UTF-8
 * encoding.
 *
 * @param source - A file path or an in-memory `Buffer`.
 * @returns The decoded UTF-8 text of `source`.
 * @throws {@link M3LError} with code `ERR_IMPORT_SOURCE` when `source` is a
 *   path that cannot be read, chaining the underlying filesystem error.
 */
export async function readSourceText(source: string | Buffer): Promise<string> {
  if (Buffer.isBuffer(source)) return source.toString("utf8");
  try {
    return await readFile(source, "utf8");
  } catch (cause) {
    throw new M3LError(`failed to read import source: ${source}`, {
      code: ERR_IMPORT_SOURCE,
      cause,
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
