/**
 * `core/config/M3LConfigParameterDescriptor` — the display-safe descriptor
 * shape produced from a script's declared config parameters, and
 * {@link describeConfigParameters}, the function that produces it.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { toTrustedArray } from "../../internal/config/toTrustedArray.js";
import { validateParameterLikeFields } from "../../internal/config/validateParameterLikeFields.js";

/**
 * Mask rendered in place of a secret-flagged parameter's default value.
 * Mirrors `M3LConfigHelpFormatter`'s own `SECRET_MASK` — the same 8-asterisk
 * convention, applied here so masking happens once, at the descriptor
 * source, rather than being left to every renderer downstream (a discovery
 * cache, an `inspect`-style table, its `--json` output, a console parameter
 * form) to remember independently.
 */
const SECRET_MASK = "********";

/**
 * The set of value shapes a config parameter's default can take — the union
 * every `M3LCoercedValue<T>` ({@link M3LConfigParameterType}) resolves to.
 * Scoped to this primitive/array/`Buffer` union (rather than `unknown`) so
 * `String(...)` never risks the `[object Object]` fallback.
 */
export type M3LConfigParameterValue =
  string | number | boolean | readonly string[] | readonly number[] | Buffer;

/**
 * The minimal shape a `configParameters` element must expose — the public
 * getters `M3LConfigParameter` declares — so a duck-typed export from a
 * dynamically imported module can be described without requiring it to be a
 * real `M3LConfigParameter` instance. A real `M3LConfigParameter` satisfies
 * this shape, but so does a structurally-equivalent export from a module
 * compiled against a different version of this library — the point, since a
 * script's `config.js` is loaded out-of-process and cannot be assumed to
 * share this package's class identity.
 *
 * @example
 * ```ts
 * import type { M3LConfigParameterLike } from "@m3l-automation/m3l-common/core";
 *
 * const duckTyped: M3LConfigParameterLike = {
 *   getName: () => "PORT",
 *   getAliases: () => [],
 *   getType: () => "INT",
 *   isRequired: () => false,
 *   getDefaultValue: () => 3000,
 *   getDescription: () => undefined,
 * };
 * ```
 */
export interface M3LConfigParameterLike {
  /** The parameter's canonical name. */
  getName(): string;
  /** The parameter's declared aliases. */
  getAliases(): readonly string[];
  /** The parameter's declared coercion target type, as a string. */
  getType(): string;
  /** Whether the parameter is required. */
  isRequired(): boolean;
  /** The parameter's default value, or `undefined` when none was declared. */
  getDefaultValue(): M3LConfigParameterValue | undefined;
  /** The parameter's human-readable description, or `undefined` when absent. */
  getDescription(): string | undefined;
  /**
   * Optional — NOT part of the six-getter parameter-like gate
   * ({@link PARAMETER_LIKE_GETTER_NAMES} in
   * `loadScriptConfigDescriptors.ts`). A duck-typed export compiled against a
   * dist predating the secret-threading addition simply won't have this
   * method; {@link describeConfigParameters} treats its **absence** as
   * non-secret (version skew) rather than rejecting the whole element. A
   * **present but misbehaving** `isSecret` — not a function, throwing when
   * called, or returning a non-boolean — is treated the opposite way and
   * fails closed as secret: see `safeIsSecret` in
   * `M3LConfigParameterDescriptor.ts`.
   */
  isSecret?(): boolean;
  /**
   * Optional — NOT part of the six-getter parameter-like gate
   * ({@link PARAMETER_LIKE_GETTER_NAMES} in
   * `loadScriptConfigDescriptors.ts`). A duck-typed export compiled against a
   * dist predating the ADR-0055 operation-declaration addition simply won't
   * have this method; {@link describeConfigParameters} treats its absence
   * (or a malformed return value) as declaring no operations, falling back
   * to `[]`, rather than rejecting the whole element.
   */
  getOperations?(): unknown;
}

/**
 * A display-safe rendering of one declared operation (ADR-0055) — the same
 * name/description/requiredParameters shape as `M3LOperationDeclaration`,
 * but with `requiredParameters` always an array (never optional) so every
 * consumer of {@link M3LConfigParameterDescriptor.operations} can read it
 * unconditionally.
 */
