/**
 * `internal/parameter-bindings` — resolves a session's parameter bindings
 * into the string-valued map `ParameterForm` prefills its controls from.
 * Private to this package: never re-exported from a public entry point.
 *
 * @packageDocumentation
 */

/** One resolved parameter binding — the value a session step bound to a script parameter. */
export interface M3LParameterBinding {
  /** The script parameter name this binding prefills. */
  readonly parameterName: string;
  /**
   * The bound value, whose runtime shape depends on `multiSelect`: a scalar
   * (or `null`/`undefined`) when `false`, an array when `true`.
   */
  readonly value: unknown;
  /** Whether `value` is a multi-select array rather than a single scalar. */
  readonly multiSelect: boolean;
}

/**
 * Coerces one scalar binding value to the string a text/checkbox control
 * expects: a string passes through unchanged, a number/boolean stringifies
 * via `String()`, and a plain object/array serializes via `JSON.stringify`.
 * Not exported — used by both the single-value and multi-select branches of
 * {@link resolveBindingValues}.
 */
function coerceScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Resolves the parameters map ADR-0068-style bindings prefill: for each
 * binding, `multiSelect: false` coerces the value via {@link coerceScalar}
 * (omitting the key entirely for `null`/`undefined`); `multiSelect: true`
 * requires `value` to be an array — each element is coerced then
 * comma-joined (an empty array resolves to `""`, key still present) — and
 * omits the key entirely (never throws) when `value` is not an array. A
 * later binding for the same `parameterName` overrides an earlier one.
 *
 * Built on `Object.create(null)` rather than a plain object literal — same
 * hazard `ParameterForm.tsx`'s own `buildInitialValues`/
 * `buildSubmissionParameters` already guard against: a `parameterName`
 * literally `"__proto__"` hits `Object.prototype`'s own accessor setter
 * under plain-object bracket assignment and silently drops the value
 * instead of becoming an own property.
 *
 * @param bindings - The session's resolved parameter bindings.
 * @returns A map from `parameterName` to its resolved string value; a
 *   binding contributing no value (a `null`/`undefined` scalar, or a
 *   non-array `multiSelect: true` value) has no key in the result.
 * @example
 * ```ts
 * import { resolveBindingValues } from "@m3l-automation/m3l-console-web/internal/parameter-bindings.js";
 *
 * resolveBindingValues([
 *   { parameterName: "region", value: "us-east-1", multiSelect: false },
 *   { parameterName: "queueUrls", value: ["a", "b"], multiSelect: true },
 * ]);
 * // => { region: "us-east-1", queueUrls: "a,b" }
 * ```
 */
export function resolveBindingValues(
  bindings: readonly M3LParameterBinding[],
): Readonly<Record<string, string>> {
  const values: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const binding of bindings) {
    if (binding.multiSelect) {
      if (!Array.isArray(binding.value)) {
        continue;
      }
      values[binding.parameterName] = binding.value
        .map((element) => coerceScalar(element))
        .join(",");
      continue;
    }
    if (binding.value === null || binding.value === undefined) {
      continue;
    }
    values[binding.parameterName] = coerceScalar(binding.value);
  }
  return values;
}
