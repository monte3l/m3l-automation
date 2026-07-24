/**
 * `core/script/run-script` — the composition-root wrapper around
 * {@link M3LScript.run} (ADR-0035 phase 4a).
 *
 * @packageDocumentation
 */

import {
  M3L_EXIT_CODES,
  M3LRunReporter,
  mapErrorToExitCode,
} from "../diagnostics/index.js";
import type {
  M3LBreadcrumbTrail,
  M3LRunReportInput,
} from "../diagnostics/index.js";

import { logBestEffortDiagnostic } from "../../internal/script/diagnostics.js";
import { pushForcedSignalExitCode } from "../../internal/script/signalHandlers.js";

import { installProcessGuards, serializeError } from "./process-guards.js";
import type { M3LScript } from "./M3LScript.js";
import type { M3LScriptRunOptions } from "./M3LScriptOptions.js";

/**
 * Options accepted by {@link runScript}.
 *
 * Deliberately its own interface rather than `extends M3LScriptRunOptions`:
 * `runScript` only ever forwards `dryRun` to `script.run`, so an `extends`
 * relationship would silently inherit any future `M3LScriptRunOptions` field
 * into this type while the forwarding call below kept forwarding only
 * `dryRun` — reproducing the exact ADR-0035 phase-2 `wrapError` defect (a new
 * optional field accepted and silently dropped). The duplication is the
 * safer factoring.
 *
 * @example
 * ```ts
 * import type { M3LRunScriptOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LRunScriptOptions = { dryRun: true, report: false };
 * ```
 */
export interface M3LRunScriptOptions {
  /** Forwarded to `script.run(mainFn, { dryRun })`; defaults to `false`. */
  readonly dryRun?: boolean;
  /** Whether to best-effort persist an `M3LRunReport`; defaults to `true`. */
  readonly report?: boolean;
  /**
   * A breadcrumb trail whose `entries()` become the persisted report's
   * `timeline`. Narrowed to just the `entries` method this module actually
   * calls — a `Pick`, not the full `M3LBreadcrumbTrail` — mirroring
   * `M3LRunReporterOptions.paths`'s `Pick<M3LPathsPort, "getOutputDir">` in
   * `core/diagnostics/run-report.ts`.
   */
  readonly trail?: Pick<M3LBreadcrumbTrail, "entries">;
}

/**
 * Best-effort builds (via `buildInput`) and persists (via `reporter.persist`)
 * an `M3LRunReport`, absorbing any failure from EITHER step so it can never
 * lose the exit code `runScript` already resolved before calling this, and
 * never shadows the original error that triggered a failure report in the
 * first place.
 *
 * `buildInput` is a thunk, not an already-constructed `M3LRunReportInput`,
 * specifically so its evaluation — which can throw (e.g. a caller-supplied
 * `options.trail` whose `entries()` throws) — happens INSIDE this function's
 * own try/catch rather than as a synchronous argument-evaluation step at the
 * call site, which would throw before this function is even entered. Build
 * and persist failures are logged under distinct diagnostic labels
 * (`run-report-build-failed` / `run-report-persist-rejected`) so the two
 * cannot be confused when triaging a stderr diagnostic.
 *
 * `M3LRunReporter.persist` is documented never to reject, but the persist
 * call is wrapped anyway rather than relying on that alone — the same
 * defensive posture `M3LScript` itself applies to its own best-effort hook
 * invocations (`runOnErrorBestEffort`/`runCleanup`).
 */
async function persistBestEffort(
  reporter: M3LRunReporter,
  buildInput: () => M3LRunReportInput,
): Promise<void> {
  let input: M3LRunReportInput;
  try {
    input = buildInput();
  } catch (cause) {
    logBestEffortDiagnostic("run-report-build-failed", serializeError(cause));
    return;
  }

  try {
    await reporter.persist(input);
  } catch (cause) {
    logBestEffortDiagnostic(
      "run-report-persist-rejected",
      serializeError(cause),
    );
  }
}

