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
- `M3LJSONFileImporter`
- `M3LJSONListImporter`, `M3LJSONListImporterOptions`
- `M3LFileListImporter`
- `M3LTextFileImporter`

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

| Event              | Emitted when                    |
| ------------------ | ------------------------------- |
| `import:started`   | Parsing begins                  |
| `import:item`      | A single item has been parsed   |
| `import:progress`  | Periodic progress update        |
| `import:error`     | A record (or the source) failed |
| `import:completed` | Parsing finished                |

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

- **CSV transformation pipeline** — `M3LCSVListImporter` is backed by `csv-parse`. File-path sources are streamed; buffer sources are processed in memory. Each row passes through, in order: **column mapping → default values → row validator → row transformer**. `M3LCSVFormatAdapter` and `M3LCSVAdapterFactory` provide reusable column/format adapters configured through `M3LCSVListImporterOptions`.
- **JSON format dispatch** — `M3LJSONListImporter` dispatches to JSON-array parsing or JSONL (newline-delimited JSON) line-by-line streaming based on the detected format. Nested values are extracted with dot-notation **field paths** (for example, `metadata.author`).
- **Format detection** — detection (via `M3LJSONFormatDetector`) supports four depth levels — `extension`, `shallow` (first byte), `standard` (first N lines), and `deep` (sample of middle/end) — returning `{ format: 'json' | 'jsonl' | 'unknown', confidence, method }`. See [json](./json.md).
- **Handler isolation** — because list importers extend `M3LEventEmitterBase`, an error thrown by one event handler does not prevent the other handlers from running.

## See also

- [exporters](./exporters.md) — the write side, mirroring batch/streaming.
- [json](./json.md) — field paths and format detection.
- [events](./events.md) — the typed event emitter base.
- [files](./files.md) — archiving processed input files.
