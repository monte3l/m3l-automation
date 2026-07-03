/**
 * `core/files/M3LFileCopier` — execution-directory file archival.
 *
 * Registers files during a run and copies them together at the end into the
 * execution output directory, producing a per-file report plus an aggregate
 * summary.
 *
 * @packageDocumentation
 */

import { mkdir } from "node:fs/promises";

import {
  isPositiveIntegerThreshold,
  isSafeRelativeSegment,
} from "../../internal/files/guards.js";
import { executeQueuedCopy } from "../../internal/files/copyExecution.js";
import { writeManifestFile } from "../../internal/files/manifest.js";
import { buildSummary } from "../../internal/files/summary.js";
import type {
  CopyReport,
  CopyReportSummary,
  FileCopyOutcome,
  FileCopySkipReason,
} from "../../internal/files/types.js";
import { M3LPrompt } from "../prompt/index.js";
import { M3LPaths } from "../utils/index.js";

import { M3LFileCopyError } from "./M3LFileCopyError.js";

// ---------------------------------------------------------------------------
// M3LFileCopySkipReason / M3LFileCopyResult / M3LFileCopyReportSummary /
// M3LFileCopyReport
//
// Re-exported from the canonical internal definitions in
// `internal/files/types.ts` so the skip-reason union and the result/summary
// shapes are declared exactly once, not retyped separately for the public
// surface and the internal execution modules.
// ---------------------------------------------------------------------------

/**
 * The reason a queued file was skipped rather than copied during
 * {@link M3LFileCopier.finalizeRegisteredFiles}.
 *
 * @example
 * ```ts
 * import type { M3LFileCopySkipReason } from "@m3l-automation/m3l-common/core";
 *
 * function describe(reason: M3LFileCopySkipReason): string {
 *   return `skipped: ${reason}`;
 * }
 * ```
 */
export type M3LFileCopySkipReason = FileCopySkipReason;

/**
 * The outcome of a single queued file after
 * {@link M3LFileCopier.finalizeRegisteredFiles} runs, discriminated on
 * `skipped`.
 *
 * @example
 * ```ts
 * import type { M3LFileCopyResult } from "@m3l-automation/m3l-common/core";
 *
 * function report(result: M3LFileCopyResult): string {
 *   return result.skipped
 *     ? `skipped (${result.reason})`
 *     : `copied ${String(result.size)} bytes to ${result.destination}`;
 * }
 * ```
 */
export type M3LFileCopyResult = FileCopyOutcome;

/**
 * The aggregate portion of an {@link M3LFileCopyReport}.
 *
 * @example
 * ```ts
 * import type { M3LFileCopyReportSummary } from "@m3l-automation/m3l-common/core";
 *
 * function isClean(summary: M3LFileCopyReportSummary): boolean {
 *   return summary.skipped === 0;
 * }
 * ```
 */
export type M3LFileCopyReportSummary = CopyReportSummary;

/**
 * The full report returned by {@link M3LFileCopier.finalizeRegisteredFiles}.
 *
 * @example
 * ```ts
 * import type { M3LFileCopyReport } from "@m3l-automation/m3l-common/core";
 *
 * function summarize(report: M3LFileCopyReport): number {
 *   return report.summary.copied;
 * }
 * ```
 */
export type M3LFileCopyReport = CopyReport;

// ---------------------------------------------------------------------------
// M3LFileCopierOptions
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link M3LFileCopier}.
 *
 * `paths` and `prompt` are dependency-injection ports: omit them in
 * production to use the real {@link M3LPaths} / `M3LPrompt` implementations
 * (constructed lazily, only when actually needed), or inject fakes in tests.
 *
 * @example
 * ```ts
 * import type { M3LFileCopierOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LFileCopierOptions = {
 *   maxFileSizeBytes: 10_000_000,
 *   overwrite: false,
 * };
 * ```
 */
