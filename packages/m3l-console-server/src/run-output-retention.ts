/**
 * `run-output-retention` — {@link pruneRunOutputs}, the X8 run-output
 * retention-policy driver (ADR-0070 slice 5b).
 *
 * This module is deliberately zone-free: it sits directly under `src/`,
 * like `main.ts`, `telemetry-recorder.ts`, and `telemetry-retention.ts`,
 * rather than inside any `CONSOLE_SERVER_LAYERS` zone directory
 * (`bin/check-eslint-zones.mjs`), because it needs to import from both
 * `config/` (the resolved retention policy) and `store/` (the run repository
 * it consults) — an import combination no single zone directory is allowed
 * to make (`config/`'s own zone forbids importing `store/`, and vice versa).
 *
 * **Run outputs only — never `sessions/`.** `sessions/artifacts.ts` has no
 * `ENOENT` branch anywhere: every read failure there raises
 * `ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT`, which `http/envelope.ts` maps to a
 * 500 fault under a comment saying it means the filesystem drifted from what
 * that module wrote. Sweeping a session artifact would make a routine,
 * policy-driven deletion report as a corruption fault. Run outputs have the
 * opposite property: `runs/report.ts` already branches on
 * `errnoCodeOf(cause) === "ENOENT"` and returns `undefined`, which the route
 * renders as the already-documented `ERR_CONSOLE_RUN_NOT_FOUND` 404 — so a
 * swept run-output directory degrades honestly with no change to the read
 * path. Session-artifact sweeping is a later slice's job (5b-ii).
 *
 * **This module schedules nothing.** ADR-0070 requires "an operator-run
 * cleanup command — never silent deletion": there is no timer, no interval,
 * and no call site in `main.ts`/`startConsole` here. The only caller is the
 * operator cleanup subcommand (a later slice) — invoking this on demand is
 * the entire point.
 *
 * @packageDocumentation
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { M3LConsoleError } from "./errors/console-error.js";
import { errnoCodeOf } from "./errors/errno.js";
import type { AccumulatedFailure, MutableOutcome } from "./retention-walk.js";
import {
  readdirRoot,
  sortByName,
  validateNowMs,
  validateRetentionMs,
} from "./retention-walk.js";
import { isTerminalRunStatus } from "./store/run-status.js";
import type { M3LConsoleRunsRepository } from "./store/runs-repository.js";

/**
 * One run-output directory that failed to delete during a
 * {@link pruneRunOutputs} walk, as published in a thrown error's
 * `context.failures` — the run id and the errno code only, never the
 * absolute path. `ERR_CONSOLE_INTERNAL` maps to a 500 whose context can be
 * logged, and the filesystem layout is not something an error surface
 * should publish.
 *
 * @example
 * ```ts
 * const failure: RunOutputPruneFailure = { runId: "run-1", code: "EACCES" };
 * ```
 */
interface RunOutputPruneFailure {
  /** The run id (the directory's basename) whose deletion failed. */
  readonly runId: string;
  /** The failing `rm` call's errno code, or `undefined` if it had none. */
  readonly code: string | undefined;
}

/**
 * One accumulated deletion failure for {@link pruneRunOutputs}: pairs the
 * original caught value (for chaining as `cause`) with the narrow
 * {@link RunOutputPruneFailure} shape published in `context.failures`.
 * Uses {@link "./retention-walk.js".AccumulatedFailure} as its shared base.
 */
type RunAccumulatedFailure = AccumulatedFailure<RunOutputPruneFailure>;

/**
 * The result of one {@link pruneRunOutputs} run: every swept directory
 * lands in exactly one of these four buckets, and `rootExisted` separately
 * reports whether `runsOutputRoot` itself was present.
 *
 * `rootExisted` is deliberately NOT derivable from the four bucket counters
 * — an `ENOENT` root and a present-but-empty root both produce all-zero
 * counts, so without this field the two are byte-identical and a typo'd or
 * unmounted output root reports "nothing to sweep" forever. Keep the bucket
 * union in {@link ClassifyResult} explicit rather than deriving it from
 * `keyof M3LRunOutputPruneOutcome`: this type's fields are no longer all
 * bucket counters now that `rootExisted` is one of them.
 *
 * @example
 * ```ts
 * function describe(outcome: M3LRunOutputPruneOutcome): string {
 *   if (!outcome.rootExisted) return "runs output root is missing";
 *   return `deleted ${String(outcome.deleted)} of ${String(outcome.deleted + outcome.retainedLive + outcome.retainedYoung + outcome.orphaned)}`;
 * }
 * ```
 */
