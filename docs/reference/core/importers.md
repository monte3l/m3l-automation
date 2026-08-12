# Core `importers`

Streaming and batch file parsing for CSV, JSON/JSONL, and text sources. Every list importer is event-driven and offers both an all-at-once batch API and an async-generator streaming API.

## Overview

The `importers` module reads structured data from files (or in-memory buffers) and turns each record into a typed item. List importers share a single contract, `M3LListImporter<TItem>`, and extend `M3LEventEmitterBase`, so progress, per-item, and error events are emitted as parsing proceeds. Format-specific importers add their own options:

- **CSV** — `M3LCSVListImporter` runs a transformation pipeline (column mapping, defaults, validation, transformation) on every row.
- **JSON / JSONL** — `M3LJSONListImporter` dispatches between JSON-array parsing and newline-delimited JSON streaming based on the detected format, and supports dot-notation field paths for nested extraction.
- **Text** — `M3LTextFileImporter` reads plain text content.
- **Whole-file** — `M3LFileImporter`, `M3LJSONFileImporter`, and `M3LFileListImporter` cover file-level reads.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols:

- `M3LFileImporter`
- `M3LListImporter` — the `M3LListImporter<TItem>` contract
- `M3LListImporterEvents` — the event map type
- `M3LListImporterResult` — batch result type
- `M3LImportStreamSummary` — the streaming return summary (skip count)
- `M3LCSVListImporter`, `M3LCSVListImporterOptions`
- `M3LCSVFormatAdapter`, `M3LCSVAdapterFactory`
- `M3LJSONFileImporter`, `M3LJSONFileImporterOptions`
- `M3LJSONListImporter`, `M3LJSONListImporterOptions`
- `M3LFileListImporter`
- `M3LTextFileImporter`, `M3LTextFileImporterOptions`

### The `M3LListImporter<TItem>` contract

All list importers extend `M3LEventEmitterBase` and implement `M3LListImporter<TItem>`, which defines two access patterns:

- `import(source)` — **batch**: returns all items at once, in an
  `M3LListImporterResult` that includes the record-level `errors[]`.
- `importStream(source)` — **streaming**: an async generator that yields items
  one by one and, on completion, **returns** an `M3LImportStreamSummary`
  (`{ processed, skipped, durationMs }`) as the generator's return value. This
  closes the batch/streaming asymmetry: the malformed-record `skipped` count is
  available directly from the stream, without subscribing to `import:error`.
  Existing `for await … of` consumers ignore the return value and are
  unaffected; a caller that wants the summary captures it from the loop's
  completion (see the JSON/JSONL example below).

### Event map (`M3LListImporterEvents`)

List importers emit the following events, each carrying a structured payload (item, index, processed count, duration, and similar):

| Event              | Emitted when                                         |
| ------------------ | ---------------------------------------------------- |
| `import:started`   | Parsing begins                                       |
| `import:item`      | A single item has been parsed                        |
| `import:progress`  | Periodic progress update                             |
| `import:error`     | A record (or the source) failed                      |
| `import:completed` | Parsing finished (see per-method firing rules below) |

## Usage

### Batch import (CSV)

```typescript
import { Core } from "@m3l-automation/m3l-common";

const importer = new Core.M3LCSVListImporter<{ id: string; name: string }>({
  filePath: "./data/inputs/users.csv",
});

importer.on("import:error", (payload) => {
  console.error("row failed", payload);
});

const result = await importer.import("./data/inputs/users.csv");
for (const user of result.items) {
  // ...
}
```

### Streaming import (CSV)

```typescript
import { Core } from "@m3l-automation/m3l-common";

const importer = new Core.M3LCSVListImporter<{ id: string; name: string }>({
  filePath: "./data/inputs/users.csv",
});

importer.on("import:progress", (payload) => {
  // update a progress indicator
});

for await (const user of importer.importStream("./data/inputs/users.csv")) {
  // process one item at a time; memory stays bounded
}
```

### JSON / JSONL with field paths

```typescript
import { Core } from "@m3l-automation/m3l-common";

const importer = new Core.M3LJSONListImporter<{ author: string }>({
  // extract a nested value via dot notation
  fieldPath: "metadata.author",
});

// Simple consumption ignores the return value (existing behavior, unaffected):
for await (const item of importer.importStream("./data/inputs/records.jsonl")) {
  // ...
}

// To read the skip count, drive the generator manually and capture its return:
const stream = importer.importStream("./data/inputs/records.jsonl");
let step = await stream.next();
while (step.done !== true) {
  const item = step.value;
  // ...process one item at a time; memory stays bounded
  step = await stream.next();
}
const summary = step.value; // M3LImportStreamSummary
console.log(
  `skipped ${String(summary.skipped)} of ${String(summary.processed)}`,
);
```

## Notes and behavior

