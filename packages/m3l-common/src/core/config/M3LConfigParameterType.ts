/**
 * `core/config/M3LConfigParameterType` — the finite set of coercion target
 * types recognized by {@link coerceConfigValue}.
 *
 * @packageDocumentation
 */

/**
 * The set of coercion target types a {@link M3LConfigParameter} can declare.
 * Implemented as a `const` object (not a TS `enum`) so members are accessible
 * as plain string values (`M3LConfigParameterType.STRING === "STRING"`) while
 * still narrowing to a literal union at the type level.
 *
 * @example
 * ```ts
 * import { M3LConfigParameterType } from "@m3l-automation/m3l-common/core";
 * const type = M3LConfigParameterType.INT; // "INT"
 * ```
 */
export const M3LConfigParameterType = {
  STRING: "STRING",
  INT: "INT",
  DOUBLE: "DOUBLE",
  BOOL: "BOOL",
  STRING_ARRAY: "STRING_ARRAY",
  INT_ARRAY: "INT_ARRAY",
  DOUBLE_ARRAY: "DOUBLE_ARRAY",
  BUFFER: "BUFFER",
} as const;

/**
 * The literal union of all {@link M3LConfigParameterType} member values.
 *
 * @example
 * ```ts
 * import type { M3LConfigParameterType } from "@m3l-automation/m3l-common/core";
 * function describe(type: M3LConfigParameterType): string {
 *   return `coercion target: ${type}`;
 * }
 * ```
 */
export type M3LConfigParameterType =
  (typeof M3LConfigParameterType)[keyof typeof M3LConfigParameterType];

/**
 * Maps a {@link M3LConfigParameterType} member to the static type its
 * coerced value carries. Used to type both {@link coerceConfigValue}'s return
 * value and {@link M3LConfigParameter}'s resolved value, so the declared
 * `type` field drives the value type rather than an independent caller
 * generic.
 *
 * @typeParam T - The declared coercion target type.
 *
 * @example
 * ```ts
 * import type { M3LCoercedValue } from "@m3l-automation/m3l-common/core";
 *
 * type Port = M3LCoercedValue<"INT">; // number
 * type Tags = M3LCoercedValue<"STRING_ARRAY">; // readonly string[]
 * ```
 */
export type M3LCoercedValue<T extends M3LConfigParameterType> =
  T extends "STRING"
    ? string
    : T extends "INT"
      ? number
      : T extends "DOUBLE"
        ? number
        : T extends "BOOL"
          ? boolean
          : T extends "STRING_ARRAY"
            ? readonly string[]
            : T extends "INT_ARRAY"
              ? readonly number[]
              : T extends "DOUBLE_ARRAY"
                ? readonly number[]
                : T extends "BUFFER"
                  ? Buffer
                  : never;