export interface M3LFileCopierOptions {
  /**
   * Maximum source size, in bytes. A source strictly greater than this
   * value is skipped with reason `"size-too-large"`. Must be a finite
   * positive integer when supplied. `undefined` disables the check.
   */
  readonly maxFileSizeBytes?: number;
  /**
   * Whether an existing destination file is replaced. Defaults to `false`
   * (a pre-existing destination is skipped with reason `"already-exists"`).
   */
  readonly overwrite?: boolean;
  /**
   * Threshold, in bytes, above which a source triggers an interactive
   * confirmation before being copied. A source strictly greater than this
   * value prompts via `prompt.confirm`. Must be a finite positive integer
   * when supplied. `undefined` disables prompting. Pre-empted by
   * `maxFileSizeBytes`: a file over the size limit is skipped before the
   * prompt is ever consulted.
   */
  readonly largeFilePromptThresholdBytes?: number;
  /**
   * Whether to write a JSON manifest (the full {@link M3LFileCopyReport}) to
   * the output directory after finalization. Defaults to `false`.
   */
  readonly writeManifest?: boolean;
  /**
   * The manifest file name, relative to the output directory. Defaults to
   * `"manifest.json"`. Must not be an absolute path and must not contain a
   * `..` segment — it is joined directly onto the output directory, so an
   * unsanitized value could otherwise write outside the intended tree.
   */
  readonly manifestFileName?: string;
  /**
   * Injected paths port supplying the output directory. Defaults to a
   * lazily-constructed `new M3LPaths()`.
   */
  readonly paths?: { getOutputDir(): string };
  /**
   * Injected prompt port used for the large-file confirmation. Defaults to
   * a lazily-constructed `new M3LPrompt()`.
   */
  readonly prompt?: {
    confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  };
}

// ---------------------------------------------------------------------------
// M3L_FILE_COPIER_DEFAULTS
// ---------------------------------------------------------------------------

/**
 * Default option values applied by {@link M3LFileCopier} when a given
 * {@link M3LFileCopierOptions} field is omitted.
 *
 * @example
 * ```ts
 * import { M3L_FILE_COPIER_DEFAULTS } from "@m3l-automation/m3l-common/core";
 *
 * console.log(M3L_FILE_COPIER_DEFAULTS.manifestFileName); // "manifest.json"
 * ```
 */
export const M3L_FILE_COPIER_DEFAULTS = {
  /** No size limit by default. */
  maxFileSizeBytes: undefined,
  /** Existing destinations are not overwritten by default. */
  overwrite: false,
  /** No large-file prompt by default. */
  largeFilePromptThresholdBytes: undefined,
  /** No manifest is written by default. */
  writeManifest: false,
  /** Default manifest file name when `writeManifest` is enabled. */
  manifestFileName: "manifest.json",
} as const;

// ---------------------------------------------------------------------------
// Internal: resolved (defaulted + validated) options
// ---------------------------------------------------------------------------

/** Fully-resolved options after applying defaults and validating thresholds. */
interface ResolvedOptions {
  readonly maxFileSizeBytes: number | undefined;
  readonly overwrite: boolean;
  readonly largeFilePromptThresholdBytes: number | undefined;
  readonly writeManifest: boolean;
  readonly manifestFileName: string;
  readonly paths: { getOutputDir(): string } | undefined;
  readonly prompt:
    | {
        confirm(
          message: string,
          options?: { default?: boolean },
        ): Promise<boolean>;
      }
    | undefined;
}

/**
 * Validates a size-threshold option, throwing {@link M3LFileCopyError} when
 * it is defined but not a finite positive integer. `undefined` is always
 * valid — it disables the corresponding behavior.
 */
function validateThreshold(value: number | undefined, fieldName: string): void {
  if (value === undefined) return;
  if (!isPositiveIntegerThreshold(value)) {
    throw new M3LFileCopyError(
      `${fieldName} must be a finite positive integer, got: ${String(value)}`,
      { context: { field: fieldName, value } },
    );
  }
}

/**
 * Validates a path-shaped option (`manifestFileName`), throwing
 * {@link M3LFileCopyError} when it is absolute or escapes its parent via a
 * `..` segment — both would let the resolved path land outside the output
 * directory it is joined onto.
 */
function validatePathSegment(value: string, fieldName: string): void {
  if (!isSafeRelativeSegment(value)) {
    throw new M3LFileCopyError(
      `${fieldName} must be a relative path with no ".." segment, got: "${value}"`,
      { context: { field: fieldName, value } },
    );
  }
}

