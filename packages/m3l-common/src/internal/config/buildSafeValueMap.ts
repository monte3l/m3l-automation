/**
 * `internal/config/buildSafeValueMap` — shared prototype-pollution guard used
 * by config providers that build an internal value map from parsed or
 * external input (JSON files, YAML files, Lambda events, in-memory records,
 * presets).
 *
 * Private to `core/config`; never re-exported through a public barrel.
 */

import { isDangerousKey } from "../../core/security/index.js";
import { M3LUnsafeConfigKeyError } from "../../core/config/M3LUnsafeConfigKeyError.js";

/**
 * Builds a `Map` from `source`, screening every **top-level** key with
 * {@link isDangerousKey}. Throws {@link M3LUnsafeConfigKeyError} on the first
 * dangerous key encountered (`__proto__`, `constructor`, `prototype`) instead
 * of assigning it — this prevents prototype pollution when `source` originates
 * from untrusted parsed input.
 *
 * Only the first level of keys is screened; nested object/array values are
 * stored by reference and are not walked or deep-copied, so a dangerous key
 * nested inside a safe top-level value is not detected by this function.
 *
 * @param source - A plain record of raw values (e.g. `JSON.parse` output).
 * @returns A `Map` containing every safe top-level key/value pair from
 *   `source`.
 * @throws {@link M3LUnsafeConfigKeyError} When `source` contains a
 *   prototype-pollution vector key at the top level.
 */
export function buildSafeValueMap(
  source: Record<string, unknown>,
): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const key of Object.keys(source)) {
    if (isDangerousKey(key)) {
      throw new M3LUnsafeConfigKeyError(
        `Refusing to read unsafe configuration key: "${key}"`,
        { context: { key } },
      );
    }
    map.set(key, source[key]);
  }
  return map;
}
