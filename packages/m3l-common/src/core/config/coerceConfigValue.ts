/**
 * `core/config/coerceConfigValue` — coerces a raw config value to its
 * declared {@link M3LConfigParameterType}.
 *
 * @packageDocumentation
 */

import { M3LConfigCoercionError } from "./M3LConfigCoercionError.js";
import type { M3LCoercedValue } from "./M3LConfigParameterType.js";
import { M3LConfigParameterType } from "./M3LConfigParameterType.js";

/** Case-insensitive truthy string tokens accepted by the BOOL coercer. */
const TRUE_TOKENS = new Set(["true", "1", "yes"]);

/** Case-insensitive falsy string tokens accepted by the BOOL coercer. */
const FALSE_TOKENS = new Set(["false", "0", "no"]);

/**
 * Builds a non-revealing description of `raw` for use in a coercion-failure
 * error. Config values often carry secrets (tokens, passwords), so the raw
 * content is never embedded verbatim — only its runtime type, and for
 * strings its length, are surfaced.
 */
function describeRawValue(raw: unknown): {
  readonly valueType: string;
  readonly valueLength?: number;
} {
  const valueType = typeof raw;
  if (valueType === "string") {
    return { valueType, valueLength: (raw as string).length };
  }
  return { valueType };
}

/** Builds the redacted error message + context shared by every coercer. */
function coercionFailure(
  targetType: M3LConfigParameterType,
  raw: unknown,
  reason: string,
): M3LConfigCoercionError {
  const described = describeRawValue(raw);
  const detail =
    described.valueLength === undefined
      ? `${described.valueType}`
      : `${described.valueType} of length ${described.valueLength}`;
  return new M3LConfigCoercionError(
    `Cannot coerce value to ${targetType} (received ${detail}): ${reason}`,
    { context: { ...described, targetType } },
  );
}

/** Coerces `raw` to a string, throwing if it is not already a string. */
function coerceString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  throw coercionFailure(
    M3LConfigParameterType.STRING,
    raw,
    "expected a string",
  );
}

/** Coerces `raw` to an integer, rejecting non-integer numeric strings. */
function coerceInt(raw: unknown): number {
  const str = coerceString(raw);
  if (!/^-?\d+$/.test(str)) {
    throw coercionFailure(M3LConfigParameterType.INT, raw, "is not an integer");
  }
  const value = Number(str);
  if (!Number.isSafeInteger(value)) {
    throw coercionFailure(
      M3LConfigParameterType.INT,
      raw,
      "is out of safe integer range",
    );
  }
  return value;
}

/** Coerces `raw` to a finite double, rejecting NaN/Infinity. */
function coerceDouble(raw: unknown): number {
  const str = coerceString(raw);
  const value = Number(str);
  if (str.trim() === "" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw coercionFailure(
      M3LConfigParameterType.DOUBLE,
      raw,
      "is not a finite number",
    );
  }
  return value;
}

/**
 * Coerces `raw` to a boolean via the documented case-insensitive tokens. A
 * value that is already a real `boolean` (e.g. a bare `--flag` from the
 * command-line provider) passes through unchanged.
 */
function coerceBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;

  const str = coerceString(raw).toLowerCase();
  if (TRUE_TOKENS.has(str)) return true;
  if (FALSE_TOKENS.has(str)) return false;
  throw coercionFailure(
    M3LConfigParameterType.BOOL,
    raw,
    "is not one of true/false/1/0/yes/no",
  );
}

/**
 * Strips trailing base64 `=` padding using a linear scan. A regex such as
 * `/=+$/` is polynomial-time on adversarial input (a long run of `=`), and the
 * base64 string here is uncontrolled config input — the manual scan avoids that
 * ReDoS while producing the same result.
 */
function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "=") end -= 1;
  return value.slice(0, end);
}

