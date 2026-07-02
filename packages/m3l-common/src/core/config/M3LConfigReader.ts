/**
 * `core/config/M3LConfigReader` — resolves a raw value across an ordered list
 * of {@link M3LConfigProvider} instances.
 *
 * @packageDocumentation
 */

import type { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * Composes an ordered list of {@link M3LConfigProvider} instances and
 * resolves raw values across them. Provider order is priority: the first
 * provider in the array is consulted first.
 *
 * {@link M3LConfigReader.getRawValueForKeys} resolves **providers-outer,
 * keys-inner**: for each provider in priority order, every candidate key
 * (a parameter's canonical name plus its aliases) is tried against that
 * provider before advancing to the next provider. This means a
 * higher-priority provider's alias value wins over a lower-priority
 * provider's canonical-key value.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigReader,
 *   M3LCommandLineConfigProvider,
 *   M3LEnvironmentConfigProvider,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const reader = new M3LConfigReader([
 *   new M3LCommandLineConfigProvider(),
 *   new M3LEnvironmentConfigProvider(),
 * ]);
 * const raw = reader.getRawValueForKeys(["region", "aws-region"]);
 * ```
 */
export class M3LConfigReader {
  /** The ordered list of providers, highest priority first. */
  private readonly providers: ReadonlyArray<M3LConfigProvider>;

  /**
   * Creates a new `M3LConfigReader`.
   *
   * @param providers - Ordered list of config providers; the first entry has
   *   the highest priority.
   */
  constructor(providers: ReadonlyArray<M3LConfigProvider>) {
    this.providers = providers;
  }

  /**
   * Resolves the first defined raw value found across `keys`, checking every
   * key against each provider (in priority order) before moving on to the
   * next provider.
   *
   * @param keys - Candidate keys to try, in preference order (typically the
   *   parameter's canonical name followed by its aliases).
   * @returns The first defined raw value found, or `undefined` when no
   *   provider has a value for any of the keys.
   */
  getRawValueForKeys(keys: readonly string[]): unknown {
    for (const provider of this.providers) {
      for (const key of keys) {
        const value = provider.getRawValue(key);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  }

  /**
   * Convenience single-key lookup; delegates to
   * {@link M3LConfigReader.getRawValueForKeys} with a one-element key list.
   *
   * @param key - The configuration key to look up.
   * @returns The first defined raw value found, or `undefined` when absent.
   */
  getRawValue(key: string): unknown {
    return this.getRawValueForKeys([key]);
  }
}
