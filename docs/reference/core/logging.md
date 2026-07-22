# Core / logging

Structured, multi-handler logging for `@m3l-automation/m3l-common`. A single `M3LLogger` fans each log event out to an ordered array of handlers — console, file, and JSON — and renders tables.

## Overview

`M3LLogger` manages an ordered array of handler instances and exposes typed methods for each kind of message. Every call produces an `M3LLogEvent` (carrying an `M3LLogEventCategory`) that each handler renders independently, so the same event can be colored on a terminal, queued to a file, and emitted as one JSON line for CloudWatch — all without subclassing the logger.

Three built-in handlers cover the common sinks, and a table formatter renders aligned, ANSI-aware tables. Helpers redact sensitive values before they reach a sink.

## Public API

Public surface (`logging/index.ts`):

- `M3LLogger` — the logger facade over an ordered handler array.
- `M3LLoggerOptions` — optional logger construction options (currently `correlationId`).
- `M3LLogEvent` — the per-message event object (carries an optional `correlationId`).
- `M3LLogEventCategory` — the event category enum (nine categories).
- `M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`, `M3LJsonLoggerHandler` — the three built-in handlers.
- `M3LTableFormatter`, `M3LTableOptions`, `M3LTableColumn` — table rendering.
- `redactSensitiveLogText`, `redactSensitiveLogValue` — redaction helpers.

### `M3LLogger` methods

`M3LLogger` exposes the typed methods:
`text`, `step`, `info`, `success`, `warning`, `error`, `fatal`, `section`, `header`, `newline`, `table`, `simpleTable`, `keyValueTable`.

### `M3LLogEventCategory`

Nine categories: `TEXT`, `STEP`, `SUCCESS`, `ERROR`, `FATAL`, `WARNING`, `HEADER`, `INFO`, `SECTION`.

### Log levels and debug mode

> **Status: specified, not yet implemented** —
> [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) phase 3.
> Today the logger has no level filtering: every event fans out to every
> handler unconditionally.

- A tenth category, `DEBUG`, sits below `TEXT` and carries the library's own
  diagnostic events (breadcrumbs, timings). The categories gain a severity
  ordering (`DEBUG < TEXT/STEP/INFO/SECTION/HEADER < SUCCESS < WARNING <
ERROR < FATAL`) solely for floor comparison — the category enum itself is
  unchanged.
- `M3LLoggerOptions.minLevel` sets the logger-wide severity floor (default:
  everything passes, preserving current behavior); each built-in handler
  accepts the same option for a per-sink floor (e.g. console at `INFO`, file
  handler at `DEBUG`).
- Resolution reuses the config precedence chain: `--log-level` / `--debug` CLI
  flags > `M3L_LOG_LEVEL` / `M3L_DEBUG=1` environment > config file > default.
  `M3L_DEBUG=1` is the one-switch debug mode: it drops the floor to `DEBUG`.
- `logger.errorFrom(error, message?)` logs an `ERROR` event with the error's
  `code`, `context`, and the **full recursive cause chain** promoted to
  structured fields (via `serializeErrorChain` from
  [diagnostics](./diagnostics.md#formaterrorchain)) — unlike `serializeError`,
  which is single-level and omits `cause`.
- `logger.time(label)` returns a disposer that logs a `DEBUG` event carrying
  `durationMs` — the shared replacement for the inline `Date.now()` deltas the
  importer/network/credentials modules currently duplicate.

### Correlation IDs

Every `M3LLogEvent` carries an optional `correlationId?: string` — a per-run
trace identifier that lets a downstream system (CloudWatch Insights, a log
aggregator) group all the lines emitted during one script run or Lambda
invocation.

```typescript
interface M3LLoggerOptions {
  readonly correlationId?: string;
}

// A logger constructed with a correlationId stamps it onto every event it emits.
new M3LLogger(handlers: readonly M3LLoggerHandler[], options?: M3LLoggerOptions);
```

- The constructor widens additively — `new M3LLogger(handlers)` keeps working
  unchanged; `new M3LLogger(handlers, { correlationId })` stamps the id onto the
  `correlationId` field of every event the logger dispatches.
- The `M3LJsonLoggerHandler` includes `correlationId` in the emitted JSON line
  when present; handlers that ignore the field keep working.
- `M3LScript` resolves one correlation id per run and exposes it on the hook
  context (`ctx.correlationId`, see
  [`script` → Correlation IDs](./script.md#correlation-ids)). It emits no log
  lines itself; to correlate your own logs, construct a logger with that id via
  the constructor option above (or seed it from `M3LScriptOptions.correlationId`,
  which you know up front).
- **Not redacted.** A correlation id is a tracing value, not a secret: the key
  `correlationId` matches no sensitive-key pattern, so
  `redactSensitiveLogValue` / `redactSensitiveLogText` pass it through
  untouched. It never displaces or short-circuits redaction of other fields.

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
- **`M3LJsonLoggerHandler`** emits one JSON line per event (one CloudWatch log entry per message) and promotes scalar fields from the event's `data` payload to the top level for easy CloudWatch Insights querying. Empty spacer events are dropped. Worked Insights queries (by `correlationId`, by category, by promoted fields) live in the [troubleshooting guide](../../guides/troubleshooting.md#5-correlation-ids-and-cloudwatch-insights).
- **Table rendering.** `M3LTableFormatter` supports per-column alignment and ANSI-aware width (via `string-width`). Three border styles are available: `full` (Unicode box-drawing characters `┌ ─ │ ├ ┤ └ ┐ ┘`), `border-less` (minimal characters), and `compact` (no border characters).

## See also

- [Core / events](./events.md)
- [Core / prompt](./prompt.md) — shares TTY-aware rendering
- [Core / errors](./errors.md)
- [Core / diagnostics](./diagnostics.md) — cause-chain serialization, run reports
- [Guide: Troubleshooting](../../guides/troubleshooting.md)
- [Architecture overview](../../m3l-common-architecture.md)
