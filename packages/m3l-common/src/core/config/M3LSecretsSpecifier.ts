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
 * @see {@link deriveSecretsSpecifier} — derives a populated
 *   `M3LSecretsSpecifier` from a whole schema's declared `isSecret()`
 *   parameters (and, by default, their aliases) instead of hand-maintaining a
 *   name list.
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
   *
   * @remarks
   * When this instance was produced by {@link deriveSecretsSpecifier} with
   * its default `includeAliases: true`, this set is a set of _reachable flag
   * names_, not a 1:1 mapping of declared parameter names — a secret
   * parameter's declared aliases appear here alongside its canonical name.
   */
  get secretNames(): ReadonlySet<string> {
    return new Set(this.names);
  }
}
