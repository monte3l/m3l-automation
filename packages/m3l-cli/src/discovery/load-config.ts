/**
 * `discovery/load-config` — parameter-descriptor mapping, dist-first
 * config-module resolution, and the injectable-importer config loader.
 *
 * @packageDocumentation
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { M3LCliError } from "../cli/errors.js";

/**
 * Mask rendered in place of a secret-flagged parameter's default value.
 * Mirrors `Core.M3LConfigHelpFormatter`'s own `SECRET_MASK` — the same
 * 8-asterisk convention, applied here so masking happens once, at the
 * descriptor source, rather than being left to every renderer (the
 * discovery cache, `inspect`'s table, its `--json` output) to remember
 * independently.
 */
const SECRET_MASK = "********";

/**
 * A CLI-facing rendering of a config parameter's declaration, with every
 * value coerced to a display-safe primitive.
 */
export interface M3LCliParameterDescriptor {
  /** The parameter's canonical name. */
  readonly name: string;
  /** The parameter's declared aliases. */
  readonly aliases: readonly string[];
  /** The parameter's declared coercion target type, as a string. */
  readonly type: string;
  /** Whether the parameter is required. */
  readonly required: boolean;
  /** The parameter's default value, rendered via `String(...)`, or `undefined`. */
  readonly defaultValue: string | undefined;
  /** The parameter's human-readable description, or `""` when absent. */
  readonly description: string;
  /**
   * Whether the parameter is declared secret (see `Core.M3LConfigParameter.isSecret`).
   * A secret-flagged parameter's resolved value must never be persisted or
   * rendered unmasked by any consumer of this descriptor (the preset writer
   * skips it entirely; a display surface must hard-mask it). Declared
   * optional so a hand-built fixture literal predating the 8f
   * secret-threading addition remains a valid `M3LCliParameterDescriptor`;
   * {@link describeParameters} itself always assigns an explicit `true`/`false`,
   * never leaves it `undefined`.
   */
  readonly secret?: boolean;
}

/**
 * The set of value shapes a config parameter's default can take — the union
 * every `M3LCoercedValue<T>` (`@m3l-automation/m3l-common`'s
 * `core/config/M3LConfigParameterType`) resolves to. Scoped to this
 * primitive/array/`Buffer` union (rather than `unknown`) so `String(...)`
 * never risks the `[object Object]` fallback.
 */
type M3LCliParameterValue =
  string | number | boolean | readonly string[] | readonly number[] | Buffer;

/**
 * The minimal shape a `configParameters` element must expose — the public
 * getters `Core.M3LConfigParameter` (`@m3l-automation/m3l-common`) declares —
 * so a duck-typed export from a dynamically imported module can be described
 * without requiring it to be a real `M3LConfigParameter` instance.
 */
interface M3LCliParameterLike {
  getName(): string;
  getAliases(): readonly string[];
  getType(): string;
  isRequired(): boolean;
  getDefaultValue(): M3LCliParameterValue | undefined;
  getDescription(): string | undefined;
  /**
   * Optional — NOT part of the six-getter parameter-like gate
   * ({@link PARAMETER_LIKE_GETTER_NAMES}). A duck-typed export compiled
   * against a dist predating the 8f secret-threading addition simply won't
   * have this method; {@link describeParameters} treats its absence as
   * non-secret rather than rejecting the whole element.
   */
  isSecret?(): boolean;
}

/**
 * Renders a parameter's default value for the {@link M3LCliParameterDescriptor}
 * shape: `undefined` stays `undefined` (no default was declared), a secret
 * default renders as {@link SECRET_MASK} rather than the raw value — an
 * env-sourced secret default materializes at import time, so masking here
 * (the one place every descriptor is built) covers the discovery cache and
 * every renderer downstream in one change — and every other default renders
 * via `String(...)`.
 *
 * @param value - The parameter's raw default value, or `undefined`.
 * @param secret - Whether the parameter is declared secret.
 * @returns The display-safe rendering.
 */
function renderDefaultValue(
  value: M3LCliParameterValue | undefined,
  secret: boolean,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return secret ? SECRET_MASK : String(value);
}

/**
 * Maps declared config parameters (real `Core.M3LConfigParameter` instances,
 * or any duck-typed equivalent) to their display-safe
 * {@link M3LCliParameterDescriptor} form.
 *
 * @param parameters - The declared parameters to describe.
 * @returns One descriptor per input parameter, in the same order.
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
  parameters: readonly M3LCliParameterLike[],
): readonly M3LCliParameterDescriptor[] {
  return parameters.map((parameter) => {
    const defaultValue = parameter.getDefaultValue();
    const secret =
      typeof parameter.isSecret === "function" ? parameter.isSecret() : false;
    return {
      name: parameter.getName(),
      aliases: parameter.getAliases(),
      type: parameter.getType(),
      required: parameter.isRequired(),
      defaultValue: renderDefaultValue(defaultValue, secret),
      description: parameter.getDescription() ?? "",
      secret,
    };
  });
}

/**
 * Where a script's config module was resolved from. Not exported: nothing
 * outside this module needs to reference the string-literal union by name —
 * only through {@link M3LCliConfigModuleLocation.source}, which is.
 */
