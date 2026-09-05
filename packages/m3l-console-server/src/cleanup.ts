/**
 * `cleanup` — {@link runCleanup}, the X8 operator-triggered retention sweep
 * (ADR-0070 slice 5c).
 *
 * Calls all three retention drivers exactly once per invocation —
 * {@link pruneTelemetry}, {@link pruneRunOutputs},
 * {@link pruneSessionArtifacts} — providing their only call sites in this
 * package. The drivers are independent concerns; a failure in one does not
 * prevent the other two from running. See {@link runCleanup} for the
 * accumulate-continue-report contract.
 *
 * This module schedules nothing. ADR-0070 requires "an operator-run cleanup
 * command — never silent deletion": the only caller is the `cleanup`
 * subcommand in `bin/m3l-console-server.mjs`.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "./errors/console-error.js";
import { errnoCodeOf } from "./errors/errno.js";
import { loadRetentionConfig } from "./config/retention.js";
import { loadTelemetryConfig } from "./config/telemetry.js";
import {
  resolveStoreDatabasePath,
  resolveRunsOutputRoot,
  resolveSessionArtifactRoot,
} from "./config/paths.js";
import { openConsoleStore } from "./store/store.js";
import type { M3LConsoleStore, M3LConsoleStoreHandle } from "./store/store.js";
import { pruneTelemetry } from "./telemetry-retention.js";
import type { M3LTelemetryPruneOutcome } from "./telemetry-retention.js";
import { pruneRunOutputs } from "./run-output-retention.js";
import type { M3LRunOutputPruneOutcome } from "./run-output-retention.js";
import { pruneSessionArtifacts } from "./session-artifact-retention.js";
import type { M3LSessionArtifactPruneOutcome } from "./session-artifact-retention.js";

/**
 * Options accepted by {@link runCleanup}.
 *
 * @example
 * ```ts
 * import { runCleanup } from "@m3l-automation/m3l-console-server/cleanup";
 *
 * const outcome = await runCleanup({
 *   env: process.env,
 *   nowMs: Date.now,
 * });
 * ```
 */
export interface RunCleanupOptions {
  /**
   * The environment-variable map to resolve paths and retention windows from;
   * defaults to `process.env`. Reads `M3L_CONSOLE_DB_PATH`,
   * `M3L_CONSOLE_RUNS_OUTPUT_ROOT`, `M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT`,
   * and every variable that {@link loadRetentionConfig} and
   * {@link loadTelemetryConfig} consume.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Test seam, mirroring `startConsole`'s own `openStore` (see `main.ts`).
   * Defaults to `(location) => openConsoleStore({ location })`.
   */
  readonly openStore?: (
    location: string,
  ) => M3LConsoleStore & M3LConsoleStoreHandle;
  /**
   * Clock seam forwarded to each retention driver; defaults to `Date.now`.
   * All three drivers share the same resolved value so the sweep is
   * effectively atomic with respect to time.
   */
  readonly nowMs?: () => number;
}

/**
 * The combined result of one {@link runCleanup} run: the outcome each
 * retention driver reported.
 *
 * @example
 * ```ts
 * function summarize(outcome: M3LConsoleCleanupOutcome): string {
 *   return [
 *     `telemetry: ${String(outcome.telemetry.total)} rows pruned`,
 *     `run outputs: ${String(outcome.runOutputs.deleted)} dirs deleted`,
 *     `session artifacts: ${String(outcome.sessionArtifacts.deleted)} files deleted`,
 *   ].join(", ");
 * }
 * ```
 */
export interface M3LConsoleCleanupOutcome {
  /** The telemetry-rollup retention sweep result. */
  readonly telemetry: M3LTelemetryPruneOutcome;
  /** The run-output directory retention sweep result. */
  readonly runOutputs: M3LRunOutputPruneOutcome;
  /** The session-artifact file retention sweep result. */
  readonly sessionArtifacts: M3LSessionArtifactPruneOutcome;
}

/** The identity of one of the three retention drivers. */
type DriverName = "telemetry" | "runOutputs" | "sessionArtifacts";

