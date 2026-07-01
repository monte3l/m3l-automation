/**
 * `core/json/types` — shared type definitions for JSON format detection.
 *
 * @packageDocumentation
 */

/**
 * The JSON-family format that {@link M3LJSONFormatDetector} can identify:
 * a JSON document (`"json"`), newline-delimited JSON (`"jsonl"`), or a file
 * whose format could not be determined at the configured detection depth
 * (`"unknown"`).
 *
 * @example
 * ```typescript
 * import type { M3LJSONFormat } from "@m3l-automation/m3l-common/core";
 * const format: M3LJSONFormat = "jsonl";
 * ```
 */
export type M3LJSONFormat = "json" | "jsonl" | "unknown";

/**
 * The depth at which {@link M3LJSONFormatDetector} inspects a file, trading
 * speed for accuracy:
 *
 * - `"extension"` — decide from the file extension alone (fastest, 0 bytes read).
 * - `"shallow"` — inspect the first byte.
 * - `"standard"` — inspect the first several lines.
 * - `"deep"` — sample the start, middle, and end of the file (most accurate).
 *
 * @example
 * ```typescript
 * import type { M3LJSONDetectionDepth } from "@m3l-automation/m3l-common/core";
 * const depth: M3LJSONDetectionDepth = "standard";
 * ```
 */
export type M3LJSONDetectionDepth =
  "extension" | "shallow" | "standard" | "deep";

/**
 * A confidence score in the closed interval `[0, 1]`, branded so it cannot be
 * constructed by a bare numeric literal or arithmetic result — only through
 * the module-internal validating constructor, which earns the brand by
 * checking the value is actually in range.
 *
 * Consumers never construct a value of this type themselves; they only read
 * {@link M3LJSONDetectionResult.confidence} as a plain `number`.
 *
 * @example
 * ```typescript
 * import type { M3LConfidence } from "@m3l-automation/m3l-common/core";
 * function logConfidence(confidence: M3LConfidence): void {
 *   console.log(confidence satisfies number);
 * }
 * ```
 */
export type M3LConfidence = number & { readonly __brand: unique symbol };

/**
 * Constructor options for {@link M3LJSONFormatDetector}.
 *
 * @example
 * ```typescript
 * import type { M3LJSONDetectorOptions } from "@m3l-automation/m3l-common/core";
 * const options: M3LJSONDetectorOptions = { depth: "deep" };
 * ```
 */
export interface M3LJSONDetectorOptions {
  /**
   * The detection depth to use. Defaults to `"standard"` when omitted.
   */
  readonly depth?: M3LJSONDetectionDepth;
}

/**
 * The result of a {@link M3LJSONFormatDetector.detect} call.
 *
 * @example
 * ```typescript
 * import type { M3LJSONDetectionResult } from "@m3l-automation/m3l-common/core";
 * const result: M3LJSONDetectionResult = {
 *   format: "jsonl",
 *   confidence: 0.9,
 *   method: "standard",
 *   details: { bytesInspected: 512, linesInspected: 8 },
 * };
 * ```
 */
export interface M3LJSONDetectionResult {
  /** The detected format, or `"unknown"` if it could not be determined. */
  readonly format: M3LJSONFormat;
  /** A confidence score in the closed interval `[0, 1]`. */
  readonly confidence: M3LConfidence;
  /** The detection depth that was actually used. */
  readonly method: M3LJSONDetectionDepth;
  /** How much of the file was actually inspected. */
  readonly details: {
    /** The number of bytes read from the file. */
    readonly bytesInspected: number;
    /** The number of lines inspected. */
    readonly linesInspected: number;
  };
}