type M3LCliConfigModuleSource = "dist" | "src";

/** The resolved config module's absolute path and origin. */
export interface M3LCliConfigModuleLocation {
  /** The absolute path to the resolved config module. */
  readonly path: string;
  /** Whether the resolved module came from `dist/` or `src/`. */
  readonly source: M3LCliConfigModuleSource;
}

/**
 * Resolves the config module a script's `configParameters` export should be
 * loaded from, preferring the compiled `dist/config.js` over the
 * type-stripped `src/config.ts` whenever the compiled output is at least as
 * fresh.
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
  const distPath = join(scriptDirectory, "dist", "config.js");
  const srcPath = join(scriptDirectory, "src", "config.ts");

  const distExists = existsSync(distPath);
  const srcExists = existsSync(srcPath);

  if (
    distExists &&
    (!srcExists || statSync(distPath).mtimeMs >= statSync(srcPath).mtimeMs)
  ) {
    return { path: distPath, source: "dist" };
  }

  if (srcExists) {
    return { path: srcPath, source: "src" };
  }

  throw new M3LCliError(
    "ERR_CLI_CONFIG_IMPORT",
    `no config module found for script at '${scriptDirectory}' (checked dist/config.js and src/config.ts)`,
  );
}

/**
 * Imports `specifier` as an ES module and returns its namespace object.
 * The default importer {@link loadScriptParameters} uses when the caller
 * does not inject one.
 *
 * @param specifier - A module specifier, typically a `file://` URL.
 * @returns The imported module's namespace object.
 */
async function defaultImportModule(specifier: string): Promise<unknown> {
  const moduleExports: unknown = await import(specifier);
  return moduleExports;
}

/**
 * The full set of getter method names {@link M3LCliParameterLike} declares —
 * every one of these must be a function on a candidate value for it to be
 * trusted as parameter-like (checking only `getName` let a malformed export
 * missing the other five getters through, to fail later as a raw
 * `TypeError` inside {@link describeParameters}).
 */
const PARAMETER_LIKE_GETTER_NAMES: readonly (keyof M3LCliParameterLike)[] = [
  "getName",
  "getAliases",
  "getType",
  "isRequired",
  "getDefaultValue",
  "getDescription",
];

/**
 * Checks whether `value` exposes the minimal duck-type
 * {@link M3LCliParameterLike} requires — every getter in
 * {@link PARAMETER_LIKE_GETTER_NAMES} must be present as a function.
 *
 * @param value - The candidate `configParameters` array element.
 * @returns Whether `value` is parameter-like.
 */
function isParameterLike(value: unknown): value is M3LCliParameterLike {
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
 * (a failure here propagates unwrapped — it is already an
 * {@link M3LCliError}), imports it, validates the module exports an array
 * `configParameters` whose elements are parameter-like, and describes them
 * via {@link describeParameters}.
 *
 * @param scriptDirectory - The script's root directory.
 * @param importModule - The module importer to use; defaults to a dynamic
 *   `import()` against the resolved module's `file://` URL. Tests inject a
 *   stub here.
 * @returns The script's described parameters.
 * @throws {@link M3LCliError} with code `ERR_CLI_CONFIG_IMPORT` when the
 *   import rejects, or the module's `configParameters` export is missing,
 *   not an array, or contains a non-parameter-like element.
 *
 * @example
 * ```ts
 * const descriptors = await loadScriptParameters("/repo/scripts/foo");
 * // one M3LCliParameterDescriptor per declared config parameter
 * ```
 */
export async function loadScriptParameters(
  scriptDirectory: string,
  importModule: (specifier: string) => Promise<unknown> = defaultImportModule,
): Promise<readonly M3LCliParameterDescriptor[]> {
  const { path } = resolveConfigModulePath(scriptDirectory);

  let moduleExports: unknown;
  try {
    moduleExports = await importModule(pathToFileURL(path).href);
  } catch (cause) {
    throw new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      `failed to import config module '${path}'`,
      { cause },
    );
  }

  if (typeof moduleExports !== "object" || moduleExports === null) {
    throw new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      `config module '${path}' did not export an object`,
    );
  }

  const configParameters = (moduleExports as Record<string, unknown>)[
    "configParameters"
  ];
  if (!Array.isArray(configParameters)) {
    throw new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      `config module '${path}' does not export an array 'configParameters'`,
    );
  }

  if (!configParameters.every(isParameterLike)) {
    throw new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      `config module '${path}' exports a 'configParameters' element that is not parameter-like`,
    );
  }

  return describeParameters(configParameters);
}