export interface M3LConfigOperationDescriptor {
  /** The operation's canonical name. */
  readonly name: string;
  /** A human-readable description. */
  readonly description: string;
  /** Names of other declared parameters this operation requires to be set. */
  readonly requiredParameters: readonly string[];
}

/**
 * A display-safe rendering of a config parameter's declaration, with every
 * value coerced to a display-safe primitive so the whole array is
 * JSON-serializable without a replacer and can cross a process or an HTTP
 * boundary unchanged.
 */
export interface M3LConfigParameterDescriptor {
  /** The parameter's canonical name. */
  readonly name: string;
  /** The parameter's declared aliases. */
  readonly aliases: readonly string[];
  /** The parameter's declared coercion target type, as a string. */
  readonly type: string;
  /** Whether the parameter is required. */
  readonly required: boolean;
  /** The parameter's default value, rendered via `String(...)`, or `undefined`. */
  readonly defaultValue: string | undefined;
  /** The parameter's human-readable description, or `""` when absent. */
  readonly description: string;
  /**
   * Whether the parameter is declared secret (see
   * `M3LConfigParameter.isSecret`). A secret-flagged parameter's resolved
   * value must never be persisted or rendered unmasked by any consumer of
   * this descriptor. Required, not optional: {@link describeConfigParameters}
   * is the sole producer of this shape and always assigns an explicit
   * `true`/`false`, so `undefined` was never a state it actually produced —
   * and under this repo's `exactOptionalPropertyTypes: true`, a `?` marker
   * would have forced a dead `?? false` fallback onto every consumer to
   * satisfy a case that never occurs.
   */
  readonly secret: boolean;
  /**
   * The parameter's declared operations (ADR-0055), normalized from
   * `M3LConfigParameter.getOperations`. Required, not optional: the same
   * reasoning as {@link secret} applies — {@link describeConfigParameters}
   * always assigns an array (falling back to `[]` when the parameter
   * declares no operations or its `getOperations()` returns a malformed
   * shape), so `undefined` was never a state the sole producer produced, and
   * a `?` marker would have forced a dead `?? []` fallback onto every
   * consumer under `exactOptionalPropertyTypes: true`.
   */
  readonly operations: readonly M3LConfigOperationDescriptor[];
}

/**
 * Renders a parameter's default value for the
 * {@link M3LConfigParameterDescriptor} shape: `undefined` stays `undefined`
 * (no default was declared), a secret default renders as {@link SECRET_MASK}
 * rather than the raw value — an env-sourced secret default materializes at
 * import time, so masking here (the one place every descriptor is built)
 * covers every renderer downstream in one change — and every other default
 * renders via `String(...)`.
 *
 * @param value - The parameter's raw default value, or `undefined`.
 * @param secret - Whether the parameter is declared secret.
 * @returns The display-safe rendering.
 */
function renderDefaultValue(
  value: M3LConfigParameterValue | undefined,
  secret: boolean,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return secret ? SECRET_MASK : String(value);
}

/**
 * Validates and projects a single candidate operation element (one entry of
 * a `getOperations()` return value) onto {@link M3LConfigOperationDescriptor}.
 * Every field is read into a local variable at validation time via
 * `Object.hasOwn` + direct property access, and the returned descriptor is
 * built from those same locals — the candidate object is never re-read
 * after being validated, so a mutable/accessor property on it cannot
 * disagree with what was checked.
 *
 * @param candidate - One element of a `getOperations()` return value.
 * @returns The normalized descriptor, or `undefined` when `candidate` is
 *   not a well-formed operation.
 */
function normalizeOperationCandidate(
  candidate: unknown,
): M3LConfigOperationDescriptor | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  if (
    !Object.hasOwn(candidate, "name") ||
    !Object.hasOwn(candidate, "description")
  ) {
    return undefined;
  }

  const name: unknown = (candidate as Record<string, unknown>)["name"];
  const description: unknown = (candidate as Record<string, unknown>)[
    "description"
  ];
  if (typeof name !== "string" || typeof description !== "string") {
    return undefined;
  }

  if (!Object.hasOwn(candidate, "requiredParameters")) {
    return { name, description, requiredParameters: [] };
  }
  const requiredParameters: unknown = (candidate as Record<string, unknown>)[
    "requiredParameters"
  ];
  if (
    !Array.isArray(requiredParameters) ||
    !requiredParameters.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return { name, description, requiredParameters };
}