/** The `timeline` entry, when a `trail` was supplied — omitted otherwise. */
function timelineEntry(
  trail: Pick<M3LBreadcrumbTrail, "entries"> | undefined,
): Pick<M3LRunReportInput, "timeline"> | Record<string, never> {
  return trail === undefined ? {} : { timeline: trail.entries() };
}

/**
 * The correlation-id sentinel embedded when `script.correlationId` is
 * `undefined` — the same sentinel this module uses for an unresolved failure
 * `stage` a few lines below. Never `""`: `M3LScriptOptions.correlationId`'s
 * TSDoc documents a blank string as meaning "omitted", and
 * `M3LScript.resolveCorrelationId` guards `length > 0` twice, so writing `""`
 * into a persisted report would launder the one value this module elsewhere
 * treats as absence. In practice this sentinel is unreachable — `run`/
 * `runPipeline` resolves the correlation id before any stage can throw or
 * complete — but it exists so an unresolved id is never silently mistaken for
 * a deliberately-blank one.
 */
const UNRESOLVED_CORRELATION_ID = "unknown";

/** Builds the persisted report input for a successful (or dry-run) outcome. */
function buildSuccessInput(
  script: M3LScript,
  startedAt: Date,
  options: M3LRunScriptOptions | undefined,
): M3LRunReportInput {
  const dryRun = options?.dryRun ?? false;
  // A dry run skips stage 9 (file archival) entirely, so `getLastArchiveReport()`
  // — never reset per run — would otherwise still return a PRIOR real run's
  // archive manifest on an instance that already ran once. Omit `archive`
  // entirely for a dry run rather than embedding stale data.
  const archive = dryRun ? undefined : script.getLastArchiveReport();
  return {
    script: script.metadata,
    correlationId: script.correlationId ?? UNRESOLVED_CORRELATION_ID,
    startedAt,
    outcome: dryRun ? "dry-run" : "success",
    ...timelineEntry(options?.trail),
    ...(archive !== undefined && { archive }),
  };
}

/** Builds the persisted report input for a failed outcome. */
function buildFailureInput(
  script: M3LScript,
  startedAt: Date,
  options: M3LRunScriptOptions | undefined,
  error: unknown,
): M3LRunReportInput {
  return {
    script: script.metadata,
    correlationId: script.correlationId ?? UNRESOLVED_CORRELATION_ID,
    startedAt,
    outcome: "failure",
    stage: script.getLastFailureStage() ?? "unknown",
    error,
    ...timelineEntry(options?.trail),
  };
}

/**
 * Runs `script` through {@link M3LScript.run}, wrapping it with the
 * process-level composition-root behavior every automation script and Lambda
 * handler needs: installing the process guards, forcing the second-signal
 * exit code to {@link M3L_EXIT_CODES.INTERRUPTED} for the duration of the
 * run, best-effort persisting an end-of-run `M3LRunReport`, and mapping any
 * failure to a `process.exitCode` — all without ever re-throwing or calling
 * `process.exit()` itself.
 *
 * On failure, the error is routed to `script.logger.errorFrom` (which never
 * throws) and then absorbed — deliberately **not** re-thrown. Re-throwing
 * here would let the rejection escape as an unhandled promise rejection, and
 * Node then prints the raw stack and exits with code `1` regardless of
 * whatever `process.exitCode` this function already set, defeating the whole
 * point of the exit-code registry this phase exists to deliver. The error is
 * not lost: it is logged via `errorFrom` and (best-effort) embedded in the
 * persisted failure report.
 *
 * The forced second-signal exit code ({@link M3L_EXIT_CODES.INTERRUPTED}) is
 * scoped to the duration of this call via
 * `internal/script/signalHandlers`'s depth-aware
 * `pushForcedSignalExitCode`/release pair, not a plain capture-then-restore:
 * the baseline is captured only on the OUTERMOST in-flight `runScript` call
 * and restored only once every overlapping/nested `runScript` call in the
 * same process has released. This composes correctly for nested calls (a
 * `runScript` invoked from inside another's `mainFn`) and for genuinely
 * overlapping calls (two `runScript(...)` promises in flight at once,
 * `await`ed via `Promise.all` or otherwise un-awaited) — in both cases the
 * override observed by a shutdown handler always reflects the innermost
 * still-running call, and the pre-existing value is restored exactly once,
 * when the last of them settles. A bare `M3LScript.run()` elsewhere in the
 * same process, entirely outside any `runScript` call, is never affected by
 * an override that outlived its run.
 *
 * @param script - The configured `M3LScript` to run.
 * @param mainFn - The user function to run at stage 7 of the pipeline.
 * @param options - Optional `dryRun`/`report`/`trail` overrides.
 * @returns A promise that always resolves, never rejects.
 *
 * @example
 * ```ts
 * import { M3LScript, runScript } from "@m3l-automation/m3l-common/core";
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * const script = new M3LScript({
 *   metadata: { name: "import-users", version: "1.0.0" },
 * });
 *
 * await runScript(script, async () => {
 *   const shouldFail = false;
 *   if (shouldFail) {
 *     throw new M3LError("import failed", { code: "ERR_CONFIG_MISSING" });
 *   }
 * });
 * // process.exitCode is now set on failure; runScript itself never throws.
 * ```
 */
