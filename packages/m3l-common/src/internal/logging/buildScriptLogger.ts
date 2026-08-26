/**
 * `internal/logging/buildScriptLogger` — the default-logger policy a script
 * gets when it supplies no `logger` of its own.
 *
 * Not exported from any barrel — `internal/` is private API, freely
 * changeable without a semver bump. It lives here rather than inline in
 * `core/script/M3LScript.ts` because that file sits at a frozen
 * `check:file-budget` baseline and the policy is a pure function of one
 * argument: nothing in it reads `this` beyond the derived secrets port, so
 * keeping it as a private method bought no encapsulation and cost the budget
 * the host seam needed.
 *
 * @packageDocumentation
 */

import { M3LConsoleLoggerHandler } from "../../core/logging/M3LConsoleLoggerHandler.js";
import { M3LLogger } from "../../core/logging/M3LLogger.js";
import type { M3LSecretNamesPort } from "../../core/logging/redact.js";

import { resolveLogLevelFloor } from "./resolveLogLevelFloor.js";

/**
 * Builds the default logger a script uses when its caller omits
 * `M3LScriptOptions.logger` — a single {@link M3LConsoleLoggerHandler} with
 * `minLevel` set to whatever {@link resolveLogLevelFloor} resolves from the
 * ambient CLI/env chain, and `secrets` set to the script's own derived
 * specifier.
 *
 * Both options are *conditionally spread* rather than passed as a possibly-
 * `undefined` value: `exactOptionalPropertyTypes` rejects an explicit
 * `undefined` against an optional field, and — more importantly — an explicit
 * `minLevel: undefined` would read as "a floor was resolved" to any future
 * `M3LLogger` change that distinguishes the two.
 *
 * Called only from the `??` branch of `M3LScript`'s logger assignment, so a
 * caller-supplied logger never triggers (or is affected by) this resolution:
 * such a logger is never touched and does not receive the script's derived
 * `secrets` automatically. `M3LLogger` has no post-construction way to widen
 * an already-built instance's redaction, so a caller who wants widened
 * redaction on their own logger must pass `secrets` at that logger's own
 * construction.
 *
 * @param secrets - The script's derived secret-names port, or `undefined`
 *   when the script declared no config schema (and so no secret parameters).
 * @returns A freshly built console logger carrying the resolved floor.
 * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when the ambient
 *   CLI/env log-level chain carries an out-of-vocabulary value, or
 *   `--log-level` is present with no value — see {@link resolveLogLevelFloor}.
 *
 * @example
 * ```ts
 * import { buildScriptLogger } from "../../internal/logging/buildScriptLogger.js";
 *
 * const logger = buildScriptLogger(this.secrets);
 * ```
 */
export function buildScriptLogger(
  secrets: M3LSecretNamesPort | undefined,
): M3LLogger {
  const resolvedLogLevelFloor = resolveLogLevelFloor();
  return new M3LLogger([new M3LConsoleLoggerHandler()], {
    ...(resolvedLogLevelFloor !== undefined
      ? { minLevel: resolvedLogLevelFloor }
      : {}),
    ...(secrets !== undefined ? { secrets } : {}),
  });
}
