/**
 * Shared contract for the `core/text` extraction subsystem: the extractor
 * interface, the options/result shapes, and the ZIP recursion-depth symbol.
 *
 * @packageDocumentation
 */

/**
 * Symbol key used to track ZIP recursion depth on the options object passed
 * through {@link M3LTextExtractor.extract}.
 *
 * The `M3LZipTextExtractor` reads and increments the value under this key as it
 * re-dispatches nested archive entries through the registry, enforcing a depth
 * cap that resists zip-bomb amplification. A `Symbol` (rather than a named
 * field) keeps it out of the public option surface so callers never set it by
 * accident.
 */
export const ZIP_DEPTH_SYMBOL: unique symbol = Symbol("m3l.text.zipDepth");

/**
 * Options threaded through {@link M3LTextExtractor.extract}.
 *
 * Carries the internal ZIP recursion depth (keyed by {@link ZIP_DEPTH_SYMBOL},
 * managed by the ZIP extractor, never set by callers) plus two public caps —
 * `maxEntries` and `maxTotalBytes` — that bound {@link M3LZipTextExtractor}
 * against malicious archives (breadth and size attacks). The shape is open for
 * future per-extractor options.
 */
export type M3LTextExtractionOptions = {
  /** Internal ZIP recursion depth; set and incremented by the ZIP extractor. */
  readonly [ZIP_DEPTH_SYMBOL]?: number;
  /**
   * Maximum number of ZIP entries {@link M3LZipTextExtractor} will process
   * before stopping and marking the result truncated. Bounds a breadth attack
   * (an archive declaring millions of entries). Defaults to a safe finite value.
   */
  readonly maxEntries?: number;
  /**
   * Maximum cumulative decompressed byte budget {@link M3LZipTextExtractor} will
   * materialize across processed entries before stopping and marking the result
   * truncated. Each entry's declared uncompressed size is checked against the
   * remaining budget before it is decompressed, so a high-inflation "zip bomb"
   * entry is skipped rather than materialized. Defaults to a safe finite value.
   */
  readonly maxTotalBytes?: number;
};

/**
 * The uniform result every extractor returns, so consuming code never branches
 * per format.
 */
export type M3LTextExtractionResult = {
  /** The extracted text. */
  readonly text: string;
  /** Page count, present only where the format exposes one (e.g. PDF). */
  readonly pages?: number;
  /** Whether the extracted result was cut short. */
  readonly truncated: boolean;
};

/**
 * The contract every extractor implements. The registry inspects `mimeTypes`
 * and `extensions` to route a call; `extract()` then receives only the already
 * matched `filePath` plus the options.
 */
export interface M3LTextExtractor {
  /** MIME types this extractor handles (e.g. `"application/pdf"`). */
  readonly mimeTypes: readonly string[];
  /** File extensions this extractor handles, dot-prefixed (e.g. `".pdf"`). */
  readonly extensions: readonly string[];
  /**
   * Extract text from an already-matched file.
   *
   * @param filePath - Absolute or relative path to the source file.
   * @param options - Optional extraction options.
   * @returns The uniform extraction result.
   */
  extract(
    filePath: string,
    options?: M3LTextExtractionOptions,
  ): Promise<M3LTextExtractionResult>;
}
