/**
 * `session-artifact-retention` — {@link pruneSessionArtifacts}, the X8
 * session-artifact retention-policy driver (ADR-0070 slice 5b-ii).
 *
 * This module is deliberately zone-free: it sits directly under `src/`,
 * like `main.ts`, `telemetry-retention.ts`, and its own sibling
 * `run-output-retention.ts`, rather than inside any `CONSOLE_SERVER_LAYERS`
 * zone directory (`bin/check-eslint-zones.mjs`), because it needs to import
 * from both `config/` (the resolved retention policy) and `store/` (the
 * sessions repository it consults) — an import combination no single zone
 * directory is allowed to make.
 *
 * **The layout is two levels deep**: `<artifactRoot>/<sessionId>/<stepId>.json`
 * (`sessions/artifacts.ts` writes it; `sessions/service.ts` passes
 * `step.sessionId` and `step.id`). This walks session directories, then the
 * `.json` files within each — one level deeper than `run-output-retention.ts`'s
 * `pruneRunOutputs`, which walks a single level.
 *
 * **A step's completion is `endedAtMs` being set, not a terminal status.**
 * `pruneRunOutputs` classifies liveness via `isTerminalRunStatus(record.status)`
 * because a run's own status is the authority on whether it is still live.
 * `M3LSessionStepRecord` carries no equivalent for this purpose:
 * `endedAtMs: number | undefined` is set only once, when `finishStep` writes
 * a terminal outcome (`store/sessions-repository-types.ts`), so it alone
 * tells this sweep whether a step has finished.
 *
 * **This module schedules nothing.** ADR-0070 requires "an operator-run
 * cleanup command — never silent deletion": there is no timer, no interval,
 * and no call site in `main.ts`/`startConsole` here. The only caller is the
 * operator cleanup subcommand (a later slice) — invoking this on demand is
 * the entire point.
 *
 * @packageDocumentation
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_INVALID_CODE } from "./config/settings.js";
import { M3LConsoleError } from "./errors/console-error.js";
import { errnoCodeOf } from "./errors/errno.js";
import type { M3LConsoleSessionsRepository } from "./store/sessions-repository-types.js";

/**
 * One session-artifact file that failed to delete during a
 * {@link pruneSessionArtifacts} walk, as published in a thrown error's
 * `context.failures` — the session id, the step id, and the errno code
 * only, never the absolute path. `ERR_CONSOLE_INTERNAL` maps to a 500 whose
 * context can be logged, and the filesystem layout is not something an
 * error surface should publish.
 *
 * @example
 * ```ts
 * const failure: SessionArtifactPruneFailure = {
 *   sessionId: "session-1",
 *   stepId: "step-1",
 *   code: "EACCES",
 * };
 * ```
 */
interface SessionArtifactPruneFailure {
  /** The session id (the parent directory's basename) the failing file belongs to. */
  readonly sessionId: string;
  /** The step id (the failing file's basename, minus `.json`). */
  readonly stepId: string;
  /** The failing `unlink` call's errno code, or `undefined` if it had none. */
  readonly code: string | undefined;
}

/**
 * One accumulated deletion failure, paired internally with the original
 * caught value so the thrown {@link M3LConsoleError}'s `cause` can chain the
 * FIRST failure's original error unchanged (by identity) while
 * `context.failures` publishes only the narrow
 * {@link SessionArtifactPruneFailure} shape for every failure.
 */
interface AccumulatedFailure {
  readonly published: SessionArtifactPruneFailure;
  readonly cause: unknown;
}

/**
 * The result of one {@link pruneSessionArtifacts} run: every artifact file
 * lands in exactly one of these four buckets, and `rootExisted` separately
 * reports whether `artifactRoot` itself was present.
 *
 * `rootExisted` is deliberately NOT derivable from the four bucket counters
 * — an `ENOENT` root and a present-but-empty root both produce all-zero
 * counts, so without this field the two are byte-identical and a typo'd or
 * unmounted artifact root reports "nothing to sweep" forever.
 *
 * @example
 * ```ts
 * function describe(outcome: M3LSessionArtifactPruneOutcome): string {
 *   if (!outcome.rootExisted) return "session artifact root is missing";
 *   return `deleted ${String(outcome.deleted)} of ${String(outcome.deleted + outcome.retainedLive + outcome.retainedYoung + outcome.orphaned)}`;
 * }
 * ```
 */