/** One driver's result: either a successful outcome or the caught failure. */
type DriverOk<T> = { readonly ok: true; readonly outcome: T };
type DriverFail = {
  readonly ok: false;
  readonly cause: unknown;
  /** Which driver produced this failure, used to populate `context.failures`. */
  readonly driver: DriverName;
};
type DriverResult<T> = DriverOk<T> | DriverFail;

/**
 * Narrow per-driver failure published in a thrown error's `context.failures`,
 * mirroring `AccumulatedFailure<T>` in `retention-walk.ts`. No absolute path
 * appears here — only the driver identity and the error code/errno extracted
 * from the caught value.
 */
interface CleanupDriverFailure {
  /** Which driver failed. */
  readonly driver: DriverName;
  /**
   * The failure's `M3LConsoleError` code, when the caught value is an
   * `M3LConsoleError`; `undefined` otherwise.
   */
  readonly code: string | undefined;
  /**
   * The failure's raw Node errno code (e.g. `"EACCES"`), extracted from the
   * caught value's own `code` property; `undefined` when not present.
   */
  readonly errno: string | undefined;
}

/**
 * Wraps a synchronous driver call into a {@link DriverResult}: captures any
 * throw rather than propagating it, so the caller ({@link runCleanup}) can
 * continue to the next driver regardless.
 */
function runSync<T>(driver: DriverName, fn: () => T): DriverResult<T> {
  try {
    return { ok: true, outcome: fn() };
  } catch (cause) {
    return { ok: false, cause, driver };
  }
}

/**
 * Wraps an asynchronous driver call into a {@link DriverResult}: captures
 * any rejection rather than propagating it, so the caller
 * ({@link runCleanup}) can continue to the next driver regardless.
 */
async function runAsync<T>(
  driver: DriverName,
  fn: () => Promise<T>,
): Promise<DriverResult<T>> {
  try {
    return { ok: true, outcome: await fn() };
  } catch (cause) {
    return { ok: false, cause, driver };
  }
}

/** Narrows one {@link DriverFail} into the published {@link CleanupDriverFailure} shape. */
function toCleanupFailure(result: DriverFail): CleanupDriverFailure {
  return {
    driver: result.driver,
    code:
      result.cause instanceof M3LConsoleError ? result.cause.code : undefined,
    errno: errnoCodeOf(result.cause),
  };
}

/**
 * Builds the `{ firstCause, context }` pair used by
 * {@link resolveCleanupOutcome} when at least one driver failed.
 *
 * `context` carries each successful driver's outcome PLUS `context.failures`
 * (one {@link CleanupDriverFailure} per failed driver, mirroring
 * `AccumulatedFailure<T>` in `retention-walk.ts`). No absolute path appears
 * in `context`; a chained `cause` may carry one in its own `.message`.
 */
function buildDriverFailureContext(
  tResult: DriverResult<M3LTelemetryPruneOutcome>,
  rResult: DriverResult<M3LRunOutputPruneOutcome>,
  sResult: DriverResult<M3LSessionArtifactPruneOutcome>,
): { readonly firstCause: unknown; readonly context: Record<string, unknown> } {
  // firstCause — whichever driver ran first and did not succeed.
  // if-else chain so each branch narrows the DriverResult to DriverFail
  // before accessing .cause, satisfying no-unsafe-assignment.
  let firstCause: unknown;
  if (!tResult.ok) firstCause = tResult.cause;
  else if (!rResult.ok) firstCause = rResult.cause;
  else if (!sResult.ok) firstCause = sResult.cause;

  // Successful drivers' outcomes — present so the caller knows what completed.
  const context: Record<string, unknown> = {};
  if (tResult.ok) context["telemetry"] = tResult.outcome;
  if (rResult.ok) context["runOutputs"] = rResult.outcome;
  if (sResult.ok) context["sessionArtifacts"] = sResult.outcome;

  // One entry per failed driver — a second simultaneous failure is never lost.
  const failures: CleanupDriverFailure[] = [];
  if (!tResult.ok) failures.push(toCleanupFailure(tResult));
  if (!rResult.ok) failures.push(toCleanupFailure(rResult));
  if (!sResult.ok) failures.push(toCleanupFailure(sResult));
  context["failures"] = failures;

  return { firstCause, context };
}

