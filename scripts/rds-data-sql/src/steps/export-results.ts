/**
 * `steps/export-results` — coerces a `M3LRDSDataValue` to its output
 * representation.
 *
 * Business logic lives here — never in `main.ts`. This is the sole boundary
 * where the library's typed `M3LRDSDataValue` discriminated union is
 * flattened to a plain JS value ready for JSON/JSONL/CSV encoding; every
 * other step keeps passing the typed union around unchanged.
 */

import { Core, type AWS } from "@m3l-automation/m3l-common";

/** The `Core.M3LError` code thrown for an unhandled `output.format` value in {@link coerceRdsDataValueForOutput}'s exhaustive switch. */
const OUTPUT_FORMAT_CODE = "ERR_RDS_DATA_SQL_OUTPUT_FORMAT";

/** The `Core.M3LError` code thrown for an unhandled `M3LRDSDataValue.kind` in {@link coerceRdsDataValue}'s exhaustive switch. */
const VALUE_KIND_CODE = "ERR_RDS_DATA_SQL_VALUE_KIND";

/** The output formats `query`'s exporter can encode to. */
export type RdsDataSqlOutputFormat = "json" | "jsonl" | "csv";

/**
 * Coerces a single `M3LRDSDataValue` to its output representation.
 * `null`/`string`/`long`/`double`/`boolean` pass through as their JS
 * equivalents; `blob` becomes a base64-encoded string. The coercion is
 * identical across all three `output.format` values — the exhaustive
 * `switch` exists to keep a future format-specific divergence a deliberate,
 * compile-checked addition rather than a silent fall-through.
 *
 * @param value - The typed RDS Data API value to coerce.
 * @param format - The selected `output.format`; every branch coerces
 *   identically today, but the parameter keeps the coercion boundary
 *   reachable from a future format-specific divergence.
 * @returns The plain JS value ready for JSON/JSONL/CSV encoding.
 *
 * @example
 * ```ts
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { coerceRdsDataValueForOutput } from "./export-results.js";
 *
 * const value: AWS.M3LRDSDataValue = { kind: "long", value: 42 };
 * coerceRdsDataValueForOutput(value, "json"); // 42
 * ```
 */
export function coerceRdsDataValueForOutput(
  value: AWS.M3LRDSDataValue,
  format: RdsDataSqlOutputFormat,
): unknown {
  switch (format) {
    case "json":
    case "jsonl":
    case "csv":
      return coerceRdsDataValue(value);
    default: {
      const exhaustive: never = format;
      throw new Core.M3LError(
        `unhandled output.format: ${String(exhaustive)}`,
        { code: OUTPUT_FORMAT_CODE },
      );
    }
  }
}

/**
 * Coerces `value`'s discriminated `kind` to its plain output representation
 * — split out of {@link coerceRdsDataValueForOutput} so the format-level
 * `switch` above stays a pure dispatcher.
 */
function coerceRdsDataValue(value: AWS.M3LRDSDataValue): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "string":
      return value.value;
    case "long":
      return value.value;
    case "double":
      return value.value;
    case "boolean":
      return value.value;
    case "blob":
      return Buffer.from(value.value).toString("base64");
    default: {
      const exhaustive: never = value;
      throw new Core.M3LError(
        `unhandled M3LRDSDataValue kind: ${String((exhaustive as { readonly kind?: unknown }).kind)}`,
        { code: VALUE_KIND_CODE },
      );
    }
  }
}
