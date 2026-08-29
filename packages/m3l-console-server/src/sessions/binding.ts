/**
 * `sessions/binding` — typed bindings between a caller-declared expected
 * shape and the actual value a {@link M3LStepReference} resolves to (X6
 * workbench-sessions module, slice 2, ADR-0068).
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { M3LStepReference } from "./reference.js";

/**
 * The closed vocabulary of scalar/object shapes a {@link M3LSessionBinding}
 * can expect. Deliberately excludes an `"array"` member — arrayness is
 * expressed by {@link M3LSessionBinding.multiSelect} instead, not by a
 * separate `expectedType`.
 *
 * @example
 * ```ts
 * function isScalar(expectedType: M3LBindingExpectedType): boolean {
 *   return expectedType !== "object";
 * }
 * ```
 */
export type M3LBindingExpectedType = "string" | "number" | "boolean" | "object";

/**
 * A typed binding: a reference into a step's recorded output, the shape the
 * value at that reference is expected to have, and whether the caller
 * expects a single value or an array of them.
 *
 * @example
 * ```ts
 * import type { M3LStepReference } from "@m3l-automation/m3l-console-server/sessions";
 *
 * function describe(
 *   binding: M3LSessionBinding,
 *   reference: M3LStepReference,
 * ): string {
 *   return `${binding.multiSelect ? "list of " : ""}${binding.expectedType} at ${String(reference.ordinal)}`;
 * }
 * ```
 */
export interface M3LSessionBinding {
  /** The parsed step-output reference this binding resolves. */
  readonly reference: M3LStepReference;
  /** The scalar/object shape the resolved value (or each array element, when `multiSelect`) must have. */
  readonly expectedType: M3LBindingExpectedType;
  /** Whether the resolved value must be a single value (`false`) or an array of them (`true`). */
  readonly multiSelect: boolean;
}

/** Checks `value` against a single {@link M3LBindingExpectedType}, never throwing. */
function matchesExpectedType(
  value: unknown,
  expectedType: M3LBindingExpectedType,
): boolean {
  switch (expectedType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return Core.isPlainObject(value);
    default: {
      const exhaustive: never = expectedType;
      return exhaustive;
    }
  }
}

/**
 * Validates `value` against `binding`'s `expectedType`/`multiSelect` shape.
 * Never throws — a caller decides what a `false` result means (e.g. reject
 * the run, or fall back to a default).
 *
 * When `multiSelect` is `false`, checks `value`'s runtime type matches
 * `expectedType` directly. When `multiSelect` is `true`, checks `value` is
 * an array and every element individually matches `expectedType`; an empty
 * array passes vacuously for every `expectedType` (there is no element to
 * violate the shape).
 *
 * @param value - The candidate value, typically a {@link M3LStepReference}'s resolved output.
 * @param binding - The `expectedType`/`multiSelect` shape to validate against.
 * @returns `true` when `value` satisfies the binding's shape.
 * @example
 * ```ts
 * import { validateBindingValue } from "@m3l-automation/m3l-console-server/sessions";
 *
 * validateBindingValue("queue-a", { expectedType: "string", multiSelect: false }); // true
 * validateBindingValue([1, 2], { expectedType: "string", multiSelect: true }); // false
 * validateBindingValue([], { expectedType: "object", multiSelect: true }); // true — vacuous
 * ```
 */
export function validateBindingValue(
  value: unknown,
  binding: Pick<M3LSessionBinding, "expectedType" | "multiSelect">,
): boolean {
  if (!binding.multiSelect) {
    return matchesExpectedType(value, binding.expectedType);
  }
  if (!Array.isArray(value)) return false;
  return value.every((element) =>
    matchesExpectedType(element, binding.expectedType),
  );
}
