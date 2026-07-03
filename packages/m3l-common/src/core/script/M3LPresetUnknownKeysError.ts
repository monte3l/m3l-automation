/**
 * `core/script/M3LPresetUnknownKeysError` — thrown by
 * {@link M3LScriptPresetLoader.load} when a preset file declares one or more
 * keys the script's config schema does not recognize.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

/** Machine-readable code for {@link M3LPresetUnknownKeysError}. */
const UNKNOWN_PRESET_KEYS_CODE = "ERR_PRESET_UNKNOWN_KEYS";

/**
 * A single unrecognized preset key paired with its closest declared-name
 * suggestion (Damerau-Levenshtein distance), if any declared name exists to
 * compare against.
 *
 * This shape is reachable structurally as the element type of
 * {@link M3LPresetUnknownKeysError.suggestions}; it is not a separately
 * importable named export, so read it off a caught error rather than
 * importing the type directly.
 *
 * @example
 * ```ts
 * import { M3LPresetUnknownKeysError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // loader.load(...)
 * } catch (e) {
 *   if (e instanceof M3LPresetUnknownKeysError) {
 *     const [first] = e.suggestions; // { key, suggestion } entries
 *     console.error(first?.key, first?.suggestion);
 *   }
 * }
 * ```
 */
export interface M3LPresetUnknownKeySuggestion {
  /** The unrecognized key as it appeared in the preset file. */
  readonly key: string;
  /** The closest declared name, or `undefined` when no declared names exist. */
  readonly suggestion: string | undefined;
}

/**
 * Thrown when {@link M3LScriptPresetLoader.load} encounters one or more
 * top-level preset keys that are not declared in the script's config schema.
 *
 * The offending keys and their "did you mean" suggestions are available both
 * as typed, readonly properties (`unknownKeys`, `suggestions` — the
 * preferred access path) and, for structured-logging convenience, inside the
 * inherited `context` bag under the same names.
 *
 * @example
 * ```ts
 * import { M3LPresetUnknownKeysError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   // loader.load(...)
 * } catch (e) {
 *   if (e instanceof M3LPresetUnknownKeysError) {
 *     console.error(e.message, e.suggestions);
 *   }
 * }
 * ```
 */
export class M3LPresetUnknownKeysError extends M3LError {
  /** Narrows the inherited `code` property to the literal `"ERR_PRESET_UNKNOWN_KEYS"`. */
  override readonly code: typeof UNKNOWN_PRESET_KEYS_CODE =
    UNKNOWN_PRESET_KEYS_CODE;

  /** The raw list of unrecognized preset keys. */
  readonly unknownKeys: readonly string[];

  /**
   * Each unknown key paired with its closest declared-name suggestion (by
   * Damerau-Levenshtein distance), or `undefined` per-entry when no declared
   * name exists to compare against.
   */
  readonly suggestions: readonly M3LPresetUnknownKeySuggestion[];

  /**
   * Creates a new `M3LPresetUnknownKeysError`.
   *
   * @param message - Human-readable description of the failure, including a
   *   "did you mean" hint for the closest declared-name suggestions.
   * @param unknownKeys - The raw list of unrecognized preset keys.
   * @param suggestions - Each unknown key paired with its closest declared
   *   name, or `undefined` when none is available.
   */
  constructor(
    message: string,
    unknownKeys: readonly string[],
    suggestions: readonly M3LPresetUnknownKeySuggestion[],
  ) {
    super(message, {
      code: UNKNOWN_PRESET_KEYS_CODE,
      context: { unknownKeys, suggestions },
    });
    this.unknownKeys = unknownKeys;
    this.suggestions = suggestions;
  }
}
