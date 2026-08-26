/**
 * `core/script/M3LScriptConfigLoader` — walks a script's declared config
 * schema against the standard provider chain, resolving each parameter
 * (including its `asyncFallback`) into a live {@link M3LConfig} store.
 *
 * @packageDocumentation
 */

import {
  M3LCommandLineConfigProvider,
  M3LConfig,
  M3LConfigReader,
  M3LEnvironmentConfigProvider,
} from "../config/index.js";
import type { M3LConfigParameter, M3LConfigProvider } from "../config/index.js";

/**
 * Options accepted by {@link M3LScriptConfigLoader.load}.
 *
 * Not exported from the `script` barrel — it is only ever supplied inline at
 * the `loader.load(...)` call site, so callers never need to name this shape
 * directly.
 */
interface M3LScriptConfigLoadOptions {
  /** The declared configuration parameters to resolve. */
  readonly params: readonly M3LConfigParameter[];
  /**
   * Additional providers, consulted AFTER the command-line and environment
   * providers (precedence level 5, e.g. a Lambda event payload).
   */
  readonly extraProviders?: readonly M3LConfigProvider[];
  /**
   * Lowest-priority providers, appended AFTER the command-line and
   * environment providers (precedence level 6, e.g. a loaded preset).
   */
  readonly presetProviders?: readonly M3LConfigProvider[];
  /**
   * Config-file providers (precedence levels 2-3, between command-line and
   * environment providers), ordered highest priority first.
   */
  readonly configFileProviders?: readonly M3LConfigProvider[];
  /**
   * A replacement for the level-1 command-line provider, supplied by a program
   * hosting the script in-process and carrying the parameter values it already
   * resolved.
   *
   * It **replaces** the command-line provider rather than layering above it: a
   * hosted run must not additionally read the host's own `process.argv`.
   * Omitted, a real {@link M3LCommandLineConfigProvider} is constructed as
   * before.
   */
  readonly commandLineProvider?: M3LConfigProvider;
}

/**
 * Resolves a script's declared {@link M3LConfigParameter} list against the
 * standard provider chain (the command-line provider — or a host-supplied
 * replacement at the same precedence level — then config-file providers, then
 * environment variables, then extra providers, then preset providers, in
 * priority order), producing a populated {@link M3LConfig} store.
 *
 * Each parameter's `asyncFallback` (if any) is honored via
 * {@link M3LConfigParameter.getValueAsync}, so `load` is asynchronous.
 *
 * @example
 * ```ts
 * import { M3LScriptConfigLoader } from "@m3l-automation/m3l-common/core";
 *
 * const loader = new M3LScriptConfigLoader();
 * const config = await loader.load({ params: [] });
 * ```
 */
export class M3LScriptConfigLoader {
  /**
   * Resolves every declared parameter in `options.params` against the
   * provider chain, storing each result (including `undefined` results,
   * which are simply omitted) into a fresh {@link M3LConfig}.
   *
   * @param options - The parameters to resolve plus any extra providers.
   * @returns The populated configuration store.
   * @throws {@link M3LConfigCoercionError} When a provider-supplied raw value
   *   cannot be coerced to a parameter's declared type.
   */
  async load(options: M3LScriptConfigLoadOptions): Promise<M3LConfig> {
    const providers: M3LConfigProvider[] = [
      options.commandLineProvider ?? new M3LCommandLineConfigProvider(),
      ...(options.configFileProviders ?? []),
      new M3LEnvironmentConfigProvider(),
      ...(options.extraProviders ?? []),
      ...(options.presetProviders ?? []),
    ];
    const reader = new M3LConfigReader(providers);
    const config = new M3LConfig();

    for (const parameter of options.params) {
      const resolved = await parameter.resolveAsync(reader);
      if (resolved !== undefined) {
        config.set(parameter.getName(), resolved.value, resolved.source);
      }
    }

    return config;
  }
}
