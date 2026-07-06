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
   * (an archive declaring millions of entries). Must be a finite integer `>= 1`;
   * a non-finite, fractional (floored), zero, negative, or omitted value is
   * silently clamped to a safe finite default rather than rejected
   * (validation-boundary lenience — {@link M3LZipTextExtractor} never throws on
   * a hostile options value).
   */
  readonly maxEntries?: number;
  /**
   * Maximum cumulative decompressed byte budget {@link M3LZipTextExtractor} will
   * materialize across processed entries before stopping and marking the result
   * truncated. Each entry's declared uncompressed size is checked against the
   * remaining budget before it is decompressed, so a high-inflation "zip bomb"
   * entry is skipped rather than materialized. Must be a finite integer `>= 1`;
   * a non-finite, fractional (floored), zero, negative, or omitted value is
   * silently clamped to a safe finite default rather than rejected
   * (validation-boundary lenience — {@link M3LZipTextExtractor} never throws on
   * a hostile options value).
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
 * The contract every extractor implements — including a custom one a consumer
 * registers to teach the registry a format the built-ins do not cover. The
 * registry inspects `mimeTypes` and `extensions` to route a call, matching
 * `mimeTypes` **exactly** first and falling back to the file's (lowercased)
 * extension only when no MIME match is found; `extract()` then receives only
 * the already-matched `filePath` plus the options and must not re-check the
 * format itself — the registry has already decided this extractor handles the
 * file.
 *
 * @example
 * A minimal custom extractor (see the `text` reference doc's "Extending the
 * registry" section for the full worked example with registration):
 * ```ts
 * import {
 *   M3LTextExtractionError,
 *   type M3LTextExtractor,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const jsonLinesExtractor: M3LTextExtractor = {
 *   mimeTypes: ["application/x-ndjson"],
 *   extensions: [".jsonl"],
 *   async extract(filePath) {
 *     try {
 *       const text = await readLines(filePath);
 *       return { text, truncated: false };
 *     } catch (cause) {
 *       throw new M3LTextExtractionError(`failed to read '${filePath}'`, {
 *         code: "ERR_TEXT_EXTRACTION",
 *         cause,
 *       });
 *     }
 *   },
 * };
 * ```
 */
export interface M3LTextExtractor {
  /**
   * MIME types this extractor handles (e.g. `"application/pdf"`), matched
   * **exactly** against the requested MIME type — no wildcard or prefix
   * matching.
   */
  readonly mimeTypes: readonly string[];
  /**
   * File extensions this extractor handles. Must be **dot-prefixed and
   * lowercase** (e.g. `".pdf"`, not `"pdf"` or `".PDF"`) — the registry
   * lowercases only the file path's extension before the fallback match, so an
   * upper-case entry here would never match.
   */
  readonly extensions: readonly string[];
  /**
   * Extract text from an already-matched file.
   *
   * The registry has already decided this extractor handles `filePath` (by
   * MIME type or extension), so implementations must not re-check the format
   * — just read and extract.
   *
   * The returned {@link M3LTextExtractionResult} has three obligations:
   * `text` is required and must be `""` (never `undefined`) for an empty
   * source; `truncated` is required and must be `true` only when this
   * extractor deliberately cut the result short (its own size or count cap),
   * `false` for a complete extraction; `pages` is optional and should be
   * omitted entirely (not set to `undefined`) unless the format exposes a
   * page count.
   *
   * Any failure must surface as a chained {@link M3LTextExtractionError} —
   * the registry does **not** wrap extractor errors; it propagates a
   * rejection unchanged, so an extractor that lets a bare `Error` or string
   * escape breaks the module's typed-error guarantee.
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
