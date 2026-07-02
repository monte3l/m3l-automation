/**
 * `core/config/M3LSecretsSpecifier` — classifies which config parameter
 * names carry secret values.
 *
 * @packageDocumentation
 */

/**
 * Tracks which configuration parameter names are considered secrets.
 * Classification only — it never redacts or transforms values; that
 * responsibility belongs to the logging/display layer, which should consult
 * `isSecret` before rendering a value.
 *
 * @example
 * ```ts
 * import { M3LSecretsSpecifier } from "@m3l-automation/m3l-common/core";
 *
 * const secrets = new M3LSecretsSpecifier(["apiKey"]);
 * secrets.markSecret("dbPassword");
 * secrets.isSecret("apiKey"); // true
 * secrets.isSecret("region"); // false
 * ```
 */
export class M3LSecretsSpecifier {
  private readonly names = new Set<string>();

  /**
   * Creates a new `M3LSecretsSpecifier`.
   *
   * @param secretNames - Names to mark as secret immediately; equivalent to
   *   calling `markSecret` for each.
   */
  constructor(secretNames?: readonly string[]) {
    for (const name of secretNames ?? []) {
      this.names.add(name);
    }
  }

  /**
   * Marks `name` as carrying a secret value.
   *
   * @param name - The parameter name to mark.
   */
  markSecret(name: string): void {
    this.names.add(name);
  }

  /**
   * Returns `true` when `name` has been marked as a secret.
   *
   * @param name - The parameter name to check.
   * @returns `true` if `name` is marked secret.
   */
  isSecret(name: string): boolean {
    return this.names.has(name);
  }

  /**
   * A snapshot of the currently marked secret names. Returns a defensive
   * copy — mutating the returned set, or calling `markSecret` after reading
   * it, never affects this instance's internal state or a previously read
   * snapshot.
   */
  get secretNames(): ReadonlySet<string> {
    return new Set(this.names);
  }
}