export interface M3LSessionArtifactPruneOutcome {
  /** Artifact files removed. */
  readonly deleted: number;
  /** Skipped: the step record exists and has not ended yet (`endedAtMs` is `undefined`). */
  readonly retainedLive: number;
  /** Skipped: ended, but inside the retention window. */
  readonly retainedYoung: number;
  /** Skipped: no step record found for the file's step id. */
  readonly orphaned: number;
  /**
   * `false` only when the `readdir` on `artifactRoot` failed with `ENOENT`;
   * `true` in every other case, including a present root with no entries at
   * all. This is the discriminator between "the root is missing" (a
   * misconfigured or unmounted `M3L_CONSOLE_SESSIONS_ARTIFACT_ROOT` — an
   * operator needs to know) and "the root is empty" (nothing to sweep yet —
   * routine, expected before any step has produced an artifact).
   */
  readonly rootExisted: boolean;
}

/**
 * Options for {@link pruneSessionArtifacts}.
 *
 * @example
 * ```ts
 * const options: PruneSessionArtifactsOptions = {
 *   artifactRoot: "/var/lib/m3l/console/sessions",
 *   repository,
 *   retentionMs: 7_776_000_000,
 * };
 * ```
 */
export interface PruneSessionArtifactsOptions {
  /** The root directory whose immediate subdirectories are session directories. */
  readonly artifactRoot: string;
  /** The sessions registry consulted to classify each artifact file. */
  readonly repository: M3LConsoleSessionsRepository;
  /** The resolved retention window, in milliseconds (see `config/retention.ts`). */
  readonly retentionMs: number;
  /** Clock seam; defaults to `Date.now`. */
  readonly nowMs?: () => number;
}

/** The mutable counters {@link pruneSessionArtifacts} accumulates across one walk. */
interface MutableOutcome {
  deleted: number;
  retainedLive: number;
  retainedYoung: number;
  orphaned: number;
}

/**
 * One artifact file's classification result: either the bucket it landed in
 * (matching one of {@link M3LSessionArtifactPruneOutcome}'s four fields), or
 * a failed deletion attempt. Returned rather than accumulated via a mutated
 * parameter, so {@link classifyAndSweep} never reassigns a caller's object —
 * the caller ({@link pruneSessionArtifacts}) owns the running counters and
 * applies exactly one bucket increment (or records exactly one failure) per
 * result.
 */
type ClassifyResult =
  | {
      readonly bucket:
        "deleted" | "retainedLive" | "retainedYoung" | "orphaned";
    }
  | { readonly bucket: "failed"; readonly failure: AccumulatedFailure };

/**
 * Validates `options.retentionMs` before {@link pruneSessionArtifacts} touches
 * the filesystem, against the exact predicate `config/retention.ts` enforces
 * at boot for the same window (`m3l.console.sessions.artifact.retention.ms`)
 * — deliberately duplicated here rather than imported, because
 * `pruneSessionArtifacts` is a public function a caller can invoke with a
 * hand-built `retentionMs` that never passed through `loadRetentionConfig`
 * (X8 slice 5c's operator CLI subcommand is exactly such a caller, and
 * `Number("30d")` is `NaN`). The retention window is the ONLY thing bounding
 * a file deletion: with a `NaN` on the right-hand side,
 * `endedAtMs >= nowMs - retentionMs` is always `false`, so every completed
 * step falls through to deletion; a negative value puts the cutoff in the
 * future, so every completed step is "old enough" immediately.
 */
function validateRetentionMs(retentionMs: number): void {
  if (!Number.isInteger(retentionMs) || retentionMs < 1) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      "'retentionMs' must be an integer of at least 1",
      { context: { retentionMs } },
    );
  }
}

/**
 * Validates the value returned by the resolved `nowMs()` clock, read once at
 * the top of {@link pruneSessionArtifacts} before any file is classified. A
 * `NaN` clock reading has the same effect as an invalid `retentionMs`: the
 * eligibility comparison `endedAtMs >= nowMs - retentionMs` becomes `false`
 * for every completed step, so a broken clock silently turns a bounded
 * sweep into an unconditional one.
 */
function validateNowMs(now: number): void {
  if (!Number.isFinite(now)) {
    throw new M3LConsoleError(
      CONFIG_INVALID_CODE,
      "the resolved 'nowMs()' clock reading must be a finite number",
      { context: { now } },
    );
  }
}

/**
 * Classifies one artifact file against its step record (if any) and, when
 * eligible, attempts its deletion.
 *
 * A per-file `unlink` failure is deliberately captured and returned rather
 * than thrown — {@link pruneSessionArtifacts} is the layer that decides the
 * walk must continue past one failure, so this helper only reports it.
 */
