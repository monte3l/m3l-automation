/**
 * `run/report-lookup` — scans the managed output directory for the
 * timestamp-named run subdirectory matching a spawned script's observed run
 * window, and projects its `run-report.json` to an allowlisted scalar
 * summary (ADR-0063 / #539).
 *
 * The CLI (parent process) cannot compute the report's path directly: the
 * directory name is derived from the CHILD's own `startedAt`, never
 * communicated back through any other channel. This module scans for a
 * matching, in-window, timestamp-named subdirectory instead.
 *
 * **Deliberate deviation from this repo's default filesystem-error
 * convention.** The house style (`.claude/rules/library-src.md`) ignores only
 * `ENOENT` and re-throws everything else (`EACCES`/`EPERM`/…). This module
 * does the opposite on purpose: ADR-0063 requires the envelope to be
 * *read-tolerant*, because the child process has already exited and its exit
 * code has already been resolved by the time this scan runs. A permission
 * fault reading the output directory or a report file must degrade to a
 * named {@link M3LCliRunReportUnavailableReason}, never crash the CLI and
 * discard an already-resolved outcome.
 *
 * @packageDocumentation
 */

import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import type {
  M3LCliRunOutcome,
  M3LCliRunReportLookup,
  M3LCliRunReportSummary,
  M3LCliRunReportUnavailableReason,
} from "./envelope.js";

/** The report file name every run directory carries (`core/diagnostics/run-report.ts`'s default). */
const REPORT_FILE_NAME = "run-report.json";

/**
 * Anchored shape of a run directory name: an ISO-8601 timestamp with every
 * `:` replaced by `-` (mirrors `internal/diagnostics/runDirectoryName.ts`),
 * e.g. `2026-07-24T10-14-02.000Z`. Captures the three colon-substituted
 * segments so the real ISO string can be reconstructed for `Date.parse`.
 */
const RUN_DIRECTORY_NAME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)$/;

/** The exhaustive set of recognized {@link M3LCliRunOutcome} literals, for a safe runtime narrow. */
const RECOGNIZED_OUTCOMES: ReadonlySet<M3LCliRunOutcome> = new Set([
  "success",
  "failure",
  "dry-run",
  "interrupted",
  "partial",
]);

/**
 * The inputs {@link locateRunReport} needs to scan for a matching run report.
 *
 * @example
 * ```ts
 * import type { M3LCliRunReportLookupOptions } from "@m3l-automation/m3l-cli/run/report-lookup";
 *
 * const options: M3LCliRunReportLookupOptions = {
 *   outputDirPath: "/repo/data/output",
 *   scriptName: "export-users",
 *   startedAt: new Date(),
 *   finishedAt: new Date(),
 * };
 * ```
 */
export interface M3LCliRunReportLookupOptions {
  /** The managed output directory to scan (typically `M3LPaths.outputDir`). */
  readonly outputDirPath: string;
  /** The invoked script's name — must match the report's `script.name`. */
  readonly scriptName: string;
  /** The parent-observed time the child process was spawned (inclusive lower bound). */
  readonly startedAt: Date;
  /** The parent-observed time the child process exited (inclusive upper bound). */
  readonly finishedAt: Date;
}

/** One candidate run directory discovered under the output directory. */
interface RunDirectoryCandidate {
  readonly name: string;
  readonly timestampMs: number;
}

/** The reasons {@link listCandidates} can fail to enumerate the output directory. */
type OutputDirectoryFailureReason =
  "output-directory-missing" | "output-directory-unreadable";

/**
 * Safely reads a caught value's `.code` property (e.g. `"ENOENT"`),
 * tolerating a non-`Error`/non-object throw.
 */
function readErrnoCode(cause: unknown): unknown {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }
  return (cause as { readonly code?: unknown }).code;
}

/**
 * Parses a directory name against {@link RUN_DIRECTORY_NAME_PATTERN} and
 * resolves its timestamp, or `undefined` when the name doesn't match the
 * shape or parses to an invalid date.
 */
