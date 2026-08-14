/**
 * `core/config/deriveSecretsSpecifier` — derives an {@link M3LSecretsSpecifier}
 * from a schema's declared `secret` parameters.
 *
 * @packageDocumentation
 */

import type { M3LConfigSchema } from "./M3LConfigSchema.js";
import { M3LSecretsSpecifier } from "./M3LSecretsSpecifier.js";

/**
 * Options for {@link deriveSecretsSpecifier}.
 */
export interface M3LDeriveSecretsSpecifierOptions {
  /**
   * When `true` (the default), every declared alias of a secret parameter is
   * marked alongside its canonical name — a secret is reachable under any of
   * its aliases (e.g. the m3l CLI's dynamic per-script subcommands accept an
   * alias exactly like the canonical name), so a lookup consumer such as
   * redaction that only marked the canonical name would under-redact a value
   * logged by its alias. Pass `false` when the consumer instead iterates the
   * specifier as a parameter-name set (e.g. a listing that prints "these
   * parameters are secret") and needs a clean 1:1 mapping to declared
   * parameters instead of reachable flag names.
   */
  readonly includeAliases?: boolean;
}

/**
 * Derives an {@link M3LSecretsSpecifier} from `schema`'s declared parameters:
 * every parameter where `isSecret()` is `true` is marked, by canonical name
 * and — when `options.includeAliases` is `true` (the default) — every one of
 * its declared aliases too. A non-secret parameter contributes nothing.
 *
 * A standalone function rather than an `M3LConfigSchema` method, matching the
 * free-function convention {@link coerceConfigValue} already establishes for
 * per-schema derivations.
 *
 * Each call returns a fresh, independent {@link M3LSecretsSpecifier}
 * instance: mutating a returned specifier via `markSecret` never affects the
 * schema or any other previously/subsequently returned specifier. A schema
 * with no secret parameters returns an empty (but non-`undefined`)
 * specifier.
 *
 * @param schema - The schema whose declared parameters to inspect.
 * @param options - Derivation options; see
 *   {@link M3LDeriveSecretsSpecifierOptions}.
 * @returns A fresh {@link M3LSecretsSpecifier} marking every secret
 *   parameter's canonical name (and, by default, its aliases).
 *
 * @example
 * ```ts
 * import {
 *   deriveSecretsSpecifier,
 *   M3LConfigSchema,
 *   M3LConfigParameter,
 *   M3LConfigParameterType,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const schema = new M3LConfigSchema([
 *   new M3LConfigParameter({
 *     name: "apiKey",
 *     type: M3LConfigParameterType.STRING,
 *     aliases: ["api-key"],
 *     secret: true,
 *   }),
 * ]);
 *
 * const specifier = deriveSecretsSpecifier(schema);
 * specifier.isSecret("apiKey"); // true
 * specifier.isSecret("api-key"); // true (alias, includeAliases defaults to true)
 * ```
 */
export function deriveSecretsSpecifier(
  schema: M3LConfigSchema,
  options?: M3LDeriveSecretsSpecifierOptions,
): M3LSecretsSpecifier {
  const includeAliases = options?.includeAliases ?? true;
  const specifier = new M3LSecretsSpecifier();

  for (const parameter of schema.parameters) {
    if (!parameter.isSecret()) continue;

    specifier.markSecret(parameter.getName());
    if (includeAliases) {
      for (const alias of parameter.getAliases()) {
        specifier.markSecret(alias);
      }
    }
  }

  return specifier;
}