export interface M3LRunOutputPruneOutcome {
  /** Output directories removed. */
  readonly deleted: number;
  /** Skipped: the run record exists and is not in a terminal status. */
  readonly retainedLive: number;
  /** Skipped: terminal, but ended inside the retention window. */
  readonly retainedYoung: number;
  /** Skipped: no run record, or terminal with no `endedAtMs`. */
  readonly orphaned: number;
  /**
   * `false` only when the `readdir` on `runsOutputRoot` failed with
   * `ENOENT`; `true` in every other case, including a present root with no
   * entries at all. This is the discriminator between "the root is missing"
   * (a misconfigured or unmounted `M3L_CONSOLE_RUNS_OUTPUT_ROOT` — an
   * operator needs to know) and "the root is empty" (nothing to sweep yet —
   * routine, expected before any run has executed).
   */
  readonly rootExisted: boolean;
}

/**
 * Options for {@link pruneRunOutputs}.
 *
 * @example
 * ```ts
 * const options: PruneRunOutputsOptions = {
 *   runsOutputRoot: "/var/lib/m3l/console/runs",
 *   repository,
 *   retentionMs: 2_592_000_000,
 * };
 * ```
 */
export interface PruneRunOutputsOptions {
  /** The root directory whose immediate subdirectories are run outputs. */
  readonly runsOutputRoot: string;
  /** The run registry consulted to classify each directory. */
  readonly repository: M3LConsoleRunsRepository;
  /** The resolved retention window, in milliseconds (see `config/retention.ts`). */
  readonly retentionMs: number;
  /** Clock seam; defaults to `Date.now`. */
  readonly nowMs?: () => number;
}

/**
 * One directory's classification result: either the bucket it landed in
 * (matching one of {@link M3LRunOutputPruneOutcome}'s four fields), or a
 * failed deletion attempt. Returned rather than accumulated via a mutated
 * parameter, so {@link classifyAndSweep} never reassigns a caller's object —
 * the caller ({@link pruneRunOutputs}) owns the running counters and applies
 * exactly one bucket increment (or records exactly one failure) per result.
 */
type ClassifyResult =
  | {
      readonly bucket:
        "deleted" | "retainedLive" | "retainedYoung" | "orphaned";
    }
  | { readonly bucket: "failed"; readonly failure: RunAccumulatedFailure };

/**
 * Classifies one run-output directory against its run record (if any) and,
 * when eligible, attempts its deletion.
 *
 * A per-directory `rm` failure is deliberately captured and returned rather
 * than thrown — {@link pruneRunOutputs} is the layer that decides the walk
 * must continue past one failure, so this helper only reports it.
 */
async function classifyAndSweep(
  dirName: string,
  dirPath: string,
  repository: M3LConsoleRunsRepository,
  retentionMs: number,
  nowMs: number,
): Promise<ClassifyResult> {
  const record = repository.get(dirName);
  if (record === undefined) {
    // No record at all: nothing in the console deletes a `console_runs`
    // row, so this is unexplained state. A sweep that silently eats
    // unexplained state is the wrong default under "never silent
    // deletion" — report it, leave the bytes.
    return { bucket: "orphaned" };
  }
  if (!isTerminalRunStatus(record.status)) {
    return { bucket: "retainedLive" };
  }
  if (record.endedAtMs === undefined) {
    // Terminal with no end timestamp is never deleted on a missing
    // timestamp — treated the same as no record at all.
    return { bucket: "orphaned" };
  }
  if (record.endedAtMs >= nowMs - retentionMs) {
    return { bucket: "retainedYoung" };
  }

  try {
    await rm(dirPath, { recursive: true, force: false });
    return { bucket: "deleted" };
  } catch (cause) {
    return {
      bucket: "failed",
      failure: {
        published: { runId: dirName, code: errnoCodeOf(cause) },
        cause,
      },
    };
  }
}

