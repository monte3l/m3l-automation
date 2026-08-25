# Core / logging

Structured, multi-handler logging for `@m3l-automation/m3l-common`. A single `M3LLogger` fans each log event out to an ordered array of handlers — console, file, and JSON — and renders tables.

## Overview

`M3LLogger` manages an ordered array of handler instances and exposes typed methods for each kind of message. Every call produces an `M3LLogEvent` (carrying an `M3LLogEventCategory`) that each handler renders independently, so the same event can be colored on a terminal, queued to a file, and emitted as one JSON line for CloudWatch — all without subclassing the logger.

Three built-in handlers cover the common sinks, and a table formatter renders aligned, ANSI-aware tables. Helpers redact sensitive values before they reach a sink.

## Public API

Public surface (`logging/index.ts`):

- `M3LLogger` — the logger facade over an ordered handler array.
- `M3LLoggerOptions` — optional logger construction options (`correlationId`, `minLevel`, `secrets`).
- `M3LErrorFromOptions` — optional third-parameter options for `errorFrom` (`{ secrets? }`), additively widening redaction for that one call only.
- `M3LLogEvent` — the per-message event object (carries an optional `correlationId`).
- `M3LLoggerHandler` — the handler port (`handle(event): void` / `reset(): void`)
  implemented by the three built-in handlers, exported so consumers can write
  their own custom handlers.
