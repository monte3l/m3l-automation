import { Core } from "@m3l-automation/m3l-common";

import type {
  AnalysisRow,
  RunbookCorrelation,
  RunbookSignature,
} from "./preset.js";

/** The error code a malformed extraction rule surfaces under. */
const EXTRACTION_CODE = "ERR_LOGS_ANALYSIS_EXTRACTION";

/**
 * Mirrors `Core.M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH`. A field value longer
 * than this is not scanned at all: preset patterns are operator-authored and
 * a pathological one against a multi-megabyte log line is the cheapest way
 * to hang an incident response.
 */
export const MAX_SCAN_LENGTH = 8192;

/** What {@link extractSignature} derives from the evidence for the cases to match on. */
export interface SignatureExtraction {
  /** The value the known cases match on. */
  readonly signature: string;
  /** The severity level a case row may additionally pin; `""` when absent. */
  readonly level: string;
  /** The emitting service a case row may additionally pin; `""` when absent. */
  readonly service: string;
}

/**
 * Compiles `pattern`, surfacing a bad one as an `M3LError` rather than a bare
 * `SyntaxError`. Presets are validated at load, so reaching this throw means
 * a pattern arrived by some other route.
 */
function compile(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch (cause) {
    throw new Core.M3LError(`'${label}' is not a valid regular expression`, {
      code: EXTRACTION_CODE,
      cause,
    });
  }
}

/**
 * Applies `pattern` to `value`, returning the first capture group when the
 * pattern declares one and the whole match otherwise.
 *
 * @param value - The field value to scan. Longer than
 *   {@link MAX_SCAN_LENGTH} and it is skipped entirely.
 * @param pattern - The pattern source.
 * @param label - The preset field the pattern came from, for error messages.
 * @returns The extracted text, or `undefined` when nothing matched.
 * @throws {@link Core.M3LError} coded `ERR_LOGS_ANALYSIS_EXTRACTION` when
 *   `pattern` does not compile.
 *
 * @example
 * ```typescript
 * import { matchPattern } from "./correlation.js";
 *
 * matchPattern("req [abc-123] failed", "\\[([^\\]]+)\\]", "correlation.pattern");
 * // => "abc-123"
 * ```
 */
export function matchPattern(
  value: string,
  pattern: string,
  label: string,
): string | undefined {
  if (value.length > MAX_SCAN_LENGTH) return undefined;
  const match = compile(pattern, label).exec(value);
  if (match === null) return undefined;
  return match[1] ?? match[0];
}

/**
 * Scans `rows` in order and returns the first non-empty `field` value that
 * `pattern` extracts something from.
 *
 * @param rows - The gathered evidence rows, in query order.
 * @param field - The row field to read.
 * @param pattern - The pattern to apply, or `undefined` to take the field verbatim.
 * @param label - The preset field the rule came from, for error messages.
 * @returns The first extracted value, or `undefined` when no row yielded one.
 *
 * @example
 * ```typescript
 * import { extractFromRows } from "./correlation.js";
 *
 * extractFromRows([{ "@message": "boom" }], "@message", undefined, "signature");
 * // => "boom"
 * ```
 */
export function extractFromRows(
  rows: readonly AnalysisRow[],
  field: string,
  pattern: string | undefined,
  label: string,
): string | undefined {
  for (const row of rows) {
    const value = row[field];
    if (value === undefined || value.length === 0) continue;
    if (pattern === undefined) return value;
    const extracted = matchPattern(value, pattern, label);
    if (extracted !== undefined && extracted.length > 0) return extracted;
  }
  return undefined;
}

/**
 * Pulls the correlation key out of the gathered evidence, per the preset's
 * own field and pattern. **No key is a terminal state** — the caller stops
 * the analysis rather than guessing (ADR-0076).
 *
 * @param rows - The gathered evidence rows.
 * @param correlation - The preset's extraction rule.
 * @returns The extracted key, or `undefined` when no row carried one.
 *
 * @example
 * ```typescript
 * import { extractCorrelationKey } from "./correlation.js";
 *
 * extractCorrelationKey([{ "@message": "id=7" }], {
 *   field: "@message",
 *   pattern: "id=(\\d+)",
 *   label: "request id",
 * });
 * // => "7"
 * ```
 */
export function extractCorrelationKey(
  rows: readonly AnalysisRow[],
  correlation: RunbookCorrelation,
): string | undefined {
  return extractFromRows(
    rows,
    correlation.field,
    correlation.pattern,
    "correlation.pattern",
  );
}

/**
 * Derives the value the known cases match on, plus the optional level and
 * service a case row may additionally pin.
 *
 * @param rows - The gathered evidence rows, deepest hop first.
 * @param signature - The preset's derivation rule.
 * @returns The extraction, or `undefined` when no row yielded a signature.
 *
 * @example
 * ```typescript
 * import { extractSignature } from "./correlation.js";
 *
 * extractSignature([{ "@message": "TimeoutError", level: "ERROR" }], {
 *   field: "@message",
 *   pattern: undefined,
 *   levelField: "level",
 *   serviceField: undefined,
 * });
 * // => { signature: "TimeoutError", level: "ERROR", service: "" }
 * ```
 */
export function extractSignature(
  rows: readonly AnalysisRow[],
  signature: RunbookSignature,
): SignatureExtraction | undefined {
  const value = extractFromRows(
    rows,
    signature.field,
    signature.pattern,
    "signature.pattern",
  );
  if (value === undefined) return undefined;
  return {
    signature: value,
    level: readField(rows, signature.levelField),
    service: readField(rows, signature.serviceField),
  };
}

/** Returns the first non-empty value of `field` across `rows`, or `""`. */
function readField(
  rows: readonly AnalysisRow[],
  field: string | undefined,
): string {
  if (field === undefined) return "";
  for (const row of rows) {
    const value = row[field];
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
}

/**
 * Returns the highest numeric value of `field` across `rows` — the observed
 * latency the authorizer hop's threshold is compared against.
 *
 * @param rows - The gathered evidence rows.
 * @param field - The row field carrying the latency, in milliseconds.
 * @returns The maximum parsed value, or `undefined` when no row carried a
 *   finite number.
 *
 * @example
 * ```typescript
 * import { maxNumericField } from "./correlation.js";
 *
 * maxNumericField([{ latency: "120" }, { latency: "480" }], "latency"); // => 480
 * ```
 */
export function maxNumericField(
  rows: readonly AnalysisRow[],
  field: string,
): number | undefined {
  let highest: number | undefined;
  for (const row of rows) {
    const raw = row[field];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    if (highest === undefined || parsed > highest) highest = parsed;
  }
  return highest;
}
