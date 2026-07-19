import type { Core } from "@m3l-automation/m3l-common";

/**
 * Lifecycle hooks for `athena-query`. All eight hooks are optional and run
 * in the fixed order documented in `docs/reference/core/script.md`; an empty
 * object is a valid declaration. Add stages as the script grows — e.g.
 * `onAfterConfigLoad` to log resolved parameters, `onError` for failure
 * diagnostics keyed by `ctx.correlationId`.
 */
export const hooks: Core.M3LScriptLifecycleHooks = {};