/**
 * Coerces `raw` to a `Buffer`, either from a base64 string or by normalizing
 * an already-binary passthrough. A `Buffer` is returned unchanged; a bare
 * `Uint8Array` (not already a `Buffer`) is wrapped via `Buffer.from` — same
 * bytes, but a real `Buffer` instance, matching this coercer's declared
 * return type.
 */
function coerceBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);

  const str = coerceString(raw);
  const decoded = Buffer.from(str, "base64");
  // Buffer.from with "base64" silently drops invalid characters instead of
  // throwing; re-encoding and comparing lengths is the standard round-trip
  // check for whether the input was valid base64.
  const reencoded = decoded.toString("base64");
  const normalizedInput = stripBase64Padding(str);
  const normalizedReencoded = stripBase64Padding(reencoded);
  if (normalizedInput !== normalizedReencoded) {
    throw coercionFailure(
      M3LConfigParameterType.BUFFER,
      raw,
      "is not valid base64",
    );
  }
  return decoded;
}

/**
 * Splits a comma-separated string into trimmed, non-empty segments. An
 * empty (or whitespace-only) input yields an empty array rather than an
 * array containing one empty string.
 */
function splitCsv(raw: unknown): readonly string[] {
  const str = coerceString(raw);
  if (str.trim() === "") return [];
  return str.split(",").map((segment) => segment.trim());
}

/**
 * Coerces a raw configuration value to the target
 * {@link M3LConfigParameterType}. This is the sole public parser — per-source
 * input parsers (argv, dotenv) are internal implementation details of their
 * respective providers.
 *
 * @typeParam T - The declared target type, narrowing the return type via
 *   {@link M3LCoercedValue}.
 * @param raw - The raw value to coerce (typically a string from a provider).
 * @param type - The declared target type.
 * @returns The coerced value, typed as `M3LCoercedValue<T>`: `string`,
 *   `number`, `boolean`, `Buffer`, or a `readonly` array of `string`/`number`
 *   for the `*_ARRAY` types.
 * @throws {@link M3LConfigCoercionError} When `raw` cannot be coerced to
 *   `type`. The error message and `context` never embed the raw value
 *   verbatim (config values often carry secrets) — only its runtime type and,
 *   for strings, its length.
 *
 * @example
 * ```ts
 * import {
 *   coerceConfigValue,
 *   M3LConfigParameterType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const port = coerceConfigValue("8080", M3LConfigParameterType.INT); // 8080
 * ```
 */
export function coerceConfigValue<T extends M3LConfigParameterType>(
  raw: unknown,
  type: T,
): M3LCoercedValue<T> {
  let result:
    string | number | boolean | readonly string[] | readonly number[] | Buffer;
  switch (type) {
    case M3LConfigParameterType.STRING:
      result = coerceString(raw);
      break;
    case M3LConfigParameterType.INT:
      result = coerceInt(raw);
      break;
    case M3LConfigParameterType.DOUBLE:
      result = coerceDouble(raw);
      break;
    case M3LConfigParameterType.BOOL:
      result = coerceBool(raw);
      break;
    case M3LConfigParameterType.BUFFER:
      result = coerceBuffer(raw);
      break;
    case M3LConfigParameterType.STRING_ARRAY:
      result = splitCsv(raw);
      break;
    case M3LConfigParameterType.INT_ARRAY:
      result = splitCsv(raw).map((segment) => coerceInt(segment));
      break;
    case M3LConfigParameterType.DOUBLE_ARRAY:
      result = splitCsv(raw).map((segment) => coerceDouble(segment));
      break;
    default: {
      const _exhaustive: never = type;
      throw new M3LConfigCoercionError(
        `Unhandled config parameter type: ${String(_exhaustive)}`,
      );
    }
  }
  // safe: the switch above exhaustively produces the runtime value matching
  // `type`, but TS cannot correlate a runtime `switch` on `type` with the
  // conditional-type branch of `M3LCoercedValue<T>` — this is the single
  // sanctioned cast at the return boundary.
  return result as M3LCoercedValue<T>;
}
