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
