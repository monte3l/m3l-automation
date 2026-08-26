/**
 * `core/config/deriveOperationValidators` — derives opt-in schema-level
 * `requiredParameters` guards (ADR-0055) from a parameter list's declared
 * operations.
 *
 * @packageDocumentation
 */

import type { M3LConfigParameter } from "./M3LConfigParameter.js";
import type { M3LConfigSchemaValidator } from "./M3LConfigSchemaValidator.js";
import { M3LConfigValidationError } from "./M3LConfigValidationError.js";
import type { M3LOperationDeclarationList } from "./M3LOperationDeclaration.js";

/**
 * Resolves a `requiredParameters` entry to its canonical (declared) name.
 *
 * Resolution runs in **two passes, exact-name first**: every parameter in
 * `parameters` is checked for `getName() === entry` before any parameter's
 * aliases are considered at all. An exact canonical-name match always wins
 * over another parameter's alias, regardless of declaration order.
 *
 * This precedence — not just the resolution itself — is load-bearing. A
 * single combined pass (`getName() === entry || getAliases().includes(entry)`)
 * takes whichever parameter appears first in `parameters`: if a parameter
 * declared earlier happens to carry `entry` as one of its own aliases,
 * while the parameter actually canonically named `entry` is declared
 * later, a single-pass resolution would misroute to the earlier one. The
 * dangerous direction is silent, not loud: the guard then watches the
 * wrong parameter, so the real, later-declared `entry` parameter can be
 * left completely unset while the derived validator vacuously returns
 * `true`. The resolved name also matters beyond this function — the
 * resolved config store (`M3LScriptConfigLoader`) stores every value under
 * its parameter's canonical name only, never under an alias, so resolving
 * to the wrong parameter's canonical name is a guard that can never fire.
 *
 * @throws {@link M3LConfigValidationError} When no declared parameter
 *   matches `entry` by name or alias — an unenforceable guard is a
 *   programming error, not a runtime condition to tolerate.
 */
function resolveCanonicalName(
  parameters: readonly M3LConfigParameter[],
  selector: string,
  operationName: string,
  entry: string,
): string {
  const byName = parameters.find((candidate) => candidate.getName() === entry);
  if (byName !== undefined) return byName.getName();

  const byAlias = parameters.find((candidate) =>
    candidate.getAliases().includes(entry),
  );
  if (byAlias !== undefined) return byAlias.getName();

  throw new M3LConfigValidationError(
    `configuration parameter '${selector}' declares operation '${operationName}' requiring unknown parameter '${entry}'`,
    {
      context: {
        parameter: selector,
        reason: `unknown required parameter '${entry}' for operation '${operationName}'`,
      },
    },
  );
}

/**
 * Builds the {@link M3LConfigSchemaValidator} for one canonical
 * required-parameter name: vacuous unless the resolved `selector` value is
 * a string naming one of `requiringOperations`, in which case
 * `canonicalName` must also be set.
 *
 * The returned reason string names only parameters and the fixed
 * `requiringOperations` list — never a resolved config value — matching the
 * secret-safety discipline the stock {@link M3LConfigValidators} factories
 * already follow.
 */
function buildRequiredParameterValidator(
  selector: string,
  canonicalName: string,
  requiringOperations: readonly string[],
): M3LConfigSchemaValidator {
  return (config) => {
    const current = config.get(selector);
    if (typeof current !== "string") return true;
    if (!requiringOperations.includes(current)) return true;
    if (config.get(canonicalName) !== undefined) return true;
    return `'${canonicalName}' is required for operation(s): ${requiringOperations.join(", ")}`;
  };
}

/**
 * Walks one declaring parameter's operations (in declaration order) and
 * accumulates, for every resolved `requiredParameters` entry, the
 * canonical parameter name mapped to the ordered, deduplicated list of
 * operation names that require it.
 *
 * Split out of {@link deriveOperationValidators} so that function's own
 * control flow stays a flat "for each declaring parameter, collect then
 * emit" — this helper is the only piece that nests a loop inside a loop.
 *
 * A `Map`'s iteration order is its insertion (first-encounter) order —
 * this is what lets {@link deriveOperationValidators} emit in
 * first-encounter order directly off the returned map, with no separate
 * order-tracking array.
 *
 * `operation.requiredParameters`'s shape — absent, or an array of
 * strings — is guaranteed by {@link M3LConfigParameter}'s constructor
 * (the only place an `operations` declaration is accepted), so this
 * function does not re-validate it: no defensive `Array.isArray`/`typeof`
 * check sits here on purpose. A malformed `requiredParameters` (a number,
 * a bare string) can only reach this loop past that constructor guard,
 * e.g. via a hand-rolled fake in a test.
 *
 * @throws {@link M3LConfigValidationError} Propagated from
 *   {@link resolveCanonicalName} when a `requiredParameters` entry names
 *   no declared parameter.
 */
