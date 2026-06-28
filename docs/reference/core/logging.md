# Core / logging

Structured, multi-handler logging for `@m3l-automation/m3l-common`. A single `M3LLogger` fans each log event out to an ordered array of handlers — console, file, and JSON — and renders tables.

## Overview

`M3LLogger` manages an ordered array of handler instances and exposes typed methods for each kind of message. Every call produces an `M3LLogEvent` (carrying an `M3LLogEventCategory`) that each handler renders independently, so the same event can be colored on a terminal, queued to a file, and emitted as one JSON line for CloudWatch — all without subclassing the logger.

Three built-in handlers cover the common sinks, and a table formatter renders aligned, ANSI-aware tables. Helpers redact sensitive values before they reach a sink.

## Public API

Public surface (`logging/index.ts`):

- `M3LLogger` — the logger facade over an ordered handler array.
- `M3LLogEvent` — the per-message event object.
- `M3LLogEventCategory` — the event category enum (nine categories).
- `M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`, `M3LJsonLoggerHandler` — the three built-in handlers.
- `M3LTableFormatter`, `M3LTableOptions`, `M3LTableColumn` — table rendering.
- `redactSensitiveLogText`, `redactSensitiveLogValue` — redaction helpers.

> Note: the architecture overview lists this category type once as `M3LLogEventCateM3Lry`; that is a typo. The correct exported name is **`M3LLogEventCategory`**.

### `M3LLogger` methods

`M3LLogger` exposes the typed methods:
`text`, `step`, `info`, `success`, `warning`, `error`, `fatal`, `section`, `header`, `newline`, `table`, `simpleTable`, `keyValueTable`.

### `M3LLogEventCategory`

Nine categories: `TEXT`, `STEP`, `SUCCESS`, `ERROR`, `FATAL`, `WARNING`, `HEADER`, `INFO`, `SECTION`.

## Usage examples

### Composing handlers

```typescript
import { Core } from "@m3l-automation/m3l-common";

// Handlers run in array order; add JSON output for CloudWatch with no subclassing.
const logger = new Core.M3LLogger([
  new Core.M3LConsoleLoggerHandler(),
  new Core.M3LFileLoggerHandler({ filePath: "run.log" }),
  new Core.M3LJsonLoggerHandler(),
]);

logger.header("Import run");
logger.step("Reading source file");
logger.success("Imported 1200 rows");
logger.warning("3 rows skipped");
```

### Rendering a table

```typescript
import { Core } from "@m3l-automation/m3l-common";

logger.table(
  [
    { profile: "prod", rows: 1200 },
    { profile: "staging", rows: 42 },
  ],
  { border: "full" },
);

logger.keyValueTable({ region: "eu-south-1", mode: "standalone" });
```

### Redacting sensitive data

```typescript
import { Core } from "@m3l-automation/m3l-common";

const safeText = Core.redactSensitiveLogText("token=abc123 user=alice");
const safeValue = Core.redactSensitiveLogValue({ apiKey: "secret" });
```

## Notes and behavior

- **Ordered handler array.** `M3LLogger` delegates each `M3LLogEvent` to every handler in array order; each handler decides independently how to render the event.
- **`M3LConsoleLoggerHandler`** writes to `process.stdout` / `process.stderr` with ANSI colors and indentation, and automatically disables colors in non-TTY contexts (Lambda, CI, a pipe) to keep logs machine-readable.
- **`M3LFileLoggerHandler`** streams to a file through a `M3LFileListExporter`, maintaining an internal sequential write queue to preserve ordering under concurrent emits. Its `reset()` is intentionally a no-op so logs are not lost across script resets.
- **`M3LJsonLoggerHandler`** emits one JSON line per event (one CloudWatch log entry per message) and promotes scalar fields from the event's `data` payload to the top level for easy CloudWatch Insights querying. Empty spacer events are dropped.
- **Table rendering.** `M3LTableFormatter` supports per-column alignment and ANSI-aware width (via `string-width`). Three border styles are available: `full` (Unicode box-drawing characters `┌ ─ │ ├ ┤ └ ┐ ┘`), `border-less` (minimal characters), and `compact` (no border characters).

## See also

- [Core / events](./events.md)
- [Core / prompt](./prompt.md) — shares TTY-aware rendering
- [Core / errors](./errors.md)
- [Architecture overview](../../m3l-common-architecture.md)