/**
 * Walks `options.runsOutputRoot`'s immediate subdirectories, classifies each
 * against `options.repository`, and deletes those whose run terminated
 * outside the retention window.
 *
 * **A missing root is a zero outcome with `rootExisted: false`, not an
 * error.** No root means no run outputs exist yet — an operator sweeping
 * before any run has executed is normal, and `runs/report.ts` already treats
 * a missing directory this way. Every other `readdir` errno propagates
 * unchanged. `rootExisted` is what distinguishes this from a present, merely
 * empty root — otherwise the two produce byte-identical all-zero bucket
 * counts, and a typo'd or unmounted `M3L_CONSOLE_RUNS_OUTPUT_ROOT` would
 * report "nothing to sweep" forever.
 *
 * **Symlinks are never followed.** Only entries where `dirent.isDirectory()`
 * is `true` are considered; `withFileTypes` reports `isSymbolicLink()`
 * separately and does not follow it, so a symlink planted in the root is
 * skipped rather than recursed through.
 *
 * **Classification is total and orphans are never deleted.** Every
 * subdirectory lands in exactly one of {@link M3LRunOutputPruneOutcome}'s
 * four buckets: no record, or a terminal record with no `endedAtMs`, is
 * `orphaned`; a non-terminal record (via `isTerminalRunStatus`, never a
 * hand-written status list) is `retainedLive`; a terminal record whose
 * `endedAtMs` is still inside the window (`endedAtMs >= nowMs - retentionMs`,
 * a strict boundary) is `retainedYoung`; otherwise the directory is deleted.
 *
 * **A per-directory `rm` failure does not abort the walk.** An operator
 * sweeping hundreds of directories should not lose the whole sweep to one
 * `EACCES`. Failures are accumulated and, once the full walk completes, if
 * any occurred, this function throws an {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_INTERNAL"`, chaining the first failure as `cause` (by
 * identity) and carrying `context.outcome` (the counts actually achieved —
 * a failed deletion is never counted as `deleted`) and
 * `context.failures` (each entry's run id and errno code only, never the
 * absolute path — the filesystem layout is not something an error surface
 * should publish).
 *
 * **`retentionMs` and the resolved `nowMs()` are validated before any
 * filesystem access.** `retentionMs` must be a finite integer of at least 1
 * — the same predicate `config/retention.ts` enforces at boot — and the
 * value `nowMs()` returns must be a finite number, read once and reused for
 * the whole walk (never re-read per directory, which would also make the
 * sweep non-atomic with respect to time). Either input feeds the
 * eligibility comparison that is the ONLY thing bounding a recursive `rm`,
 * so a `NaN`/negative/non-integer `retentionMs` or a `NaN` clock reading is
 * rejected loudly rather than silently classifying every terminal run as
 * deletable.
 *
 * @param options - See {@link PruneRunOutputsOptions}.
 * @returns The {@link M3LRunOutputPruneOutcome}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when `retentionMs` is not a finite integer of at least 1, or when the
 *   resolved `nowMs()` is not a finite number.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when any
 *   directory's deletion fails, or when `readdir` fails for a reason other
 *   than a missing root.
 *
 * @example
 * ```ts
 * import { pruneRunOutputs } from "@m3l-automation/m3l-console-server/run-output-retention";
 *
 * const outcome = await pruneRunOutputs({
 *   runsOutputRoot: "/var/lib/m3l/console/runs",
 *   repository,
 *   retentionMs: 2_592_000_000,
 * });
 * // { deleted: 12, retainedLive: 2, retainedYoung: 5, orphaned: 0, rootExisted: true }
 * ```
 */
export async function pruneRunOutputs(
  options: PruneRunOutputsOptions,
): Promise<M3LRunOutputPruneOutcome> {
  const { runsOutputRoot, repository, retentionMs, nowMs = Date.now } = options;

  validateRetentionMs(retentionMs);
  const now = nowMs();
  validateNowMs(now);

  const outcome: MutableOutcome = {
    deleted: 0,
    retainedLive: 0,
    retainedYoung: 0,
    orphaned: 0,
  };

  const rootResult = await readdirRoot(runsOutputRoot);
  if (!rootResult.present) {
    return { ...outcome, rootExisted: false };
  }

  const failures: RunAccumulatedFailure[] = [];

  // Sort by name before walking: `readdir` makes no ordering guarantee, and
  // without a deterministic order an operator-run sweep would not be
  // reproducible across invocations or filesystems. It also makes the
  // "a per-directory failure does not abort the walk" guarantee observable
  // at all — with an unordered walk, whether a later directory gets swept
  // after an earlier failure would depend on incidental filesystem
  // enumeration order rather than on this function's behavior.
  const sortedEntries = sortByName(rootResult.entries);

  for (const entry of sortedEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const result = await classifyAndSweep(
      entry.name,
      join(runsOutputRoot, entry.name),
      repository,
      retentionMs,
      now,
    );
    if (result.bucket === "failed") {
      failures.push(result.failure);
    } else {
      outcome[result.bucket] += 1;
    }
  }

  if (failures.length > 0) {
    const [firstFailure] = failures;
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `${String(failures.length)} run-output director${failures.length === 1 ? "y" : "ies"} failed to delete`,
      {
        cause: firstFailure?.cause,
        context: {
          // The walk reached this point only after a successful `readdir`,
          // so the root necessarily existed.
          outcome: { ...outcome, rootExisted: true },
          failures: failures.map((failure) => failure.published),
        },
      },
    );
  }

  return { ...outcome, rootExisted: true };
}
