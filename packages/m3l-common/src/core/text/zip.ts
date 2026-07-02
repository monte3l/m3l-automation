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
    const { default: AdmZipCtor } = await loadAdmZip();
    try {
      const zip = new AdmZipCtor(filePath);
      const parts: string[] = [];

      for (const entry of zip.getEntries()) {
        const part = await this.#handleEntry(entry, depth);
        if (part !== undefined) parts.push(part);
      }

      return { text: parts.join("\n"), truncated: false };
    } catch (cause) {
      if (cause instanceof M3LTextExtractionError) throw cause;
      throw new M3LTextExtractionError(
        `failed to extract ZIP text from '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }

  /**
   * Resolves a single archive entry to its text contribution, or `undefined`
   * when the entry yields nothing (a directory, or a nested entry skipped
   * because no registry is present or the depth cap is reached).
   *
   * Directories and `.txt` entries are handled directly; every other entry is
   * re-dispatched through the registry one level deeper.
   */
  async #handleEntry(
    entry: AdmZip.IZipEntry,
    depth: number,
  ): Promise<string | undefined> {
    if (entry.isDirectory) return undefined;

    if (isTextEntry(entry.entryName)) {
      return entry.getData().toString("utf8");
    }

    // Descend into a nested entry only when a registry is present to
    // re-dispatch through and the child layer would stay under the cap;
    // otherwise skip it (a no-registry extractor takes direct text only) to
    // bound recursive amplification. `DEFAULT_DEPTH_CAP` counts total archive
    // layers including the root, so `depth + 1` is the child's layer index.
    if (this.#registry === undefined || depth + 1 >= DEFAULT_DEPTH_CAP) {
      return undefined;
    }

    const nested = await this.#dispatchEntry(
      this.#registry,
      entry.entryName,
      entry.getData(),
      depth + 1,
    );
    return nested?.text;
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
  ): Promise<M3LTextExtractionResult | undefined> {
    const dir = await mkdtemp(path.join(tmpdir(), "m3l-zip-"));
    const nestedPath = path.join(dir, path.basename(entryName));
    try {
      await writeFile(nestedPath, data);
      return await registry.extract("", nestedPath, {
        [ZIP_DEPTH_SYMBOL]: depth,
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
