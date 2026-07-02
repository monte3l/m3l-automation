/**
 * `core/config/M3LPresetConfigProvider` — a config provider backed by an
 * already-loaded preset object.
 *
 * @packageDocumentation
 */

import { buildSafeValueMap } from "../../internal/config/buildSafeValueMap.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * A config provider backed by a caller-supplied preset object — an
 * already-loaded `Record` of default values (e.g. environment presets baked
 * into a deployment artifact). The preset stays decoupled from the script
 * module: callers load it however they like and hand it to this provider.
 *
 * Every top-level key is screened against the prototype-pollution guard at
 * construction; a dangerous key throws {@link M3LUnsafeConfigKeyError}.
 * Nested object/array values are stored by reference and are not walked, so a
 * dangerous key nested inside a safe top-level value is not detected.
 *
 * @example
 * ```ts
 * import { M3LPresetConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LPresetConfigProvider({ stage: "prod" });
 * provider.getRawValue("stage"); // "prod"
 * ```
 */
export class M3LPresetConfigProvider extends M3LConfigProvider {
  private readonly values: ReadonlyMap<string, unknown>;

  /**
   * Creates a new `M3LPresetConfigProvider`.
   *
   * @param preset - The already-loaded preset values.
   * @throws {@link M3LUnsafeConfigKeyError} When `preset` contains a
   *   prototype-pollution vector key.
   */
  constructor(preset: Record<string, unknown>) {
    super();
    this.values = buildSafeValueMap(preset);
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    return this.values.get(key);
  }
}
