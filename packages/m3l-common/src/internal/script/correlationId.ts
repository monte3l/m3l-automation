/**
 * `internal/script/correlationId` — resolves the correlation id one script
 * run (or Lambda invocation) is carried out under, following ADR-0070's
 * four-tier precedence.
 *
 * Library-internal; never re-exported through a public barrel. Split out of
 * `core/script/M3LScript.ts` under ADR-0072's file-size ceiling — that file
 * is frozen at its baselined size and cannot absorb the environment tier —
 * following the established sibling precedent (`signalHandlers.ts`,
 * `presetDepth.ts`, `diagnostics.ts`). Extracting it also gives the
 * precedence chain a directly unit-testable home, independent of the
 * nine-stage pipeline that consumes it.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import process from "node:process";

import { isString } from "../../core/utils/guards.js";

/** The inputs {@link resolveRunCorrelationId} reads, in precedence order. */
export interface CorrelationIdSources {
  /** `M3LScriptOptions.correlationId`, fixed for the script's lifetime. */
  readonly configured?: string | undefined;
  /**
   * The per-invocation value: `M3LScriptRunOptions.correlationId` from
   * `run()`, or Lambda's `context.awsRequestId`. These are mutually
   * exclusive entry points, so they share one tier rather than competing.
   */
  readonly preferred?: string | undefined;
  /**
   * The environment map to read {@link M3L_CORRELATION_ID_ENV} from,
   * defaulting to `process.env`.
   *
   * This seam exists for the internal test — reading the real environment
   * would make the env-tier cases order-dependent against every other suite
   * in the run. It is not a caller-facing feature; production call sites
   * omit it, exactly as `internal/logging/resolveLogLevelFloor.ts` does.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Returns the first of `values` that is a non-empty string.
 *
 * Non-emptiness is `length > 0`, deliberately **not** `trim()`: that is the
 * rule `M3LScriptOptions.correlationId` has always applied, so a
 * whitespace-only id like `"   "` is used verbatim rather than falling
 * through. Changing that here would silently alter a shipped behaviour for
 * every tier at once.
 */
function firstNonEmpty(
  values: readonly (string | undefined)[],
): string | undefined {
  for (const value of values) {
    if (isString(value) && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resolves a run's correlation id under ADR-0070's precedence:
 *
 * 1. `M3LScriptOptions.correlationId` — the constructor value, when non-empty.
 * 2. `M3LScriptRunOptions.correlationId`, or Lambda's `context.awsRequestId`.
 * 3. The `M3L_CORRELATION_ID` environment variable.
 *
 * **Mirrored literal.** `packages/m3l-console-server/src/runs/executor.ts`
 * WRITES that exact variable onto a spawned run's environment. The two
 * copies are deliberate — neither package needs the other's compile-time
 * surface for a string — but each side carries a test that exercises the
 * literal verbatim (`tests/script-correlation.test.ts` here, the console
 * server's `tests/runs-executor.test.ts` there), so a rename on one side
 * fails loudly instead of silently breaking correlation across the process
 * boundary.
 * 4. A freshly generated `crypto.randomUUID()`.
 *
 * Environment sits BELOW both explicit values, matching this library's own
 * precedent that an explicit `--log-level` beats `M3L_LOG_LEVEL`: an
 * inherited environment is ambient context, and ambient context must never
 * override a value a caller wrote down. It sits ABOVE generation so a
 * spawned child process joins its parent's trace instead of starting a new
 * one — which is the whole point of the tier.
 *
 * @param sources - The three candidate tiers; every field is optional.
 * @returns A non-empty correlation id — always, never `undefined`.
 * @example
 * ```ts
 * import { resolveRunCorrelationId } from "../internal/script/correlationId.js";
 *
 * resolveRunCorrelationId({ preferred: "req-1", env: {} }); // "req-1"
 * ```
 */
export function resolveRunCorrelationId(sources: CorrelationIdSources): string {
  const env = sources.env ?? process.env;
  return (
    firstNonEmpty([
      sources.configured,
      sources.preferred,
      // Inline literal, not a hoisted `const`: this library writes every
      // env-var name inline (`env["M3L_LOG_LEVEL"]` in
      // `internal/logging/resolveLogLevelFloor.ts`), because `errors.test.ts`'s
      // source scan treats any `const NAME = "M3L_…"` as a declared error
      // code and fails on the drift.
      env["M3L_CORRELATION_ID"],
    ]) ?? randomUUID()
  );
}
