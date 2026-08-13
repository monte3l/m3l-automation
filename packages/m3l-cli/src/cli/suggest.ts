/**
 * `cli/suggest` — the shared Damerau-Levenshtein "did you mean" suggestion
 * routine, reusing `Core.M3LConfigSchema` + `Core.M3LUnknownParameterDetector`
 * against a throwaway schema built purely to rank a set of known names.
 *
 * Consumed by `main.ts` (unknown command), `commands/inspect.ts` (unknown
 * script), and `commands/run.ts` (unknown script) so the three previously
 * duplicated inline bodies collapse to one.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * Ranks `unknown` against `knownNames` via
 * {@link Core.M3LUnknownParameterDetector}'s Damerau-Levenshtein suggestion
 * ranking, treating `knownNames` as a throwaway `Core.M3LConfigSchema`'s
 * declared parameter names purely to reuse that ranking logic.
 *
 * @param unknown - The unrecognized name (a command or script name) to find
 *   near-misses for.
 * @param knownNames - The full set of valid names to rank against.
 * @returns The near-miss suggestions, in ranked order; `[]` when nothing is
 *   close (or `knownNames` is empty).
 *
 * @example
 * ```ts
 * const suggestions = suggestNames("lsit", ["list", "inspect", "help"]);
 * // ["list"]
 * ```
 */
export function suggestNames(
  unknown: string,
  knownNames: readonly string[],
): readonly string[] {
  const schema = new Core.M3LConfigSchema(
    knownNames.map(
      (name) =>
        new Core.M3LConfigParameter({
          name,
          type: Core.M3LConfigParameterType.STRING,
        }),
    ),
  );
  const detector = new Core.M3LUnknownParameterDetector(schema);
  return detector
    .detectWithSuggestions([unknown])
    .flatMap((entry) => entry.suggestions);
}