async function classifyAndSweep(
  sessionId: string,
  stepId: string,
  filePath: string,
  repository: M3LConsoleSessionsRepository,
  retentionMs: number,
  nowMs: number,
): Promise<ClassifyResult> {
  const step = repository.getStep(stepId);
  if (step === undefined) {
    // No step record at all: unexplained state relative to what
    // `sessions/artifacts.ts` writes. A sweep that silently eats
    // unexplained state is the wrong default under "never silent
    // deletion" — report it, leave the bytes.
    return { bucket: "orphaned" };
  }
  if (step.endedAtMs === undefined) {
    // The step has not finished yet: never delete a live step's artifact.
    return { bucket: "retainedLive" };
  }
  if (step.endedAtMs >= nowMs - retentionMs) {
    return { bucket: "retainedYoung" };
  }

  try {
    await unlink(filePath);
    return { bucket: "deleted" };
  } catch (cause) {
    return {
      bucket: "failed",
      failure: {
        published: { sessionId, stepId, code: errnoCodeOf(cause) },
        cause,
      },
    };
  }
}

/** Sorts directory entries by name — see {@link pruneSessionArtifacts}'s own doc for why. */
function sortByName<T extends { readonly name: string }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * Walks every session directory under `artifactRoot`'s already-`readdir`'d
 * `rootEntries`, aggregating bucket counts and failures across all of them.
 * Split out of {@link pruneSessionArtifacts} purely to keep that function's
 * cyclomatic complexity under the project's lint ceiling — this holds no
 * independent design rationale beyond that.
 */
async function walkSessionDirectories(
  artifactRoot: string,
  rootEntries: readonly { readonly name: string; isDirectory(): boolean }[],
  repository: M3LConsoleSessionsRepository,
  retentionMs: number,
  nowMs: number,
): Promise<{ outcome: MutableOutcome; failures: AccumulatedFailure[] }> {
  const outcome: MutableOutcome = {
    deleted: 0,
    retainedLive: 0,
    retainedYoung: 0,
    orphaned: 0,
  };
  const failures: AccumulatedFailure[] = [];

  for (const sessionEntry of sortByName(rootEntries)) {
    if (!sessionEntry.isDirectory()) {
      continue;
    }
    const results = await sweepSessionDirectory(
      sessionEntry.name,
      join(artifactRoot, sessionEntry.name),
      repository,
      retentionMs,
      nowMs,
    );
    for (const result of results) {
      if (result.bucket === "failed") {
        failures.push(result.failure);
      } else {
        outcome[result.bucket] += 1;
      }
    }
  }

  return { outcome, failures };
}

/**
 * Walks one session directory's `.json` files, classifying and sweeping
 * each, and returns one {@link ClassifyResult} per file. Returned rather
 * than accumulated via mutated parameters — see {@link ClassifyResult}'s own
 * doc for why the caller ({@link pruneSessionArtifacts}) owns the running
 * counters and failures list.
 *
 * A per-session `readdir` failure is not tolerated the way the root's is,
 * so it always propagates — a session directory that exists (it was listed
 * by the root walk) but cannot be read is unexplained state at least as
 * surprising as a per-file `unlink` failure, and unlike that failure it
 * would otherwise silently skip every step inside it.
 */
async function sweepSessionDirectory(
  sessionId: string,
  sessionDirPath: string,
  repository: M3LConsoleSessionsRepository,
  retentionMs: number,
  nowMs: number,
): Promise<ClassifyResult[]> {
  const fileEntries = await readdir(sessionDirPath, { withFileTypes: true });
  const sortedFiles = sortByName(fileEntries);

  const results: ClassifyResult[] = [];
  for (const fileEntry of sortedFiles) {
    if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) {
      continue;
    }
    const stepId = fileEntry.name.slice(0, -".json".length);
    results.push(
      await classifyAndSweep(
        sessionId,
        stepId,
        join(sessionDirPath, fileEntry.name),
        repository,
        retentionMs,
        nowMs,
      ),
    );
  }
  return results;
}