/** Applies {@link M3L_FILE_COPIER_DEFAULTS} and validates thresholds. */
function resolveOptions(options: M3LFileCopierOptions): ResolvedOptions {
  validateThreshold(options.maxFileSizeBytes, "maxFileSizeBytes");
  validateThreshold(
    options.largeFilePromptThresholdBytes,
    "largeFilePromptThresholdBytes",
  );

  const manifestFileName =
    options.manifestFileName ?? M3L_FILE_COPIER_DEFAULTS.manifestFileName;
  validatePathSegment(manifestFileName, "manifestFileName");

  return {
    maxFileSizeBytes: options.maxFileSizeBytes,
    overwrite: options.overwrite ?? M3L_FILE_COPIER_DEFAULTS.overwrite,
    largeFilePromptThresholdBytes: options.largeFilePromptThresholdBytes,
    writeManifest:
      options.writeManifest ?? M3L_FILE_COPIER_DEFAULTS.writeManifest,
    manifestFileName,
    paths: options.paths,
    prompt: options.prompt,
  };
}

// ---------------------------------------------------------------------------
// M3LFileCopier
// ---------------------------------------------------------------------------

/**
 * Batches files for copy to the execution output directory.
 *
 * Files are registered as the script runs via {@link M3LFileCopier.registerFile}
 * (queuing only — no filesystem I/O happens at registration time), then
 * copied together when {@link M3LFileCopier.finalizeRegisteredFiles} is
 * awaited. Finalization produces a per-file {@link M3LFileCopyResult} plus an
 * aggregate {@link M3LFileCopyReportSummary}.
 *
 * @example
 * ```ts
 * import { M3LFileCopier } from "@m3l-automation/m3l-common/core";
 *
 * const copier = new M3LFileCopier();
 * copier.registerFile("./data/inputs/source.csv", { subdir: "inputs" });
 * const report = await copier.finalizeRegisteredFiles();
 * console.log(report.summary.copied);
 * ```
 */
export class M3LFileCopier {
  private readonly resolved: ResolvedOptions;
  private readonly queue: { sourcePath: string; subdir: string }[] = [];

  /**
   * Creates a new `M3LFileCopier`.
   *
   * @param options - Optional configuration; see {@link M3LFileCopierOptions}.
   *   Omitted fields fall back to {@link M3L_FILE_COPIER_DEFAULTS}.
   * @throws {@link M3LFileCopyError} When `maxFileSizeBytes` or
   *   `largeFilePromptThresholdBytes` is supplied but is not a finite
   *   positive integer.
   *
   * @example
   * ```ts
   * import { M3LFileCopier } from "@m3l-automation/m3l-common/core";
   *
   * const copier = new M3LFileCopier({ overwrite: true });
   * ```
   */
  constructor(options: M3LFileCopierOptions = {}) {
    this.resolved = resolveOptions(options);
  }

  /**
   * Queues `sourcePath` for copy into `options.subdir` under the output
   * directory. Performs no filesystem I/O — the source is only touched when
   * {@link M3LFileCopier.finalizeRegisteredFiles} runs, so registering a
   * nonexistent path never throws here. `subdir` is validated immediately
   * (fail fast at registration time), since it is joined directly onto the
   * output directory.
   *
   * @param sourcePath - Absolute or relative path to the file to archive.
   * @param options - Registration options; `subdir` groups the file under a
   *   subdirectory of the output directory (see
   *   `getDefaultSubdirForPathType` for a documented convention). Must be a
   *   relative path with no `..` segment.
   * @throws {@link M3LFileCopyError} When `subdir` is absolute or escapes
   *   its parent via a `..` segment.
   *
   * @example
   * ```ts
   * import { M3LFileCopier } from "@m3l-automation/m3l-common/core";
   *
   * const copier = new M3LFileCopier();
   * copier.registerFile("./config.yaml", { subdir: "configs" });
   * ```
   */
  registerFile(sourcePath: string, options: { subdir: string }): void {
    validatePathSegment(options.subdir, "subdir");
    this.queue.push({ sourcePath, subdir: options.subdir });
  }

