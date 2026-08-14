/**
 * `lib/defaults` — the numeric/string default constants shared between
 * `config.ts` (declaring each parameter's `defaultValue`) and
 * `steps/resolve-settings.ts` (re-applying the same default when narrowing a
 * directly-built `Core.M3LConfig` that bypassed `M3LConfigParameter`
 * resolution).
 *
 * Extracted here, mirroring `lib/identifiers.ts`'s precedent for a shared
 * non-step helper module, replacing what was previously copy-pasted
 * `BATCH_SIZE_DEFAULT`/`PAGE_SIZE_DEFAULT`/`MIGRATIONS_TABLE_DEFAULT`
 * constants between the two files.
 */

/** `batch.size`'s documented default value, applied by `load` when unset. */
export const BATCH_SIZE_DEFAULT = 100;

/** `page.size`'s documented default value, applied by `query` when unset. */
export const PAGE_SIZE_DEFAULT = 1_000;

/** `migrations.table`'s documented default value, applied by `migrate` when unset. */
export const MIGRATIONS_TABLE_DEFAULT = "schema_migrations";
