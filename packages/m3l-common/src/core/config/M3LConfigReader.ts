/**
 * `core/config/M3LConfigReader` — resolves a raw value across an ordered list
 * of {@link M3LConfigProvider} instances.
 *
 * @packageDocumentation
 */

import type { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * A resolved value paired with the source label identifying which provider
 * (or, more broadly, which resolution branch) supplied it.
 *
 * @typeParam TValue - The type of the resolved value; defaults to `unknown`.
 *
 * @example
 * ```ts
 * import type { M3LConfigResolution } from "@m3l-automation/m3l-common/core";
 *
 * const resolution: M3LConfigResolution<string> = {
 *   value: "eu-west-1",
 *   source: "cli",
 * };
 * ```
 */
export interface M3LConfigResolution<TValue = unknown> {
  /** The resolved value. */
  readonly value: TValue;
  /** The source label identifying where `value` came from. */
  readonly source: string;
}

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
   * Resolves the first defined raw value found across `keys` — same
   * providers-outer/keys-inner traversal as {@link M3LConfigReader.resolveForKeys}
   * — tagged with the winning provider's source label.
   *
   * @param keys - Candidate keys to try, in preference order (typically the
   *   parameter's canonical name followed by its aliases).
   * @returns The first defined value/source pair found, or `undefined` when
   *   no provider has a value for any of the keys.
   */
  resolveForKeys(keys: readonly string[]): M3LConfigResolution | undefined {
    for (const provider of this.providers) {
      for (const key of keys) {
        const value = provider.getRawValue(key);
        if (value !== undefined) {
          return { value, source: provider.getSourceLabel() };
        }
      }
    }
    return undefined;
  }

  /**
   * Resolves the first defined raw value found across `keys`, checking every
   * key against each provider (in priority order) before moving on to the
   * next provider. Delegates to {@link M3LConfigReader.resolveForKeys} so the
   * providers-outer/keys-inner traversal exists in exactly one place.
   *
   * @param keys - Candidate keys to try, in preference order (typically the
   *   parameter's canonical name followed by its aliases).
   * @returns The first defined raw value found, or `undefined` when no
   *   provider has a value for any of the keys.
   */
  getRawValueForKeys(keys: readonly string[]): unknown {
    return this.resolveForKeys(keys)?.value;
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
