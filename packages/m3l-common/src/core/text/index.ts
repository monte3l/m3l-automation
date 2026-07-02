/**
 * `core/text` — multi-format text extraction.
 *
 * A single {@link M3LTextExtractorRegistry} dispatches extraction to the right
 * extractor by MIME type or file extension. The registry and
 * {@link M3LPlainTextExtractor} depend only on Node's `fs`; the five
 * library-backed extractors load their backing library through a lazy dynamic
 * `import()` on first use, keeping the base install minimal and the module
 * tree-shakeable.
 *
 * @packageDocumentation
 */

export { M3LTextExtractionError } from "./errors.js";
export { M3LTextExtractorRegistry } from "./registry.js";
export { M3LPlainTextExtractor } from "./plain-text.js";
export { M3LPdfTextExtractor } from "./pdf.js";
export { M3LDocxTextExtractor } from "./docx.js";
export { M3LXlsxTextExtractor } from "./xlsx.js";
export { M3LEmailTextExtractor } from "./email.js";
export { M3LZipTextExtractor } from "./zip.js";
export { ZIP_DEPTH_SYMBOL } from "./contract.js";
export type {
  M3LTextExtractionOptions,
  M3LTextExtractionResult,
  M3LTextExtractor,
} from "./contract.js";