export async function runScript(
  script: M3LScript,
  mainFn: () => void | Promise<void>,
  options?: M3LRunScriptOptions,
): Promise<void> {
  installProcessGuards();

  // Scoped to this call via a depth-aware push/release (see this function's
  // own TSDoc): correct even under nested/overlapping `runScript` calls in
  // the same process, unlike a plain capture-then-restore around the two
  // signal-handler functions, which corrupts state under overlap.
  const releaseForcedSignalExitCode = pushForcedSignalExitCode(
    M3L_EXIT_CODES.INTERRUPTED,
  );

  const shouldReport = options?.report !== false;
  const startedAt = new Date();
  const reporter = shouldReport
    ? new M3LRunReporter({ paths: script.paths })
    : undefined;

  // Every field of `M3LScriptRunOptions` is forwarded explicitly via a
  // `Required<M3LScriptRunOptions>` literal rather than a hand-picked subset
  // (`{ dryRun: ... }`) — if `M3LScriptRunOptions` gains a second optional
  // field, this literal fails to compile instead of silently dropping it
  // (the ADR-0035 phase-2 `wrapError` defect this guards against).
  const runOptions: Required<M3LScriptRunOptions> = {
    dryRun: options?.dryRun ?? false,
  };

  try {
    await script.run(mainFn, runOptions);

    if (reporter !== undefined) {
      // `script.runStartedAt` is co-located with stage-9 archival's own
      // per-run directory (both derive their directory name from the same
      // timestamp via `runDirectoryName`, ADR-0035 phase 5 A5 part 1) — this
      // wrapper's own `startedAt` (captured above, before `script.run` even
      // began) is only a defensive fallback for the fresh-script case where
      // `runPipeline` never got a chance to set it.
      const reportStartedAt = script.runStartedAt ?? startedAt;
      await persistBestEffort(reporter, () =>
        buildSuccessInput(script, reportStartedAt, options),
      );
    }
  } catch (error) {
    script.logger.errorFrom(error);
    // Assigned immediately after `errorFrom` and BEFORE any report
    // construction/persistence below — `mapErrorToExitCode` needs only
    // `error`, so nothing is lost by resolving it first. This guarantees the
    // exit code is set even if building or persisting the failure report
    // itself throws (e.g. a hostile `options.trail.entries()`), since
    // `persistBestEffort` already isolates that failure on its own but this
    // removes any dependency on it doing so.
    process.exitCode = mapErrorToExitCode(error);

    if (reporter !== undefined) {
      // See the success branch above: prefer the script's own per-run
      // timestamp so the failure report lands in the same per-run directory
      // stage-9 archival (if it ran before failing) used.
      const reportStartedAt = script.runStartedAt ?? startedAt;
      await persistBestEffort(reporter, () =>
        buildFailureInput(script, reportStartedAt, options, error),
      );
    }
  } finally {
    releaseForcedSignalExitCode();
  }
}
