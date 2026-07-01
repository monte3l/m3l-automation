/**
 * `core/json/M3LJSONFormatDetector` — JSON vs JSONL format detection.
 *
 * @packageDocumentation
 */

import { open } from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";

import { M3LError } from "../errors/index.js";

import { M3LJSONFormatDetectionError } from "./M3LJSONFormatDetectionError.js";

import type {
  M3LConfidence,
  M3LJSONDetectionDepth,
  M3LJSONDetectionResult,
  M3LJSONDetectorOptions,
  M3LJSONFormat,
} from "./types.js";

/**
 * Validates that `n` lies in the closed interval `[0, 1]` and returns it
 * branded as {@link M3LConfidence}. Module-local: the brand must be earned by
 * this validation, never asserted with a bare `as` at a call site, and this
 * detector is the only place a confidence value is constructed.
 *
 * @param n - The candidate confidence value.
 * @returns `n`, branded as {@link M3LConfidence}.
 * @throws {@link M3LError} when `n` is outside the closed interval `[0, 1]`.
 */
function asConfidence(n: number): M3LConfidence {
  if (!(n >= 0 && n <= 1)) {
    throw new M3LError(`confidence must be within [0, 1], got: ${n}`, {
      code: "ERR_JSON_INVALID_CONFIDENCE",
    });
  }
  return n as M3LConfidence;
}

/** Raw confidence value for an extension-only decision. */
const EXTENSION_CONFIDENCE_VALUE = 0.5;
/** Raw confidence value for a shallow (first-byte) decision. */
const SHALLOW_CONFIDENCE_VALUE = 0.65;
/** Raw confidence value for a standard (first-N-lines) decision. */
const STANDARD_CONFIDENCE_VALUE = 0.85;
/** Raw confidence value for a deep (sampled) decision. */
const DEEP_CONFIDENCE_VALUE = 0.97;
/** Raw confidence value when the format could not be determined at all. */
const UNKNOWN_CONFIDENCE_VALUE = 0;

/** Confidence assigned to an extension-only decision. */
const EXTENSION_CONFIDENCE = asConfidence(EXTENSION_CONFIDENCE_VALUE);
/** Confidence assigned to a shallow (first-byte) decision. */
const SHALLOW_CONFIDENCE = asConfidence(SHALLOW_CONFIDENCE_VALUE);
/** Confidence assigned to a standard (first-N-lines) decision. */
const STANDARD_CONFIDENCE = asConfidence(STANDARD_CONFIDENCE_VALUE);
/** Confidence assigned to a deep (sampled) decision. */
const DEEP_CONFIDENCE = asConfidence(DEEP_CONFIDENCE_VALUE);
/** Confidence assigned when the format could not be determined at all. */
const UNKNOWN_CONFIDENCE = asConfidence(UNKNOWN_CONFIDENCE_VALUE);

/** Number of leading lines inspected at `"standard"` depth. */
const STANDARD_LINE_COUNT = 8;
/** Number of bytes read for the `"shallow"` depth's first-byte sample. */
const SHALLOW_SAMPLE_BYTES = 1;
/** Number of bytes in a kibibyte, used to size the `"standard"`-depth prefix cap. */
const BYTES_PER_KIB = 1024;
/** Size, in KiB, of the bounded prefix read at `"standard"` depth. */
const STANDARD_PREFIX_KIB = 64;
/** Maximum bytes read for the `"standard"` depth's bounded prefix (64 KiB). */
const STANDARD_PREFIX_BYTES = STANDARD_PREFIX_KIB * BYTES_PER_KIB;
/** Number of bytes sampled from each region at `"deep"` depth. */
const DEEP_SAMPLE_BYTES = 512;
/** Divisor used to find the midpoint of a value (e.g. content length). */
const HALF_DIVISOR = 2;
/** Half of {@link DEEP_SAMPLE_BYTES}, used to center the middle sample. */
const DEEP_SAMPLE_HALF = DEEP_SAMPLE_BYTES / HALF_DIVISOR;

/**
 * Decides {@link M3LJSONFormat} from a file extension alone.
 *
 * @param filePath - The path whose extension is inspected.
 * @returns `"json"` for a `.json` extension, `"jsonl"` for `.jsonl`, and
 *   `"unknown"` for anything else.
 */
function formatFromExtension(filePath: string): M3LJSONFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  return "unknown";
}

/**
 * Decides {@link M3LJSONFormat} from a content sample: a JSON array/object
 * document starts (after leading whitespace) with `[` or `{`, while JSONL
 * content contains multiple newline-separated, non-empty lines and does not
 * start with `[`.
 *
 * @param sample - The text sample to classify.
 * @returns The decided format, or `"unknown"` when the sample is inconclusive.
 */
function formatFromContent(sample: string): M3LJSONFormat {
  const trimmed = sample.trimStart();
  if (trimmed.startsWith("[")) return "json";

  const nonEmptyLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length > 1 && nonEmptyLines[0]?.startsWith("{")) {
    return "jsonl";
  }
  if (trimmed.startsWith("{")) return "json";

  return "unknown";
}

