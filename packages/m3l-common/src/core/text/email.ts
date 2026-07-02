/**
 * Email text extractor backed by the optional `mailparser` + `cheerio` peer
 * dependencies.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";

import type * as Mailparser from "mailparser";
import type * as Cheerio from "cheerio";

import { M3LTextExtractionError } from "./errors.js";
import type { M3LTextExtractionResult, M3LTextExtractor } from "./contract.js";

/**
 * Extracts email headers and body from `.eml` files using `mailparser`, with an
 * HTML-only body converted to plain text via `cheerio`.
 *
 * Both `mailparser` and `cheerio` are **optional peer dependencies** loaded via
 * a lazy dynamic `import()` on the first {@link extract} call — never at module
 * load or construction. If either is absent, `extract()` throws an
 * {@link M3LTextExtractionError} naming the missing dependency.
 *
 * @example
 * ```ts
 * import { M3LEmailTextExtractor } from "@m3l-automation/m3l-common/core";
 *
 * const extractor = new M3LEmailTextExtractor();
 * const { text } = await extractor.extract("./message.eml");
 * ```
 */
export class M3LEmailTextExtractor implements M3LTextExtractor {
  /** MIME types handled by this extractor. */
  readonly mimeTypes: readonly string[] = ["message/rfc822"];

  /** File extensions handled by this extractor. */
  readonly extensions: readonly string[] = [".eml"];

  /**
   * Extracts the email headers and body text.
   *
   * @param filePath - Path to the `.eml` file.
   * @returns The header summary followed by the body text.
   * @throws {@link M3LTextExtractionError} if a peer dependency is absent or
   *   extraction fails.
   */
  async extract(filePath: string): Promise<M3LTextExtractionResult> {
    const { simpleParser } = await loadMailparser();
    const { load } = await loadCheerio();
    try {
      const raw = await readFile(filePath);
      const parsed = await simpleParser(raw);

      const headerLines = [
        parsed.subject !== undefined ? `Subject: ${parsed.subject}` : undefined,
        parsed.from?.text !== undefined
          ? `From: ${parsed.from.text}`
          : undefined,
        toHeader(parsed.to),
      ].filter((line): line is string => line !== undefined);

      // Prefer converting a rich HTML body via cheerio (dropping tags); fall
      // back to the plain-text body, then to an empty string.
      const body =
        typeof parsed.html === "string"
          ? load(parsed.html).text()
          : typeof parsed.text === "string"
            ? parsed.text
            : "";

      const text = [...headerLines, "", body].join("\n");
      return { text, truncated: false };
    } catch (cause) {
      if (cause instanceof M3LTextExtractionError) throw cause;
      throw new M3LTextExtractionError(
        `failed to extract email text from '${filePath}'`,
        { code: "ERR_TEXT_EXTRACTION", context: { filePath }, cause },
      );
    }
  }
}

/**
 * The flattened shape of a mailparser address value we read: an address object
 * (or array of them) exposes a `.text` field carrying the rendered form.
 */
type AddressLike = { readonly text: string };

/**
 * Renders the parsed `to` field into a `To:` header line. mailparser exposes
 * `to` as an address object (or array of them), each carrying a flattened
 * `.text`; we read that flattened form and join multiple objects with commas.
 */
function toHeader(
  to: AddressLike | readonly AddressLike[] | undefined,
): string | undefined {
  if (to === undefined) return undefined;
  // `in` narrows the union cleanly where `Array.isArray` (guard `arg is any[]`)
  // does not narrow the `readonly {text}[]` branch.
  const text =
    "text" in to ? to.text : to.map((entry) => entry.text).join(", ");
  return `To: ${text}`;
}

/**
 * Lazily loads `mailparser`, wrapping an absent peer dependency as a typed
 * error.
 */
async function loadMailparser(): Promise<typeof Mailparser> {
  try {
    return await import("mailparser");
  } catch (cause) {
    throw new M3LTextExtractionError(
      "could not load the optional peer dependency 'mailparser' for email extraction; ensure it is installed",
      {
        code: "ERR_TEXT_EXTRACTION_MISSING_DEP",
        context: { dependency: "mailparser" },
        cause,
      },
    );
  }
}

/**
 * Lazily loads `cheerio`, wrapping an absent peer dependency as a typed error.
 */
async function loadCheerio(): Promise<typeof Cheerio> {
  try {
    return await import("cheerio");
  } catch (cause) {
    throw new M3LTextExtractionError(
      "could not load the optional peer dependency 'cheerio' for email extraction; ensure it is installed",
      {
        code: "ERR_TEXT_EXTRACTION_MISSING_DEP",
        context: { dependency: "cheerio" },
        cause,
      },
    );
  }
}
