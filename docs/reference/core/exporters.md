# Core `exporters`

Streaming and batch file export for CSV, JSON/JSONL, HTML, and binary outputs. List exporters mirror the importer contract, offering an all-at-once batch API and an incremental streaming writer.

## Overview

The `exporters` module writes typed items to files. List exporters share the `M3LListExporter<TItem>` contract, extend `M3LEventEmitterBase`, and write through an `fs.WriteStream`. Format-specific exporters add their own options:

- **CSV** — `M3LCSVListExporter` uses `csv-stringify` and resolves column conflicts between generated and original row data via a `ColumnConflictStrategy`.
- **JSON / JSONL** — `M3LJSONListExporter` supports both a JSON array and JSONL; `M3LJSONFileExporter` writes a whole-file JSON document.
- **HTML** — `M3LHTMLListExporter` renders a `{{count}}` / `{{items}}` / `{{date}}` template.
- **Binary / whole-file** — `M3LBinaryFileExporter`, `M3LFileExporter`, and `M3LFileListExporter` cover file-level writes.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols:

- `M3LListExporter` — the `M3LListExporter<TItem>` contract
- `M3LListExporterStreamWriter` — the `M3LListExporterStreamWriter<TItem>` returned by `exportStream()`
- `M3LListExporterEvents` — the `export:*` event map shared by every list exporter, plus its payload types `M3LListExporterStartedPayload`, `M3LListExporterCompletedPayload`, and `M3LListExporterErrorPayload`
- `ColumnConflictStrategy` — `'keep-generated' | 'keep-original'`, used by `M3LCSVListExporter`
- `M3LCSVListExporter` (plus `M3LCSVListExporterOptions`)
- `M3LJSONListExporter` (plus `M3LJSONListExporterOptions` and `M3LJSONListExporterFormat`, the `'array' | 'jsonl'` union backing `options.format`)
- `M3LHTMLListExporter` (plus `M3LHTMLListExporterOptions`)
- `M3LFileExporter` (plus `M3LFileExporterOptions`)
- `M3LJSONFileExporter` (plus `M3LJSONFileExporterOptions`)
- `M3LBinaryFileExporter` (plus `M3LBinaryFileExporterOptions`)
- `M3LFileListExporter` (plus `M3LFileListExporterOptions`)

### The `M3LListExporter<TItem>` contract

All list exporters extend `M3LEventEmitterBase` and define two modes:

- `export(items)` — **batch**: writes all items in one call.
- `exportStream()` — **streaming**: returns an `M3LListExporterStreamWriter<TItem>` exposing `append(item)` and `close()`.

### Event map

List exporters emit:

| Event              | Emitted when                              |
| ------------------ | ----------------------------------------- |
| `export:started`   | Writing begins                            |
| `export:completed` | Writing finished and the stream is closed |
| `export:error`     | A write or serialization failed           |

## Usage

### Batch export (CSV)

```typescript
import { Core } from "@m3l-automation/m3l-common";

const exporter = new Core.M3LCSVListExporter<{ id: string; name: string }>({
  filePath: "./data/outputs/users.csv",
});

exporter.on("export:error", (payload) => {
  console.error("export failed", payload);
});

await exporter.export([
  { id: "1", name: "Ada" },
  { id: "2", name: "Linus" },
]);
```

### Streaming export (CSV)

```typescript
import { Core } from "@m3l-automation/m3l-common";

const exporter = new Core.M3LCSVListExporter<{ id: string; name: string }>({
  filePath: "./data/outputs/users.csv",
});

const writer = exporter.exportStream();
for await (const user of source) {
  await writer.append(user);
}
await writer.close();
```

### JSON array vs JSONL

```typescript
import { Core } from "@m3l-automation/m3l-common";

// Array: writer emits `[` on open, `]` on close, commas between items.
const arrayExporter = new Core.M3LJSONListExporter<{ id: string }>({
  filePath: "./data/outputs/records.json",
});
await arrayExporter.export([{ id: "1" }, { id: "2" }]);

// JSONL: one JSON object per line; no surrounding brackets.
const jsonlExporter = new Core.M3LJSONListExporter<{ id: string }>({
  filePath: "./data/outputs/records.jsonl",
});
const writer = jsonlExporter.exportStream();
await writer.append({ id: "1" });
await writer.close();
```

## Notes and behavior

- **CSV column conflicts** — `M3LCSVListExporter` uses `csv-stringify` over an `fs.WriteStream`. When merging original row data, column name collisions are resolved by `ColumnConflictStrategy`: `'keep-generated'` or `'keep-original'`.
- **JSON vs JSONL** — `M3LJSONListExporter` supports both the JSON array format and JSONL. In streaming array mode it writes `[` on open and `]` on close, inserting commas between items; in JSONL mode it writes neither bracket.
- **HTML templating** — `M3LHTMLListExporter` substitutes `{{count}}` (number of items), `{{items}}` (the rendered rows), and `{{date}}` into a template, with configurable column selection and ordering.
- **Binary / whole-file** — `M3LBinaryFileExporter` writes raw binary content; `M3LFileExporter` and `M3LFileListExporter` write whole-file outputs.
- **Handler isolation** — list exporters extend `M3LEventEmitterBase`, so a failing event handler does not stop the others.

## See also

- [importers](./importers.md) — the read side, mirroring batch/streaming.
- [files](./files.md) — archiving generated output files.
- [json](./json.md) — JSON field paths and format detection.
- [events](./events.md) — the typed event emitter base.
