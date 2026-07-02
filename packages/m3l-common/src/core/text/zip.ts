/**
 * ZIP archive text extractor backed by the optional `adm-zip` peer dependency.
 *
 * @packageDocumentation
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import type AdmZip from "adm-zip";

import { M3LTextExtractionError } from "./errors.js";
import { ZIP_DEPTH_SYMBOL } from "./contract.js";
import type {
  M3LTextExtractionOptions,
  M3LTextExtractionResult,
  M3LTextExtractor,
} from "./contract.js";

/**
 * Default cap on ZIP recursion, counting **total archive layers including the
 * root**. A cap of `2` therefore permits the root archive plus one level of
 * nested archives. The cap bounds the recursive re-dispatch (the depth-guard in
 * `#handleEntry`), not the top-level {@link M3LZipTextExtractor.extract} open,
 * and resists zip-bomb amplification.
 */
const DEFAULT_DEPTH_CAP = 2;

/**
 * Default cap on the number of archive entries processed before extraction
 * stops and marks the result truncated. Bounds a **breadth** attack — an
 * archive declaring millions of sibling entries — independently of the depth
 * cap. Every iterated entry (directories included) counts toward it.
 */
const DEFAULT_MAX_ENTRIES = 4096;

/**
 * Default cumulative **decompressed** byte budget across processed entries. An
 * entry whose declared uncompressed size would exceed the remaining budget is
 * skipped without being materialized, so a high-inflation "zip bomb" cannot be
 * decompressed. 256 MiB is a generous ceiling for legitimate text archives
 * while still bounding a size attack.
 */
const DEFAULT_MAX_TOTAL_BYTES = 268_435_456; // 256 MiB (256 * 1024 * 1024)

/**
 * The text contribution and accounting a single entry yields back to
 * {@link M3LZipTextExtractor.extract}: the decoded `text` (absent when the
 * entry contributes none), the **actual** decompressed `bytes` charged to the
 * budget, and whether handling the entry tripped a cap (`truncated`).
 */
interface EntryOutcome {
  readonly text?: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Minimal structural view of the registry the ZIP extractor re-dispatches
 * through — declared locally to avoid a construction-time import cycle with the
 * concrete `M3LTextExtractorRegistry`.
 */
interface RegistryLike {
  extract(
    mimeType: string,
    filePath: string,
    options?: M3LTextExtractionOptions,
  ): Promise<M3LTextExtractionResult>;
}

/**
 * Extracts text from ZIP archives using `adm-zip`. Text entries are decoded
 * directly; other entries are re-dispatched back through the registry so nested
 * archives and supported documents inside the ZIP are extracted too.
 *
 * Recursive dispatch is capped at a default depth of **2** (tracked via
 * {@link ZIP_DEPTH_SYMBOL} on the options object) to resist zip-bomb
 * amplification.
 *
 * `adm-zip` is an **optional peer dependency** loaded via a lazy dynamic
 * `import()` on the first {@link extract} call — never at module load or
 * construction. If it is absent, `extract()` throws an
 * {@link M3LTextExtractionError} naming the missing dependency.
 *
 * @example
 * ```ts
 * import {
 *   M3LTextExtractorRegistry,
 *   M3LZipTextExtractor,
 * } from "@m3l-automation/m3l-common/core";
 *
 * const registry = new M3LTextExtractorRegistry();
 * registry.register(new M3LZipTextExtractor(registry));
 * const { text } = await registry.extract("application/zip", "./bundle.zip");
 * ```
 */
export class M3LZipTextExtractor implements M3LTextExtractor {
  /** MIME types handled by this extractor. */
  readonly mimeTypes: readonly string[] = ["application/zip"];

  /** File extensions handled by this extractor. */
  readonly extensions: readonly string[] = [".zip"];

  readonly #registry: RegistryLike | undefined;

  /**
   * @param registry - The registry that nested (non-text) entries are
   *   re-dispatched through. When omitted, the extractor decodes direct text
   *   entries only and never recurses into nested archives or documents.
   */
  constructor(registry?: RegistryLike) {
    this.#registry = registry;
  }

