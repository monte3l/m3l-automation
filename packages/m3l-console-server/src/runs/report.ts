/**
 * `runs/report` — `createRunReportReader`, the read side of X7d's run-report
 * addressing seam (ADR-0070): given a run id, finds and parses the
 * `run-report.json` the spawned child wrote under that run's own output
 * directory.
 *
 * **Why this exists at all.** `M3LRunReporter` writes to
 * `<outputDir>/<runDirectoryName(startedAt)>/run-report.json`, where
 * `startedAt` is the CHILD's own clock — a value the console never observes
 * and cannot reconstruct (its own `started_at_ms` is written by the
 * orchestrator around the spawn, not by the child). The run id is the only
 * value both sides agree on, so `runs/orchestrator.ts` pins each run's
 * `M3L_OUTPUT_DIR` to `<runsOutputRoot>/<runId>` and this reader looks for
 * the single timestamp directory beneath it. Two directories under one run
 * id is not a run this reader will guess about — see {@link readRunReport}.
 *
 * **Why `runs/` rather than `http/routes/runs.ts`.** The route module
 * declares narrow structural ports for every collaborator and performs no
 * I/O of its own; putting a `node:fs` read there would make it the only
 * request handler in the package that touches the filesystem directly.
 * `http/` reaches this through its own declared `M3LRunReportPort`, exactly
 * as it reaches the registry and the orchestrator.
 *
 * @packageDocumentation
 */

