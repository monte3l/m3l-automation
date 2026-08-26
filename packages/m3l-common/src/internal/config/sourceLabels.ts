/**
 * `internal/config/sourceLabels` — the provider source labels that more than
 * one module has to agree on, named once.
 *
 * Not re-exported publicly: these are the words that appear in a resolved
 * store's `sourceOf()` answers and in `run-report.json`, and a consumer reads
 * them, never writes them. Making them public surface would freeze a
 * diagnostic string into the semver contract for no consumer that exists.
 *
 * @packageDocumentation
 */

/**
 * The source label configuration precedence level 1 reports, wherever level 1
 * is bound.
 *
 * Two modules bind that level: `core/config/M3LCommandLineConfigProvider`
 * (parsing the real `process.argv`) and `core/script/M3LScript` (substituting
 * an `M3LInMemoryConfigProvider` over `host.parameterValues` on the hosted
 * path). Both must report the same word, so a hosted run's `run-report.json`
 * stays indistinguishable from a spawned run's — ADR-0054's parity clause. A
 * second hand-typed `"cli"` at the substituting call site would be a literal
 * that only *happened* to agree; naming it once makes the agreement structural.
 *
 * @example
 * ```ts
 * import { CLI_CONFIG_SOURCE_LABEL } from "../../internal/config/sourceLabels.js";
 *
 * const provider = new M3LInMemoryConfigProvider(values, {
 *   sourceLabel: CLI_CONFIG_SOURCE_LABEL,
 * });
 * ```
 */
export const CLI_CONFIG_SOURCE_LABEL = "cli";
