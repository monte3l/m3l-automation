/**
 * `core/config/M3LInMemoryConfigProvider` — a config provider backed by an
 * in-memory `Record` or `Map`.
 *
 * @packageDocumentation
 */

import { buildSafeValueMap } from "../../internal/config/buildSafeValueMap.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/**
 * A config provider backed by a caller-supplied in-memory value source
 * (`Record<string, unknown>` or `ReadonlyMap<string, unknown>`). Useful for
 * tests, script-internal defaults, or values already resolved by another
 * mechanism.
 *
 * When seeded from a `Record`, every top-level key is screened against the
 * prototype-pollution guard — a dangerous key (`__proto__`, `constructor`,
 * `prototype`) throws {@link M3LUnsafeConfigKeyError} at construction. Nested
 * object/array values are stored by reference and are not walked, so a
 * dangerous key nested inside a safe top-level value is not detected.
 *
 * The reported source label defaults to `"in-memory"` but may be overridden at
 * construction. That exists for a caller other than a test — a hosted script's
 * config loader, binding already-resolved parameter values in place of the
 * command-line provider — which needs to report the SAME label the spawn path
 * would have used. Without it a hosted run's `run-report.json` records
 * `"in-memory"` where an identical spawned run records `"cli"`, and the two
 * runs stop being indistinguishable in the very artifact ADR-0054's parity
 * clause is about.
 *
 * @example
 * ```ts
 * import { M3LInMemoryConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LInMemoryConfigProvider({ region: "eu-west-1" });
 * provider.getRawValue("region"); // "eu-west-1"
 * provider.getSourceLabel(); // "in-memory"
 *
 * const hosted = new M3LInMemoryConfigProvider(
 *   { region: "eu-west-1" },
 *   { sourceLabel: "cli" },
 * );
 * hosted.getSourceLabel(); // "cli"
 * ```
 */
export class M3LInMemoryConfigProvider extends M3LConfigProvider {
  private readonly values: ReadonlyMap<string, unknown>;
  /** The label {@link M3LInMemoryConfigProvider.getSourceLabel} reports. */
  private readonly sourceLabel: string;

  /**
   * Creates a new `M3LInMemoryConfigProvider`.
   *
   * @param values - The seed values, as a plain `Record` or a `Map`.
   * @param options - Optional construction options. `sourceLabel` overrides
   *   the reported provenance label, which otherwise stays `"in-memory"`; an
   *   omitted or empty bag leaves every existing call site unchanged.
   * @throws {@link M3LUnsafeConfigKeyError} When `values` is a `Record`
   *   containing a prototype-pollution vector key. The guard runs over
   *   `values` regardless of what `options` carries.
   */
  constructor(
    values: Record<string, unknown> | ReadonlyMap<string, unknown>,
    options?: { readonly sourceLabel?: string },
  ) {
    super();
    this.values =
      values instanceof Map
        ? values
        : buildSafeValueMap(values as Record<string, unknown>);
    this.sourceLabel = options?.sourceLabel ?? "in-memory";
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    return this.values.get(key);
  }

  /** {@inheritDoc M3LConfigProvider.getSourceLabel} */
  override getSourceLabel(): string {
    return this.sourceLabel;
  }
}
