/**
 * `core/config/M3LConfigAccessor` — defensive typed reads over a resolved
 * {@link M3LConfig}, promoting the `readTypedConfigValue`-style helper
 * pattern first written ad hoc in individual consumer scripts (e.g.
 * `scripts/eks-ops/src/steps/config-helpers.ts`) into a single reusable,
 * documented class.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";

import type { M3LConfig } from "./M3LConfig.js";

/** Narrows `value` to `string`. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Narrows `value` to `number`. Does not reject `NaN` — `typeof NaN === "number"`. */
function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Narrows `value` to `boolean`. A string `"true"`/`"false"` is deliberately not coerced. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Constructor options for {@link M3LConfigAccessor}.
 *
 * @example
 * ```ts
 * import type { M3LConfigAccessorOptions } from "@m3l-automation/m3l-common/core";
 * import { M3LConfig } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LConfigAccessorOptions = {
 *   config: new M3LConfig(),
 *   code: "ERR_MY_SCRIPT_CONFIG",
 * };
 * ```
 */
export interface M3LConfigAccessorOptions {
  /** The resolved configuration store to read from. */
  readonly config: M3LConfig;
  /**
   * Machine-readable error code attached to every `M3LError` this accessor
   * throws. Every consumer script's config-reading errors share one code so
   * callers can `catch (e) { if (e.code === MY_CODE) … }` uniformly.
   */
  readonly code: string;
}

/**
 * Defensive typed reads over a resolved {@link M3LConfig}.
 *
 * Every read distinguishes "unset" (returns `undefined`, or a supplied
 * default) from "set to the wrong type" (throws a bare {@link M3LError}
 * carrying the caller-supplied `code`) — values are never silently coerced.
 * This is the class-based promotion of the per-script `readTypedConfigValue`
 * skeleton (see `scripts/eks-ops/src/steps/config-helpers.ts` for the
 * precedent this generalizes).
 *
 * @example
 * ```ts
 * import { M3LConfig, M3LConfigAccessor } from "@m3l-automation/m3l-common/core";
 *
 * const config = new M3LConfig();
 * config.set("retries", 3);
 *
 * const accessor = new M3LConfigAccessor({ config, code: "ERR_MY_SCRIPT_CONFIG" });
 * accessor.numberWithDefault("retries", 5); // 3
 * accessor.numberWithDefault("timeout", 30); // 30 (unset, falls back)
 * ```
 */
export class M3LConfigAccessor {
  readonly #config: M3LConfig;
  readonly #code: string;

  /**
   * Creates a new `M3LConfigAccessor`.
   *
   * @param options - See {@link M3LConfigAccessorOptions}.
   */
  constructor(options: M3LConfigAccessorOptions) {
    this.#config = options.config;
    this.#code = options.code;
  }