/**
 * Counts non-empty lines in a text sample.
 *
 * @param sample - The text sample to count lines in.
 * @returns The number of non-empty lines.
 */
function countLines(sample: string): number {
  return sample.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Builds the `"extension"`-depth detection result: no file content is read.
 *
 * @param filePath - The path whose extension decides the format.
 * @returns The detection result for `"extension"` depth.
 */
function detectByExtension(filePath: string): M3LJSONDetectionResult {
  const format = formatFromExtension(filePath);
  return {
    format,
    confidence:
      format === "unknown" ? UNKNOWN_CONFIDENCE : EXTENSION_CONFIDENCE,
    method: "extension",
    details: { bytesInspected: 0, linesInspected: 0 },
  };
}

/**
 * Reads a bounded window of `handle` into a freshly allocated buffer.
 *
 * @param handle - The open file handle to read from.
 * @param length - The maximum number of bytes to read.
 * @param position - The byte offset to read from.
 * @returns The bytes actually read (a slice of length `bytesRead`) and the
 *   count of bytes read.
 */
async function readWindow(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<{ readonly buffer: Buffer; readonly bytesRead: number }> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return { buffer: buffer.subarray(0, bytesRead), bytesRead };
}

/**
 * Builds the `"shallow"`-depth detection result from the first byte of the
 * file content, read directly from `handle`.
 *
 * @param handle - The open file handle to sample from.
 * @returns The detection result for `"shallow"` depth.
 */
async function detectShallow(
  handle: FileHandle,
): Promise<M3LJSONDetectionResult> {
  const { buffer, bytesRead } = await readWindow(
    handle,
    SHALLOW_SAMPLE_BYTES,
    0,
  );
  const sample = buffer.toString("utf8");
  const format = formatFromContent(sample);
  return {
    format,
    confidence: format === "unknown" ? UNKNOWN_CONFIDENCE : SHALLOW_CONFIDENCE,
    method: "shallow",
    details: { bytesInspected: bytesRead, linesInspected: 0 },
  };
}

/**
 * Builds the `"standard"`-depth detection result from the first
 * {@link STANDARD_LINE_COUNT} lines of a bounded prefix read from `handle`.
 *
 * @param handle - The open file handle to sample from.
 * @returns The detection result for `"standard"` depth.
 */
async function detectStandard(
  handle: FileHandle,
): Promise<M3LJSONDetectionResult> {
  const { buffer } = await readWindow(handle, STANDARD_PREFIX_BYTES, 0);
  // The 64 KiB prefix may cut the final inspected line mid-line at the byte
  // boundary; linesInspected can then count that partial line. Deliberate
  // tradeoff — 64 KiB is generous enough that this is rarely observed.
  const prefix = buffer.toString("utf8");
  const lines = prefix.split("\n").slice(0, STANDARD_LINE_COUNT);
  const sample = lines.join("\n");
  const format = formatFromContent(sample);
  return {
    format,
    confidence: format === "unknown" ? UNKNOWN_CONFIDENCE : STANDARD_CONFIDENCE,
    method: "standard",
    details: {
      bytesInspected: Buffer.byteLength(sample, "utf8"),
      linesInspected: countLines(sample),
    },
  };
}

/** A half-open byte range `[start, end)` paired with the bytes it covers. */
interface ByteWindow {
  readonly start: number;
  readonly end: number;
  readonly buffer: Buffer;
}

/**
 * Merges a set of (possibly overlapping) {@link ByteWindow}s into the
 * concatenation of their UNIQUE, non-overlapping byte ranges in ascending
 * file-offset order. Used by {@link detectDeep} so that a start/middle/end
 * sample with overlapping windows (small files) is classified and counted
 * from exactly the bytes actually inspected, each counted once.
 *
 * @param windows - The sampled byte windows, in any order.
 * @returns The concatenated unique bytes, in ascending offset order.
 */
function dedupeWindows(windows: readonly ByteWindow[]): Buffer {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const chunks: Buffer[] = [];
  let coveredEnd = Number.NEGATIVE_INFINITY;
  for (const window of sorted) {
    const sliceStart = Math.max(window.start, coveredEnd);
    if (window.end > sliceStart) {
      chunks.push(
        window.buffer.subarray(
          sliceStart - window.start,
          window.end - window.start,
        ),
      );
      coveredEnd = window.end;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Builds the `"deep"`-depth detection result by sampling bounded windows from
 * the start, middle, and end of `handle`, using `stat()` to locate the
 * middle/end offsets without reading the whole file.
 *
 * When the whole file fits within a single {@link DEEP_SAMPLE_BYTES} window
 * it is read exactly once (no overlap is possible). Otherwise, three windows
 * are read (start/middle/end); any overlap between them (small files) is
 * de-duplicated via {@link dedupeWindows} before classification and counting,
 * so `bytesInspected`/`linesInspected` always reflect UNIQUE bytes actually
 * inspected and never overstate what informed the decision.
 *
 * @param handle - The open file handle to sample from.
 * @returns The detection result for `"deep"` depth.
 */
async function detectDeep(handle: FileHandle): Promise<M3LJSONDetectionResult> {
  const { size } = await handle.stat();

  const uniqueBuffer = await (async (): Promise<Buffer> => {
    if (size <= DEEP_SAMPLE_BYTES) {
      const { buffer } = await readWindow(handle, DEEP_SAMPLE_BYTES, 0);
      return buffer;
    }

    const startWindow = await readWindow(handle, DEEP_SAMPLE_BYTES, 0);
    const middlePosition = Math.max(
      0,
      Math.floor(size / HALF_DIVISOR) - DEEP_SAMPLE_HALF,
    );
    const middleWindow = await readWindow(
      handle,
      DEEP_SAMPLE_BYTES,
      middlePosition,
    );
    const endPosition = Math.max(0, size - DEEP_SAMPLE_BYTES);
    const endWindow = await readWindow(handle, DEEP_SAMPLE_BYTES, endPosition);

    return dedupeWindows([
      { start: 0, end: startWindow.buffer.length, buffer: startWindow.buffer },
      {
        start: middlePosition,
        end: middlePosition + middleWindow.buffer.length,
        buffer: middleWindow.buffer,
      },
      {
        start: endPosition,
        end: endPosition + endWindow.buffer.length,
        buffer: endWindow.buffer,
      },
    ]);
  })();

  const sample = uniqueBuffer.toString("utf8");
  const format = formatFromContent(sample);

  return {
    format,
    confidence: format === "unknown" ? UNKNOWN_CONFIDENCE : DEEP_CONFIDENCE,
    method: "deep",
    details: {
      bytesInspected: uniqueBuffer.length,
      linesInspected: countLines(sample),
    },
  };
}

/**
 * Detects whether a file holds JSON or JSONL content, at a configurable
 * depth that trades speed for accuracy.
 *
 * @example
 * ```typescript
 * import { M3LJSONFormatDetector } from "@m3l-automation/m3l-common/core";
 * const detector = new M3LJSONFormatDetector();
 * const result = await detector.detect("./data/inputs/records.jsonl");
 * // result.format === "jsonl"
 * ```
 */
export class M3LJSONFormatDetector {
  /** The detection depth used by every {@link detect} call. */
  private readonly depth: M3LJSONDetectionDepth;

  /**
   * Creates a format detector.
   *
   * @param options - Detector options. `depth` defaults to `"standard"`.
   */
  constructor(options?: M3LJSONDetectorOptions) {
    this.depth = options?.depth ?? "standard";
  }

  /**
   * Detects the JSON-family format of the file at `filePath`.
   *
   * @param filePath - The path of the file to inspect.
   * @returns A promise resolving to the detection result.
   * @throws {@link M3LJSONFormatDetectionError} when the file cannot be read
   *   (e.g. it does not exist); the underlying filesystem error is chained as
   *   `cause`.
   *
   * @example
   * ```typescript
   * import {
   *   M3LJSONFormatDetectionError,
   *   M3LJSONFormatDetector,
   * } from "@m3l-automation/m3l-common/core";
   *
   * const detector = new M3LJSONFormatDetector({ depth: "deep" });
   * try {
   *   const result = await detector.detect("./data/inputs/records.json");
   *   console.log(result.format);
   * } catch (error) {
   *   if (error instanceof M3LJSONFormatDetectionError) {
   *     console.error(error.code, error.cause);
   *   }
   * }
   * ```
   */
  async detect(filePath: string): Promise<M3LJSONDetectionResult> {
    if (this.depth === "extension") {
      return detectByExtension(filePath);
    }

    const handle = await this.openHandle(filePath);
    try {
      switch (this.depth) {
        case "shallow":
          return await detectShallow(handle);
        case "standard":
          return await detectStandard(handle);
        case "deep":
          return await detectDeep(handle);
        default: {
          const exhaustive: never = this.depth;
          throw new M3LError(
            `unhandled detection depth: ${String(exhaustive)}`,
            {
              code: "ERR_JSON_DETECT_DEPTH",
            },
          );
        }
      }
    } catch (cause) {
      if (cause instanceof M3LError) throw cause;
      throw new M3LJSONFormatDetectionError(
        `failed to read file for format detection: ${filePath}`,
        { cause },
      );
    } finally {
      try {
        await handle.close();
      } catch {
        // best-effort: a close() failure after inspection must not shadow a
        // real read/stat error above, and is not actionable by the caller.
      }
    }
  }

  /**
   * Opens `filePath` for reading, wrapping any open failure in an
   * {@link M3LJSONFormatDetectionError}.
   *
   * @param filePath - The path of the file to open.
   * @returns The open file handle.
   * @throws {@link M3LJSONFormatDetectionError} chaining the underlying
   *   filesystem error.
   */
  private async openHandle(filePath: string): Promise<FileHandle> {
    try {
      return await open(filePath, "r");
    } catch (cause) {
      throw new M3LJSONFormatDetectionError(
        `failed to read file for format detection: ${filePath}`,
        { cause },
      );
    }
  }
}
