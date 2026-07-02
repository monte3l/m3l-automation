/**
 * `core/config/M3LLambdaEventConfigProvider` — a config provider backed by
 * top-level keys of an AWS Lambda event payload.
 *
 * @packageDocumentation
 */

import { buildSafeValueMap } from "../../internal/config/buildSafeValueMap.js";
import { isPlainObject } from "../utils/index.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * A config provider backed by the top-level keys of an AWS Lambda event
 * payload. Non-object events (e.g. a string or number payload) yield
 * `undefined` for every key rather than throwing — Lambda event shapes vary
 * widely by trigger source.
 *
 * When the event is an object, every top-level key is screened against the
 * prototype-pollution guard at construction; a dangerous key throws
 * {@link M3LUnsafeConfigKeyError}. Nested object/array values are stored by
 * reference and are not walked, so a dangerous key nested inside a safe
 * top-level value is not detected.
 *
 * @example
 * ```ts
 * import { M3LLambdaEventConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LLambdaEventConfigProvider({ region: "eu-west-1" });
 * provider.getRawValue("region"); // "eu-west-1"
 * ```
 */
export class M3LLambdaEventConfigProvider extends M3LConfigProvider {
  private readonly values: ReadonlyMap<string, unknown>;

  /**
   * Creates a new `M3LLambdaEventConfigProvider`.
   *
   * @param event - The raw Lambda event payload.
   * @throws {@link M3LUnsafeConfigKeyError} When `event` is an object
   *   containing a prototype-pollution vector key.
   */
  constructor(event: unknown) {
    super();
    this.values = isPlainObject(event)
      ? buildSafeValueMap(event)
      : new Map<string, unknown>();
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    return this.values.get(key);
  }
}
