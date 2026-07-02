/**
 * `core/config/M3LConfigSchema` — the declared set of config parameters for
 * a script.
 *
 * @packageDocumentation
 */

import type { M3LConfigParameter } from "./M3LConfigParameter.js";

/**
 * Declares the full set of configuration parameters a script accepts.
 * Consumers use it to enumerate declared names/aliases and to check
 * membership — most usefully alongside {@link M3LUnknownParameterDetector}.
 *
 * @example
 * ```ts
 * import {
 *   M3LConfigSchema,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const schema = new M3LConfigSchema([
 *   new M3LConfigParameter({
 *     name: "region",
 *     type: M3LConfigParameterType.STRING,
 *     aliases: ["aws-region"],
 *   }),
 * ]);
 * schema.has("region"); // true
 * ```
 */
export class M3LConfigSchema {
  /** The constructor-supplied parameter list, exposed verbatim. */
  readonly parameters: readonly M3LConfigParameter[];

  /** Cached union of every declared name + alias, for fast `has` lookups. */
  private readonly declared: ReadonlySet<string>;

  /**
   * Creates a new `M3LConfigSchema`.
   *
   * @param parameters - The declared parameters.
   */
  constructor(parameters: readonly M3LConfigParameter[]) {
    this.parameters = parameters;
    const names = new Set<string>();
    for (const parameter of parameters) {
      names.add(parameter.getName());
      for (const alias of parameter.getAliases()) {
        names.add(alias);
      }
    }
    this.declared = names;
  }

  /**
   * Returns every declared name and alias across all parameters.
   *
   * @returns A `readonly` array of declared name/alias strings.
   */
  declaredNames(): readonly string[] {
    return Array.from(this.declared);
  }

  /**
   * Returns `true` when `name` matches a declared parameter's canonical name
   * or one of its aliases.
   *
   * @param name - The name to check.
   * @returns `true` if `name` is declared.
   */
  has(name: string): boolean {
    return this.declared.has(name);
  }
}