function parseRunDirectoryTimestamp(name: string): number | undefined {
  const match = RUN_DIRECTORY_NAME_PATTERN.exec(name);
  if (!match) return undefined;

  const [, datePrefix, hourColonSegment, secondSuffix] = match;
  const isoCandidate = `${datePrefix}:${hourColonSegment}:${secondSuffix}`;
  const parsed = Date.parse(isoCandidate);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Filters `entries` to in-window, timestamp-named directories and sorts them
 * newest-first.
 */
function filterAndSortCandidates(
  entries: readonly Dirent[],
  lowerBound: number,
  upperBound: number,
): readonly RunDirectoryCandidate[] {
  const candidates: RunDirectoryCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const timestampMs = parseRunDirectoryTimestamp(entry.name);
    if (timestampMs === undefined) continue;
    if (timestampMs < lowerBound || timestampMs > upperBound) continue;
    candidates.push({ name: entry.name, timestampMs });
  }
  return candidates.toSorted((a, b) => b.timestampMs - a.timestampMs);
}

/**
 * Lists every in-window, timestamp-named candidate directory under
 * `outputDirPath`, sorted newest-first, or the reason the directory itself
 * could not be enumerated.
 */
function listCandidates(
  outputDirPath: string,
  startedAt: Date,
  finishedAt: Date,
):
  | { readonly ok: true; readonly candidates: readonly RunDirectoryCandidate[] }
  | { readonly ok: false; readonly reason: OutputDirectoryFailureReason } {
  let entries;
  try {
    entries = readdirSync(outputDirPath, { withFileTypes: true });
  } catch (cause) {
    const reason: OutputDirectoryFailureReason =
      readErrnoCode(cause) === "ENOENT"
        ? "output-directory-missing"
        : "output-directory-unreadable";
    return { ok: false, reason };
  }

  const candidates = filterAndSortCandidates(
    entries,
    startedAt.getTime(),
    finishedAt.getTime(),
  );
  return { ok: true, candidates };
}

/**
 * Safely reads a string property from an unknown value, tolerating a value
 * that isn't a plain object or a hostile getter that throws.
 */
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Safely reads a value's property, tolerating a hostile getter that throws.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Projects a parsed report to its allowlisted scalar summary. Guards every
 * field read so a hostile getter degrades that field to `null` rather than
 * throwing.
 */
function projectSummary(
  report: Record<string, unknown>,
): M3LCliRunReportSummary {
  const outcomeRaw = readString(report, "outcome");
  const outcome =
    outcomeRaw !== undefined &&
    RECOGNIZED_OUTCOMES.has(outcomeRaw as M3LCliRunOutcome)
      ? (outcomeRaw as M3LCliRunOutcome)
      : null;

  const timeline = readProperty(report, "timeline");

  let timelineCount: number | null = null;
  let timelineSourceCount: number | null = null;
  if (Array.isArray(timeline)) {
    timelineCount = timeline.length;
    const sources = new Set<string>();
    for (const entry of timeline) {
      const source = readString(entry, "source");
      if (source !== undefined) sources.add(source);
    }
    timelineSourceCount = sources.size;
  }

  const recoveryTotalRaw = readProperty(report, "recoveryTotal");
  const recoveryTotal =
    outcome === "partial" && typeof recoveryTotalRaw === "number"
      ? recoveryTotalRaw
      : null;

  // Unlike recoveryTotal, retryAttempts carries no outcome gate — it applies
  // to every terminal outcome (success, failure, partial, dry-run,
  // interrupted alike), not only "partial".
  const retryAttemptsRaw = readProperty(report, "retryAttempts");
  const retryAttempts =
    typeof retryAttemptsRaw === "number" ? retryAttemptsRaw : null;

  return {
    outcome,
    timelineCount,
    timelineSourceCount,
    recoveryTotal,
    retryAttempts,
  };
}

/** The outcome of {@link readCandidateReport}, discriminated by `kind`. */
type CandidateReportOutcome =
  | { readonly kind: "enoent" }
  | { readonly kind: "mismatch" }
  | {
      readonly kind: "stop";
      readonly reason: "report-unreadable" | "report-malformed";
    }
  | { readonly kind: "found"; readonly summary: M3LCliRunReportSummary };

/**
 * Reads `reportPath`, tolerating a missing file.
 *
 * @returns The file's raw text on success, `{ kind: "enoent" }` when it
 *   doesn't exist, or `{ kind: "stop-unreadable" }` for any other read
 *   failure.
 */
