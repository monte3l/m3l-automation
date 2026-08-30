/**
 * `internal/config/validateParameterLikeFields` — runtime validation of the
 * six REQUIRED getters on an `M3LConfigParameterLike` candidate, extracted
 * out of `describeConfigParameters` (X10a change 2).
 *
 * `M3LConfigParameterDescriptor.ts` sits close to `pnpm check:file-budget`'s
 * per-file ceiling (ADR-0072); this validation layer (six checks plus their
 * TSDoc) would have pushed it over. This module carries that validation as
 * free functions instead, so the descriptor file stays comfortably under the
 * ceiling and the validation itself stays independently readable/testable.
 * Private to `core/config`; never re-exported through a public barrel.
 */

import { M3LError } from "../../core/errors/index.js";
import type {
  M3LConfigParameterLike,
  M3LConfigParameterValue,
} from "../../core/config/M3LConfigParameterDescriptor.js";

/**
 * The six REQUIRED-getter fields of an `M3LConfigParameterLike` candidate,
 * validated and narrowed to their declared runtime type.
 * `defaultValue`/`description` keep their legal `undefined` — that value is
 * not a validation failure for either field, only a foreign type is.
 */
export interface ValidatedParameterLikeFields {
  /** The parameter's canonical name, confirmed to be a `string`. */
  readonly name: string;
  /** The parameter's declared aliases, confirmed to be an array of `string`. */
  readonly aliases: readonly string[];
  /** The parameter's declared coercion target type, confirmed to be a `string`. */
  readonly type: string;
  /** Whether the parameter is required, confirmed to be a `boolean`. */
  readonly required: boolean;
  /**
   * The parameter's default value, confirmed to be `undefined` or a member
   * of `M3LConfigParameterValue`.
   */
  readonly defaultValue: M3LConfigParameterValue | undefined;
  /** The parameter's description, confirmed to be `undefined` or a `string`. */
  readonly description: string | undefined;
}

/**
 * Builds the `ERR_CONFIG_MODULE_INVALID` thrown when a required getter's
 * projected value fails its runtime type check, naming both the offending
 * getter and the parameter it belongs to.
 *
 * @param parameterName - The already-validated parameter name. Only
 *   {@link validateRequiredName} cannot supply this (its own failure is what
 *   would be reported) — see that function for how it phrases its own error
 *   instead of interpolating a name it could not determine.
 * @param getterName - The name of the getter that returned an invalid value.
 * @param expectation - A human-readable description of the value the getter
 *   was required to return.
 * @returns Never returns; always throws.
 */
function throwInvalidGetter(
  parameterName: string,
  getterName: string,
  expectation: string,
): never {
  throw new M3LError(
    `config module invalid: parameter '${parameterName}''s ${getterName}() must return ${expectation}`,
    { code: "ERR_CONFIG_MODULE_INVALID" },
  );
}

/**
 * Validates `parameter.getName()` returns a `string`. Deliberately does not
 * (cannot) name the parameter in its own error message — a `getName()` that
 * fails validation is exactly the case where the parameter's name is not yet
 * known, so this says so instead of interpolating a value that would itself
 * be garbage.
 *
 * @param parameter - The candidate to validate.
 * @returns The validated name.
 * @throws {@link M3LError} with code `ERR_CONFIG_MODULE_INVALID` when
 *   `getName()` does not return a `string`.
 */
function validateRequiredName(parameter: M3LConfigParameterLike): string {
  const rawName: unknown = parameter.getName();
  if (typeof rawName !== "string") {
    throw new M3LError(
      "config module invalid: getName() must return a string (the parameter's name cannot be reported because this is the getter that failed)",
      { code: "ERR_CONFIG_MODULE_INVALID" },
    );
  }
  return rawName;
}

/**
 * Type guard for "an array whose every element is a `string`" — the runtime
 * shape `getAliases()` must return.
 */
function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

/**
 * Type guard for {@link M3LConfigParameterValue} — the runtime shape
 * `getDefaultValue()` must return when it returns anything at all
 * (`undefined` is handled separately by the caller, since it is a legal
 * "no default declared" state rather than a value to type-check).
 */
function isConfigParameterValue(
  value: unknown,
): value is M3LConfigParameterValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Buffer.isBuffer(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return (
      value.every((item): item is string => typeof item === "string") ||
      value.every((item): item is number => typeof item === "number")
    );
  }
  return false;
}

/**
 * Validates the five remaining required getters (every getter but
 * `getName`, already validated by {@link validateRequiredName}) and returns
 * their narrowed values.
 *
 * @param parameter - The candidate to validate.
 * @param name - The already-validated parameter name, used only to name the
 *   parameter in a thrown error message.
 * @returns The validated `aliases`, `type`, `required`, `defaultValue`, and
 *   `description` fields.
 * @throws {@link M3LError} with code `ERR_CONFIG_MODULE_INVALID` when any of
 *   the five getters returns a value outside its declared runtime type.
 */
function validateRemainingRequiredFields(
  parameter: M3LConfigParameterLike,
  name: string,
): Omit<ValidatedParameterLikeFields, "name"> {
  const rawAliases: unknown = parameter.getAliases();
  if (!isStringArray(rawAliases)) {
    throwInvalidGetter(name, "getAliases", "an array of strings");
  }

  const rawType: unknown = parameter.getType();
  if (typeof rawType !== "string") {
    throwInvalidGetter(name, "getType", "a string");
  }

  const rawRequired: unknown = parameter.isRequired();
  if (typeof rawRequired !== "boolean") {
    throwInvalidGetter(name, "isRequired", "a boolean");
  }

  const rawDefaultValue: unknown = parameter.getDefaultValue();
  if (
    rawDefaultValue !== undefined &&
    !isConfigParameterValue(rawDefaultValue)
  ) {
    throwInvalidGetter(
      name,
      "getDefaultValue",
      "undefined, or a string, number, boolean, string array, number array, or Buffer",
    );
  }

  const rawDescription: unknown = parameter.getDescription();
  if (rawDescription !== undefined && typeof rawDescription !== "string") {
    throwInvalidGetter(name, "getDescription", "a string, or undefined");
  }

  return {
    aliases: rawAliases,
    type: rawType,
    required: rawRequired,
    defaultValue: rawDefaultValue,
    description: rawDescription,
  };
}

/**
 * Validates every one of `M3LConfigParameterLike`'s six REQUIRED getters and
 * returns their projected values, narrowed to the runtime type each is
 * documented to return. `getName()` is validated first, so a failure in any
 * later getter can name the parameter it belongs to.
 *
 * This is the strict half of `describeConfigParameters`'s documented
 * asymmetry: the two OPTIONAL methods (`isSecret`, `getOperations`) are
 * tolerant of absence and misbehaviour by design, but a required getter that
 * returns the wrong runtime type means the module is broken, not merely
 * version-skewed — masking that would let a `getDefaultValue()` returning a
 * plain object render as the literal string `"[object Object]"`, the exact
 * failure this validation exists to make impossible.
 *
 * @param parameter - The candidate to validate.
 * @returns The validated `name`, `aliases`, `type`, `required`,
 *   `defaultValue`, and `description` fields.
 * @throws {@link M3LError} with code `ERR_CONFIG_MODULE_INVALID` when any
 *   required getter returns a value outside its declared runtime type.
 */
export function validateParameterLikeFields(
  parameter: M3LConfigParameterLike,
): ValidatedParameterLikeFields {
  const name = validateRequiredName(parameter);
  const remaining = validateRemainingRequiredFields(parameter, name);
  return { name, ...remaining };
}
