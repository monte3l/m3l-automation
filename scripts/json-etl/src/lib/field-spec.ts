/**
 * `lib/field-spec` — the shared field-spec parsing helper `config.ts` and
 * `steps/run-json-etl.ts` both need.
 *
 * Extracted here (rather than left duplicated, or hoisted into either
 * consumer) because `config.ts` must not import from a `steps/` module —
 * that dependency direction is backwards for a script package (config is the
 * seam `steps/` reads, not the other way around) — so a small,
 * dependency-free `lib/` module is the only shape both can share.
 */

/**
 * Extracts the output column name (`"name"` of a `"name=path"` extraction
 * spec) from a `fields` entry. A spec with no `=` is returned unchanged — it
 * is already just the column name.
 *
 * @param spec - One entry from the `fields` config parameter, e.g. `"id=id"`
 *   or `"tags=items.*.tag"`.
 * @returns The output column name.
 *
 * @example
 * ```ts
 * import { fieldName } from "./lib/field-spec.js";
 *
 * fieldName("tags=items.*.tag"); // "tags"
 * fieldName("id"); // "id"
 * ```
 */
export function fieldName(spec: string): string {
  const separatorIndex = spec.indexOf("=");
  return separatorIndex < 0 ? spec : spec.slice(0, separatorIndex);
}
