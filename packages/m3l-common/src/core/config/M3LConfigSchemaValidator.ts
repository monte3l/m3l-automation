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
