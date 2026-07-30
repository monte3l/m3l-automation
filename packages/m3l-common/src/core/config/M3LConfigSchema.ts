/**
 * `core/config/M3LConfigSchema` — the declared set of config parameters for
 * a script.
 *
 * @packageDocumentation
 */

import type { M3LConfig } from "./M3LConfig.js";
import { M3LConfigValidationError } from "./M3LConfigValidationError.js";
import type { M3LConfigParameter } from "./M3LConfigParameter.js";
import type { M3LConfigSchemaValidator } from "./M3LConfigSchemaValidator.js";

/**
 * Declares the full set of configuration parameters a script accepts.
 * Consumers use it to enumerate declared names/aliases and to check
 * membership — most usefully alongside {@link M3LUnknownParameterDetector} —
 * and it also runs any declared schema-level cross-parameter validators
 * against a resolved config store via {@link M3LConfigSchema.validate}.
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

  /**
   * The constructor-supplied schema-level cross-parameter validator list,
   * exposed verbatim — see {@link M3LConfigSchemaValidator} and
   * {@link M3LConfigSchema.validate}.
   */
  readonly validators: readonly M3LConfigSchemaValidator[];

  /** Cached union of every declared name + alias, for fast `has` lookups. */
  private readonly declared: ReadonlySet<string>;

  /**
   * Creates a new `M3LConfigSchema`.
   *
   * @param parameters - The declared parameters.
   * @param validators - The schema-level cross-parameter validators, run in
   *   declaration order by {@link M3LConfigSchema.validate}. Defaults to an
   *   empty array when omitted.
   */
  constructor(
    parameters: readonly M3LConfigParameter[],
    validators: readonly M3LConfigSchemaValidator[] = [],
  ) {
    this.parameters = parameters;
    this.validators = validators;
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

  /**
   * Runs every schema-level {@link M3LConfigSchemaValidator} against
   * `config`, in declaration order, fail-fast: the first validator to return
   * a failure reason throws immediately and no later validator runs. Returns
   * normally (no throw) when every validator returns `true`, or when this
   * schema declares no validators.
   *
   * @remarks
   * If a validator function itself throws (rather than returning a failure
   * string), that exception propagates unmodified — it is not caught or
   * wrapped here.
   *
   * @param config - The fully-resolved `M3LConfig` store to validate.
   * @throws {@link M3LConfigValidationError} coded `ERR_CONFIG_VALIDATION`
   *   when a validator returns a failure reason; `context` carries
   *   `{ validatorIndex, reason }`. `validatorIndex` is library-supplied and
   *   never a config value, but `reason` is the validator's own returned
   *   string — author-controlled free text with no redaction applied, so an
   *   author who embeds a secret's value in it defeats this guarantee.
   */
  validate(config: M3LConfig): void {
    for (const [validatorIndex, validator] of this.validators.entries()) {
      const result = validator(config);
      if (result !== true) {
        throw new M3LConfigValidationError(result, {
          context: { validatorIndex, reason: result },
        });
      }
    }
  }
}
