# `text` — Multi-format Text Extraction

The `text` module extracts plain text from a variety of file formats through a single registry that dispatches to the right extractor based on MIME type or file extension.

## Overview

`M3LTextExtractorRegistry` decouples format detection from extraction logic. A caller issues one `extract(mimeType, filePath, options)` call and the registry routes it to the first registered extractor that declares support for the format — the caller never needs to know which underlying library does the work. Each extractor is a thin wrapper around a focused parsing library, and every extractor returns the same result shape so callers can treat all formats uniformly.

The ZIP extractor recurses into archives by re-dispatching their entries through the registry, with a depth cap to resist zip-bomb amplification.

## Public API

Exported from `@m3l-automation/m3l-common/core` (`text` subpath):

| Symbol                     | Kind      | Purpose                                                                     |
| -------------------------- | --------- | --------------------------------------------------------------------------- |
| `M3LTextExtractorRegistry` | class     | Dispatches extraction to the correct registered extractor.                  |
| `M3LPlainTextExtractor`    | class     | Extracts plain `.txt` files (Node `fs`).                                    |
| `M3LPdfTextExtractor`      | class     | Extracts PDF text (`unpdf`, serverless-safe, no native deps).               |
| `M3LDocxTextExtractor`     | class     | Extracts DOCX text (`mammoth`, `extractRawText()`).                         |
| `M3LXlsxTextExtractor`     | class     | Extracts spreadsheet text (`read-excel-file`).                              |
| `M3LEmailTextExtractor`    | class     | Extracts email headers and body (`mailparser` + `cheerio`).                 |
| `M3LZipTextExtractor`      | class     | Extracts ZIP entries, re-dispatching them through the registry (`adm-zip`). |
| `ZIP_DEPTH_SYMBOL`         | symbol    | Tracks recursion depth on the options object for ZIP extraction.            |
| `M3LTextExtractor`         | interface | Contract implemented by every extractor.                                    |
| `M3LTextExtractionOptions` | type      | Options passed through `extract()` to the extractor.                        |
| `M3LTextExtractionResult`  | type      | The common `{ text, pages?, truncated }` result shape.                      |
| `M3LTextExtractionError`   | class     | Typed error for extraction failures.                                        |

### Registry dispatch

`M3LTextExtractorRegistry.extract(mimeType, filePath, options)` selects an extractor in this order:

1. **MIME type** — the first registered extractor that declares support for `mimeType` is used.
2. **File extension fallback** — if no extractor matches the MIME type, the registry falls back to matching on the `filePath` extension.

On conflicts (more than one extractor supporting the same format), **first-registered wins**.

### Extractor → library table

| Extractor               | Backing library          | Notes                                                                               |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `M3LPlainTextExtractor` | Node `fs`                | Plain `.txt` files.                                                                 |
| `M3LPdfTextExtractor`   | `unpdf`                  | Serverless-safe, no native dependencies.                                            |
| `M3LDocxTextExtractor`  | `mammoth`                | Uses `extractRawText()`; images are dropped.                                        |
| `M3LXlsxTextExtractor`  | `read-excel-file`        | Per-sheet headers with tab-separated cells.                                         |
| `M3LEmailTextExtractor` | `mailparser` + `cheerio` | Headers plus plain-text body; HTML is converted to text via cheerio.                |
| `M3LZipTextExtractor`   | `adm-zip`                | Text entries extracted directly; binary entries re-dispatched through the registry. |

### Result shape

Every extractor returns an `M3LTextExtractionResult`:

```typescript
{
  text: string;       // the extracted text
  pages?: number;     // page count where the format exposes one (e.g. PDF)
  truncated: boolean; // whether the result was cut short
}
```

## Usage

```typescript
import { Core } from "@m3l-automation/m3l-common";

const registry = new Core.M3LTextExtractorRegistry();

const result = await registry.extract("application/pdf", "./input/report.pdf");

console.log(result.text);
if (result.pages !== undefined) {
  console.log(`pages: ${result.pages}`);
}
if (result.truncated) {
  console.warn("extraction was truncated");
}
```

When the MIME type is unknown, the registry falls back to the file extension:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const registry = new Core.M3LTextExtractorRegistry();

// No reliable MIME type — extension ".docx" drives the dispatch.
const result = await registry.extract(
  "application/octet-stream",
  "./contract.docx",
);
console.log(result.text);
```

## Notes & behavior

- **ZIP recursion cap.** `M3LZipTextExtractor` extracts text entries directly and re-dispatches binary entries back through the registry. To resist zip-bomb amplification, recursive dispatch is limited to a default depth of **2**, tracked via `ZIP_DEPTH_SYMBOL` attached to the options object.
- **Uniform results.** All extractors honor the same `{ text, pages?, truncated }` shape, so consuming code does not branch per format.
- **Errors.** Extraction failures surface as `M3LTextExtractionError`.
- **Dependencies are per-extractor.** Each extractor imports only its own backing library, keeping the import graph shallow and tree-shakeable.

## See also

- [`importers`](./importers.md) — structured record import (CSV, JSON, files).
- [`json`](./json.md) — JSON field extraction and format detection.
- [`storage`](./storage.md) — full-text indexing of extracted text.
- [`errors`](./errors.md) — the `LibError` hierarchy these errors extend.
- [Capability index](../../guides/capability-index.md) — map of dependencies to the modules that use them.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
