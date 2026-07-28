/**
 * `config-helpers` — the config-error code shared across every
 * `eventbridge-schedules` step (`list-rules`, `describe-rule`, `put-rule`,
 * `delete-rule`, `enable-rule`, `disable-rule`). Each step reads its own
 * config values via its own `Core.M3LConfigAccessor`, bound to this code;
 * `ruleName`'s per-operation requiredness (e.g. required for `describe`/
 * `delete`/`enable`/`disable`/`create`/`update`) is guard-checked at each
 * call site via `Core.M3LConfigAccessor.requiredString`, rather than on the
 * shared config schema, since `ruleName` is never declared `required: true`
 * there (see `src/config.ts`).
 */

/** The config-error code every `eventbridge-schedules` guard/parse failure throws with. */
export const CONFIG_ERROR_CODE = "ERR_EVENTBRIDGE_SCHEDULES_CONFIG";
