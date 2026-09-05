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

/** One driver's result: either a successful outcome or the caught failure. */
type DriverOk<T> = { readonly ok: true; readonly outcome: T };
type DriverFail = { readonly ok: false; readonly cause: unknown };
type DriverResult<T> = DriverOk<T> | DriverFail;

/**
 * Wraps a synchronous driver call into a {@link DriverResult}: captures any
 * throw rather than propagating it, so the caller ({@link runCleanup}) can
 * continue to the next driver regardless.
 */
function runSync<T>(fn: () => T): DriverResult<T> {
  try {
    return { ok: true, outcome: fn() };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * Wraps an asynchronous driver call into a {@link DriverResult}: captures
 * any rejection rather than propagating it, so the caller
 * ({@link runCleanup}) can continue to the next driver regardless.
 */
async function runAsync<T>(fn: () => Promise<T>): Promise<DriverResult<T>> {
  try {
    return { ok: true, outcome: await fn() };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * Given the three driver results, either returns the combined outcome (all
 * succeeded) or throws one {@link M3LConsoleError} carrying the first
 * failure as `cause` and every successful driver's outcome in `context`.
 *
 * Extracted from {@link runCleanup} to keep that function within the
 * project's cyclomatic-complexity limit — this helper holds all the
 * failure-path branching.
 *
 * **`context` never contains an absolute root path** — only the count/flag
 * objects the three retention drivers return, which carry no path strings.
 * The same discipline is documented in the sibling retention modules.
 */
function resolveCleanupOutcome(
  tResult: DriverResult<M3LTelemetryPruneOutcome>,
  rResult: DriverResult<M3LRunOutputPruneOutcome>,
  sResult: DriverResult<M3LSessionArtifactPruneOutcome>,
): M3LConsoleCleanupOutcome {
  if (!tResult.ok || !rResult.ok || !sResult.ok) {
    // First failure: whichever driver ran first and did not succeed.
    let firstFailureCause: unknown;
    if (!tResult.ok) firstFailureCause = tResult.cause;
    else if (!rResult.ok) firstFailureCause = rResult.cause;
    else if (!sResult.ok) firstFailureCause = sResult.cause;
    const context: Record<string, unknown> = {};
    if (tResult.ok) context["telemetry"] = tResult.outcome;
    if (rResult.ok) context["runOutputs"] = rResult.outcome;
    if (sResult.ok) context["sessionArtifacts"] = sResult.outcome;
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "one or more retention drivers failed during cleanup",
      { cause: firstFailureCause, context },
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
 *   one or more drivers fail; `context` carries the successful drivers'
 *   outcomes.
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
  let tResult: DriverResult<M3LTelemetryPruneOutcome>;
  let rResult: DriverResult<M3LRunOutputPruneOutcome>;
  let sResult: DriverResult<M3LSessionArtifactPruneOutcome>;

  try {
    tResult = runSync(() =>
      pruneTelemetry({
        repository: store.telemetry,
        retentionMs: telemetryConfig.retentionMs,
        nowMs,
      }),
    );
    rResult = await runAsync(() =>
      pruneRunOutputs({
        runsOutputRoot,
        repository: store.runs,
        retentionMs: retentionConfig.runOutputMs,
        nowMs,
      }),
    );
    sResult = await runAsync(() =>
      pruneSessionArtifacts({
        artifactRoot,
        repository: store.sessions,
        retentionMs: retentionConfig.artifactMs,
        nowMs,
      }),
    );
  } finally {
    // Best-effort: a failing close() must not mask the driver error above.
    try {
      store.close();
    } catch {
      /* ignore — the driver outcome above is what matters */
    }
  }

  return resolveCleanupOutcome(tResult, rResult, sResult);
}
