/**
 * `cleanup` — {@link runCleanup}, the X8 operator-triggered retention sweep
 * (ADR-0070 slice 5c).
 *
 * Four sections run exactly once per invocation — {@link pruneTelemetry},
 * {@link pruneRunOutputs}, {@link pruneSessionArtifacts}, and
 * {@link reportAuditTrailUsage} — providing their only call sites in this
 * package. The first three are independent RETENTION drivers (they delete
 * expired data); the fourth is an OBSERVATION driver — it reports the
 * audit trail's segment count and byte size and deletes nothing at all (see
 * `audit-trail-usage.ts`'s own header for why). A failure in any one section
 * does not prevent the other three from running. See {@link runCleanup} for
 * the accumulate-continue-report contract.
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
import type { M3LConsoleTelemetryConfig } from "./config/telemetry.js";
import {
  resolveStoreDatabasePath,
  resolveRunsOutputRoot,
  resolveSessionArtifactRoot,
  resolveAuditStreamRoot,
} from "./config/paths.js";
import { openConsoleStore } from "./store/store.js";
import type { M3LConsoleStore, M3LConsoleStoreHandle } from "./store/store.js";
import { pruneTelemetry } from "./telemetry-retention.js";
import type { M3LTelemetryPruneOutcome } from "./telemetry-retention.js";
import { pruneRunOutputs } from "./run-output-retention.js";
import type { M3LRunOutputPruneOutcome } from "./run-output-retention.js";
import { pruneSessionArtifacts } from "./session-artifact-retention.js";
import type { M3LSessionArtifactPruneOutcome } from "./session-artifact-retention.js";
import { reportAuditTrailUsage } from "./audit-trail-usage.js";
import type { M3LAuditTrailUsageOutcome } from "./audit-trail-usage.js";

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
   * `M3L_CONSOLE_AUDIT_ROOT`, and every variable that
   * {@link loadRetentionConfig} and {@link loadTelemetryConfig} consume.
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
 *     `audit trail: ${String(outcome.auditTrail.segments)} segments observed`,
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
  /** The audit-trail usage OBSERVATION result — reports only, deletes nothing. */
  readonly auditTrail: M3LAuditTrailUsageOutcome;
}

/** The identity of one of the four cleanup-sweep sections (three retention drivers, one observation driver). */
type DriverName =
  "telemetry" | "runOutputs" | "sessionArtifacts" | "auditTrail";

/**
 * One driver's result: either a successful outcome or the caught failure.
 * Every result — success or failure — records its own `driver` identity, so
 * downstream logic can iterate over a set of results uniformly instead of
 * branching per driver.
 */
type DriverOk<T> = {
  readonly ok: true;
  readonly outcome: T;
  readonly driver: DriverName;
};
type DriverFail = {
  readonly ok: false;
  readonly cause: unknown;
  /** Which driver produced this failure, used to populate `context.failures`. */
  readonly driver: DriverName;
};
type DriverResult<T> = DriverOk<T> | DriverFail;

/** Every driver's result for one sweep, keyed by driver name. */
interface CleanupResults {
  readonly telemetry: DriverResult<M3LTelemetryPruneOutcome>;
  readonly runOutputs: DriverResult<M3LRunOutputPruneOutcome>;
  readonly sessionArtifacts: DriverResult<M3LSessionArtifactPruneOutcome>;
  readonly auditTrail: DriverResult<M3LAuditTrailUsageOutcome>;
}

/**
 * Every result in RUN order. The order is load-bearing: `firstCause` is the
 * first driver that ran and did not succeed, and `context.failures` is
 * published in the same order.
 *
 * This one record type plus one run-order accessor is what keeps a fourth
 * driver from tripping either of two lint ceilings: a per-driver `if`-chain
 * in {@link buildDriverFailureContext} would push its cyclomatic complexity
 * past the project's `complexity: 10` limit, and inlining the same
 * branching into `runCleanup` would push it past `max-lines-per-function`'s
 * 60-line ceiling. Do not "simplify" this back into parallel `if`/`else if`
 * chains — that is exactly the shape this exists to avoid.
 */
