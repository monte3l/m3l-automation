/**
 * `core/config/M3LUnknownParameterDetector` — flags supplied keys that are
 * not declared in a {@link M3LConfigSchema}.
 *
 * @packageDocumentation
 */

import type { M3LConfigSchema } from "./M3LConfigSchema.js";

/**
 * Detects configuration keys that were supplied at runtime but are not
 * declared in a {@link M3LConfigSchema}. Non-throwing by contract — callers
 * decide what to do with the flagged names (warn, error, ignore).
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigSchema,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 *   M3LUnknownParameterDetector,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const schema = new M3LConfigSchema([
 *   new M3LConfigParameter({ name: "region", type: M3LConfigParameterType.STRING }),
 * ]);
 * const detector = new M3LUnknownParameterDetector(schema);
 * detector.detect(["region", "typo"]); // ["typo"]
 * ```
 */
export class M3LUnknownParameterDetector {
  private readonly schema: M3LConfigSchema;

  /**
   * Creates a new `M3LUnknownParameterDetector`.
   *
   * @param schema - The schema to check supplied keys against.
   */
  constructor(schema: M3LConfigSchema) {
    this.schema = schema;
  }

  /**
   * Returns the subset of `suppliedKeys` that are not declared (by name or
   * alias) in the schema.
   *
   * @param suppliedKeys - The keys actually present at runtime.
   * @returns A `readonly` array of undeclared keys, preserving input order.
   */
  detect(suppliedKeys: readonly string[]): readonly string[] {
    return suppliedKeys.filter((key) => !this.schema.has(key));
  }
}
