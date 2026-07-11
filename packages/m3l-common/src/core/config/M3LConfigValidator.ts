/**
 * `core/config/M3LConfigValidator` — schema-time validation of a coerced
 * config value against an application-defined constraint.
 *
 * @packageDocumentation
 */

/**
 * A schema-time validator for a coerced configuration value.
 *
 * Returns the literal `true` when `value` satisfies the constraint, or a
 * human-readable failure reason string otherwise. The return type is
 * deliberately `true | string` rather than `boolean`: a plain boolean
 * predicate could return a truthy `false` mistake or (worse) a validator
 * author could return `true` as a string, but with `true | string` a
 * `boolean`-returning function is not assignable — the only way to "pass" is
 * the literal `true`, so a validator can never be accidentally treated as
 * passing.
 *
 * @typeParam T - The coerced value type the validator inspects. This follows
 *   a parameter's declared `M3LConfigParameterType` through
 *   {@link M3LCoercedValue}, so a validator written for the wrong shape is a
 *   compile error at the parameter declaration site.
 *
 * @example
 * ```ts
 * import type { M3LConfigValidator } from "@m3l-automation/m3l-common/core";
 *
 * const isPositive: M3LConfigValidator<number> = (value) =>
 *   value > 0 ? true : "must be a positive number";
 * ```
 */
export type M3LConfigValidator<T> = (value: T) => true | string;

/**
 * Stock {@link M3LConfigValidator} factories for common application
 * constraints.
 *
 * Every failure reason returned by these validators describes the
 * **constraint only** (the bound, pattern, or allowed set) — it never echoes
 * the received value. This makes the stock validators safe to attach to a
 * secret parameter: the thrown {@link M3LConfigValidationError}'s message and
 * `context.reason` can be logged without risk of leaking the secret's value.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LConfigValidators,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const port = new M3LConfigParameter({
 *   name: "PORT",
 *   type: M3LConfigParameterType.INT,
 *   defaultValue: 3000,
 *   validate: M3LConfigValidators.range(1, 65535),
 * });
 * ```
 */
export const M3LConfigValidators = {
  /**
   * Builds a validator that passes when `min <= value <= max` (inclusive).
   *
   * @param min - The inclusive lower bound.
   * @param max - The inclusive upper bound.
   * @returns A validator whose failure reason names the bounds, never the
   *   received value.
   */
  range:
    (min: number, max: number): M3LConfigValidator<number> =>
    (value) =>
      value >= min && value <= max ? true : `must be between ${min} and ${max}`,

  /**
   * Builds a validator that passes when `pattern.test(value)` is `true`.
   *
   * @param pattern - The regular expression the value must match.
   * @returns A validator whose failure reason names the pattern, never the
   *   received value.
   */
  regex:
    (pattern: RegExp): M3LConfigValidator<string> =>
    (value) =>
      pattern.test(value) ? true : `must match ${String(pattern)}`,

  /**
   * Builds a validator that passes when `allowed` includes `value`.
   *
   * @typeParam T - The allowed value union, inferred from `allowed`.
   * @param allowed - The fixed set of accepted values.
   * @returns A validator whose failure reason lists the allowed set, never
   *   the received value.
   */
  oneOf:
    <T>(allowed: readonly T[]): M3LConfigValidator<T> =>
    (value) =>
      allowed.includes(value) ? true : `must be one of: ${allowed.join(", ")}`,

  /**
   * A validator (not a factory — used directly, with no call) that rejects
   * an empty value (`length === 0`) and accepts any other.
   *
   * Typed against the structural shape `{ readonly length: number }`, a
   * supertype of `string`, the `*_ARRAY` coerced types, and `BUFFER`: via
   * parameter contravariance this makes `nonEmpty` assignable wherever a
   * `M3LConfigValidator` for any of those is expected, while a
   * `number`/`boolean` parameter (no `length`) rejects it at compile time.
   * The `=== 0` test (rather than `> 0`) means a value that somehow arrives
   * without a `length` — reachable only past a suppressed compile-time
   * mismatch — passes rather than throwing.
   */
  nonEmpty: ((value: { readonly length: number }) =>
    value.length === 0 ? "must not be empty" : true) as M3LConfigValidator<{
    readonly length: number;
  }>,

  /**
   * Builds a validator that rejects a value shorter than `min`.
   *
   * @param min - The inclusive minimum length.
   * @returns A validator whose failure reason names the bound, never the
   *   received value. Typed against `{ readonly length: number }` for the
   *   same reason as {@link nonEmpty} — it applies equally to `string`, the
   *   `*_ARRAY` types, and `BUFFER`, and fails on `< min` for the same
   *   no-`length`-passes reason.
   */
  minLength:
    (min: number): M3LConfigValidator<{ readonly length: number }> =>
    (value) =>
      value.length < min ? `must be minimum ${min} in length` : true,
} as const;