/**
 * Normalizes a `getOperations()` return value onto a
 * {@link M3LConfigOperationDescriptor} array, never throwing: any malformed
 * shape (not an array, or containing even one malformed element — see
 * {@link normalizeOperationCandidate}) falls back to `[]` for the whole
 * list, rather than silently dropping just the bad element, since a
 * partially-normalized operations list could hide a config-authoring
 * mistake behind an apparently-valid parameter listing.
 *
 * @param value - The raw `getOperations()` return value (or `undefined`
 *   when the duck-typed element has no such method).
 * @returns The normalized operations list, or `[]` on any malformed shape.
 */
function describeOperations(
  value: unknown,
): readonly M3LConfigOperationDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: M3LConfigOperationDescriptor[] = [];
  for (const candidate of value) {
    const operation = normalizeOperationCandidate(candidate);
    if (operation === undefined) {
      return [];
    }
    normalized.push(operation);
  }
  return normalized;
}

/**
 * Safely invokes a duck-typed `getOperations()`. Extends the tolerance
 * `isSecret` already gets for a non-function property, and additionally
 * survives a throw from the call itself: a non-function `getOperations` or
 * one that throws when called degrades to `undefined` (normalized to
 * `operations: []` by {@link describeOperations}) rather than escaping as a
 * raw `TypeError` and failing the whole script's config load.
 *
 * @param parameter - The duck-typed parameter-like element to inspect.
 * @returns The raw `getOperations()` return value, or `undefined` when the
 *   method is absent, not a function, or throws when invoked.
 */
function safeGetOperations(parameter: M3LConfigParameterLike): unknown {
  try {
    // Read the property into a local exactly once (X10a security hardening,
    // Fix 2's sibling): a getter/accessor that answers differently across
    // repeated reads of the same property cannot disagree with itself when
    // there is only one read to disagree with. The whole read + invocation
    // sits in one try — this method is documented tolerant (unlike
    // `safeIsSecret`'s fail-closed `isSecret`), so a throw from either the
    // property read or the call itself degrades to `undefined` alike.
    // Re-bound explicitly via `.call(parameter)` below, so no unintended
    // `this` can occur.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getOperations = parameter.getOperations;
    if (typeof getOperations !== "function") {
      return undefined;
    }
    return getOperations.call(parameter);
  } catch {
    return undefined;
  }
}

/**
 * Safely invokes a duck-typed `isSecret()`, failing **closed** rather than
 * open: an absent `isSecret` is read as "not secret" (version skew — a
 * config module compiled against a `dist/` predating secret-threading
 * simply won't have this method), but a *present, misbehaving* `isSecret` —
 * not a function, throwing when called, or returning a non-boolean — is
 * read as **secret**. Masking a default that was not actually secret only
 * hides a value the script's own source already shows; trusting a broken
 * flag the other way would print a real credential.
 *
 * Reads `parameter.isSecret` into a local exactly once (X10a security
 * hardening, Fix 2) — the previous three-separate-reads shape let an
 * accessor answer "secret" honestly on the first two checks and flip to
 * "not secret" on the actual invocation, producing `secret: false` with an
 * unmasked default from a property that, read once, would have failed
 * closed. A throw from the property read itself (as opposed to a throw from
 * *calling* the getter, which is caught below and still fails closed) is
 * deliberately NOT caught here: it propagates out of this function and out
 * of {@link describeConfigParameters}'s per-parameter mapping, to be wrapped
 * as `M3LError` `ERR_CONFIG_MODULE_INVALID` there (Fix 4) rather than
 * silently degrading to a guessed answer.
 *
 * @param parameter - The duck-typed parameter-like element to inspect.
 * @returns Whether the parameter should be treated as secret.
 */
function safeIsSecret(parameter: M3LConfigParameterLike): boolean {
  // Read once deliberately (see TSDoc above); re-bound explicitly via
  // `.call(parameter)` below, so no unintended `this` can occur.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const isSecret = parameter.isSecret;
  if (isSecret === undefined) {
    return false;
  }
  if (typeof isSecret !== "function") {
    return true;
  }
  try {
    const result: unknown = isSecret.call(parameter);
    return typeof result === "boolean" ? result : true;
  } catch {
    return true;
  }
}

