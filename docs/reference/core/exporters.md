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

`TItem` is bound `TItem extends object` across the shared contracts
(`M3LListExporter`, `M3LListExporterStreamWriter`) and every concrete exporter
that implements them (`M3LCSVListExporter`, `M3LHTMLListExporter`,
`M3LJSONListExporter`). Row-shaped exporters read `TItem`'s keys, so a primitive
instantiation (`M3LListExporter<number>`) is a bug that would silently produce
empty rows — the bound rejects it at compile time instead. The standalone
whole-file `M3LFileListExporter` is not part of this contract (it `JSON`-serializes
the array wholesale and never reads keys), so it leaves `TItem` unbounded.

All list exporters extend `M3LEventEmitterBase` and define two modes:

- `export(items)` — **batch**: writes all items in one call.
- `exportStream()` — **streaming**: returns an `M3LListExporterStreamWriter<TItem>` exposing `append(item)`, `close()`, and `bytesWritten` (the running output size, for resume — see below).

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

### Resuming a streaming export

`exportStream()` truncates its target file on open by default — a caller
resuming an interrupted run must not simply reopen the same path. `resumeFromByte`
(on both `M3LJSONListExporterOptions` and `M3LCSVListExporterOptions`) makes a
streaming resume safe without buffering the run's output a second time:

```typescript
import { Core } from "@m3l-automation/m3l-common";

// First run: append until the process is interrupted.
const exporter = new Core.M3LJSONListExporter<{ id: string }>({
  filePath: "./data/outputs/records.jsonl",
});
const writer = exporter.exportStream();
await writer.append({ id: "1" });
const checkpointedOffset = writer.bytesWritten; // persist this, not the item

// Later, a resumed run:
const resumed = new Core.M3LJSONListExporter<{ id: string }>({
  filePath: "./data/outputs/records.jsonl",
  resumeFromByte: checkpointedOffset,
});
const resumedWriter = resumed.exportStream();
await resumedWriter.append({ id: "2" }); // appended after the offset, not truncated
await resumedWriter.close();
```

The contract, in three rules:

1. `resumeFromByte: n` truncates the output file to exactly `n` bytes, then
   appends. `undefined`/`0` is the default truncate-to-empty behavior.
2. `bytesWritten` (on `M3LListExporterStreamWriter`) is `resumeFromByte` plus
   every byte the writer has since had accepted by the underlying stream
   (not necessarily durably flushed to disk — see ADR-0045's Consequences)
   — the value to persist in a checkpoint, never the appended items
   themselves. `M3LHTMLListExporter` buffers every row until `close()`, so
   its `bytesWritten` reads `0` for the entire append phase.
3. **Ordering is load-bearing.** Call `append`, then read `bytesWritten`,
   then write the checkpoint — in that order. A crash anywhere in that
   window leaves the checkpoint behind the file; the next resume truncates
   away the un-checkpointed tail and redoes that work. Duplicate work,
   never lost or doubled output.

`M3LCSVListExporter` additionally requires `columns` (the exact, ordered
column set already written to the file) whenever `resumeFromByte > 0` —
otherwise the writer has no way to know the on-disk header, and construction
throws `ERR_CSV_EXPORT` synchronously. `columns` may also be supplied on a
fresh export (`resumeFromByte` unset) to pin the column set from the start
rather than deriving it from the first appended row's own keys.

`M3LHTMLListExporter` has no `resumeFromByte` option — a mid-document HTML
resume is incoherent (its closing tags are only ever written on a clean
`close()`), so it stays truncate-only.

`resumeFromByte` is only ever honored by `exportStream()`. The batch
`export(items)` method always writes the complete file fresh, ignoring any
`resumeFromByte` the exporter was constructed with — resume is a
streaming-only concern.

An invalid `resumeFromByte` fails in one of two distinct ways, depending on
what's wrong with it:

- **A malformed value** (negative, `NaN`, `Infinity`, or non-integer) throws
  synchronously **from the exporter's own constructor** — `new
Core.M3LJSONListExporter({ resumeFromByte: -1, ... })` throws immediately,
  before `exportStream()` is ever called.
- **A value larger than the target file's actual on-disk size** — which can
  happen after an unclean shutdown, since a write's callback fires once the
  OS accepts it, not once it is durably flushed — never throws synchronously
  and never silently truncates-and-pads with NUL bytes; it defers a
  rejection to the writer's first `append()`/`close()` call, chaining the
  real cause.

See ADR-0045 for the full design rationale.

Two format-specific edge cases worth knowing before relying on this in
production:

- **JSON array-format resume** requires the on-disk prefix to already be an
  unterminated array holding at least one item (a resumed writer primes
  itself to emit a leading `,` on the next append, and `]` on `close()`) —
  this only holds if the prior writer was never `close()`d before the crash;
  resuming past a cleanly-closed array (which already has its trailing `]`)
  produces malformed JSON. JSONL has no such constraint — a resumed line
  simply appends after the offset.
- **CSV resume** requires `columns` to be non-empty as well as present —
  `columns: []` with `resumeFromByte > 0` is rejected the same as an absent
  `columns`.

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
- [ADR-0045](../../adr/0045-streaming-safe-resume-contract.md) — the byte-offset resume design rationale.
