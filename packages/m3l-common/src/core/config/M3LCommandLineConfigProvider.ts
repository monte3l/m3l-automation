/**
 * `core/config/M3LCommandLineConfigProvider` — a config provider backed by
 * parsed `--flag=value` command-line arguments.
 *
 * @packageDocumentation
 */

import { parseArgv } from "../../internal/config/parseArgv.js";
import { M3LConfigProvider } from "./M3LConfigProvider.js";

/** Number of leading argv entries (`node`, script path) skipped by default. */
const ARGV_SKIP_COUNT = 2;

/**
 * A config provider backed by command-line arguments. Supports
 * `--key=value`, `--key value`, and boolean-style `--flag` forms. Defaults
 * to `process.argv.slice(2)` when no explicit argv array is supplied.
 *
 * @example
 * ```ts
 * import { M3LCommandLineConfigProvider } from "@m3l-automation/m3l-common/core";
 *
 * const provider = new M3LCommandLineConfigProvider(["--region=eu-west-1"]);
 * provider.getRawValue("region"); // "eu-west-1"
 * ```
 */
export class M3LCommandLineConfigProvider extends M3LConfigProvider {
  private readonly values: ReadonlyMap<string, string | boolean>;

  /**
   * Creates a new `M3LCommandLineConfigProvider`.
   *
   * @param argv - The raw argument list to parse; defaults to
   *   `process.argv.slice(2)`.
   */
  constructor(argv?: readonly string[]) {
    super();
    this.values = parseArgv(argv ?? process.argv.slice(ARGV_SKIP_COUNT));
  }

  /** {@inheritDoc M3LConfigProvider.getRawValue} */
  override getRawValue(key: string): unknown {
    return this.values.get(key);
  }
}
