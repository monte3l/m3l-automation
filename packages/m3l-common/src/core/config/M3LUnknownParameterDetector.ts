/**
 * `core/config/M3LUnknownParameterDetector` — flags supplied keys that are
 * not declared in a {@link M3LConfigSchema}.
 *
 * @packageDocumentation
 */

import { damerauLevenshteinDistance } from "../../internal/config/damerauLevenshtein.js";
import type { M3LConfigSchema } from "./M3LConfigSchema.js";

/**
 * A single undeclared supplied key paired with its nearest declared-name
 * suggestions, ranked closest first. Returned by
 * {@link M3LUnknownParameterDetector.detectWithSuggestions}.
 */
export interface M3LUnknownParameterSuggestion {
  /** The undeclared supplied key. */
  readonly key: string;
  /**
   * Declared names within the configured distance threshold, ranked by
   * ascending Damerau-Levenshtein distance, ties broken by
   * {@link M3LConfigSchema.declaredNames} order. Empty when nothing is close
   * enough — the key is never omitted from the result on that account.
   */
  readonly suggestions: readonly string[];
}

/**
 * Tuning options for {@link M3LUnknownParameterDetector.detectWithSuggestions}.
 */
export interface M3LUnknownParameterSuggestOptions {
  /**
   * The maximum Damerau-Levenshtein distance a declared name may have from
   * the supplied key to be included as a suggestion. Defaults to `2`.
   */
  readonly maxDistance?: number;
  /**
   * The maximum number of suggestions returned per key. Defaults to `3`.
   */
  readonly maxSuggestions?: number;
}

/** Default value for {@link M3LUnknownParameterSuggestOptions.maxDistance}. */
const DEFAULT_MAX_DISTANCE = 2;

/** Default value for {@link M3LUnknownParameterSuggestOptions.maxSuggestions}. */
const DEFAULT_MAX_SUGGESTIONS = 3;

/**
 * Detects configuration keys that were supplied at runtime but are not
 * declared in a {@link M3LConfigSchema}. Non-throwing by contract — callers
 * decide what to do with the flagged names (warn, error, ignore).
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigSchema,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LUnknownParameterDetector,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const schema = new M3LConfigSchema([
 *   new M3LConfigParameter({ name: "region", type: M3LConfigParameterType.STRING }),
 * ]);
 * const detector = new M3LUnknownParameterDetector(schema);
 * detector.detect(["region", "typo"]); // ["typo"]
 * ```
 */
export class M3LUnknownParameterDetector {
  private readonly schema: M3LConfigSchema;

  /**
   * Creates a new `M3LUnknownParameterDetector`.
   *
   * @param schema - The schema to check supplied keys against.
   */
  constructor(schema: M3LConfigSchema) {
    this.schema = schema;
  }

  /**
   * Returns the subset of `suppliedKeys` that are not declared (by name or
   * alias) in the schema.
   *
   * @param suppliedKeys - The keys actually present at runtime.
   * @returns A `readonly` array of undeclared keys, preserving input order.
   */
  detect(suppliedKeys: readonly string[]): readonly string[] {
    return suppliedKeys.filter((key) => !this.schema.has(key));
  }

  /**
   * Like {@link M3LUnknownParameterDetector.detect}, but additionally ranks
   * each undeclared key against the schema's declared names by
   * {@link damerauLevenshteinDistance}, returning the closest candidates as
   * "did you mean" suggestions.
   *
   * @param suppliedKeys - The keys actually present at runtime.
   * @param options - Tuning for the distance threshold and suggestion cap.
   * @returns A `readonly` array of `{ key, suggestions }` pairs, one per
   *   undeclared key, in `suppliedKeys` order. A key with nothing within
   *   `maxDistance` still appears, with an empty `suggestions` array.
   */
  detectWithSuggestions(
    suppliedKeys: readonly string[],
    options: M3LUnknownParameterSuggestOptions = {},
  ): readonly M3LUnknownParameterSuggestion[] {
    const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
    const maxSuggestions = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
    const declaredNames = this.schema.declaredNames();

    return this.detect(suppliedKeys).map((key) => ({
      key,
      suggestions: rankSuggestions(
        key,
        declaredNames,
        maxDistance,
        maxSuggestions,
      ),
    }));
  }
}

/**
 * Ranks `declaredNames` by ascending Damerau-Levenshtein distance from
 * `key`, filters to `maxDistance`, and caps at `maxSuggestions`.
 * `Array.prototype.sort` is stable and `declaredNames` is iterated in its
 * original (schema-declared) order, so distance ties preserve that order
 * without an explicit secondary sort key.
 */
function rankSuggestions(
  key: string,
  declaredNames: readonly string[],
  maxDistance: number,
  maxSuggestions: number,
): readonly string[] {
  return declaredNames
    .map((name) => ({ name, distance: damerauLevenshteinDistance(key, name) }))
    .filter((candidate) => candidate.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxSuggestions)
    .map((candidate) => candidate.name);
}
