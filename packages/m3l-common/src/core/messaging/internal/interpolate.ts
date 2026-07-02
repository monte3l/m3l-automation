/**
 * `core/messaging/internal/interpolate` — minimal `{{ key }}` template
 * interpolation for {@link M3LMessenger.sendReport}.
 *
 * Private to the messaging module: not re-exported through any barrel. This
 * exists only so `sendReport` does not need a dependency on the (currently
 * unimplemented) `text` submodule for a single-purpose token substitution.
 *
 * @packageDocumentation
 */

/**
 * Matches a `{{ key }}` token, capturing the (possibly padded) key name.
 *
 * The captured group is trimmed in {@link interpolate} rather than in the
 * pattern itself: wrapping the capture in `\s*` on both sides would overlap
 * with the lazy `[^{}]*?` (whitespace is also a non-brace character),
 * producing catastrophic backtracking on unbalanced input such as `{{` +
 * many spaces + no closing `}}`. A single greedy, non-overlapping
 * `[^{}]*` keeps the scan linear.
 */
const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * Renders `template`, replacing each `{{ key }}` token (whitespace around the
 * key is trimmed) with `String(data[key])`.
 *
 * A token whose key is not an own property of `data` is left verbatim in the
 * output — this is distinct from a key that is present with value
 * `undefined`, which stringifies to the literal text `"undefined"`. Single
 * braces are never treated as tokens.
 *
 * @param template - The template text containing zero or more `{{ key }}`
 *   tokens.
 * @param data - The values to interpolate, keyed by (untrimmed) token name.
 * @returns The rendered text.
 */
export function interpolate(
  template: string,
  data: Record<string, unknown>,
): string {
  return template.replace(TOKEN_PATTERN, (fullMatch, rawKey: string) => {
    const key = rawKey.trim();
    if (!Object.prototype.hasOwnProperty.call(data, key)) return fullMatch;
    return String(data[key]);
  });
}
