/**
 * `core/config/M3LConfigProvider` — the abstract base every config provider
 * implements.
 *
 * @packageDocumentation
 */

/**
 * Abstract base class for a single configuration source. Providers are
 * synchronous: reading a raw value never touches an async API. Any file
 * parsing a file-backed provider needs happens once, at construction time.
 *
 * A `M3LConfigReader` composes an ordered list of providers and consults them
 * in priority order via {@link M3LConfigReader.getRawValueForKeys}.
 *
 * @example
 * ```ts
 * import { M3LConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * class StaticConfigProvider extends M3LConfigProvider {
 *   constructor(private readonly values: Record<string, unknown>) {
 *     super();
 *   }
 *   override getRawValue(key: string): unknown {
 *     return this.values[key];
 *   }
 * }
 * ```
 */
export abstract class M3LConfigProvider {
  /**
   * Returns the raw (uncoerced) value stored under `key`, or `undefined`
   * when the provider has no value for that key.
   *
   * @param key - The configuration key to look up.
   * @returns The raw value, or `undefined` when absent.
   */
  abstract getRawValue(key: string): unknown;

  /**
   * Returns the human-readable source label identifying this provider (e.g.
   * `"cli"`, `"environment-variable"`). Deliberately a concrete method with a
   * default implementation, not `abstract` — this class documents external
   * subclassing (see the class-level `@example`), and adding an abstract
   * member would be a source-breaking change for any existing subclass. A
   * subclass overrides this to report its own canonical label; a subclass
   * that does not override it falls back to `"other"`.
   *
   * @returns The provider's source label; `"other"` unless overridden.
   */
  getSourceLabel(): string {
    return "other";
  }

  /**
   * Returns the keys this provider actually declares, in whatever order is
   * natural to its backing source. Deliberately a concrete method with a
   * default implementation, not `abstract` — this class documents external
   * subclassing (see the class-level `@example`), and adding an abstract
   * member would be a source-breaking change for any existing subclass. A
   * subclass overrides this to enumerate its own source; a subclass that does
   * not override it reports no keys.
   *
   * Enumeration is what {@link M3LConfigProvider.getRawValue} alone cannot
   * express: `getRawValue` answers "what is this key worth?" but never "which
   * keys were written?", so a caller that must reject keys the source declared
   * but its schema does not know (an unknown-key check over a config or flow
   * document) has nothing to iterate. A provider whose backing source cannot
   * be enumerated — an environment or CLI provider consulted key-by-key —
   * correctly keeps the empty default.
   *
   * @returns The declared keys; `[]` unless overridden. Callers must treat the
   *   result as read-only: an implementation may return a live view.
   *
   * @example
   * ```ts
   * import { M3LYAMLConfigProvider } from "@m3l-automation/m3l-common/core";
   *
   * const knownKeys = new Set(["region", "profile"]);
   * const provider = new M3LYAMLConfigProvider("./data/config/app.yaml");
   * const unknown = provider.rawKeys().filter((key) => !knownKeys.has(key));
   * ```
   */
  rawKeys(): readonly string[] {
    return [];
  }
}
