# `text` — Multi-format Text Extraction

The `text` module extracts plain text from a variety of file formats through a single registry that dispatches to the right extractor based on MIME type or file extension.

## Overview

`M3LTextExtractorRegistry` decouples format detection from extraction logic. A caller issues one `extract(mimeType, filePath, options)` call and the registry routes it to the first registered extractor that declares support for the format — the caller never needs to know which underlying library does the work. Each extractor returns the same result shape so callers can treat all formats uniformly.

The registry and the plain-text extractor depend only on Node's `fs` and are always available. The five library-backed extractors (PDF, DOCX, XLSX, email, ZIP) are **opt-in**: each is a thin wrapper that loads its backing library through a lazy dynamic `import()` on first use, and those libraries are declared as **optional peer dependencies** so the base install stays minimal and the import graph stays tree-shakeable. See [Notes & behavior](#notes--behavior) for the full dependency posture.

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

### The extractor contract

Every extractor implements `M3LTextExtractor`, which declares the formats it
handles through two read-only arrays and a single `extract()` method:

```typescript
interface M3LTextExtractor {
  /** MIME types this extractor handles (e.g. "application/pdf"). */
  readonly mimeTypes: readonly string[];
  /** File extensions this extractor handles, dot-prefixed (e.g. ".pdf"). */
  readonly extensions: readonly string[];
  /** Extract text from an already-matched file. */
  extract(
    filePath: string,
    options?: M3LTextExtractionOptions,
  ): Promise<M3LTextExtractionResult>;
}
```

The registry inspects `mimeTypes` / `extensions` to route a call; the extractor's
own `extract()` receives only the `filePath` (the registry has already matched
the format) and the options.

### Registration

`M3LTextExtractorRegistry` holds an ordered list of extractors:

- `new M3LTextExtractorRegistry(extractors?)` — when `extractors` is omitted, the
  registry starts with a single `M3LPlainTextExtractor` registered (the dep-free
  core extractor, always available). When an array is passed, those extractors are
  registered in array order and no default is added, giving the caller full
  control of precedence.
- `register(extractor: M3LTextExtractor): void` — appends an extractor to the
  list. Registration order is the precedence order (see dispatch below).

The five optional extractors are **not** registered by default; a consumer opts
in by `register()`-ing one (and installing its peer dependency).

### Registry dispatch

`M3LTextExtractorRegistry.extract(mimeType, filePath, options)` selects an extractor in this order:

1. **MIME type** — the first registered extractor whose `mimeTypes` includes `mimeType` is used.
2. **File extension fallback** — if no extractor matches the MIME type, the registry falls back to the first extractor whose `extensions` includes the `filePath` extension.

On conflicts (more than one extractor supporting the same format), **first-registered wins** — the registry iterates in registration order and takes the first match.

If **no** registered extractor matches either the MIME type or the file extension, `extract()` throws an `M3LTextExtractionError` naming the unsupported MIME type and extension — it never returns a silent empty result.

### Extractor → library table

| Extractor               | Backing library          | Availability            | Notes                                                                               |
| ----------------------- | ------------------------ | ----------------------- | ----------------------------------------------------------------------------------- |
| `M3LPlainTextExtractor` | Node `fs`                | Core (always available) | Plain `.txt` files.                                                                 |
| `M3LPdfTextExtractor`   | `unpdf`                  | Optional (peer, lazy)   | Serverless-safe, no native dependencies.                                            |
| `M3LDocxTextExtractor`  | `mammoth`                | Optional (peer, lazy)   | Uses `extractRawText()`; images are dropped.                                        |
| `M3LXlsxTextExtractor`  | `read-excel-file`        | Optional (peer, lazy)   | Per-sheet headers with tab-separated cells.                                         |
| `M3LEmailTextExtractor` | `mailparser` + `cheerio` | Optional (peer, lazy)   | Headers plus plain-text body; HTML is converted to text via cheerio.                |
| `M3LZipTextExtractor`   | `adm-zip`                | Optional (peer, lazy)   | Text entries extracted directly; binary entries re-dispatched through the registry. |

Extractors in the **Core** row work with only the base install. Each **Optional
(peer, lazy)** extractor requires its backing library to be installed by the
consumer (declared as an optional `peerDependency`) and loads it via a dynamic
`import()` the first time that extractor runs — never at module load.

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

> The PDF and DOCX examples below use optional extractors, so they require the
> corresponding peer dependency (`unpdf`, `mammoth`) to be installed. Without it,
> `extract()` throws a typed `M3LTextExtractionError` naming the missing library.

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
- **Errors.** Extraction failures surface as `M3LTextExtractionError` (a subclass of the `errors` hierarchy), always chaining the underlying failure via `cause` — the module never throws a bare string or an unwrapped library exception.
- **Core vs optional extractors.** `M3LTextExtractorRegistry` and `M3LPlainTextExtractor` depend only on Node's `fs` and are always available with the base install. The five library-backed extractors (`M3LPdfTextExtractor`, `M3LDocxTextExtractor`, `M3LXlsxTextExtractor`, `M3LEmailTextExtractor`, `M3LZipTextExtractor`) are opt-in.
- **Optional dependencies.** The backing libraries (`unpdf`, `mammoth`, `read-excel-file`, `mailparser`, `cheerio`, `adm-zip`) are declared as optional `peerDependencies` (with `peerDependenciesMeta.<lib>.optional = true`), **not** runtime `dependencies`. The base install of `@m3l-automation/m3l-common` therefore pulls in none of them, honoring the minimal-runtime-dependencies constraint; a consumer installs only the libraries for the formats it actually extracts.
- **Lazy loading.** Each library-backed extractor performs a lazy dynamic `import()` of its backing library on the first `extract()` call — never at module load. Importing the `text` module, constructing the registry, or registering an extractor whose library is absent has no side effect until that extractor is actually invoked, so unused extractors never pull their library into the consumer's import graph.
- **Absent-library behavior.** When an optional extractor runs and its backing library is not installed, the failing dynamic `import()` is caught and re-thrown as a typed `M3LTextExtractionError` that names the missing peer dependency and carries the original module-resolution error as `cause`. The registry never surfaces a bare `ERR_MODULE_NOT_FOUND`.

## See also

- [`importers`](./importers.md) — structured record import (CSV, JSON, files).
- [`json`](./json.md) — JSON field extraction and format detection.
- [`storage`](./storage.md) — full-text indexing of extracted text.
- [`errors`](./errors.md) — the `M3LError` hierarchy these errors extend.
- [Capability index](../../guides/capability-index.md) — map of dependencies to the modules that use them.
- [Architecture overview](../../m3l-common-architecture.md) — authoritative spec.