/**
 * Closes the store, applying the discipline determined by whether any driver
 * failed.
 *
 * - `bestEffort === true`: a close() failure is swallowed — the driver error
 *   that already occurred is the real signal, and a close() failure on top of
 *   it is noise.
 * - `bestEffort === false`: all three drivers succeeded, so a close() failure
 *   is a genuine fault the supervisor must see; it is raised as
 *   {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"`.
 *
 * Extracted from {@link runCleanup}'s `finally` block so that the conditional
 * throw lives in a plain function rather than directly in `finally`, avoiding
 * the `no-unsafe-finally` lint rule while preserving the same observable
 * behaviour. The rule targets `finally` control-flow that could mask the
 * original try-block exception; here the throw in the `!bestEffort` branch
 * can only run when all drivers succeeded — meaning there IS no try-block
 * exception to mask.
 */
function closeStore(
  store: M3LConsoleStore & M3LConsoleStoreHandle,
  bestEffort: boolean,
): void {
  if (bestEffort) {
    try {
      store.close();
    } catch {
      /* best-effort — the driver outcome above is what matters */
    }
  } else {
    try {
      store.close();
    } catch (cause) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        "store failed to close after a clean sweep",
        { cause },
      );
    }
  }
}

/**
 * Given the three driver results, either returns the combined outcome (all
 * succeeded) or throws one {@link M3LConsoleError} carrying the first
 * failure as `cause`, every successful driver's outcome in `context`, and
 * one {@link CleanupDriverFailure} entry per failed driver in
 * `context.failures`.
 *
 * Extracted from {@link runCleanup} to keep that function within the
 * project's cyclomatic-complexity limit.
 *
 * **`context` never contains an absolute root path** — only the count/flag
 * objects the three retention drivers return, which carry no path strings.
 * **`context.failures` mirrors `AccumulatedFailure<T>` in
 * `retention-walk.ts`**: a second simultaneous failure is never lost.
 */
function resolveCleanupOutcome(
  tResult: DriverResult<M3LTelemetryPruneOutcome>,
  rResult: DriverResult<M3LRunOutputPruneOutcome>,
  sResult: DriverResult<M3LSessionArtifactPruneOutcome>,
): M3LConsoleCleanupOutcome {
  if (!tResult.ok || !rResult.ok || !sResult.ok) {
    const { firstCause, context } = buildDriverFailureContext(
      tResult,
      rResult,
      sResult,
    );
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "one or more retention drivers failed during cleanup",
      { cause: firstCause, context },
    );
  }
  return {
    telemetry: tResult.outcome,
    runOutputs: rResult.outcome,
    sessionArtifacts: sResult.outcome,
  };
}

