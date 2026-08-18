/**
 * `core/config/M3LConfigSchemaValidator` — schema-time cross-parameter
 * validation over a fully-resolved {@link M3LConfig} store.
 *
 * @packageDocumentation
 */

import type { M3LConfig } from "./M3LConfig.js";

/**
 * A schema-level validator for a cross-parameter constraint spanning two or
 * more resolved configuration values (e.g. "`sort` requires `limit` to also
 * be set").
 *
 * Returns the literal `true` when the constraint is satisfied, or a
 * human-readable failure reason string otherwise — see
 * `docs/reference/core/config.md`'s "Cross-parameter validation" section. The
 * return type follows the same reasoning as {@link M3LConfigValidator}:
 * `true | string` rather than `boolean`, so a plain boolean-returning
 * predicate is not assignable and a validator can never be mistaken for
 * "valid" through a stray truthy `false`.
 *
 * The validator receives the live, fully-resolved `M3LConfig` store so it can
 * read any combination of parameters via `get`/`has`/`sourceOf`. **A
 * validator must not call `M3LConfig.set()`** — it is handed the store for
 * reading, not for mutation; this is a documented contract, not one enforced
 * by the type system.
 *
 * A schema-level validator's blast radius is wider than a per-parameter
 * {@link M3LConfigValidator}'s: it sees the **whole** resolved config store,
 * not one already-typed value. The failure reason string returned here
 * becomes, verbatim and with no redaction applied, both the thrown
 * {@link M3LConfigValidationError}'s `message` and its `context.reason`.
 * Never embed an actual config value in the returned reason — describe the
 * constraint, not the value — especially when the validator reads a
 * secret-bearing parameter, whether or not that parameter is the one nominally
 * failing. This mirrors the discipline the stock {@link M3LConfigValidators}
 * factories already follow at the per-parameter level.
 *
 * @example
 * ```ts
 * import type { M3LConfigSchemaValidator } from "@m3l-automation/m3l-common/core";
 *
 * const sortRequiresLimit: M3LConfigSchemaValidator = (config) =>
 *   config.get("sort") === undefined || config.get("limit") !== undefined
 *     ? true
 *     : "'sort' requires 'limit' to be set";
 * ```
 */
export type M3LConfigSchemaValidator = (config: M3LConfig) => true | string;

/**
 * Stock factory object for the commonest schema-level cross-parameter
 * constraints.
 *
 * Mirrors the curried shape of {@link M3LConfigValidators} (per-parameter
 * validators) but operates at the schema level — the factory receives the
 * **whole** resolved {@link M3LConfig} store rather than a single typed value.
 *
 * The same secret-safety discipline applies: every returned reason string
 * describes the constraint by **parameter name only** and never embeds an
 * actual resolved value, regardless of which parameter the validator reads.
 * Reason strings reach both the thrown `M3LConfigValidationError`'s `message`
 * and its `context.reason` with no redaction applied downstream.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigSchema,
 *   M3LConfigSchemaValidators,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const schema = new M3LConfigSchema(
 *   [sortParam, limitParam],
 *   [M3LConfigSchemaValidators.requires("sort", "limit")],
 * );
 * ```
 */
export const M3LConfigSchemaValidators = {
  /**
   * Builds a validator that passes vacuously when `dependent` is unset, and
   * passes when both `dependent` and `required` are set; fails with the reason
   * `'<dependent>' requires '<required>' to be set` when `dependent` is set
   * and `required` is not.
   *
   * "Set" is determined by `config.get(name) !== undefined` — i.e. a value
   * that has been stored for the parameter resolves as set, regardless of
   * whether it was declared in the schema. This matches the resolved-value
   * semantics used across `M3LConfig` consumers and ensures the check is
   * consistent with per-parameter `required` resolution.
   *
   * The returned reason string embeds only the **names** passed to `requires()`,
   * never any resolved value — this is the project's secret-safety discipline
   * for validator reason strings. If either parameter may hold a sensitive
   * value, this factory is safe to use without additional redaction.
   *
   * @param dependent - The name of the parameter whose presence implies
   *   `required` must also be present.
   * @param required - The name of the parameter that must be set whenever
   *   `dependent` is set.
   * @returns A {@link M3LConfigSchemaValidator} enforcing the implication
   *   `dependent → required`.
   *
   * @example
   * ```ts
   * import {
   *   M3LConfigSchemaValidators,
   * } from "@m3l-automation/m3l-common/core";
   *
   * // Sensitive opt-in requires the plain bypass to also be present.
   * const v = M3LConfigSchemaValidators.requires("yesSensitive", "yes");
   * ```
   */
  requires:
    (dependent: string, required: string): M3LConfigSchemaValidator =>
    (config) =>
      config.get(dependent) === undefined || config.get(required) !== undefined
        ? true
        : `'${dependent}' requires '${required}' to be set`,
} as const;