function readReportFile(
  reportPath: string,
): string | { readonly kind: "enoent" | "stop-unreadable" } {
  try {
    return readFileSync(reportPath, "utf8");
  } catch (cause) {
    return {
      kind: readErrnoCode(cause) === "ENOENT" ? "enoent" : "stop-unreadable",
    };
  }
}

/**
 * Parses and validates `content` as a report object, without ever reading or
 * attaching a `JSON.parse` failure — it can embed the raw (sensitive) file
 * content, and the run report is a crash-dump-class artifact (ADR-0035).
 *
 * @returns The parsed report object, or `undefined` when the content is not
 *   valid JSON or doesn't parse to a plain object.
 */
function parseReportObject(
  content: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Attempts to read and validate the report at `reportPath` for `scriptName`.
 *
 * @returns `{ kind: "enoent" }` when the file doesn't exist (caller should
 *   continue to the next candidate); `{ kind: "stop", reason }` for any other
 *   read failure or a malformed report (the caller remembers this as a
 *   fallback reason and continues scanning older candidates — it wins only
 *   if the scan never finds a match); `{ kind: "mismatch" }` when the report
 *   parses fine but belongs to a different script (caller should continue to
 *   the next candidate); `{ kind: "found", summary }` on a match.
 */
function readCandidateReport(
  reportPath: string,
  scriptName: string,
): CandidateReportOutcome {
  const fileResult = readReportFile(reportPath);
  if (typeof fileResult !== "string") {
    return fileResult.kind === "enoent"
      ? { kind: "enoent" }
      : { kind: "stop", reason: "report-unreadable" };
  }

  const report = parseReportObject(fileResult);
  if (report === undefined) {
    return { kind: "stop", reason: "report-malformed" };
  }

  const reportScriptName = readString(readProperty(report, "script"), "name");
  if (reportScriptName === undefined) {
    return { kind: "stop", reason: "report-malformed" };
  }
  if (reportScriptName !== scriptName) {
    return { kind: "mismatch" };
  }

  return { kind: "found", summary: projectSummary(report) };
}

/**
 * Scans the managed output directory for the run subdirectory matching a
 * spawned script's observed run window, and projects its `run-report.json`
 * to an allowlisted scalar summary.
 *
 * Read-tolerant by design (see this module's top-level doc for why): never
 * throws. Every failure mode resolves to a named
 * {@link M3LCliRunReportUnavailableReason} instead.
 *
 * @param options - The output directory, script name, and observed run
 *   window to scan for.
 * @returns `{ status: "found", reportPath, summary }` for the newest in-window
 *   directory whose report matches `scriptName`; otherwise
 *   `{ status: "unavailable", reason }`.
 *
 * @example
 * ```ts
 * import { locateRunReport } from "@m3l-automation/m3l-cli/run/report-lookup";
 *
 * const lookup = locateRunReport({
 *   outputDirPath: "/repo/data/output",
 *   scriptName: "export-users",
 *   startedAt: new Date("2026-07-24T10:00:00.000Z"),
 *   finishedAt: new Date("2026-07-24T11:00:00.000Z"),
 * });
 * ```
 */
export function locateRunReport(
  options: M3LCliRunReportLookupOptions,
): M3LCliRunReportLookup {
  const listing = listCandidates(
    options.outputDirPath,
    options.startedAt,
    options.finishedAt,
  );
  if (!listing.ok) {
    return { status: "unavailable", reason: listing.reason };
  }

  let fallbackReason: M3LCliRunReportUnavailableReason | undefined;
  for (const candidate of listing.candidates) {
    const reportPath = join(
      options.outputDirPath,
      candidate.name,
      REPORT_FILE_NAME,
    );
    const outcome = readCandidateReport(reportPath, options.scriptName);

    switch (outcome.kind) {
      case "enoent":
      case "mismatch":
        continue;
      case "stop":
        // Remember only the FIRST stop reason encountered; an older,
        // still-unscanned candidate may hold a genuinely valid report for
        // this script — a later candidate's own stop must never mask that.
        fallbackReason ??= outcome.reason;
        continue;
      case "found":
        return { status: "found", reportPath, summary: outcome.summary };
    }
  }

  return {
    status: "unavailable",
    reason: fallbackReason ?? "no-matching-report",
  };
}