/**
 * Walks `options.artifactRoot`'s two-level layout
 * (`<artifactRoot>/<sessionId>/<stepId>.json`), classifies each artifact
 * file against `options.repository`, and deletes those whose step finished
 * outside the retention window.
 *
 * **A missing root is a zero outcome with `rootExisted: false`, not an
 * error.** No root means no session artifacts exist yet — an operator
 * sweeping before any step has produced one is normal. Every other
 * `readdir` errno propagates unchanged. `rootExisted` is what distinguishes
 * this from a present, merely empty root — otherwise the two produce
 * byte-identical all-zero bucket counts.
 *
 * **Symlinks are never followed.** Only entries where `dirent.isDirectory()`
 * is `true` are considered session directories, and only entries where
 * `dirent.isFile()` is `true` are considered artifact files; `withFileTypes`
 * reports `isSymbolicLink()` separately and does not follow it, so a
 * symlink planted at either level is skipped rather than recursed through.
 *
 * **Classification is total and orphans are never deleted.** Every artifact
 * file lands in exactly one of {@link M3LSessionArtifactPruneOutcome}'s four
 * buckets: no step record is `orphaned`; a step whose `endedAtMs` is
 * `undefined` (not yet finished) is `retainedLive`; a finished step whose
 * `endedAtMs` is still inside the window (`endedAtMs >= nowMs - retentionMs`,
 * a strict boundary) is `retainedYoung`; otherwise the file is deleted.
 *
 * **An emptied session directory is left in place.** Removing it would be a
 * second kind of deletion with its own race (a concurrent step could be
 * writing into it), and an empty directory costs an inode.
 *
 * **Determinism:** both the session directories and the files within each
 * are sorted by name before walking — an operator-run sweep must be
 * reproducible, and without a defined order the "one failure does not abort
 * the walk" guarantee is not verifiable.
 *
 * **A per-file `unlink` failure does not abort the walk.** An operator
 * sweeping hundreds of artifacts should not lose the whole sweep to one
 * `EACCES`. Failures are accumulated and, once the full walk completes, if
 * any occurred, this function throws an {@link M3LConsoleError} with code
 * `"ERR_CONSOLE_INTERNAL"`, chaining the first failure as `cause` (by
 * identity) and carrying `context.outcome` (the counts actually achieved —
 * a failed deletion is never counted as `deleted`) and `context.failures`
 * (each entry's session id, step id, and errno code only, never the
 * absolute path — the filesystem layout is not something an error surface
 * should publish).
 *
 * **`retentionMs` and the resolved `nowMs()` are validated before any
 * filesystem access.** `retentionMs` must be a finite integer of at least 1
 * — the same predicate `config/retention.ts` enforces at boot — and the
 * value `nowMs()` returns must be a finite number, read once and reused for
 * the whole walk. Either input feeds the eligibility comparison that is the
 * ONLY thing bounding a file deletion, so a `NaN`/negative/non-integer
 * `retentionMs` or a `NaN` clock reading is rejected loudly rather than
 * silently classifying every finished step as deletable.
 *
 * @param options - See {@link PruneSessionArtifactsOptions}.
 * @returns The {@link M3LSessionArtifactPruneOutcome}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_CONFIG_INVALID"`
 *   when `retentionMs` is not a finite integer of at least 1, or when the
 *   resolved `nowMs()` is not a finite number.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_INTERNAL"` when any
 *   artifact file's deletion fails, or when `readdir` fails for a reason
 *   other than a missing root.
 *
 * @example
 * ```ts
 * import { pruneSessionArtifacts } from "@m3l-automation/m3l-console-server/session-artifact-retention";
 *
 * const outcome = await pruneSessionArtifacts({
 *   artifactRoot: "/var/lib/m3l/console/sessions",
 *   repository,
 *   retentionMs: 7_776_000_000,
 * });
 * // { deleted: 12, retainedLive: 2, retainedYoung: 5, orphaned: 0, rootExisted: true }
 * ```
 */
export async function pruneSessionArtifacts(
  options: PruneSessionArtifactsOptions,
): Promise<M3LSessionArtifactPruneOutcome> {
  const { artifactRoot, repository, retentionMs, nowMs = Date.now } = options;

  validateRetentionMs(retentionMs);
  const now = nowMs();
  validateNowMs(now);

  const zeroOutcome: MutableOutcome = {
    deleted: 0,
    retainedLive: 0,
    retainedYoung: 0,
    orphaned: 0,
  };

  let rootEntries;
  try {
    rootEntries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (cause) {
    if (errnoCodeOf(cause) === "ENOENT") {
      return { ...zeroOutcome, rootExisted: false };
    }
    throw cause;
  }

  const { outcome, failures } = await walkSessionDirectories(
    artifactRoot,
    rootEntries,
    repository,
    retentionMs,
    now,
  );

  if (failures.length > 0) {
    const [firstFailure] = failures;
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `${String(failures.length)} session artifact${failures.length === 1 ? "" : "s"} failed to delete`,
      {
        cause: firstFailure?.cause,
        context: {
          // The walk reached this point only after a successful `readdir`
          // on the root, so the root necessarily existed.
          outcome: { ...outcome, rootExisted: true },
          failures: failures.map((failure) => failure.published),
        },
      },
    );
  }

  return { ...outcome, rootExisted: true };
}