function collectRequiringOperations(
  parameters: readonly M3LConfigParameter[],
  selector: string,
  operations: M3LOperationDeclarationList,
): ReadonlyMap<string, readonly string[]> {
  const requiringByCanonical = new Map<string, string[]>();

  for (const operation of operations) {
    for (const entry of operation.requiredParameters ?? []) {
      const canonicalName = resolveCanonicalName(
        parameters,
        selector,
        operation.name,
        entry,
      );

      let requiringOperations = requiringByCanonical.get(canonicalName);
      if (requiringOperations === undefined) {
        requiringOperations = [];
        requiringByCanonical.set(canonicalName, requiringOperations);
      }
      if (!requiringOperations.includes(operation.name)) {
        requiringOperations.push(operation.name);
      }
    }
  }

  return requiringByCanonical;
}

/**
 * Derives one {@link M3LConfigSchemaValidator} per canonical
 * required-parameter name declared across `parameters`' operations
 * (ADR-0055), grouping every requiring operation onto that single
 * validator rather than emitting one validator per operation.
 *
 * Takes a **parameter list**, not a {@link M3LConfigSchema} — a script
 * authors `configValidators` beside `configParameters`, before any schema
 * exists. Pass `schema.parameters` when a schema is already in hand.
 *
 * For each parameter in `parameters` that declares operations
 * ({@link M3LConfigParameter.getOperations} is not `undefined`), its
 * operations and their `requiredParameters` are walked and resolved to
 * canonical (declared) parameter names by {@link collectRequiringOperations}
 * — see {@link resolveCanonicalName} for the resolution itself. Validators
 * are then emitted in first-encounter order per declaring parameter
 * (grouped per declaring parameter, in parameter order — the common
 * single-selector case is unaffected). Declaring the same required
 * parameter twice within one operation contributes a single entry.
 *
 * Returns `[]` when no parameter declares operations, so an unconditional
 * spread (`new M3LConfigSchema(params, [...deriveOperationValidators(params), ...])`)
 * is always safe. Returns a fresh array on every call.
 *
 * @remarks
 * Every emitted validator's "selector resolves outside the declared
 * operation set → vacuous pass" arm is correct only because the
 * per-parameter membership check {@link M3LConfigParameter} derives from
 * a declared `operations` list already rejected that value **during
 * resolution** — i.e. the config store was populated by resolving each
 * declared parameter (as `M3LScriptConfigLoader.load` does). `M3LConfig.set()`
 * is public: a caller that populates a store directly, bypassing parameter
 * resolution, can store a selector value outside the declared operation
 * set with no membership check ever running. Every validator derived for
 * that selector then passes vacuously against that store — this is not a
 * bug in the derived validators, but a precondition on how the store they
 * inspect was populated.
 *
 * @param parameters - The declared parameter list to derive validators
 *   from.
 * @returns A fresh array of derived schema-level validators, one per
 *   canonical required-parameter name.
 * @throws {@link M3LConfigValidationError} When an operation's
 *   `requiredParameters` entry names no declared parameter (by canonical
 *   name or alias) in `parameters`.
 *
 * @example
 * ```ts
 * import {
 *   deriveOperationValidators,
 *   M3LConfig,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LConfigSchema,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const parameters = [
 *   new M3LConfigParameter({
 *     name: "operation",
 *     type: M3LConfigParameterType.STRING,
 *     operations: [
 *       { name: "get", description: "Fetch one item.", requiredParameters: ["key"] },
 *       { name: "list", description: "List items." },
 *     ],
 *   }),
 *   new M3LConfigParameter({ name: "key", type: M3LConfigParameterType.STRING }),
 * ];
 * const schema = new M3LConfigSchema(
 *   parameters,
 *   deriveOperationValidators(parameters),
 * );
 *
 * const config = new M3LConfig();
 * config.set("operation", "get");
 * schema.validate(config); // throws M3LConfigValidationError — 'key' is required for operation(s): get
 * ```
 */
export function deriveOperationValidators(
  parameters: readonly M3LConfigParameter[],
): readonly M3LConfigSchemaValidator[] {
  const validators: M3LConfigSchemaValidator[] = [];

  for (const parameter of parameters) {
    const operations = parameter.getOperations();
    if (operations === undefined) continue;
    const selector = parameter.getName();

    const requiringByCanonical = collectRequiringOperations(
      parameters,
      selector,
      operations,
    );

    for (const [canonicalName, requiringOperations] of requiringByCanonical) {
      validators.push(
        buildRequiredParameterValidator(
          selector,
          canonicalName,
          requiringOperations,
        ),
      );
    }
  }

  return validators;
}