import { constants as fsConstants, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { M3LConsoleError } from "../errors/console-error.js";
import { errnoCodeOf } from "../errors/errno.js";

/**
 * The file name `M3LRunReporter` writes, mirrored here because `runs/` may
 * not import `m3l-common`'s `internal/` and the public `M3LRunReporter`
 * exposes the name only through `resolveReportPath`, which needs the
 * child's `startedAt` — the one value this module does not have.
 *
 * Exported so `tests/runs-report.test.ts` can pin the literal against
 * `M3LRunReporter`'s own default, which is what keeps the duplication from
 * drifting silently into a reader that finds nothing.
 *
 * @example
 * ```ts
 * import { RUN_REPORT_FILE_NAME } from "@m3l-automation/m3l-console-server/runs/report.js";
 *
 * RUN_REPORT_FILE_NAME; // "run-report.json"
 * ```
 */
export const RUN_REPORT_FILE_NAME = "run-report.json";

/**
 * The charset a run id must match before it is ever joined onto a path:
 * letters, digits, underscore, hyphen — never a separator or a `.`. The
 * orchestrator's ids are `crypto.randomUUID()` values, well inside this, but
 * the id arriving here came off a URL and is treated as untrusted regardless.
 * Mirrors `sessions/artifacts.ts`'s own `SAFE_ID_PATTERN` for the same reason.
 */
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The longest run id accepted, so a hostile path never reaches the filesystem. */
const SAFE_RUN_ID_MAX_LENGTH = 128;

/**
 * The largest `run-report.json` this reader will load into memory: 8 MiB.
 *
 * A report is a diagnostic summary, not a data channel — `M3LRunReporter`
 * caps what it writes — but the file on disk is written by a CHILD PROCESS
 * this console does not control, so its size is not an invariant the reader
 * may assume. The cap is checked against the file's real size through the
 * same descriptor the read then uses, before any content is buffered.
 */
const MAX_REPORT_BYTES = 8_388_608;

/**
 * Reads one run's persisted report, or `undefined` when there is none to
 * read.
 *
 * @example
 * ```ts
 * const reader: M3LRunReportReader = { read: () => Promise.resolve(undefined) };
 * ```
 */
export interface M3LRunReportReader {
  /**
   * Resolves `runId`'s `run-report.json`, parsed.
   *
   * @param runId - The run's id.
   * @returns The parsed report, or `undefined` when this run has no output
   *   directory yet, no timestamp directory inside it, or no report file —
   *   every one of which is the ordinary state of a run that is still queued
   *   or running, or that died before its reporter got to persist. All three
   *   are the caller's 404, not a fault.
   * @throws {@link M3LConsoleError} `ERR_CONSOLE_BAD_REQUEST` for a `runId`
   *   that is not path-safe.
   * @throws {@link M3LConsoleError} `ERR_CONSOLE_INTERNAL` when the run's
   *   output directory holds more than one timestamp directory (whose report
   *   is whose is not a question this reader answers by guessing), when the
   *   resolved report path escapes the configured root, when the file is
   *   over {@link MAX_REPORT_BYTES}, or when its contents are not JSON.
   */
  read(runId: string): Promise<unknown>;
}

/**
 * Constructor options for {@link createRunReportReader}.
 *
 * @example
 * ```ts
 * const options: CreateRunReportReaderOptions = { root: "/var/lib/m3l/console/runs" };
 * ```
 */
export interface CreateRunReportReaderOptions {
  /** The runs output root every run's `<runId>/` directory sits under. */
  readonly root: string;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` when `runId` is not safe to join onto a path. */
function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `run id must match ${SAFE_RUN_ID_PATTERN.source}`,
    );
  }
  if (runId.length > SAFE_RUN_ID_MAX_LENGTH) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_BAD_REQUEST",
      `run id must be at most ${String(SAFE_RUN_ID_MAX_LENGTH)} characters`,
    );
  }
}

/**
 * Throws `ERR_CONSOLE_INTERNAL` when `candidate` does not resolve inside
 * `root` — defence in depth behind {@link assertSafeRunId}, verifying the
 * join's actual result rather than only its input, exactly as
 * `core/diagnostics/run-report.ts` does on the write side.
 */
function assertContained(candidate: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + sep)
  ) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "the resolved run-report path escapes the configured runs output root",
    );
  }
}

/**
 * Lists the directory entries under `runDir`, or `undefined` when `runDir`
 * does not exist — the ordinary state of a run that has not spawned yet, or
 * one whose child never wrote anything.
 *
 * Only a missing directory is swallowed. A permission error, an `ENOTDIR`, or
 * any other failure propagates: those are real faults and must not be
 * reported to an operator as "this run has no report".
 */
async function listRunDirectory(
  runDir: string,
): Promise<readonly string[] | undefined> {
  try {
    const entries = await readdir(runDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (cause) {
    if (errnoCodeOf(cause) === "ENOENT") return undefined;
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "failed to list the run's output directory",
      { cause },
    );
  }
}

/**
 * Opens `filePath` exactly once and reads it, or returns `undefined` when it
 * does not exist.
 *
 * The open flags and the check ordering are lifted from
 * `sessions/artifacts.ts`'s `readArtifactFileBuffer`, for the same reasons:
 * `O_NOFOLLOW` so a symlink planted at the final component fails with
 * `ELOOP` rather than being followed out of the tree, `O_NONBLOCK` so a FIFO
 * planted at the path with no writer returns immediately instead of starving
 * libuv's fs thread pool forever, and the size check taken from the SAME
 * descriptor the read then uses — never a prior independent `stat`, which
 * leaves a window to swap the file between check and read. `close()` runs
 * best-effort in `finally` so a failing close cannot shadow the real
 * outcome.
 */
async function readCappedFile(filePath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        "the resolved run-report path is not a regular file",
      );
    }
    if (stats.size > MAX_REPORT_BYTES) {
      throw new M3LConsoleError(
        "ERR_CONSOLE_INTERNAL",
        `the run report is larger than the ${String(MAX_REPORT_BYTES)}-byte read cap`,
      );
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (cause) {
    if (cause instanceof M3LConsoleError) throw cause;
    if (errnoCodeOf(cause) === "ENOENT") return undefined;
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "failed to read the run report",
      { cause },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The reader's whole algorithm, extracted out of the returned object literal
 * so the factory stays short: validate, locate the one timestamp directory,
 * read the report, parse it.
 */
async function readRunReport(root: string, runId: string): Promise<unknown> {
  assertSafeRunId(runId);
  const runDir = join(root, runId);
  assertContained(runDir, root);

  const timestampDirs = await listRunDirectory(runDir);
  if (timestampDirs === undefined || timestampDirs.length === 0) {
    return undefined;
  }
  if (timestampDirs.length > 1) {
    // Deliberately a fault, not a guess. One run id owns one output
    // directory; two timestamp directories inside it means something other
    // than this run wrote there, and picking the newest would serve an
    // operator a report belonging to a different execution while looking
    // entirely successful.
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      `run '${runId}' has ${String(timestampDirs.length)} output directories; exactly one is expected`,
    );
  }

  const reportPath = join(runDir, timestampDirs[0] ?? "", RUN_REPORT_FILE_NAME);
  assertContained(reportPath, root);

  const contents = await readCappedFile(reportPath);
  if (contents === undefined) return undefined;

  try {
    return JSON.parse(contents);
  } catch (cause) {
    throw new M3LConsoleError(
      "ERR_CONSOLE_INTERNAL",
      "the run report is not valid JSON",
      { cause },
    );
  }
}

/**
 * Creates the {@link M3LRunReportReader} `GET /api/v1/runs/:id/report` is
 * served through.
 *
 * @param options - See {@link CreateRunReportReaderOptions}.
 * @returns A reader over `options.root`.
 *
 * @example
 * ```ts
 * import { createRunReportReader } from "@m3l-automation/m3l-console-server/runs/report.js";
 *
 * const reader = createRunReportReader({ root: "/var/lib/m3l/console/runs" });
 * ```
 */
export function createRunReportReader(
  options: CreateRunReportReaderOptions,
): M3LRunReportReader {
  const { root } = options;
  return {
    read(runId: string): Promise<unknown> {
      return readRunReport(root, runId);
    },
  };
}