/**
 * Maps declared config parameters (real `M3LConfigParameter` instances, or
 * any duck-typed equivalent) to their display-safe
 * {@link M3LConfigParameterDescriptor} form.
 *
 * Required getters are strict; optional methods are tolerant — that
 * asymmetry is deliberate, not an oversight. The six REQUIRED getters
 * (`getName`, `getAliases`, `getType`, `isRequired`, `getDefaultValue`,
 * `getDescription`) are validated, not merely called: each projected value
 * must have its declared runtime type, or this throws `M3LError` with
 * code `ERR_CONFIG_MODULE_INVALID` naming both the offending getter and the
 * parameter (see {@link validateParameterLikeFields}) — without this, a
 * `getDefaultValue()` returning a plain object would render as the literal
 * string `"[object Object]"` this type exists to make impossible. The two
 * OPTIONAL methods, `isSecret` and `getOperations`, exist for version skew
 * rather than correctness and stay tolerant: absent, non-function, throwing,
 * or malformed-return degrades to a safe default (`false` — but see
 * {@link safeIsSecret}'s fail-closed exception for a *present* misbehaving
 * `isSecret` — and `[]` respectively) rather than rejecting the parameter.
 *
 * A hostile caller cannot substitute its own iteration or projection: the
 * input is first materialized through {@link toTrustedArray} (X10a security
 * hardening, Fix 1), defending against a genuine `Array` instance carrying an
 * OWN `map` property that shadows `Array.prototype.map` for that one
 * instance — `Array.isArray()` is `true` for such a value, so callers of this
 * function that only checked `Array.isArray` (as
 * `loadScriptConfigDescriptors` does) cannot have ruled it out. Every element
 * is also processed inside its own `try`/`catch` so a raw exception thrown by
 * any step — an unvalidated element failing inside
 * {@link validateParameterLikeFields}, or a hostile property access throwing
 * inside {@link safeIsSecret} — surfaces as `M3LError`
 * `ERR_CONFIG_MODULE_INVALID` (chaining the original as `cause`) rather than
 * escaping this function unwrapped (Fix 4); an already-`M3LError` failure
 * (from {@link validateParameterLikeFields}) is re-thrown unchanged, never
 * double-wrapped. The returned `aliases` array is a fresh copy of whatever
 * `getAliases()` returned (Fix 3), so a caller that mutates its own aliases
 * array after this function returns cannot reach an already-built descriptor.
 *
 * @param parameters - The declared parameters to describe.
 * @returns One descriptor per input parameter, in the same order.
 * @throws `M3LError` with code `ERR_CONFIG_MODULE_INVALID` when any required
 *   getter of any parameter returns a value outside its declared runtime
 *   type, or when describing a parameter otherwise throws (see above).
 *
 * @example
 * ```ts
 * import { M3LConfigParameter, M3LConfigParameterType } from "@m3l-automation/m3l-common/core";
 * import { describeConfigParameters } from "@m3l-automation/m3l-common/core";
 *
 * const port = new M3LConfigParameter({
 *   name: "PORT",
 *   type: M3LConfigParameterType.INT,
 *   defaultValue: 3000,
 * });
 * const [descriptor] = describeConfigParameters([port]);
 * // descriptor.defaultValue === "3000"
 * ```
 */
export function describeConfigParameters(
  parameters: readonly M3LConfigParameterLike[],
): readonly M3LConfigParameterDescriptor[] {
  const trustedParameters = toTrustedArray(parameters);
  return trustedParameters.map((parameter) => {
    try {
      const { name, aliases, type, required, defaultValue, description } =
        validateParameterLikeFields(parameter);
      const secret = safeIsSecret(parameter);
      const operations = describeOperations(safeGetOperations(parameter));
      return {
        name,
        aliases: [...aliases],
        type,
        required,
        defaultValue: renderDefaultValue(defaultValue, secret),
        description: description ?? "",
        secret,
        operations,
      };
    } catch (cause) {
      if (cause instanceof M3LError) {
        throw cause;
      }
      throw new M3LError(
        "config module invalid: failed to describe a config parameter",
        { code: "ERR_CONFIG_MODULE_INVALID", cause },
      );
    }
  });
}
