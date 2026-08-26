/**
 * `core/cli-contract/logger` — the logger factory a host uses to build the
 * {@link M3LCommandContext.logger} it hands a hosted command.
 *
 * A host cannot build that logger correctly by hand. `new M3LLogger([handler])`
 * carries neither the resolved `--log-level`/`M3L_LOG_LEVEL` floor
 * (`resolveLogLevelFloor` is `internal/`, and so unreachable from outside the
 * library) nor the script's own schema-derived `secrets` — so a declared secret
 * parameter's value would stop being redacted the moment a run went hosted
 * rather than spawned. This factory applies the same policy `M3LScript`'s own
 * default logger applies, over caller-supplied handlers instead of a hardcoded
 * console handler.
 *
 * The layering is legal in both directions: `core/cli-contract` may import
 * `core/logging`, `core/config` and `internal/**` freely — the ADR-0009 zone
 * bans only `core/**` → `core/script`.
 *
 * @packageDocumentation
 */

import { M3LConfigSchema, deriveSecretsSpecifier } from "../config/index.js";
import type { M3LConfigParameter } from "../config/index.js";
import { M3LError } from "../errors/index.js";
import { M3LLogger } from "../logging/index.js";
import type { M3LLoggerHandler } from "../logging/index.js";
import { hasProperty, isFunction } from "../utils/guards.js";

import { resolveLogLevelFloor } from "../../internal/logging/resolveLogLevelFloor.js";

/**
 * The `M3LConfigParameter` methods `M3LConfigSchema` and
 * `deriveSecretsSpecifier` actually invoke — the whole surface this factory
 * depends on, and therefore the whole surface worth probing for.
 */
const REQUIRED_PARAMETER_METHODS = [
  "getName",
  "getAliases",
  "isSecret",
] as const;

/**
 * The options bag {@link createCommandLogger} accepts.
 *
 * `handlers` and `configParameters` are both **required**, deliberately: a
 * host that forgot `configParameters` would silently build a logger with no
 * derived secrets, which is the exact redaction gap this factory exists to
 * close. An empty array is the honest way to say "this command declares no
 * parameters".
 *
 * @example
 * ```ts
 * import type { M3LCommandLoggerOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LCommandLoggerOptions = {
 *   handlers: [],
 *   configParameters: commandModule.configParameters,
 *   correlationId: "run-1",
 * };
 * ```
 */
export interface M3LCommandLoggerOptions {
  /**
   * The handlers the built logger fans out to — a host's own
   * {@link M3LLoggerHandler} implementations, so command logs reach the host's
   * stream rather than the process console.
   */
  readonly handlers: readonly M3LLoggerHandler[];
  /**
   * The hosted command's declared parameters, as exposed by
   * `M3LCommandModule.configParameters`. Their `secret: true` declarations
   * (and aliases) are what the built logger redacts.
   */
  readonly configParameters: readonly M3LConfigParameter[];
  /** An optional per-run correlation id stamped onto every emitted event. */
  readonly correlationId?: string;
}

/**
 * Duck-type-checks each declared parameter before it reaches
 * `M3LConfigSchema`, throwing a typed {@link M3LError} that names the offending
 * index instead of letting a raw `TypeError` ("parameter.getName is not a
 * function") escape from three frames down.
 *
 * The check exists because {@link isM3LCommandModule} deliberately does *not*
 * validate `configParameters` elements: a descriptor loaded from a foreign
 * `dist/` build carries instances constructed by a different copy of this
 * library, so an `instanceof` test would reject exactly the case the guard
 * exists for. The array therefore arrives structurally unverified, and this is
 * the boundary where its elements are first used.
 *
 * The probe is structural for the same reason — callable `getName`/
 * `getAliases`/`isSecret`, nothing more. Each read is wrapped because the
 * elements are caller-controlled: a throwing getter must surface as the same
 * typed error, not as whatever it chose to raise.
 */
function assertParametersAreShaped(
  parameters: readonly M3LConfigParameter[],
): void {
  for (const [index, parameter] of parameters.entries()) {
    const candidate: unknown = parameter;
    const missing = REQUIRED_PARAMETER_METHODS.find((method) => {
      try {
        return (
          !hasProperty(candidate, method) || !isFunction(candidate[method])
        );
      } catch {
        return true;
      }
    });
    if (missing !== undefined) {
      throw new M3LError(
        `configParameters[${String(index)}] is not a config parameter: expected a callable \`${missing}()\` method`,
        { code: "ERR_INVALID_ARGUMENT" },
      );
    }
  }
}

/**
 * Builds the logger a host hands to a hosted command through
 * {@link M3LCommandContext.logger}.
 *
 * The log-level floor is resolved **ambiently** — from the real
 * `process.argv`/`process.env`, exactly as `M3LScript` resolves it on the
 * spawn path — rather than from an argument, so a hosted run honours
 * `--log-level`/`M3L_LOG_LEVEL` the same way a spawned one does. An
 * out-of-vocabulary value is not swallowed: the loader's `M3LError` propagates,
 * so a host sees the same failure the spawn path surfaces.
 *
 * Every optional field is *conditionally spread*, never passed as a possibly-
 * `undefined` value: `exactOptionalPropertyTypes` rejects an explicit
 * `undefined` against an optional field.
 *
 * @param options - The handlers, declared parameters, and optional
 *   correlation id.
 * @returns A logger carrying the resolved floor and the derived secrets.
 * @throws {@link M3LError} with code `ERR_INVALID_ARGUMENT` when the ambient
 *   CLI/env log-level chain carries an out-of-vocabulary value, when
 *   `--log-level` is present with no value, or when an element of
 *   `configParameters` is not parameter-shaped (the message names the failing
 *   index and method).
 *
 * @example
 * ```ts
 * import { createCommandLogger } from "@m3l-automation/m3l-common/core";
 *
 * const logger = createCommandLogger({
 *   handlers: [hostHandler],
 *   configParameters: commandModule.configParameters,
 *   correlationId: runId,
 * });
 * const outcome = await commandModule.execute(parameters, {
 *   output,
 *   logger,
 *   signal,
 *   dryRun: false,
 * });
 * ```
 */
export function createCommandLogger(
  options: M3LCommandLoggerOptions,
): M3LLogger {
  // Before the schema, not after: `new M3LConfigSchema` is the frame that
  // would otherwise raise the raw `TypeError`.
  assertParametersAreShaped(options.configParameters);
  const resolvedLogLevelFloor = resolveLogLevelFloor();
  const secrets = deriveSecretsSpecifier(
    new M3LConfigSchema(options.configParameters, []),
  );
  return new M3LLogger(options.handlers, {
    ...(options.correlationId !== undefined
      ? { correlationId: options.correlationId }
      : {}),
    ...(resolvedLogLevelFloor !== undefined
      ? { minLevel: resolvedLogLevelFloor }
      : {}),
    secrets,
  });
}
