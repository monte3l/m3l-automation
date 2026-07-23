/**
 * `core/script` — the CLI / Lambda entry-point framework: `M3LScript` wires
 * configuration, logging, prompts, and process guards for automation
 * scripts and Lambda handlers.
 *
 * Re-exports exactly the fourteen public symbols documented in
 * `docs/reference/core/script.md`. No logic lives here; this file is a
 * barrel only.
 *
 * @packageDocumentation
 */

export {
  AWS_PROFILE_PARAM_NAME,
  AWS_REGION_PARAM_NAME,
} from "./aws-param-names.js";
export { M3LScript } from "./M3LScript.js";
export type {
  M3LScriptHookContext,
  M3LScriptLifecycleHooks,
  M3LScriptMetadata,
  M3LScriptOptions,
} from "./M3LScriptOptions.js";
export { M3LScriptConfigLoader } from "./M3LScriptConfigLoader.js";
export { M3LScriptPresetLoader } from "./M3LScriptPresetLoader.js";
export { M3LPresetUnknownKeysError } from "./M3LPresetUnknownKeysError.js";
export { M3LPresetCycleError } from "./M3LPresetCycleError.js";
export {
  installProcessGuards,
  serializeError,
  setProcessGuardRequestId,
} from "./process-guards.js";
