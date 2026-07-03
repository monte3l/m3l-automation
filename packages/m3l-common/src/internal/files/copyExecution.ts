/**
 * `internal/files/copyExecution` — per-file copy logic for `M3LFileCopier`.
 *
 * Isolated from the public class so the per-file decision tree (size skip,
 * overwrite check, source-readability check, large-file prompt, then the
 * actual copy) is unit-testable in isolation and keeps `M3LFileCopier`
 * itself a thin orchestration/aggregation layer.
 *
 * @packageDocumentation
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { M3LFileCopyError } from "../../core/files/M3LFileCopyError.js";

import type { FileCopyOutcome, FileCopySkipReason } from "./types.js";

/** A single queued file registration awaiting `finalizeRegisteredFiles()`. */
export interface QueuedFileEntry {
  readonly sourcePath: string;
  readonly subdir: string;
}

/**
 * The subset of `M3LFileCopierOptions` that per-file execution needs,
 * already validated, defaulted, and resolved (ports included) by the
 * caller — `M3LFileCopier` resolves `paths`/`prompt` once per finalize run,
 * not once per file.
 */
export interface CopyExecutionOptions {
  readonly maxFileSizeBytes: number | undefined;
  readonly overwrite: boolean;
  readonly largeFilePromptThresholdBytes: number | undefined;
  readonly prompt: {
    confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  };
}

/** Node.js `fs` error codes that genuinely mean "cannot read this source". */
const UNREADABLE_SOURCE_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENOTDIR",
]);

/**
 * Narrows a caught `stat`/`copyFile` failure to its Node.js error `code`,
 * when present.
 */
function errnoCode(cause: unknown): string | undefined {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return undefined;
}

/**
 * Returns the file size in bytes when `filePath` is a readable, statable
 * file, or `undefined` when `stat` fails with an error code that genuinely
 * means "missing or unreadable" ({@link UNREADABLE_SOURCE_CODES}) — the
 * caller records that as a recoverable `source-unreadable` skip. Any other
 * `stat` failure (e.g. `EMFILE`/`ENFILE`/`EIO` — transient infrastructural
 * exhaustion, not a property of this particular file) is rethrown as
 * {@link M3LFileCopyError} so it becomes batch-fatal instead of silently
 * mislabeling every remaining file as missing.
 */
async function tryStatSize(filePath: string): Promise<number | undefined> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch (cause) {
    const code = errnoCode(cause);
    if (code !== undefined && UNREADABLE_SOURCE_CODES.has(code)) {
      return undefined;
    }
    throw new M3LFileCopyError(
      `unexpected error statting source "${filePath}"`,
      { cause, context: { sourcePath: filePath } },
    );
  }
}

/**
 * Returns `true` when `filePath` already exists on disk, `false` when
 * `stat` fails with `ENOENT` (the only code that unambiguously means "does
 * not exist, safe to write"). Any other `stat` failure (e.g. `EACCES` on a
 * parent directory) is rethrown as {@link M3LFileCopyError} rather than
 * silently treated as "absent" — a permission failure on the destination
 * side is an infrastructural problem, not a per-file skip condition.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return false;
    throw new M3LFileCopyError(
      `unexpected error checking destination "${filePath}"`,
      { cause, context: { destination: filePath } },
    );
  }
}

/** Builds a `skipped: true` {@link FileCopyOutcome}, stamping the timestamp. */
function toSkippedOutcome(
  entry: QueuedFileEntry,
  destination: string,
  reason: FileCopySkipReason,
): FileCopyOutcome {
  return {
    skipped: true,
    source: entry.sourcePath,
    destination,
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determines whether `entry` (of known `size`) should be skipped before any
 * copy is attempted, checking size, overwrite, and the large-file prompt in
 * the contract's required precedence — size-too-large pre-empts the prompt.
 * Resolves to `undefined` when the file should proceed to copy.
 */
async function resolveSkipReason(
  entry: QueuedFileEntry,
  destination: string,
  size: number,
  options: CopyExecutionOptions,
): Promise<FileCopySkipReason | undefined> {
  if (
    options.maxFileSizeBytes !== undefined &&
    size > options.maxFileSizeBytes
  ) {
    return "size-too-large";
  }

  if (!options.overwrite && (await pathExists(destination))) {
    return "already-exists";
  }

  if (
    options.largeFilePromptThresholdBytes !== undefined &&
    size > options.largeFilePromptThresholdBytes
  ) {
    const proceed = await options.prompt.confirm(
      `Archive large file "${path.basename(entry.sourcePath)}" (${String(size)} bytes)?`,
    );
    if (!proceed) return "declined-by-prompt";
  }

  return undefined;
}

/**
 * Executes the copy (or skip) decision for a single queued file against the
 * already-resolved `outputDir`, returning its {@link FileCopyOutcome}.
 *
 * Never throws for recoverable per-file conditions — an unreadable source,
 * an oversized source, a pre-existing destination, or a declined prompt all
 * resolve to a `skipped: true` outcome. A genuine infrastructural failure
 * (an unexpected `stat` error, creating the destination subdirectory, or the
 * copy itself) propagates as {@link M3LFileCopyError}, since by that point
 * the failure is no longer a property of this one file and is batch-fatal
 * by contract. The destination subdirectory is created lazily, immediately
 * before the copy, so a skipped file never litters an empty subdirectory.
 */
export async function executeQueuedCopy(
  entry: QueuedFileEntry,
  outputDir: string,
  options: CopyExecutionOptions,
): Promise<FileCopyOutcome> {
  const destination = path.join(
    outputDir,
    entry.subdir,
    path.basename(entry.sourcePath),
  );

  const size = await tryStatSize(entry.sourcePath);
  if (size === undefined) {
    return toSkippedOutcome(entry, destination, "source-unreadable");
  }

  const skipReason = await resolveSkipReason(entry, destination, size, options);
  if (skipReason !== undefined) {
    return toSkippedOutcome(entry, destination, skipReason);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(entry.sourcePath, destination);
  return {
    skipped: false,
    source: entry.sourcePath,
    destination,
    size,
    timestamp: new Date().toISOString(),
  };
}
