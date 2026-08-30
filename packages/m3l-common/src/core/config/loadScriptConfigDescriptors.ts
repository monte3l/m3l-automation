/**
 * `core/config/loadScriptConfigDescriptors` — the injectable-importer config
 * loader that resolves, imports, validates, and describes a script's
 * declared `configParameters` from outside that script's own process.
 *
 * @packageDocumentation
 */

import { pathToFileURL } from "node:url";

import { M3LError } from "../errors/index.js";
import { toTrustedArray } from "../../internal/config/toTrustedArray.js";
import { describeConfigParameters } from "./M3LConfigParameterDescriptor.js";
import type {
  M3LConfigParameterDescriptor,
  M3LConfigParameterLike,
} from "./M3LConfigParameterDescriptor.js";
import { resolveConfigModulePath } from "./M3LConfigModuleLocator.js";

/**
 * Imports `specifier` as an ES module and returns its namespace object.
 * The default importer {@link loadScriptConfigDescriptors} uses when the
 * caller does not inject one.
 *
 * @param specifier - A module specifier, typically a `file://` URL.
 * @returns The imported module's namespace object.
 */
async function defaultImportModule(specifier: string): Promise<unknown> {
  const moduleExports: unknown = await import(specifier);
  return moduleExports;
}

/**
 * The full set of getter method names {@link M3LConfigParameterLike}
 * declares — every one of these must be a function on a candidate value for
 * it to be trusted as parameter-like (checking only `getName` let a
 * malformed export missing the other five getters through, to fail later as
 * a raw `TypeError` inside {@link describeConfigParameters}).
 */
const PARAMETER_LIKE_GETTER_NAMES: readonly (keyof M3LConfigParameterLike)[] = [
  "getName",
  "getAliases",
  "getType",
  "isRequired",
  "getDefaultValue",
  "getDescription",
];

/**
 * Checks whether `value` exposes the minimal duck-type
 * {@link M3LConfigParameterLike} requires — every getter in
 * {@link PARAMETER_LIKE_GETTER_NAMES} must be present as a function.
 *
 * @param value - The candidate `configParameters` array element.
 * @returns Whether `value` is parameter-like.
 */
function isParameterLike(value: unknown): value is M3LConfigParameterLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return PARAMETER_LIKE_GETTER_NAMES.every(
    (getterName) => typeof candidate[getterName] === "function",
  );
}

/**
 * Loads and describes a script's declared `configParameters`.
 *
 * Resolves the script's config module via {@link resolveConfigModulePath}
 * (a failure here propagates unwrapped — it is already an {@link M3LError}
 * with code `ERR_CONFIG_MODULE_NOT_FOUND`), imports it, validates the
 * module exports an array `configParameters` whose elements are
 * parameter-like, and describes them via {@link describeConfigParameters}.
 *
 * They deliberately never construct an `M3LConfig` and never resolve a
 * value from any provider — this describes what a script _declares_, not
 * what it would resolve to in a given environment.
 *
 * @param scriptDirectory - The script's root directory.
 * @param importModule - The module importer to use; defaults to a dynamic
 *   `import()` against the resolved module's `file://` URL. Tests inject a
 *   stub here.
 * @returns The script's described parameters.
 * @throws {@link M3LError} with code `ERR_CONFIG_MODULE_NOT_FOUND`,
 *   propagated unwrapped from {@link resolveConfigModulePath}.
 * @throws {@link M3LError} with code `ERR_CONFIG_MODULE_INVALID` when the
 *   import rejects (the rejection is chained as `cause`), the module's
 *   `configParameters` export is missing, not an array, or contains a
 *   non-parameter-like element, or `describeConfigParameters` itself throws
 *   (already an {@link M3LError}, propagated unchanged; anything else
 *   chained as `cause`) — the import, validation, and describe steps are one
 *   choke point so nothing past `resolveConfigModulePath` can escape
 *   unwrapped (X10a security hardening, Fix 4).
 *
 * @example
 * ```ts
 * import { loadScriptConfigDescriptors } from "@m3l-automation/m3l-common/core";
 *
 * const descriptors = await loadScriptConfigDescriptors("/repo/scripts/foo");
 * // one M3LConfigParameterDescriptor per declared config parameter
 * ```
 */
export async function loadScriptConfigDescriptors(
  scriptDirectory: string,
  importModule: (specifier: string) => Promise<unknown> = defaultImportModule,
): Promise<readonly M3LConfigParameterDescriptor[]> {
  // Deliberately outside the try/catch below: its ERR_CONFIG_MODULE_NOT_FOUND
  // must propagate unwrapped, never re-wrapped as ERR_CONFIG_MODULE_INVALID.
  const { path } = resolveConfigModulePath(scriptDirectory);

  try {
    let moduleExports: unknown;
    try {
      moduleExports = await importModule(pathToFileURL(path).href);
    } catch (cause) {
      throw new M3LError(`failed to import config module '${path}'`, {
        code: "ERR_CONFIG_MODULE_INVALID",
        cause,
      });
    }

    if (typeof moduleExports !== "object" || moduleExports === null) {
      throw new M3LError(`config module '${path}' did not export an object`, {
        code: "ERR_CONFIG_MODULE_INVALID",
      });
    }

    const rawConfigParameters = (moduleExports as Record<string, unknown>)[
      "configParameters"
    ];
    if (!Array.isArray(rawConfigParameters)) {
      throw new M3LError(
        `config module '${path}' does not export an array 'configParameters'`,
        { code: "ERR_CONFIG_MODULE_INVALID" },
      );
    }

    // Materialize through a trusted path (X10a security hardening, Fix 1):
    // `Array.isArray` above is `true` for a real Array instance that also
    // carries an OWN `every` property shadowing `Array.prototype.every` for
    // that one instance — see `toTrustedArray` for why length + indexed
    // reads (not `Array.from`/`.slice`) is the safe technique here.
    const configParameters = toTrustedArray(rawConfigParameters);

    if (!configParameters.every(isParameterLike)) {
      throw new M3LError(
        `config module '${path}' exports a 'configParameters' element that is not parameter-like`,
        { code: "ERR_CONFIG_MODULE_INVALID" },
      );
    }

    return describeConfigParameters(configParameters);
  } catch (cause) {
    if (cause instanceof M3LError) {
      throw cause;
    }
    throw new M3LError(`config module '${path}' could not be described`, {
      code: "ERR_CONFIG_MODULE_INVALID",
      cause,
    });
  }
}
