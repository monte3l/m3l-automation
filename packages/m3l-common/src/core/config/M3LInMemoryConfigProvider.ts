/**
 * `core/config/M3LInMemoryConfigProvider` — a config provider backed by an
 * in-memory `Record` or `Map`.
 *
 * @packageDocumentation
 */

import { buildSafeValueMap } from "../../internal/config/buildSafeValueMap.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * A config provider backed by a caller-supplied in-memory value source
 * (`Record<string, unknown>` or `ReadonlyMap<string, unknown>`). Useful for
 * tests, script-internal defaults, or values already resolved by another
 * mechanism.
 *
 * When seeded from a `Record`, every top-level key is screened against the
 * prototype-pollution guard — a dangerous key (`__proto__`, `constructor`,
 * `prototype`) throws {@link M3LUnsafeConfigKeyError} at construction. Nested
 * object/array values are stored by reference and are not walked, so a
 * dangerous key nested inside a safe top-level value is not detected.
 *
 * @example
 * ```ts
 * import { M3LInMemoryConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LInMemoryConfigProvider({ region: "eu-west-1" });
 * provider.getRawValue("region"); // "eu-west-1"
 * ```
 */
export class M3LInMemoryConfigProvider extends M3LConfigProvider {
  private readonly values: ReadonlyMap<string, unknown>;

  /**
   * Creates a new `M3LInMemoryConfigProvider`.
   *
   * @param values - The seed values, as a plain `Record` or a `Map`.
   * @throws {@link M3LUnsafeConfigKeyError} When `values` is a `Record`
   *   containing a prototype-pollution vector key.
   */
  constructor(values: Record<string, unknown> | ReadonlyMap<string, unknown>) {
    super();
    this.values =
      values instanceof Map
        ? values
        : buildSafeValueMap(values as Record<string, unknown>);
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    return this.values.get(key);
  }
}