/**
 * Opens the console store once, sweeps all three retention drivers —
 * {@link pruneTelemetry}, {@link pruneRunOutputs},
 * {@link pruneSessionArtifacts} — in sequence, and returns a combined
 * {@link M3LConsoleCleanupOutcome}.
 *
 * **A failing driver does not prevent the other two from running.** The
 * three concerns are independent: a telemetry failure is no reason to skip
 * sweeping run outputs. All three always run; their failures are accumulated
 * and, if any occurred, a single {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_INTERNAL"` is thrown AFTER all three have completed, chaining
 * the first driver's thrown value as `cause` and carrying every successful
 * driver's outcome in `context`. Aborting on the first failure would discard
 * work the earlier drivers already completed — the exact defect the review
 * round caught in `pruneSessionArtifacts` (#1037's per-session `readdir`),
 * and it must not be reintroduced one layer up.
 *
 * **`context` never contains an absolute root path.** Only per-driver
 * outcome objects (row/file/dir counts and boolean flags) are stored in
 * `context` — the same discipline the sibling retention modules follow. A
 * chained `cause` may carry a path in its own `.message`; that is accepted
 * and documented in those modules.
 *
 * Roots are resolved through `config/paths.ts` from environment variables
 * (`M3L_CONSOLE_DB_PATH`, `M3L_CONSOLE_RUNS_OUTPUT_ROOT`,
 * `M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT`), defaulting to the workspace-rooted
 * defaults when not set. Roots are never accepted as direct CLI flags.
 *
 * @param options - See {@link RunCleanupOptions}.
 * @returns The combined {@link M3LConsoleCleanupOutcome}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when
 *   one or more drivers fail; `context.failures` lists each failed driver's
 *   name and error code, and `context` also carries each successful driver's
 *   outcome. When all three drivers succeed but `store.close()` subsequently
 *   throws, this code is also raised with the close failure as `cause`.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when configuration resolution itself fails (invalid retention window,
 *   bad path, unresolvable data directory).
 *
 * @example
 * ```ts
 * import { runCleanup } from "@m3l-automation/m3l-console-server/cleanup";
 *
 * const outcome = await runCleanup();
 * console.log(
 *   `Pruned ${String(outcome.telemetry.total)} telemetry rows, ` +
 *   `deleted ${String(outcome.runOutputs.deleted)} run-output dirs, ` +
 *   `deleted ${String(outcome.sessionArtifacts.deleted)} session artifacts.`,
 * );
 * ```
 */
export async function runCleanup(
  options: RunCleanupOptions = {},
): Promise<M3LConsoleCleanupOutcome> {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now;
  const openStore =
    options.openStore ??
    ((location: string): M3LConsoleStore & M3LConsoleStoreHandle =>
      openConsoleStore({ location }));

  // Config resolution — any failure here propagates directly; no partial
  // sweep has started yet, so there is nothing to accumulate.
  const retentionConfig = loadRetentionConfig({ env });
  const telemetryConfig = loadTelemetryConfig({ env });
  const dbPath = resolveStoreDatabasePath({
    configuredPath: env["M3L_CONSOLE_DB_PATH"],
  });
  const runsOutputRoot = resolveRunsOutputRoot({
    configuredPath: env["M3L_CONSOLE_RUNS_OUTPUT_ROOT"],
  });
  const artifactRoot = resolveSessionArtifactRoot({
    configuredPath: env["M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT"],
  });

  // One store open serves all three drivers — `buildConsoleStoreUnit` exposes
  // `runs`, `sessions`, and `telemetry` off the same handle.
  const store = openStore(dbPath);

  // Run all three drivers in sequence, capturing failures independently.
  // Sequence: telemetry (first) → runOutputs → sessionArtifacts.
  // The sequence is load-bearing for tests: the failing-driver test makes
  // TELEMETRY fail to prove the other two still run — if the test failed
  // the last driver, nothing would be accumulated to lose.
  //
  // `closeBestEffort` starts `true` (conservative) and is set to `false`
  // only after all three drivers complete successfully, enabling `closeStore`
  // to raise on a failing close rather than swallow it.
  let closeBestEffort = true;
  let tResult: DriverResult<M3LTelemetryPruneOutcome>;
  let rResult: DriverResult<M3LRunOutputPruneOutcome>;
  let sResult: DriverResult<M3LSessionArtifactPruneOutcome>;

  try {
    tResult = runSync("telemetry", () =>
      pruneTelemetry({
        repository: store.telemetry,
        retentionMs: telemetryConfig.retentionMs,
        nowMs,
      }),
    );
    rResult = await runAsync("runOutputs", () =>
      pruneRunOutputs({
        runsOutputRoot,
        repository: store.runs,
        retentionMs: retentionConfig.runOutputMs,
        nowMs,
      }),
    );
    sResult = await runAsync("sessionArtifacts", () =>
      pruneSessionArtifacts({
        artifactRoot,
        repository: store.sessions,
        retentionMs: retentionConfig.artifactMs,
        nowMs,
      }),
    );
    closeBestEffort = !tResult.ok || !rResult.ok || !sResult.ok;
  } finally {
    closeStore(store, closeBestEffort);
  }

  return resolveCleanupOutcome(tResult, rResult, sResult);
}