  /**
   * Shared skeleton behind every scalar reader: reads `name`, returns
   * `undefined` when unset, and throws a bare {@link M3LError} when set to a
   * value `isValid` rejects.
   */
  #readTyped<T>(
    name: string,
    isValid: (value: unknown) => value is T,
    typeName: string,
  ): T | undefined {
    const value: unknown = this.#config.get(name);
    if (value === undefined) return undefined;
    if (!isValid(value)) {
      throw new M3LError(`'${name}' must be a ${typeName}`, {
        code: this.#code,
      });
    }
    return value;
  }

  /**
   * Reads an optional string parameter, defensively re-checking its type.
   *
   * @param name - The parameter name.
   * @returns The stored string, or `undefined` when unset.
   * @throws {@link M3LError} When `name` is set to a non-string value.
   *
   * @example
   * ```ts
   * accessor.optionalString("region"); // "eu-west-1" | undefined
   * ```
   */
  optionalString(name: string): string | undefined {
    return this.#readTyped(name, isString, "string");
  }

  /**
   * Reads an optional number parameter, defensively re-checking its type.
   * `NaN` passes through unrejected, since `typeof NaN === "number"`.
   *
   * @param name - The parameter name.
   * @returns The stored number, or `undefined` when unset.
   * @throws {@link M3LError} When `name` is set to a non-number value.
   *
   * @example
   * ```ts
   * accessor.optionalNumber("port"); // 8080 | undefined
   * ```
   */
  optionalNumber(name: string): number | undefined {
    return this.#readTyped(name, isNumber, "number");
  }

  /**
   * Reads an optional boolean parameter, defensively re-checking its type. A
   * string `"true"`/`"false"` is deliberately not coerced — it throws.
   *
   * @param name - The parameter name.
   * @returns The stored boolean, or `undefined` when unset.
   * @throws {@link M3LError} When `name` is set to a non-boolean value.
   *
   * @example
   * ```ts
   * accessor.optionalBoolean("verbose"); // true | undefined
   * ```
   */
  optionalBoolean(name: string): boolean | undefined {
    return this.#readTyped(name, isBoolean, "boolean");
  }

  /**
   * Reads an optional string-array parameter. Tolerates both an
   * already-coerced `readonly string[]` and a raw comma-separated `string`
   * (split on `,`, each segment trimmed, empty segments dropped) — the shape
   * a `M3LConfig` built directly (bypassing `M3LScript.getConfiguration()`'s
   * coercion) stores verbatim.
   *
   * @param name - The parameter name.
   * @returns The string array, or `undefined` when unset.
   * @throws {@link M3LError} When `name` is set to a value that is neither a
   *   string array nor a string.
   *
   * @example
   * ```ts
   * accessor.optionalStringArray("tags"); // ["a", "b", "c"] | undefined
   * ```
   */
  optionalStringArray(name: string): readonly string[] | undefined {
    const value: unknown = this.#config.get(name);
    if (value === undefined) return undefined;
    if (typeof value === "string") {
      return value
        .split(",")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    }
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      return value;
    }
    throw new M3LError(`'${name}' must be a string array`, {
      code: this.#code,
    });
  }

  /**
   * Reads an optional string parameter, treating an empty string the same
   * as unset. Unlike {@link optionalString}, an empty string never survives
   * as a value — this is the seam for scripts whose config schema cannot
   * express "non-empty when present" declaratively.
   *
   * @param name - The parameter name.
   * @returns The non-empty string, or `undefined` when unset or empty.
   * @throws {@link M3LError} When `name` is set to a non-string value.
   *
   * @example
   * ```ts
   * accessor.optionalNonEmptyString("namePrefix"); // "svc-" | undefined
   * ```
   */
  optionalNonEmptyString(name: string): string | undefined {
    const value = this.optionalString(name);
    return value === undefined || value.length === 0 ? undefined : value;
  }

  /**
   * Reads a number parameter, falling back to `defaultValue` when unset.
   * Uses `??` semantics — a set value of `0` wins over the default.
   *
   * @param name - The parameter name.
   * @param defaultValue - The value returned when `name` is unset.
   * @returns The stored number, or `defaultValue` when unset.
   * @throws {@link M3LError} When `name` is set to a non-number value.
   *
   * @example
   * ```ts
   * accessor.numberWithDefault("retries", 5); // 3 | 5
   * ```
   */
  numberWithDefault(name: string, defaultValue: number): number {
    return this.optionalNumber(name) ?? defaultValue;
  }

  /**
   * Reads a boolean parameter, falling back to `defaultValue` when unset.
   * Uses `??` semantics — a set value of `false` wins over the default.
   *
   * @param name - The parameter name.
   * @param defaultValue - The value returned when `name` is unset.
   * @returns The stored boolean, or `defaultValue` when unset.
   * @throws {@link M3LError} When `name` is set to a non-boolean value.
   *
   * @example
   * ```ts
   * accessor.booleanWithDefault("dryRun", true); // false | true
   * ```
   */
  booleanWithDefault(name: string, defaultValue: boolean): boolean {
    return this.optionalBoolean(name) ?? defaultValue;
  }

  /**
   * Reads a string parameter, requiring it to be one of `allowed`. Covers
   * unset, non-string, and out-of-set values with a single throw path.
   *
   * @typeParam T - The literal string union `allowed` narrows to.
   * @param name - The parameter name.
   * @param allowed - The closed set of accepted literal values.
   * @returns The stored value, narrowed to `T`.
   * @throws {@link M3LError} When `name` is unset, not a string, or not a
   *   member of `allowed`.
   *
   * @example
   * ```ts
   * accessor.oneOf("mode", ["a", "b"] as const); // "a" | "b"
   * ```
   */
  oneOf<T extends string>(name: string, allowed: readonly T[]): T {
    const value: unknown = this.#config.get(name);
    const match =
      typeof value === "string"
        ? allowed.find((candidate) => candidate === value)
        : undefined;
    if (match === undefined) {
      throw new M3LError(`'${name}' must be one of: ${allowed.join(", ")}`, {
        code: this.#code,
      });
    }
    return match;
  }

  /**
   * Returns `value`, throwing when it is `undefined`. Only `undefined`
   * throws — `false`/`0`/`""`/`null` all pass through unchanged, avoiding the
   * classic falsiness-vs-undefined bug.
   *
   * @typeParam T - The non-`undefined` type of `value` once present.
   * @param value - The candidate value, typically from an earlier
   *   `optional*` read.
   * @param name - The parameter name, for the thrown message.
   * @param operation - The operation requiring this value, for the thrown
   *   message.
   * @returns `value`, narrowed to exclude `undefined`.
   * @throws {@link M3LError} When `value` is `undefined`.
   *
   * @example
   * ```ts
   * const apiKey = accessor.requiredFor(
   *   accessor.optionalString("apiKey"),
   *   "apiKey",
   *   "publish",
   * );
   * ```
   */
  requiredFor<T>(
    value: T | undefined,
    name: string,
    operation: string,
  ): Exclude<T, undefined> {
    if (value === undefined) {
      throw new M3LError(`'${name}' is required for operation '${operation}'`, {
        code: this.#code,
      });
    }
    return value as Exclude<T, undefined>;
  }

  /**
   * Reads a required string parameter. Composes {@link optionalNonEmptyString}
   * with {@link requiredFor}, so absent, empty, and wrong-typed values all
   * throw — replacing every script-local `readRequiredString`/`requireString`
   * helper.
   *
   * @param name - The parameter name.
   * @param operation - The operation requiring this value, for the thrown
   *   message.
   * @returns The non-empty stored string.
   * @throws {@link M3LError} When `name` is unset, empty, or not a string.
   *
   * @example
   * ```ts
   * accessor.requiredString("queueUrl", "dump"); // throws if unset/empty
   * ```
   */
  requiredString(name: string, operation: string): string {
    return this.requiredFor(this.optionalNonEmptyString(name), name, operation);
  }

  /**
   * Reads a required number parameter. Composes {@link optionalNumber} with
   * {@link requiredFor}.
   *
   * @param name - The parameter name.
   * @param operation - The operation requiring this value, for the thrown
   *   message.
   * @returns The stored number.
   * @throws {@link M3LError} When `name` is unset or not a number.
   *
   * @example
   * ```ts
   * accessor.requiredNumber("windowMinutes", "query"); // throws if unset
   * ```
   */
  requiredNumber(name: string, operation: string): number {
    return this.requiredFor(this.optionalNumber(name), name, operation);
  }

  /**
   * Reads a required boolean parameter. Composes {@link optionalBoolean}
   * with {@link requiredFor}.
   *
   * @param name - The parameter name.
   * @param operation - The operation requiring this value, for the thrown
   *   message.
   * @returns The stored boolean.
   * @throws {@link M3LError} When `name` is unset or not a boolean.
   *
   * @example
   * ```ts
   * accessor.requiredBoolean("confirmed", "delete"); // throws if unset
   * ```
   */
  requiredBoolean(name: string, operation: string): boolean {
    return this.requiredFor(this.optionalBoolean(name), name, operation);
  }

  /**
   * Reads a required string-array parameter. Composes
   * {@link optionalStringArray} with {@link requiredFor}, and additionally
   * rejects an empty array — an array parameter that is required but empty
   * is treated the same as unset.
   *
   * @param name - The parameter name.
   * @param operation - The operation requiring this value, for the thrown
   *   message.
   * @returns The non-empty stored string array.
   * @throws {@link M3LError} When `name` is unset, empty, or not a string
   *   array.
   *
   * @example
   * ```ts
   * accessor.requiredStringArray("logGroups", "query"); // throws if unset/empty
   * ```
   */
  requiredStringArray(name: string, operation: string): readonly string[] {
    const value = this.optionalStringArray(name);
    return this.requiredFor(
      value !== undefined && value.length > 0 ? value : undefined,
      name,
      operation,
    );
  }
}
