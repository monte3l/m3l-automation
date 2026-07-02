/**
 * `core/config/M3LConfig` — resolved-value store with per-key source
 * tracking.
 *
 * @packageDocumentation
 */

/** A resolved value together with the source label it came from. */
interface M3LConfigEntry {
  readonly value: unknown;
  readonly source: string | undefined;
}

/**
 * A resolved-configuration store: holds the final value for each declared
 * parameter name plus a human-readable label identifying which source
 * supplied it (e.g. `"cli"`, `"environment-variable"`, `"json-file"`).
 *
 * `source` is a plain `string`, not a closed literal union — callers are free
 * to label sources however suits their script.
 *
 * @example
 * ```ts
 * import { M3LConfig } from "@m3l-automation/m3l-common/core";
 *
 * const config = new M3LConfig();
 * config.set("region", "eu-west-1", "cli");
 * config.get("region"); // "eu-west-1"
 * config.sourceOf("region"); // "cli"
 * ```
 */
export class M3LConfig {
  private readonly entries = new Map<string, M3LConfigEntry>();

  /**
   * Stores `value` under `name`, overwriting any previous entry (last write
   * wins) and recording `source` for later inspection via `sourceOf`.
   *
   * @param name - The parameter name.
   * @param value - The resolved value.
   * @param source - A human-readable label identifying the source. Optional;
   *   omitted sources read back as `undefined` via `sourceOf`.
   */
  set(name: string, value: unknown, source?: string): void {
    this.entries.set(name, { value, source });
  }

  /**
   * Returns the resolved value stored under `name`, or `undefined` when
   * `name` was never set.
   *
   * @param name - The parameter name.
   * @returns The stored value, or `undefined`.
   */
  get(name: string): unknown {
    return this.entries.get(name)?.value;
  }

  /**
   * Returns `true` when a value has been stored under `name`.
   *
   * @param name - The parameter name.
   * @returns `true` if `name` has a stored entry.
   */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Returns the source label supplied to `set` for `name`, or `undefined`
   * when `name` was never set (or was set without a source).
   *
   * @param name - The parameter name.
   * @returns The source label, or `undefined`.
   */
  sourceOf(name: string): string | undefined {
    return this.entries.get(name)?.source;
  }
}