  /**
   * Executes every queued copy and returns the resulting
   * {@link M3LFileCopyReport}.
   *
   * Per-file recoverable conditions (oversized source, pre-existing
   * destination, unreadable source, declined prompt) never throw — they are
   * recorded as a skipped result and the batch continues. A genuine
   * infrastructural failure (resolving/creating the output directory,
   * copying a file that already passed every check, or writing the
   * manifest) throws {@link M3LFileCopyError} chaining the underlying cause,
   * with `context.phase` identifying which stage failed. A failure during
   * the copy phase also carries `context.partialResultsCount`, the number of
   * per-file outcomes already recorded before the fatal error.
   *
   * @returns The full report: per-file results plus an aggregate summary.
   * @throws {@link M3LFileCopyError} On a batch-fatal I/O failure.
   *
   * @example
   * ```ts
   * import { M3LFileCopier } from "@m3l-automation/m3l-common/core";
   *
   * const copier = new M3LFileCopier();
   * copier.registerFile("./report.csv", { subdir: "inputs" });
   * const report = await copier.finalizeRegisteredFiles();
   * console.log(report.summary);
   * ```
   */
  async finalizeRegisteredFiles(): Promise<M3LFileCopyReport> {
    const outputDir = this.resolveOutputDir();
    const prompt = this.resolved.prompt ?? new M3LPrompt();

    const results = await this.copyAll(outputDir, prompt);
    const summary = buildSummary(results);
    const report: M3LFileCopyReport = { results, summary };

    if (this.resolved.writeManifest) {
      await this.writeManifest(outputDir, report);
    }

    return report;
  }

  /**
   * Resolves the output directory from the injected `paths` port, or a
   * lazily-constructed `M3LPaths` when none was injected — never at
   * construction time, so a caller who always injects `paths` never pays
   * for a real `M3LPaths` instantiation.
   */
  private resolveOutputDir(): string {
    return (this.resolved.paths ?? new M3LPaths()).getOutputDir();
  }

  /**
   * Copies every queued entry in registration order, creating the output
   * directory tree first. Delegates the per-file decision tree (including
   * the destination subdirectory creation) to `executeQueuedCopy`.
   *
   * A failure creating the output directory, or during any individual copy,
   * is wrapped as {@link M3LFileCopyError} with `context.phase` set to
   * `"output-dir"` or `"copy"` respectively; a copy-phase failure also
   * reports how many results were already recorded via
   * `context.partialResultsCount`, so an operator can see how much of the
   * batch landed before the fatal error. An already-typed
   * `M3LFileCopyError` (e.g. from `executeQueuedCopy`'s errno narrowing) is
   * re-thrown unchanged rather than double-wrapped.
   */
  private async copyAll(
    outputDir: string,
    prompt: {
      confirm(
        message: string,
        options?: { default?: boolean },
      ): Promise<boolean>;
    },
  ): Promise<FileCopyOutcome[]> {
    try {
      await mkdir(outputDir, { recursive: true });
    } catch (cause) {
      throw new M3LFileCopyError("failed to create the output directory", {
        cause,
        context: { phase: "output-dir", outputDir },
      });
    }

    const results: FileCopyOutcome[] = [];
    try {
      for (const entry of this.queue) {
        const outcome = await executeQueuedCopy(entry, outputDir, {
          maxFileSizeBytes: this.resolved.maxFileSizeBytes,
          overwrite: this.resolved.overwrite,
          largeFilePromptThresholdBytes:
            this.resolved.largeFilePromptThresholdBytes,
          prompt,
        });
        results.push(outcome);
      }
    } catch (cause) {
      if (cause instanceof M3LFileCopyError) throw cause;
      throw new M3LFileCopyError("failed while copying a registered file", {
        cause,
        context: { phase: "copy", partialResultsCount: results.length },
      });
    }
    return results;
  }

  /**
   * Writes the manifest JSON, wrapping any failure as
   * {@link M3LFileCopyError} with `context.phase` set to `"manifest"`.
   */
  private async writeManifest(
    outputDir: string,
    report: M3LFileCopyReport,
  ): Promise<void> {
    try {
      await writeManifestFile(
        outputDir,
        this.resolved.manifestFileName,
        report,
      );
    } catch (cause) {
      throw new M3LFileCopyError("failed to write copy manifest", {
        cause,
        context: {
          phase: "manifest",
          outputDir,
          manifestFileName: this.resolved.manifestFileName,
        },
      });
    }
  }
}
