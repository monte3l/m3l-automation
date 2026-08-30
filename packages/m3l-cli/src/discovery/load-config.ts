/**
 * `discovery/load-config` — a thin CLI-facing adapter over
 * `@m3l-automation/m3l-common`'s `core/config` seam
 * (`M3LConfigParameterDescriptor`, `M3LConfigModuleLocator`,
 * `loadScriptConfigDescriptors`), which now owns parameter-descriptor
 * mapping, dist-first config-module resolution, and the
 * injectable-importer config loader (X10a promotion).
 *
 * This module re-exports the Core shapes under their historical CLI names
 * and maps every `Core.M3LError` this seam throws to the CLI's own
 * `M3LCliError` (code `ERR_CLI_CONFIG_IMPORT`) at the boundary, so callers
 * elsewhere in the CLI keep observing exactly one error class. See the Core
 * modules for the algorithm itself.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";

/**
 * A CLI-facing rendering of a config parameter's declaration. A type alias
 * for `Core.M3LConfigParameterDescriptor` — see that type for field
 * documentation.
 */
export type M3LCliParameterDescriptor = Core.M3LConfigParameterDescriptor;

/**
 * A CLI-facing rendering of one declared operation (ADR-0055). A type alias
 * for `Core.M3LConfigOperationDescriptor` — see that type for field
 * documentation.
 */
export type M3LCliOperationDescriptor = Core.M3LConfigOperationDescriptor;

/**
 * The resolved config module's absolute path and origin. A type alias for
 * `Core.M3LConfigModuleLocation` — see that type for field documentation.
 */
export type M3LCliConfigModuleLocation = Core.M3LConfigModuleLocation;

/**
 * Maps declared config parameters (real `Core.M3LConfigParameter` instances,
 * or any duck-typed equivalent) to their display-safe
 * {@link M3LCliParameterDescriptor} form. Delegates to
 * `Core.describeConfigParameters`, mapping its `Core.M3LError` (code
 * `ERR_CONFIG_MODULE_INVALID`, thrown when a required getter of a
 * duck-typed element returns a value outside its declared runtime type) to
 * an `M3LCliError` at this boundary — the same treatment
 * {@link resolveConfigModulePath} and {@link loadScriptParameters} already
 * give their own Core calls, so every entry point in this module surfaces
 * exactly one error class rather than leaking a raw `Core.M3LError` from
 * just this one.
 *
 * @param parameters - The declared parameters to describe.
 * @returns One descriptor per input parameter, in the same order.
 * @throws {@link M3LCliError} with code `ERR_CLI_CONFIG_IMPORT` when a
 *   required getter of a `parameters` element returns a value outside its
 *   declared runtime type.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const port = new Core.M3LConfigParameter({
 *   name: "PORT",
 *   type: Core.M3LConfigParameterType.INT,
 *   defaultValue: 3000,
 * });
 * const [descriptor] = describeParameters([port]);
 * ```
 */
export function describeParameters(
  parameters: readonly Core.M3LConfigParameterLike[],
): readonly M3LCliParameterDescriptor[] {
  try {
    return Core.describeConfigParameters(parameters);
  } catch (error) {
    rethrowAsCliConfigImportError(error);
  }
}

/**
 * Maps a caught `Core.M3LError` to an `M3LCliError` coded
 * `ERR_CLI_CONFIG_IMPORT`, preserving the original message verbatim and
 * threading the original `cause` through (falling back to the caught error
 * itself when Core did not attach one) so the causal chain is never
 * silently dropped at this boundary. Anything else re-throws unchanged —
 * only a `Core.M3LError` from this seam is ever relabelled here.
 *
 * @param error - The value caught from a Core `core/config` call.
 * @returns Never returns; always throws.
 */
function rethrowAsCliConfigImportError(error: unknown): never {
  if (error instanceof Core.M3LError) {
    throw new M3LCliError("ERR_CLI_CONFIG_IMPORT", error.message, {
      cause: error.cause ?? error,
    });
  }
  throw error;
}

/**
 * Resolves the config module a script's `configParameters` export should be
 * loaded from, preferring the compiled `dist/config.js` over the
 * type-stripped `src/config.ts` whenever the compiled output is at least as
 * fresh. Delegates to `Core.resolveConfigModulePath`, mapping its
 * `M3LError` (code `ERR_CONFIG_MODULE_NOT_FOUND`) to an `M3LCliError`.
 *
 * @param scriptDirectory - The script's root directory.
 * @returns The resolved module's path and source.
 * @throws {@link M3LCliError} with code `ERR_CLI_CONFIG_IMPORT` when neither
 *   `dist/config.js` nor `src/config.ts` exists.
 *
 * @example
 * ```ts
 * const { path, source } = resolveConfigModulePath("/repo/scripts/foo");
 * // { path: "/repo/scripts/foo/dist/config.js", source: "dist" }
 * ```
 */
export function resolveConfigModulePath(
  scriptDirectory: string,
): M3LCliConfigModuleLocation {
  try {
    return Core.resolveConfigModulePath(scriptDirectory);
  } catch (error) {
    rethrowAsCliConfigImportError(error);
  }
}

/**
 * Loads and describes a script's declared `configParameters`. Delegates to
 * `Core.loadScriptConfigDescriptors` (which itself resolves the module via
 * `Core.resolveConfigModulePath`, imports it, and validates its
 * `configParameters` export) in a single call, so a resolution failure is
 * caught and mapped exactly once here — never double-wrapped by also
 * calling this module's own {@link resolveConfigModulePath} first.
 *
 * @param scriptDirectory - The script's root directory.
 * @param importModule - The module importer to use; defaults to a dynamic
 *   `import()` against the resolved module's `file://` URL. Tests inject a
 *   stub here.
 * @returns The script's described parameters.
 * @throws {@link M3LCliError} with code `ERR_CLI_CONFIG_IMPORT` when the
 *   module cannot be resolved, the import rejects, or the module's
 *   `configParameters` export is missing, not an array, or contains a
 *   non-parameter-like element.
 *
 * @example
 * ```ts
 * const descriptors = await loadScriptParameters("/repo/scripts/foo");
 * // one M3LCliParameterDescriptor per declared config parameter
 * ```
 */
export async function loadScriptParameters(
  scriptDirectory: string,
  importModule?: (specifier: string) => Promise<unknown>,
): Promise<readonly M3LCliParameterDescriptor[]> {
  try {
    return await Core.loadScriptConfigDescriptors(
      scriptDirectory,
      importModule,
    );
  } catch (error) {
    rethrowAsCliConfigImportError(error);
  }
}
