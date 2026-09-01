/**
 * `core/orchestration/binding` — typed bindings between a caller-declared
 * expected shape and the actual value a {@link M3LStepReference} resolves
 * to (promoted from the console's X6 workbench-sessions module, slice 2,
 * ADR-0068).
 *
 * @packageDocumentation
 */

import { isPlainObject } from "../utils/index.js";

import type { M3LStepReference } from "./step-reference.js";

/**
 * The closed vocabulary of scalar/object shapes a {@link M3LStepBinding}
 * can expect. Deliberately excludes an `"array"` member — arrayness is
 * expressed by {@link M3LStepBinding.multiSelect} instead, not by a
 * separate `expectedType`.
 *
 * @example
 * ```ts
 * import type { M3LBindingExpectedType } from "@m3l-automation/m3l-common/core";
 *
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
 * import type {
 *   M3LStepBinding,
 *   M3LStepReference,
 * } from "@m3l-automation/m3l-common/core";
 *
 * function describe(
 *   binding: M3LStepBinding,
 *   reference: M3LStepReference,
 * ): string {
 *   return `${binding.multiSelect ? "list of " : ""}${binding.expectedType} at ${String(reference.ordinal)}`;
 * }
 * ```
 */
export interface M3LStepBinding {
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
      return isPlainObject(value);
    default: {
      // Compile-time exhaustiveness proof only — an off-union runtime value
      // (a bogus string, or any non-M3LBindingExpectedType value forced past
      // the type system) fails CLOSED with `false`, never the raw value
      // itself, which was truthy for any non-empty string.
      const _exhaustive: never = expectedType;
      return false;
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
 * A sparse array (one with holes — e.g. `new Array(3)`, or an element
 * removed via `delete`) fails closed rather than vacuously passing: every
 * index from `0` to `length - 1` is visited explicitly, so a hole is
 * checked as if it held `undefined`, exactly like the dense
 * all-`undefined` equivalent.
 *
 * @example
 * ```ts
 * import { validateBindingValue } from "@m3l-automation/m3l-common/core";
 *
 * validateBindingValue("queue-a", { expectedType: "string", multiSelect: false }); // true
 * validateBindingValue([1, 2], { expectedType: "string", multiSelect: true }); // false
 * validateBindingValue([], { expectedType: "object", multiSelect: true }); // true — vacuous
 * ```
 */
export function validateBindingValue(
  value: unknown,
  binding: Pick<M3LStepBinding, "expectedType" | "multiSelect">,
): boolean {
  if (!binding.multiSelect) {
    return matchesExpectedType(value, binding.expectedType);
  }
  if (!Array.isArray(value)) return false;
  // Deliberately NOT `value.every(...)` — `every` skips holes in a sparse
  // array entirely (never invokes its callback for them), so a hole would
  // vacuously pass regardless of `expectedType`. Indexing by `length`
  // visits every position, including holes, which read back as
  // `undefined` and correctly fail the type check like a real `undefined`
  // element would.
  for (let index = 0; index < value.length; index++) {
    if (!matchesExpectedType(value[index], binding.expectedType)) {
      return false;
    }
  }
  return true;
}