- **CSV transformation pipeline** — `M3LCSVListImporter` is backed by `csv-parse`. The source (file-path or `Buffer`) is fully read into memory first (bounded by `maxBytes`, below); `csv-parse` then parses it row-by-row via its async-iterator API, so both source kinds yield identical items one row at a time rather than requiring the whole parsed result up front. Each row passes through, in order: **column mapping → default values → row validator → row transformer**. `M3LCSVFormatAdapter` and `M3LCSVAdapterFactory` provide reusable column/format adapters configured through `M3LCSVListImporterOptions`.
- **JSON format dispatch** — `M3LJSONListImporter` dispatches to JSON-array parsing or JSONL (newline-delimited JSON) line-by-line streaming based on the detected format. Nested values are extracted with dot-notation **field paths** (for example, `metadata.author`).
- **Format detection** — detection (via `M3LJSONFormatDetector`) supports four depth levels — `extension`, `shallow` (first byte), `standard` (first N lines), and `deep` (sample of middle/end) — returning `{ format: 'json' | 'jsonl' | 'unknown', confidence, method }`. See [json](./json.md).
- **Handler isolation** — because list importers extend `M3LEventEmitterBase`, an error thrown by one event handler does not prevent the other handlers from running.
- **`import:completed` firing rules differ between the batch and streaming methods.** `import()` emits it once, after every record has been processed (or skipped) — never on a thrown source/parse/bound error, since the method aborts before reaching the emit. `importStream()` emits it on graceful exit only: a full drain, or a consumer abandoning the generator early (`break`ing a `for await` loop, or calling `.return()` on the generator handle) — carrying the `processed`/`durationMs` counts as they stood at that point. It is deliberately **not** emitted when `importStream()`'s internal parsing throws (an unreadable source, a format-detection failure, a malformed JSON-array document, or an exceeded `maxRows` bound — see below): the underlying `Promise` rejects and the event is withheld, so a failed streaming run is never misreported as completed.
- **Bounded input — `maxBytes` / `maxRows`, opt-in and unbounded by default.** Each of the four importers that accept constructor options — `M3LCSVListImporter`, `M3LJSONListImporter`, `M3LTextFileImporter`, `M3LJSONFileImporter` — accepts an optional `maxBytes`; the two list importers additionally accept `maxRows`. Both default to `undefined` (unbounded), matching today's behavior exactly when omitted. (`M3LFileImporter` and `M3LFileListImporter` read file-path/`Buffer` sources too but take no options at all — their reads stay unbounded.)
  - **Constructor validation.** A defined `maxBytes`/`maxRows` must be a positive integer (`Number.isInteger(value) && value >= 1`); an invalid value (`0`, negative, non-integer, `NaN`) throws `M3LError` code `ERR_INVALID_ARGUMENT` immediately at construction, before any `read()`/`import()`/`importStream()` call.
  - **`maxBytes` is checked twice: a pre-read fast-path, and a post-read backstop.** For a file-path source, the file is `stat`-ed first; if its reported size exceeds `maxBytes`, `M3LError` code `ERR_IMPORT_SOURCE` is thrown and `readFile` is never called — an obviously-oversized regular file is never buffered. For a `Buffer` source, its `.length` is checked directly, before any further work. But a `stat`-reported size can lie — a FIFO or a `/proc` entry can report a size of `0` while still yielding arbitrarily many bytes, and a regular file can grow between the `stat` call and the read (TOCTOU) — so the bytes `readFile` actually returns are checked again against `maxBytes` immediately after the read, throwing the same `ERR_IMPORT_SOURCE` if the pre-read check was fooled. This two-layer check mirrors the validate-before-buffering discipline `M3LHttpClient`'s `maxResponseBytes` option uses (see [network](./network.md)), with the addition of the post-read backstop non-regular-file sources need.
  - **`maxRows` bounds total rows/records attempted, not just successful ones** — a skipped or failed row still counts toward the cap. Once the `(maxRows + 1)`-th row would be processed, `import()`/`importStream()` throws `M3LError` code `ERR_IMPORT_VALIDATION` instead of processing it: `import()` rejects the whole call (no partial `items`/`errors` result), and `importStream()`'s generator throws on the offending iteration (`import:completed` is withheld, per the firing rule above). A source with exactly `maxRows` rows completes normally — the cap only trips on the row _past_ it. For `M3LCSVListImporter` specifically, the bound is also enforced **while feeding the parser**, not only while consuming its output: the source is written to `csv-parse` in bounded chunks rather than as one whole-buffer write, with the running skip count checked between chunks, so a source that is entirely (or mostly) malformed rows is bounded to roughly the one chunk that tripped `maxRows` rather than being fully parsed regardless of the cap. `M3LJSONListImporter`'s JSON-array format has no equivalent chunked-feed concern — `JSON.parse` on the whole document is a single unavoidable step already bounded by `maxBytes` — but it means `maxRows` cannot bound the cost of that one parse call the way it can for JSONL's line-by-line format.
  - `M3LListImporter`'s shared contract and result/summary types (`M3LListImporterResult`, `M3LImportStreamSummary`) are unchanged — bounding is a constructor-time opt-in on each concrete importer, not part of the shared interface.

## See also

- [exporters](./exporters.md) — the write side, mirroring batch/streaming.
- [json](./json.md) — field paths and format detection.
- [events](./events.md) — the typed event emitter base.
- [files](./files.md) — archiving processed input files.