  /**
   * Extracts every text entry directly and re-dispatches other entries through
   * the registry, up to the depth cap.
   *
   * @param filePath - Path to the `.zip` archive.
   * @param options - Carries the current recursion depth under
   *   {@link ZIP_DEPTH_SYMBOL}.
   * @returns The concatenated text of all reachable entries.
   * @throws {@link M3LTextExtractionError} if `adm-zip` is absent or extraction
   *   fails.
   */
  async extract(
    filePath: string,
    options?: M3LTextExtractionOptions,
  ): Promise<M3LTextExtractionResult> {
    // ZIP_DEPTH_SYMBOL is a caller-settable option, so validate it at the
    // boundary: coerce to a finite, non-negative integer. A negative or
    // non-finite value would otherwise defeat the recursion cap.
    const raw = options?.[ZIP_DEPTH_SYMBOL] ?? 0;
    const depth = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    // maxEntries / maxTotalBytes are caller-settable, so coerce them at the
    // boundary exactly like the depth clamp above: undefined, non-finite, or
    // below the minimum falls back to the safe default — hostile input never
    // throws, it only ever gets a safe cap (validation-boundary lenience).
    const maxEntries = clampCap(options?.maxEntries, DEFAULT_MAX_ENTRIES);
    const maxTotalBytes = clampCap(
      options?.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
    );
    const { default: AdmZipCtor } = await loadAdmZip();
    try {
      const zip = new AdmZipCtor(filePath);
      return await this.#extractEntries(zip.getEntries(), depth, {
        maxEntries,
        maxTotalBytes,
      });
    } catch (cause) {
      if (cause instanceof M3LTextExtractionError) throw cause;
      throw new M3LTextExtractionError(
        `failed to extract ZIP text from '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }

  /**
   * Iterates the archive's entries under both caps, accumulating the decoded
   * text and the running decompressed-byte total. Stops early once the breadth
   * cap (`maxEntries`) is reached — every iterated entry counts, directories
   * included — and marks the result truncated when either cap trips (here or in
   * a nested archive, whose truncation is propagated up by the entry handler).
   */
  async #extractEntries(
    entries: readonly AdmZip.IZipEntry[],
    depth: number,
    caps: { readonly maxEntries: number; readonly maxTotalBytes: number },
  ): Promise<M3LTextExtractionResult> {
    const parts: string[] = [];
    let usedBytes = 0;
    let processed = 0;
    let truncated = false;

    for (const entry of entries) {
      if (processed >= caps.maxEntries) {
        truncated = true;
        break;
      }
      processed++;

      const outcome = await this.#handleEntry(entry, depth, {
        remainingBytes: caps.maxTotalBytes - usedBytes,
        maxEntries: caps.maxEntries,
        maxTotalBytes: caps.maxTotalBytes,
      });
      usedBytes += outcome.bytes;
      truncated ||= outcome.truncated;
      if (outcome.text !== undefined) parts.push(outcome.text);
    }

    return { text: parts.join("\n"), truncated };
  }

  /**
   * Resolves a single archive entry to its {@link EntryOutcome}: the decoded
   * text (absent when the entry yields none — a directory, or a nested entry
   * skipped because no registry is present or the depth cap is reached), the
   * actual decompressed bytes charged to the budget, and whether a cap tripped.
   *
   * Directories and `.txt` entries are handled directly; every other entry is
   * re-dispatched through the registry one level deeper. Before any entry is
   * decompressed its **declared** uncompressed size is checked against the
   * remaining byte budget; an entry that would overflow it is skipped without
   * being materialized (a high-inflation bomb never inflates) and truncation is
   * signalled.
   */
  async #handleEntry(
    entry: AdmZip.IZipEntry,
    depth: number,
    budget: {
      readonly remainingBytes: number;
      readonly maxEntries: number;
      readonly maxTotalBytes: number;
    },
  ): Promise<EntryOutcome> {
    if (entry.isDirectory) return { bytes: 0, truncated: false };

    // Gate on the DECLARED uncompressed size before decompressing, so a
    // high-ratio entry is skipped rather than materialized. A lying-low
    // declared size can't overshoot later entries because the budget is
    // charged the ACTUAL byte length once decompressed (below).
    const declared = Math.max(0, entry.header.size);
    if (declared > budget.remainingBytes) {
      return { bytes: 0, truncated: true };
    }

    if (isTextEntry(entry.entryName)) {
      const data = entry.getData();
      return {
        text: data.toString("utf8"),
        bytes: data.length,
        truncated: false,
      };
    }

    // Descend into a nested entry only when a registry is present to
    // re-dispatch through and the child layer would stay under the cap;
    // otherwise skip it (a no-registry extractor takes direct text only) to
    // bound recursive amplification. `DEFAULT_DEPTH_CAP` counts total archive
    // layers including the root, so `depth + 1` is the child's layer index.
    if (this.#registry === undefined || depth + 1 >= DEFAULT_DEPTH_CAP) {
      return { bytes: 0, truncated: false };
    }

    const data = entry.getData();
    const nested = await this.#dispatchEntry(
      this.#registry,
      entry.entryName,
      data,
      depth + 1,
      { maxEntries: budget.maxEntries, maxTotalBytes: budget.maxTotalBytes },
    );
    return {
      // Omit `text` entirely when the nested layer yielded none — under
      // exactOptionalPropertyTypes an explicit `undefined` is not assignable.
      ...(nested?.text !== undefined ? { text: nested.text } : {}),
      bytes: data.length,
      // A cap tripped inside the child archive propagates up to the parent.
      truncated: nested?.truncated ?? false,
    };
  }

  /**
   * Materialises a nested entry to a temp file and re-dispatches it through the
   * registry at the given depth. An entry format no registered extractor
   * supports is silently skipped (it contributes no text); any other failure —
   * a corrupt entry, or a missing peer dep for a *supported* format — is
   * re-thrown so the top-level {@link M3LZipTextExtractor.extract} catch wraps
   * it.
   */
  async #dispatchEntry(
    registry: RegistryLike,
    entryName: string,
    data: Buffer,
    depth: number,
    caps: { readonly maxEntries: number; readonly maxTotalBytes: number },
  ): Promise<M3LTextExtractionResult | undefined> {
    const dir = await mkdtemp(path.join(tmpdir(), "m3l-zip-"));
    const nestedPath = path.join(dir, path.basename(entryName));
    try {
      await writeFile(nestedPath, data);
      // Forward BOTH caps into the nested layer alongside the depth counter, so
      // every recursion layer enforces the same breadth and size budget.
      return await registry.extract("", nestedPath, {
        [ZIP_DEPTH_SYMBOL]: depth,
        maxEntries: caps.maxEntries,
        maxTotalBytes: caps.maxTotalBytes,
      });
    } catch (cause) {
      // Only "no extractor supports this entry" is a benign skip; a corrupt
      // entry or a missing peer dep for a SUPPORTED format is a real failure —
      // surface it.
      if (
        cause instanceof M3LTextExtractionError &&
        cause.code === "ERR_TEXT_EXTRACTION_UNSUPPORTED"
      ) {
        return undefined;
      }
      throw cause;
    } finally {
      // Best-effort cleanup: a failing rm must not mask the extraction outcome.
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore — the extraction result above is what matters */
      }
    }
  }
}

/**
 * Coerces a caller-supplied cap to a safe positive integer. Mirrors the depth
 * clamp's validation-boundary lenience: `undefined`, a non-finite value, or a
 * value below the minimum (`1`) falls back to `fallback` rather than throwing,
 * so hostile input can only ever yield a safe cap.
 */
function clampCap(raw: number | undefined, fallback: number): number {
  return raw !== undefined && Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : fallback;
}

/** Recognises entry names the ZIP extractor decodes directly as UTF-8 text. */
function isTextEntry(entryName: string): boolean {
  return path.extname(entryName).toLowerCase() === ".txt";
}

/**
 * Lazily loads `adm-zip`, wrapping an absent peer dependency as a typed error.
 *
 * `adm-zip` is CJS (`export = AdmZip`); under NodeNext the class arrives as the
 * dynamic import's synthetic `default`, which `import("adm-zip")` already types,
 * so no interop assertion is needed.
 */
async function loadAdmZip(): Promise<{ default: typeof AdmZip }> {
  try {
    return await import("adm-zip");
  } catch (cause) {
    throw new M3LTextExtractionError(
      "could not load the optional peer dependency 'adm-zip' for ZIP extraction; ensure it is installed",
      {
        code: "ERR_TEXT_EXTRACTION_MISSING_DEP",
        context: { dependency: "adm-zip" },
        cause,
      },
    );
  }
}
