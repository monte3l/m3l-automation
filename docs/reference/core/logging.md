# Core / logging

Structured, multi-handler logging for `@m3l-automation/m3l-common`. A single `M3LLogger` fans each log event out to an ordered array of handlers — console, file, and JSON — and renders tables.

## Overview

`M3LLogger` manages an ordered array of handler instances and exposes typed methods for each kind of message. Every call produces an `M3LLogEvent` (carrying an `M3LLogEventCategory`) that each handler renders independently, so the same event can be colored on a terminal, queued to a file, and emitted as one JSON line for CloudWatch — all without subclassing the logger.

Three built-in handlers cover the common sinks, and a table formatter renders aligned, ANSI-aware tables. Helpers redact sensitive values before they reach a sink.

## Public API

Public surface (`logging/index.ts`):

- `M3LLogger` — the logger facade over an ordered handler array.
- `M3LLoggerOptions` — optional logger construction options (`correlationId`, `minLevel`).
- `M3LLogEvent` — the per-message event object (carries an optional `correlationId`).
- `M3LLogEventCategory` — the event category enum (ten categories).
- `M3LLogLevelFloor` — the categories accepted as a severity floor (see
  [Log levels](#log-levels-and-debug-mode)).
- `M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`, `M3LJsonLoggerHandler` — the three built-in handlers.
- `M3LConsoleLoggerHandlerOptions`, `M3LFileLoggerHandlerOptions`, `M3LJsonLoggerHandlerOptions` —
  per-handler construction options; each carries an optional `minLevel` sink floor
  (`M3LFileLoggerHandlerOptions` additionally carries the required `filePath`).
- `M3LTableFormatter`, `M3LTableOptions`, `M3LTableColumn` — table rendering.
- `redactSensitiveLogText`, `redactSensitiveLogValue` — redaction helpers.

### `M3LLogger` methods

`M3LLogger` exposes the typed methods:
`text`, `step`, `info`, `success`, `warning`, `error`, `fatal`, `section`, `header`, `newline`, `table`, `simpleTable`, `keyValueTable`, `errorFrom`, `time`.

### `M3LLogEventCategory`

Ten categories: `TEXT`, `STEP`, `SUCCESS`, `ERROR`, `FATAL`, `WARNING`, `HEADER`, `INFO`, `SECTION`, `DEBUG`.

### Log levels and debug mode

A tenth category, `DEBUG`, sits below every other and carries the library's own
diagnostic events (breadcrumbs, timings). The categories carry a severity ranking
used **solely** for floor comparison:

| Rank | Categories                                  |
| ---- | ------------------------------------------- |
| 0    | `DEBUG`                                     |
| 1    | `TEXT`, `STEP`, `INFO`, `SECTION`, `HEADER` |
| 2    | `SUCCESS`                                   |
| 3    | `WARNING`                                   |
| 4    | `ERROR`                                     |
| 5    | `FATAL`                                     |

The five rank-1 categories are **tied** — they are presentational groupings, not
severities. Because a floor of `TEXT`, `STEP`, `SECTION`, or `HEADER` would be
indistinguishable from `INFO`, the floor type `M3LLogLevelFloor` excludes those
four spellings and keeps `INFO` as the rank-1 representative. It is derived
(`Exclude<M3LLogEventCategory, …>`), so it cannot drift from the category set.
The ranking itself is internal and not exported.

- `M3LLoggerOptions.minLevel` sets the logger-wide severity floor; each built-in
  handler accepts the same option for a per-sink floor (e.g. console at `INFO`,
  file handler at `DEBUG`). Both default to **no floor — everything passes**, so
  a logger or handler constructed without one behaves exactly as it did before
  this phase. A logger floor and a handler floor compose: the stricter wins.
- An unrecognised `minLevel` (reachable only by casting past the type, e.g. from
  a config file) throws `M3LError` with code `ERR_INVALID_ARGUMENT` **at
  construction**, not at the first emitted event. Failing loudly at wiring time
  is deliberate: a floor that silently matched nothing would discard every log
  line, `FATAL` included.
- An event's category is compared against the floor in the logger's single
  dispatch path, so `newline()` and the three table methods — which all emit
  `TEXT` — are filtered out by any floor above `TEXT`.
- `logger.errorFrom(error, message?)` logs an `ERROR` event with the error's
  `code`, `context`, and the **full recursive cause chain** promoted to
  structured fields (via `serializeErrorChain` from
  [diagnostics](./diagnostics.md#formaterrorchain)) — unlike `serializeError`,
  which is single-level and omits `cause`. It takes `unknown` (it is called from
  a `catch`) and never throws, even when the caught value's own `message` or
  `stack` getter throws — it still emits the event rather than losing the
  failure it exists to report.
- `logger.time(label)` returns a plain callable that, when invoked, logs a
  `DEBUG` event carrying `label` and `durationMs` — the shared replacement for
  the inline `Date.now()` deltas the importer/network/credentials modules
  currently duplicate. It is deliberately **not** a `Disposable`: `Symbol.dispose`
  is unavailable under this project's `lib: ["es2024"]`, so `using` is not
  supported.

> **Not yet implemented** —
> [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) phase 4.
> Resolution from the config precedence chain (`--log-level` / `--debug` CLI
> flags > `M3L_LOG_LEVEL` / `M3L_DEBUG=1` environment > config file > default),
> including the one-switch `M3L_DEBUG=1` debug mode, ships with `runScript()`.
> It cannot live here: reading CLI flags and config requires `core/script`, and
> ADR-0009 Zone B forbids `core/logging` from importing it. Today `minLevel` is
> set by the caller when constructing the logger or a handler.

### Correlation IDs

Every `M3LLogEvent` carries an optional `correlationId?: string` — a per-run
trace identifier that lets a downstream system (CloudWatch Insights, a log
aggregator) group all the lines emitted during one script run or Lambda
invocation.

```typescript
interface M3LLoggerOptions {
  readonly correlationId?: string;
  readonly minLevel?: M3LLogLevelFloor;
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

- **Ordered handler array.** `M3LLogger` delegates each `M3LLogEvent` to every handler in array order; each handler decides independently how to render the event. When a `minLevel` floor is set, an event below the logger's floor is dropped before any handler sees it, and each handler additionally drops events below its own floor.
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