- `M3LLogEventCategory` — the event category enum (ten categories).
- `M3LLogLevelFloor` — the categories accepted as a severity floor (see
  [Log levels](#log-levels-and-debug-mode)).
- `M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`, `M3LJsonLoggerHandler` — the three built-in handlers.
- `M3LConsoleLoggerHandlerOptions`, `M3LFileLoggerHandlerOptions`, `M3LJsonLoggerHandlerOptions` —
  per-handler construction options; each carries an optional `minLevel` sink floor
  (`M3LFileLoggerHandlerOptions` additionally carries the required `filePath`).
- `M3LTableFormatter`, `M3LTableOptions`, `M3LTableColumn` — table rendering.
- `redactSensitiveLogText`, `redactSensitiveLogValue` — redaction helpers.
- `M3LSecretNamesPort` — a structural port (`isSecret(name): boolean`)
  consulted through the optional `secrets` field of `M3LRedactOptions`; see
  [Redacting with a declared secrets specifier](#redacting-with-a-declared-secrets-specifier).
- `M3LRedactOptions` — the optional second argument accepted by both
  redaction helpers (`{ secrets?: M3LSecretNamesPort }`).

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
- `logger.errorFrom(error, message?, options?)` logs an `ERROR` event with the
  error's `code`, `context`, and the **full recursive cause chain** promoted
  to structured fields (via `serializeErrorChain` from
  [diagnostics](./diagnostics.md#formaterrorchain)) — unlike `serializeError`,
  which is single-level and omits `cause`. It takes `unknown` (it is called from
  a `catch`) and never throws, even when the caught value's own `message` or
  `stack` getter throws, or `options.secrets` is hostile — a throwing
  _accessor_ on the `secrets` property itself is guarded at the read; a
  throwing `isSecret` _implementation_ is guarded per name (conservatively
  redacting that one name and reporting a best-effort stderr diagnostic)
  before the merged port ever reaches `serializeErrorChain`, whose own body
  swallows an unguarded throw silently and with no diagnostic — so the real
  chain is preserved rather than replaced wholesale by a generic
  placeholder. `options?.secrets` (`M3LErrorFromOptions`) additively widens
  redaction for this one call, merged with the logger's own constructor-level
  `M3LLoggerOptions.secrets`.
- `logger.time(label)` returns a plain callable that, when invoked, logs a
  `DEBUG` event carrying `label` and `durationMs` — the shared replacement for
  the inline `Date.now()` deltas the importer/network/credentials modules
  currently duplicate. It is deliberately **not** a `Disposable`: `Symbol.dispose`
  is unavailable under this project's configured `lib` target (the disposable
  types live in `lib.esnext.disposable.d.ts`, not yet folded into a stable
  `esYYYY` lib), so `using` is not supported.

#### Resolving `minLevel` from CLI / environment ([`M3LScript`])

When [`M3LScript`](./script.md) builds its **default** logger (i.e. the caller
did not pass an `options.logger`), it resolves that logger's `minLevel` floor
from the ambient CLI arguments and environment
([ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) phase **4b**),
so an operator can raise or lower verbosity without editing the composition
root. Precedence, highest first:

| Tier    | Source                                           | Yields                       |
| ------- | ------------------------------------------------ | ---------------------------- |
| CLI     | `--log-level=<floor>`, else `--debug`            | that floor, else `DEBUG`     |
| env     | `M3L_LOG_LEVEL=<floor>`, else `M3L_DEBUG` truthy | that floor, else `DEBUG`     |
| default | neither set                                      | no floor (everything passes) |

- The value vocabulary is the six `M3LLogLevelFloor` names
  (`debug`/`info`/`success`/`warning`/`error`/`fatal`), matched
  **case-insensitively** and trimmed. An out-of-vocabulary explicit value — or a
  valueless `--log-level` — throws `M3LError` (`ERR_INVALID_ARGUMENT`) **at
  construction**, consistent with the loud-failure rule above. The
  `--debug`/`M3L_DEBUG` toggles are presence/truthiness switches (`M3L_DEBUG` on
  for `1`/`true`); they never throw.
- A **caller-supplied `options.logger` is never touched** and opts out of this
  resolution entirely — the CLI/env floor applies only to the logger `M3LScript`
  constructs for you.
- **Config-file tier — deliberately not supported.** ADR-0035 §2.5 originally
  listed a `config file` tier below `env`; it was dropped in phase 4b. A
  config-file floor cannot influence the logs emitted _during_ config load (the
  floor would only be known afterward), and applying it to the
  already-constructed default logger would require either a public mutator on
  `M3LLogger` or rebuilding the logger (breaking identity for holders of
  `script.logger`). CLI + env cover the operational need. See the
  [ADR §2.5 carve-out](../../adr/0035-failure-reporting-and-diagnostics.md#25-log-levels-and-the-debug-toggle-logging).

Outside `M3LScript`, `minLevel` is still set by the caller when constructing the
logger or a handler directly.

[`M3LScript`]: ./script.md

### Correlation IDs

Every `M3LLogEvent` carries an optional `correlationId?: string` — a per-run
trace identifier that lets a downstream system (CloudWatch Insights, a log
aggregator) group all the lines emitted during one script run or Lambda
invocation.

```typescript
interface M3LLoggerOptions {
  readonly correlationId?: string;
  readonly minLevel?: M3LLogLevelFloor;
  readonly secrets?: M3LSecretNamesPort | undefined;
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

By default, both helpers redact by a built-in heuristic key-name match only
(`SENSITIVE_KEY_NAMES` internally — common names like `apiKey`, `password`,
`token`). A parameter name that doesn't match that list is not redacted unless
declared secret and threaded through explicitly (below).

### Redacting with a declared secrets specifier

Both helpers accept an optional second `options` argument carrying a
`secrets` field that satisfies the structural `M3LSecretNamesPort` port:

```typescript
interface M3LSecretNamesPort {
  readonly isSecret: (name: string) => boolean;
}

interface M3LRedactOptions {
  readonly secrets?: M3LSecretNamesPort | undefined;
}
```

`M3LSecretsSpecifier` (`core/config`) satisfies this port, most commonly built
from a script's own schema via
[`deriveSecretsSpecifier`](./config.md#derivesecretsspecifier):

```typescript
import { Core } from "@m3l-automation/m3l-common";

const secrets = script.configSchema
  ? Core.deriveSecretsSpecifier(script.configSchema)
  : undefined;
const safeValue = Core.redactSensitiveLogValue(payload, { secrets });
```

A supplied port is **additive only** — it can only widen what gets redacted,
never narrow it. A key the built-in heuristic already matches (e.g.
`apiKey`) stays redacted even when the port doesn't declare it; a key the
port declares secret (e.g. a schema-declared `tenantRef` that the heuristic
wouldn't otherwise catch) is redacted because it was declared. The `options`
argument is optional and every existing single-argument call site is
unaffected — passing nothing (or `{}`, or `{ secrets: undefined }`) keeps the
byte-identical heuristic-only behavior. Any plain object literal implementing
`isSecret` works; importing `M3LSecretsSpecifier` specifically is not
required.

**Scope limitation — deliberate, not a bug.** `redactSensitiveLogText` runs
three internal passes: a quoted `"key": "value"` pass, a bare `key=value`
pass, and a third, heuristic-only pass that finds a sensitive word _embedded_
inside another field's value (e.g. `url=https://x/?token=abc`). The `secrets`
port is consulted on the first two passes only — **not** the third. That
third pass is built once, at module load, into a single precompiled regular
expression derived from the fixed built-in key-name list; extending it to an
arbitrary, mutable, caller-supplied name set would mean rebuilding that regex
on every call from untrusted-shape input, reopening the catastrophic-backtracking
class of bug the fixed pattern was specifically hardened against. So a
declared secret embedded inside another value (`url=https://x/?tenant-ref=abc`)
is **not** redacted by the port — only a _top-level_ `tenant-ref=...` pair
is. Route a value expected to embed a secret through `redactSensitiveLogValue`
on its own field instead of relying on the embedded-value pass to catch it.

**Production consumers.** `core/diagnostics`'s `M3LBreadcrumbTrail`,
`M3LRunReporter`, and `formatErrorChain`/`serializeErrorChain` each accept an
optional `secrets: M3LSecretNamesPort` constructor/options field that reaches
these two helpers. `M3LBreadcrumbTrail` and `M3LRunReporter` wrap it once, at
construction, in the same per-name throw guard described below; a direct
`formatErrorChain`/`serializeErrorChain` call still receives the caller's port
unguarded. `core/script`'s `runScript()` and
`M3LScript` each derive their own copy from the running script's own config
schema; both register their declared secret names into the same
process-global union the process-fault guards (`unhandledRejection`/
`uncaughtException`/`warning`) consult, so either composition root — a
`runScript()`-managed run, a bare `M3LScript.run()`, or a
`createLambdaHandler()` invocation — widens that shared union regardless of
which one a caller uses (the union is append-only and never narrowed; see
`core/script/process-guards`'s `addProcessGuardSecretNames`). `runScript()`
additionally wires `M3LRunReporter`; `M3LScript` additionally wires its own
lifecycle-hook and shutdown-signal diagnostics — those two remain
composition-root-specific. `M3LBreadcrumbTrail` is the one sink neither ever
constructs — it stays caller-managed, so a trail only gets widened redaction
when its own caller passes `secrets` at construction.
`M3LLogger` itself redacts **every** event it dispatches (F28,
[docs/plans/IMPLEMENTATION.md](../../plans/IMPLEMENTATION.md) row F28) —
`message`, `data`, and rendered table output alike — before any handler ever
sees it: the built-in key-name heuristic runs unconditionally, with no
opt-out, on every one of `M3LLogger`'s message methods (`text`/`step`/`info`/
`success`/`warning`/`error`/`fatal`/`section`/`header`/`newline`/`errorFrom`/
`time`/`table`/`simpleTable`/`keyValueTable`). `M3LLoggerOptions.secrets`
additively widens that heuristic for every event a given logger dispatches,
mirroring every other sink's `M3LRedactOptions.secrets` contract; `errorFrom`'s
own third parameter, `M3LErrorFromOptions.secrets`, additively widens
redaction for that one call only, merged (union, never narrowed) with the
logger's own constructor-level `secrets`. `run-script.ts`'s `handleRunFailure`
— the `script.logger.errorFrom(error)` call every failed `runScript()` run
makes — passes its own derived `secrets` here, and `M3LScript`'s default
logger (built when the caller omits `options.logger`) is constructed with
`secrets: this.secrets` too, so both composition roots' declared secrets now
reach the console/file/JSON sinks the same way they already reached
`M3LBreadcrumbTrail`/`M3LRunReporter`/`serializeErrorChain`. **A
caller-supplied `options.logger` is never touched and does not receive this
widening automatically** — `M3LLogger` has no post-construction way to widen
an already-built instance's redaction (`secrets` is set once, at
construction), so a caller who wants widened redaction on their own logger
must pass `secrets` at that logger's own construction; this mirrors the
existing `minLevel`-resolution carve-out for a caller-supplied logger (see
[Resolving `minLevel` from CLI / environment](#resolving-minlevel-from-cli--environment-m3lscript)
above) and `M3LBreadcrumbTrail`'s own "caller-managed" limitation (below).
Table redaction runs on the **structured row data**, before rendering — the
rendered table string has no `:`/`=` separator for the regex-based redactor
to key on, so redacting only the rendered string (an earlier draft of this
fix) is a no-op; a final pass over the fully-rendered string is still run
afterward as cheap, idempotent defense-in-depth. A throwing
`secrets.isSecret` implementation is guarded **per name**: the throw is
caught right at the call site, reported via a best-effort stderr diagnostic,
and that one name is conservatively treated as secret (redacted) — so the
rest of the message/data (and, for `errorFrom`, the rest of the error chain)
is preserved rather than lost wholesale. A genuinely _structural_ redaction
failure (a circular or excessively deep payload) is caught by an outer,
last-resort try/catch around the whole redaction step, substituting a fixed
placeholder message and reporting the same kind of diagnostic — mirroring
`M3LBreadcrumbTrail.record()`'s identical "must never propagate" guarantee
over the same underlying redaction call. See
[`diagnostics`](./diagnostics.md#public-api)'s redaction-guarantees note for
the other sinks' equivalent contract.

**Known limitation, shared with every other `redactSensitiveLogValue`/
`redactSensitiveLogText` consumer (not introduced or worsened by F28) —
tracked separately as a follow-up:** a declared (non-heuristic) secret's
`key=value` pair can be swallowed, unredacted, when it is immediately
preceded — with nothing to stop the value class before it — by an unrelated
`word:`/`word=` sequence, because pass 1's bare-value class has no
whitespace/separator boundary short of the next comma, semicolon, or
whitespace; and a value with no own enumerable string-keyed properties
(`Date`, `Map`, `Set` — their state lives outside what `Object.entries` can
see) is silently replaced with `{}`. This is **not** because such a value is
excluded from recursion — an ordinary class instance's own fields _are_
recursed into and redacted correctly, the same as a plain object's — it is
because `Object.entries` returns nothing for these particular built-ins, so
there is nothing for the redactor to walk. Both are pre-existing
characteristics of the shared redaction engine — already present, unchanged,
in `M3LBreadcrumbTrail.record()`'s own redaction call — not something this
logging surface introduces.

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
