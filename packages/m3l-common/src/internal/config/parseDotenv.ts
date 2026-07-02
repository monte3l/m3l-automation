/**
 * `internal/config/parseDotenv` — `.env`-file line parser used by
 * {@link M3LEnvironmentConfigProvider}.
 *
 * Private to `core/config`; never re-exported through a public barrel.
 */

/** Matches a `KEY=value` line, capturing the key and the raw value. */
const ASSIGNMENT_PATTERN = /^([^=]+)=(.*)$/;

/** Leading `export ` prefix stripped from a key, as in shell-sourceable `.env` files. */
const EXPORT_PREFIX = "export ";

/** Matches a whitespace-preceded `#` that starts an inline comment in an unquoted value. */
const INLINE_COMMENT_PATTERN = /\s#.*$/;

/** Minimum length for a value to possibly be wrapped in a matching quote pair. */
const MIN_QUOTED_LENGTH = 2;

/**
 * Strips a leading `export ` prefix from `key`, if present (shell-sourceable
 * `.env` files commonly prefix assignments with `export`).
 */
function stripExportPrefix(key: string): string {
  return key.startsWith(EXPORT_PREFIX) ? key.slice(EXPORT_PREFIX.length) : key;
}

/**
 * Resolves the final value for a `KEY=value` assignment:
 * - A value surrounded by matching double or single quotes has the quotes
 *   stripped and its inner content preserved verbatim (including any `#`) —
 *   no comment stripping is applied inside quotes.
 * - An unquoted value has a whitespace-preceded `#` (and everything after it)
 *   treated as an inline comment and dropped; a `#` with no preceding
 *   whitespace is part of the value.
 */
function resolveValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const isQuoted =
    trimmed.length >= MIN_QUOTED_LENGTH &&
    ((first === '"' && last === '"') || (first === "'" && last === "'"));

  if (isQuoted) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(INLINE_COMMENT_PATTERN, "").trimEnd();
}

/**
 * Parses `.env`-style file content into a lookup map. Supports `KEY=value`
 * lines, a leading `export ` prefix on the key, single/double-quoted values
 * (quotes stripped, content preserved verbatim), and whitespace-preceded
 * inline `#` comments on unquoted values. Blank lines and bare comment lines
 * contribute no key.
 *
 * @param content - The raw text content of a `.env` file.
 * @returns A map of key to resolved value.
 */
export function parseDotenv(content: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = ASSIGNMENT_PATTERN.exec(line);
    if (match === null) continue;

    const rawKey = match[1]?.trim();
    const rawValue = match[2];
    if (rawKey === undefined || rawKey === "" || rawValue === undefined) {
      continue;
    }

    result.set(stripExportPrefix(rawKey), resolveValue(rawValue));
  }

  return result;
}