function inRunOrder(results: CleanupResults): readonly DriverResult<unknown>[] {
  return [
    results.telemetry,
    results.runOutputs,
    results.sessionArtifacts,
    results.auditTrail,
  ];
}

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
    return { ok: true, outcome: fn(), driver };
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
    return { ok: true, outcome: await fn(), driver };
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
function buildDriverFailureContext(results: CleanupResults): {
  readonly firstCause: unknown;
  readonly context: Record<string, unknown>;
} {
  const ordered = inRunOrder(results);
  const isFail = (result: DriverResult<unknown>): result is DriverFail =>
    !result.ok;
  const failures = ordered.filter(isFail);

  // firstCause — whichever driver ran first and did not succeed.
  const firstCause: unknown = failures[0]?.cause;

  // Successful drivers' outcomes — present so the caller knows what
  // completed. Keying off `result.driver` is safe: DriverName's three
  // values ("telemetry", "runOutputs", "sessionArtifacts") are exactly the
  // keys `M3LConsoleCleanupOutcome` and this context object already use.
  const context: Record<string, unknown> = {};
  for (const result of ordered) {
    if (result.ok) context[result.driver] = result.outcome;
  }

  // One entry per failed driver — a second simultaneous failure is never lost.
  context["failures"] = failures.map(toCleanupFailure);

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

/** `true` when any driver failed — the close-discipline discriminator. */
function anyDriverFailed(results: CleanupResults): boolean {
  return inRunOrder(results).some((result) => !result.ok);
}

/**
 * Given every driver's result, either returns the combined outcome (all
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
  results: CleanupResults,
): M3LConsoleCleanupOutcome {
  const { telemetry, runOutputs, sessionArtifacts, auditTrail } = results;
  // Inline guard, not a helper call: TypeScript needs each check literally
  // present here to narrow `telemetry`/`runOutputs`/`sessionArtifacts`/
  // `auditTrail` to `DriverOk` before `.outcome` is read below.
  if (
    !telemetry.ok ||
    !runOutputs.ok ||
    !sessionArtifacts.ok ||
    !auditTrail.ok
  ) {
    const { firstCause, context } = buildDriverFailureContext(results);
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "one or more retention drivers failed during cleanup",
      { cause: firstCause, context },
    );
  }
  return {
    telemetry: telemetry.outcome,
    runOutputs: runOutputs.outcome,
    sessionArtifacts: sessionArtifacts.outcome,
    auditTrail: auditTrail.outcome,
  };
}

/** The paths and retention windows {@link runCleanup} resolves before opening the store. */
interface ResolvedCleanupConfig {
  /** The console store's SQLite database file path. */
  readonly dbPath: string;
  /** The run-output directory retention driver sweeps under this root. */
  readonly runsOutputRoot: string;
  /** The session-artifact retention driver sweeps under this root. */
  readonly artifactRoot: string;
  /** The audit-trail usage OBSERVATION driver inventories segments under this root. */
  readonly auditRoot: string;
  /** Per-granularity-tier telemetry rollup retention windows, in milliseconds. */
  readonly telemetryRetentionMs: M3LConsoleTelemetryConfig["retentionMs"];
  /** The run-output directory retention window, in milliseconds. */
  readonly runOutputRetentionMs: number;
  /** The session-artifact file retention window, in milliseconds. */
  readonly artifactRetentionMs: number;
}

/**
 * Resolves every path and retention window {@link runCleanup} needs before it
 * opens the store, from `env`.
 *
 * Any failure here propagates directly to the caller: no partial sweep has
 * started yet, so there is nothing to accumulate. This surfaces as
 * {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"` — do not
 * wrap this call in a try/catch in {@link runCleanup}, that would turn a
 * configuration failure into a swallowed or misattributed one.
 *
 * The order these six values are resolved in is preserved exactly as it was
 * inline in `runCleanup` for the first five: retention config, telemetry
 * config, database path, run-outputs root, artifact root — then the audit
 * root last, so the existing config-failure ordering for the first five is
 * unchanged.
 */
function resolveCleanupConfig(env: NodeJS.ProcessEnv): ResolvedCleanupConfig {
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
  const auditRoot = resolveAuditStreamRoot({
    configuredPath: env["M3L_CONSOLE_AUDIT_ROOT"],
  });
  return {
    dbPath,
    runsOutputRoot,
    artifactRoot,
    auditRoot,
    telemetryRetentionMs: telemetryConfig.retentionMs,
    runOutputRetentionMs: retentionConfig.runOutputMs,
    artifactRetentionMs: retentionConfig.artifactMs,
  };
}

/**
 * Opens the console store once, sweeps four sections — the three retention
 * drivers {@link pruneTelemetry}, {@link pruneRunOutputs},
 * {@link pruneSessionArtifacts}, plus the fourth, observation-only
 * {@link reportAuditTrailUsage} — in sequence, and returns a combined
 * {@link M3LConsoleCleanupOutcome}.
 *
 * **The fourth section reports only and deletes nothing.** Unlike the three
 * retention drivers before it, `reportAuditTrailUsage` never deletes,
 * truncates, or creates anything — it only inventories the audit trail's
 * segment count and byte size (see `audit-trail-usage.ts`'s own header for
 * why).
 *
 * **A failing section does not prevent the other three from running.** The
 * four concerns are independent: a telemetry failure is no reason to skip
 * sweeping run outputs, and an audit-listing failure is no reason to skip
 * the other three either. All four always run; their failures are
 * accumulated and, if any occurred, a single {@link M3LConsoleError} with
 * code `"ERR_CONSOLE_INTERNAL"` is thrown AFTER all four have completed,
 * chaining the first section's thrown value as `cause` and carrying every
 * successful section's outcome in `context`. Aborting on the first failure
 * would discard work the earlier sections already completed — the exact
 * defect the review round caught in `pruneSessionArtifacts` (#1037's
 * per-session `readdir`), and it must not be reintroduced one layer up.
 *
 * **`context` never contains an absolute root path.** Only per-section
 * outcome objects (row/file/dir/segment counts and boolean flags) are stored
 * in `context` — the same discipline the sibling retention modules follow. A
 * chained `cause` may carry a path in its own `.message`; that is accepted
 * and documented in those modules.
 *
 * Roots are resolved through `config/paths.ts` from environment variables
 * (`M3L_CONSOLE_DB_PATH`, `M3L_CONSOLE_RUNS_OUTPUT_ROOT`,
 * `M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT`, `M3L_CONSOLE_AUDIT_ROOT`), defaulting
 * to the workspace-rooted defaults when not set. Roots are never accepted as
 * direct CLI flags.
 *
 * @param options - See {@link RunCleanupOptions}.
 * @returns The combined {@link M3LConsoleCleanupOutcome}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when
 *   one or more sections fail; `context.failures` lists each failed
 *   section's name and error code, and `context` also carries each
 *   successful section's outcome. When all four sections succeed but
 *   `store.close()` subsequently throws, this code is also raised with the
 *   close failure as `cause`.
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
 *   `deleted ${String(outcome.sessionArtifacts.deleted)} session artifacts, ` +
 *   `observed ${String(outcome.auditTrail.segments)} audit segments.`,
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
  const config = resolveCleanupConfig(env);

  // One store open serves the three retention drivers — `buildConsoleStoreUnit`
  // exposes `runs`, `sessions`, and `telemetry` off the same handle. The
  // fourth section (auditTrail) does not touch the store at all.
  const store = openStore(config.dbPath);

  // Run all four sections in sequence, capturing failures independently.
  // Sequence: telemetry (first) → runOutputs → sessionArtifacts → auditTrail
  // (last). The sequence is load-bearing for tests: the failing-driver test
  // makes TELEMETRY fail to prove the other three still run — if the test
  // failed the last section, nothing would be accumulated to lose.
  //
  // `closeBestEffort` starts `true` (conservative) and is set to `false`
  // only after all four sections complete successfully, enabling `closeStore`
  // to raise on a failing close rather than swallow it.
  let closeBestEffort = true;
  let results: CleanupResults;

  try {
    const telemetry = runSync("telemetry", () =>
      pruneTelemetry({
        repository: store.telemetry,
        retentionMs: config.telemetryRetentionMs,
        nowMs,
      }),
    );
    const runOutputs = await runAsync("runOutputs", () =>
      pruneRunOutputs({
        runsOutputRoot: config.runsOutputRoot,
        repository: store.runs,
        retentionMs: config.runOutputRetentionMs,
        nowMs,
      }),
    );
    const sessionArtifacts = await runAsync("sessionArtifacts", () =>
      pruneSessionArtifacts({
        artifactRoot: config.artifactRoot,
        repository: store.sessions,
        retentionMs: config.artifactRetentionMs,
        nowMs,
      }),
    );
    const auditTrail = await runAsync("auditTrail", () =>
      reportAuditTrailUsage({ auditRoot: config.auditRoot }),
    );
    results = { telemetry, runOutputs, sessionArtifacts, auditTrail };
    closeBestEffort = anyDriverFailed(results);
  } finally {
    closeStore(store, closeBestEffort);
  }

  return resolveCleanupOutcome(results);
}
