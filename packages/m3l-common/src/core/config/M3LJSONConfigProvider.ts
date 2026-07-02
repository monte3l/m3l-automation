/**
 * `core/config/M3LJSONConfigProvider` — a config provider backed by a JSON
 * file.
 *
 * @packageDocumentation
 */

import * as fs from "fs";

import { buildSafeValueMap } from "../../internal/config/buildSafeValueMap.js";
import { isNodeError } from "../utils/index.js";
import { M3LConfigParseError } from "./M3LConfigParseError.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * Reads and parses `filePath` as JSON, screening top-level keys with the
 * prototype-pollution guard. A missing file (ENOENT) is tolerated and yields
 * an empty map; any other read/parse failure surfaces as
 * {@link M3LConfigParseError} (EACCES/EPERM are re-thrown verbatim per the
 * library filesystem contract, since they represent a genuine access
 * failure rather than a malformed file).
 */
function readJsonFile(filePath: string): Map<string, unknown> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return new Map();
    }
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new M3LConfigParseError(
      `Failed to parse JSON config file: ${filePath}`,
      { context: { filePath }, cause },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new M3LConfigParseError(
      `Expected a JSON object at the top level of config file: ${filePath}`,
      { context: { filePath } },
    );
  }

  return buildSafeValueMap(parsed as Record<string, unknown>);
}

/**
 * A config provider backed by a JSON file, parsed once at construction. A
 * missing file (`ENOENT`) is tolerated — the provider simply yields
 * `undefined` for every key. Malformed JSON content throws
 * {@link M3LConfigParseError}, chaining the underlying `SyntaxError` as
 * `cause`. Every top-level key in the parsed object is screened against the
 * prototype-pollution guard; a dangerous key throws
 * {@link M3LUnsafeConfigKeyError}. Nested object/array values are stored by
 * reference and are not walked, so a dangerous key nested inside a safe
 * top-level value is not detected.
 *
 * @example
 * ```ts
 * import { M3LJSONConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LJSONConfigProvider("./data/config/app.json");
 * provider.getRawValue("region");
 * ```
 */
export class M3LJSONConfigProvider extends M3LConfigProvider {
  private readonly values: ReadonlyMap<string, unknown>;

  /**
   * Creates a new `M3LJSONConfigProvider`, reading and parsing `filePath`
   * immediately.
   *
   * @param filePath - Path to the JSON config file.
   * @throws {@link M3LConfigParseError} When the file exists but its content
   *   is not a valid JSON object.
   * @throws {@link M3LUnsafeConfigKeyError} When the parsed object contains a
   *   prototype-pollution vector key.
   */
  constructor(filePath: string) {
    super();
    this.values = readJsonFile(filePath);
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    return this.values.get(key);
  }
}
