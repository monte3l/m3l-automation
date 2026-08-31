/**
 * `lib/identifiers` — the shared SQL-identifier validation/quoting helpers
 * `config.ts`, `steps/resolve-settings.ts`, `steps/run-load.ts`, and
 * `steps/build-operation-deps.ts` all need.
 *
 * Extracted here (mirroring `json-etl/src/lib/field-spec.ts`'s precedent for
 * a shared non-step helper module), replacing what was previously
 * copy-pasted `IDENTIFIER_PATTERN` constants (`config.ts`/
 * `resolve-settings.ts`/`run-load.ts`) and copy-pasted
 * `quoteIdentifier`/`qualifyIdentifier` functions (`build-operation-deps.ts`/
 * `run-load.ts`). PostgreSQL identifiers cannot be bound as statement
 * parameters the way values can, so every identifier this module validates
 * is later double-quoted (embedded `"` doubled) when interpolated into
 * generated SQL — never bound as a `:name` parameter.
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * The identifier pattern applied to `schema`/`table`/each entry of
 * `columns`/`migrations.table`, and to any column name inferred from an
 * imported record's own keys.
 */
export const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * {@link validateIdentifier}'s default `code`, used when a caller has no
 * established `Core.M3LError` code of its own.
 */
const DEFAULT_IDENTIFIER_CODE = "ERR_RDS_DATA_SQL_INVALID_IDENTIFIER";

/**
 * Validates `value` against {@link IDENTIFIER_PATTERN}, returning it
 * unchanged when it passes.
 *
 * @param value - The candidate identifier value.
 * @param name - A label for the field `value` came from, folded into the
 *   thrown message (e.g. `"schema"`, `"column"`).
 * @param code - The `Core.M3LError` code to throw with. Defaults to
 *   {@link DEFAULT_IDENTIFIER_CODE}; pass a caller's own established code
 *   (e.g. `resolve-settings.ts`'s `"ERR_RDS_DATA_SQL_SETTINGS"`,
 *   `run-load.ts`'s `"ERR_RDS_DATA_SQL_INVALID_COLUMN"`) to preserve it.
 * @returns `value`, unchanged.
 * @throws {@link Core.M3LError} coded `code` when `value` fails the pattern.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { validateIdentifier } from "./lib/identifiers.js";
 *
 * try {
 *   validateIdentifier("1-bad", "table");
 * } catch (error) {
 *   if (error instanceof Core.M3LError) console.error(error.message);
 * }
 * ```
 */
export function validateIdentifier(
  value: string,
  name: string,
  code: string = DEFAULT_IDENTIFIER_CODE,
): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Core.M3LError(
      `'${value}' is not a valid identifier for '${name}' (must match ^[A-Za-z_][A-Za-z0-9_]{0,62}$)`,
      { code },
    );
  }
  return value;
}

/**
 * Double-quotes a validated identifier for interpolation into generated
 * SQL, doubling any embedded `"`.
 *
 * @param name - An already-validated identifier.
 * @returns `name`, double-quoted.
 *
 * @example
 * ```ts
 * import { quoteIdentifier } from "./lib/identifiers.js";
 *
 * quoteIdentifier("users"); // '"users"'
 * ```
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

/**
 * Qualifies `name` with `schema` (when set), quoting both parts.
 *
 * @param schema - The schema qualifier, when set.
 * @param name - The unqualified identifier.
 * @returns `name`, quoted and schema-qualified when `schema` is set.
 *
 * @example
 * ```ts
 * import { qualifyIdentifier } from "./lib/identifiers.js";
 *
 * qualifyIdentifier("public", "users"); // '"public"."users"'
 * qualifyIdentifier(undefined, "users"); // '"users"'
 * ```
 */
export function qualifyIdentifier(
  schema: string | undefined,
  name: string,
): string {
  return schema === undefined
    ? quoteIdentifier(name)
    : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}
