/**
 * `internal/config/parseArgv` — command-line argument parser supporting the
 * three documented forms (`--key=value`, `--key value`, bare `--flag`) used
 * by {@link M3LCommandLineConfigProvider}.
 *
 * Private to `core/config`; never re-exported through a public barrel.
 */

/** Length of the `--` flag prefix, stripped when extracting the flag body. */
const FLAG_PREFIX_LENGTH = 2;

/**
 * Parses a flat argv array into a lookup map. Supports:
 * - `--key=value` (equals form).
 * - `--key value` (space-separated form): the next token is consumed as the
 *   value only when it exists and does not itself start with `--`.
 * - `--flag` (bare boolean form): stored as the real boolean `true` — not the
 *   string `"true"` — when no `=` is present and the next token is absent or
 *   itself starts with `--` (so a bare flag never swallows a following flag).
 *
 * Leading dashes are stripped from the key. Tokens that don't start with
 * `--` are ignored (positional arguments are out of scope for this parser).
 *
 * @param argv - The raw argument list (already stripped of `node`/`script`).
 * @returns A map of flag name to its parsed value.
 */
export function parseArgv(
  argv: readonly string[],
): Map<string, string | boolean> {
  const result = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;

    const body = token.slice(FLAG_PREFIX_LENGTH);
    const eqIndex = body.indexOf("=");
    if (eqIndex !== -1) {
      result.set(body.slice(0, eqIndex), body.slice(eqIndex + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result.set(body, next);
      i++;
    } else {
      result.set(body, true);
    }
  }

  return result;
}
