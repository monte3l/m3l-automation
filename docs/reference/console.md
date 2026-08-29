# m3l console server (`packages/m3l-console-server`)

The HTTP contract of the m3l operations console backend: REST commands and
queries, plus one Server-Sent Events channel per run. ADR-0066 fixed this
contract; this page is the shipped implementation of it, and the thing
`m3l-console-web` (ADR-0067) codes against.

Everything here is served by a single long-running `node:http` process bound
to loopback only (ADR-0071). There is no published client library — the API is
plain HTTP and `curl` is a first-class client.

This page grows one section per shipped programme item. Routes not listed here
are not yet built.

## What exists today

X4 shipped run orchestration: launch a script, list and read the run registry,
and watch one run's progress and output over SSE. The route table is:

| Method | Path                      | Auth     | Shipped in |
| ------ | ------------------------- | -------- | ---------- |
| `GET`  | `/health`                 | exempt   | X2         |
| `GET`  | `/ready`                  | exempt   | X2         |
| `POST` | `/api/v1/runs`            | required | X4         |
| `GET`  | `/api/v1/runs`            | required | X4         |
| `GET`  | `/api/v1/runs/:id`        | required | X4         |
| `GET`  | `/api/v1/runs/:id/stream` | required | X4         |

Sessions, discovery (`GET /scripts`), cancellation, and telemetry summaries
are X6/X10 and are deliberately absent — ADR-0066 describes them as the
contract's eventual shape, not as anything the server answers today.

## Enabling run orchestration

The four `/api/v1/runs*` routes are **not registered** unless the run
subsystem is configured. `M3L_CONSOLE_RUNS_SCRIPTS_DIR` is the single gate:
when it is absent, empty, or whitespace-only, the server boots with run
orchestration disabled and logs that posture once, rather than failing to
start. Requests to the run routes then fall through to the router's own
`ERR_CONSOLE_NOT_FOUND`.

```bash
M3L_CONSOLE_OPERATOR_NAME="your name" \
M3L_CONSOLE_RUNS_SCRIPTS_DIR="$PWD/scripts" \
  pnpm console:server
```

That asymmetry is deliberate: a missing operator name is fatal at boot
(ADR-0071 requires a declared operator profile), while a missing scripts
directory is a legitimate "I only want the health probes" deployment.

## Authentication

Every `/api/v1/*` route is `auth: "required"`; `/health` and `/ready` are
`auth: "exempt"` because a probe has no operator.

**There is no credential to present today.** The shipped
`createSingleOperatorProvider` resolves the configured operator profile for
every request regardless of its headers — the ADR-0071 auth _seam_ exists and
every route is behind it, but the only identity provider wired into it is the
single-operator one. What actually keeps the API private is the transport
posture, not a token:

- the listener cannot bind beyond loopback, re-asserted against the address
  actually bound;
- a cross-origin request is refused by the `Host`/`Origin` rebinding guard.

Read those two together before exposing the port through any proxy. A real
identity provider (session cookie, bearer token) slots into
`M3LOperatorProvider` without touching a route.

## Correlation

Every request accepts and every response echoes **`x-correlation-id`**. An
inbound value is reused only when it is well-formed; otherwise the server
mints one. The id appears in the error envelope and in every log line for the
request, so a 500 in a browser tab is greppable in the server's output.

ADR-0066 originally specified `m3l-correlation-id`. The shipped spelling is
`x-correlation-id`, recorded in that ADR's 2026-08-29 Update.

## Request bodies

`POST` bodies must be `application/json` and are capped at
`m3l.console.max.body.bytes` (64 KiB by default). Both checks run before the
body is read, so an oversized or wrongly-typed body is refused without being
buffered:

| Condition                               | Code                                 | Status |
| --------------------------------------- | ------------------------------------ | ------ |
| body exceeds the cap                    | `ERR_CONSOLE_BODY_TOO_LARGE`         | 413    |
| non-empty body, non-JSON `content-type` | `ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE` | 415    |
| body is not valid JSON                  | `ERR_CONSOLE_BAD_REQUEST`            | 400    |

## The error envelope

Every failure — including a stream route's failure _before_ the stream opens —
is one JSON shape. It never carries a stack trace or a `cause` chain.

```json
{
  "error": {
    "code": "ERR_CONSOLE_RUN_NOT_FOUND",
    "message": "no run found with id 'run-42'",
    "status": 404,
    "correlationId": "0f3c…",
    "origin": "caller",
    "retryable": "no"
  }
}
```

`origin` and `retryable` are the ADR-0035 classification, present when the
code has one. The codes a caller can actually provoke:

| Code                                    | Status | Meaning                                              |
| --------------------------------------- | ------ | ---------------------------------------------------- |
| `ERR_CONSOLE_BAD_REQUEST`               | 400    | Malformed body, query parameter, or route parameter. |
| `ERR_CONSOLE_UNAUTHENTICATED`           | 401    | No operator resolved for the request.                |
| `ERR_CONSOLE_NOT_FOUND`                 | 404    | No such route.                                       |
| `ERR_CONSOLE_RUN_NOT_FOUND`             | 404    | No run with that id.                                 |
| `ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND`      | 404    | No such script under the scripts directory.          |
| `ERR_CONSOLE_METHOD_NOT_ALLOWED`        | 405    | Path exists, method does not.                        |
| `ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED` | 409    | Non-dry-run launch without `confirmed: true`.        |
| `ERR_CONSOLE_BODY_TOO_LARGE`            | 413    | Body exceeded `m3l.console.max.body.bytes`.          |
| `ERR_CONSOLE_UNSUPPORTED_MEDIA_TYPE`    | 415    | Non-empty body was not `application/json`.           |
| `ERR_CONSOLE_RUN_CAPACITY_EXCEEDED`     | 429    | Every slot busy and the queue is full.               |
| `ERR_CONSOLE_UNAVAILABLE`               | 503    | The server is draining; retry against a new process. |

Server-fault codes (`ERR_CONSOLE_INTERNAL`, the `ERR_CONSOLE_STORE_*` family,
`ERR_CONSOLE_STREAM_*`) map to 500/503 and are not caller-actionable.

## `POST /api/v1/runs`

Launches a run. Validation happens at the HTTP boundary, before the
orchestrator is called at all.

```bash
curl -sS -X POST localhost:8787/api/v1/runs \
  -H 'content-type: application/json' \
  -d '{"scriptName":"sqs-etl","confirmed":true}'
```

| Field        | Type    | Required | Default | Rules                             |
| ------------ | ------- | -------- | ------- | --------------------------------- |
| `scriptName` | string  | yes      | —       | `^[a-z][a-z0-9-]*$`               |
| `confirmed`  | boolean | no       | `false` | Required `true` for a real run.   |
| `dryRun`     | boolean | no       | `false` | A dry run needs no confirmation.  |
| `parameters` | object  | no       | `{}`    | Plain object, string values only. |

**`confirmed` is not a formality.** The console cannot introspect whether an
operation mutates anything until ADR-0055's declarative operations land, so
policy treats every non-dry-run launch as mutating and demands explicit
confirmation. There is deliberately no caller-supplied `mutating: false` —
that would be a policy bypass wearing a policy hat. A `dryRun: true` request
is exempt.

On success, `201` with a run handle:

```json
{
  "id": "0193f0c2-…",
  "scriptName": "sqs-etl",
  "status": "queued",
  "dryRun": false,
  "executionMode": "spawn"
}
```

`status` is `"running"` when a slot was free and `"queued"` when the run is
waiting. `executionMode` is `"in-process"` for a script that exports an
ADR-0054 command module and `"spawn"` otherwise — the console picks, the
caller does not.

The id exists even for a run that is subsequently rejected downstream, which
is what makes a rejection nameable in the audit trail rather than anonymous.

## `GET /api/v1/runs`

Lists run records, oldest-queued-first.

| Query    | Default | Rules                                                  |
| -------- | ------- | ------------------------------------------------------ |
| `status` | unset   | One of the seven run statuses; anything else is a 400. |
| `limit`  | `50`    | Positive integer.                                      |

There is no cursor and no `nextPageToken` — pagination is X10's problem, and
inventing a token now would freeze a shape the UI has not yet asked for.

## `GET /api/v1/runs/:id`

Returns one run record, or `ERR_CONSOLE_RUN_NOT_FOUND`.

| Field            | Type             | Notes                                         |
| ---------------- | ---------------- | --------------------------------------------- |
| `id`             | string           | UUID.                                         |
| `script`         | string           | The script identifier.                        |
| `status`         | run status       | See the vocabulary below.                     |
| `dryRun`         | boolean          |                                               |
| `executionMode`  | string           | `spawn` or `in-process`.                      |
| `parameters`     | object           | Round-tripped through JSON — see the warning. |
| `operator`       | string           | Who queued the run.                           |
| `correlationId`  | string           |                                               |
| `queuedAtMs`     | number           | Epoch milliseconds.                           |
| `startedAtMs`    | number \| null   | `null` when the run never started.            |
| `endedAtMs`      | number \| null   | `null` while pending.                         |
| `outcome`        | terminal \| null | `null` while pending.                         |
| `exitCode`       | number \| null   | Spawn path only.                              |
| `failureMessage` | string \| null   | `null` on a non-failure outcome.              |

> **Run parameters are persisted and echoed back.** Whatever a caller sends as
> `parameters` is written to SQLite and returned verbatim by this route and by
> the list route. Do not pass secrets as run parameters — pass a reference the
> script resolves itself (ADR-0070's display-vs-persist split).

### Run status vocabulary

Seven values, enforced by a `CHECK` constraint in the schema:

| Status        | Terminal | Meaning                                       |
| ------------- | -------- | --------------------------------------------- |
| `queued`      | no       | Waiting for a slot.                           |
| `running`     | no       | Executing.                                    |
| `success`     | yes      | Completed cleanly.                            |
| `failure`     | yes      | Completed with a failure.                     |
| `dry-run`     | yes      | Completed as a dry run.                       |
| `interrupted` | yes      | Killed, drained, or reconciled after a crash. |
| `partial`     | yes      | Completed with partial results.               |

The five terminal statuses _are_ `Core.M3LRunOutcome` — the same vocabulary
the library and the CLI use — so there is no translation table between the
registry and a script's own result, and therefore nothing to drift.

## `GET /api/v1/runs/:id/stream`

The SSE channel for one run. Responds `200` with
`content-type: text/event-stream` and no `content-length`.

```bash
curl -sN localhost:8787/api/v1/runs/$RUN_ID/stream
```

A run that is still `queued` or `running` gets a live subscription; a run that
is already terminal replays whatever the ring buffer still holds and closes.
Either way the response opens with `200` — a terminal run is not an error, it
is a short stream.

### Events

Four run events, each carrying a monotonically increasing `id:`:

| Event         | Payload                                |
| ------------- | -------------------------------------- |
| `run.queued`  | `{ event, runId, scriptName, dryRun }` |
| `run.started` | `{ event, runId, atMs }`               |
| `run.line`    | `{ event, runId, line }`               |
| `run.ended`   | `{ event, runId, outcome, exitCode }`  |

Two control frames carry **no `id:` line**, because neither names a published
event and neither should ever become a client's resume point:

| Event        | Payload                | Meaning                                    |
| ------------ | ---------------------- | ------------------------------------------ |
| `stream.gap` | `{ oldestRetainedId }` | Requested id fell off retention; re-sync.  |
| `stream.end` | `{ reason }`           | The stream is over. See the reasons below. |

`stream.end`'s `reason` is `"completed"` when the run itself ended, and
`"draining"` when the server is shutting down with the watcher still attached.
That distinction is the whole point of the frame: a watcher can tell "the run
finished" from "the server is going away" from "the network died" (in which
case no frame arrives at all).

`run.line` carries **raw script stdout**. Treat it as untrusted display data:
it is whatever the script wrote, unredacted, and it is not persisted anywhere
the API can re-serve it.

### Resume

Send `Last-Event-ID` to resume. The server retains the last
`m3l.console.runs.stream.retention` events per run (256 by default) in memory
— a browser's native `EventSource` sends the header for free on reconnect.

| `Last-Event-ID`        | Result                                     |
| ---------------------- | ------------------------------------------ |
| absent                 | Live tail; a terminal run replays in full. |
| equal to the newest id | Nothing replayed; the tail continues.      |
| within retention       | Exactly the missed events.                 |
| older than retention   | One `stream.gap`, then the live tail.      |
| ahead of the newest id | One `stream.gap`.                          |
| malformed              | Ignored, as if absent.                     |

A gap is signalled explicitly rather than papered over, because the ring
buffer is an accelerator over queryable state, never the only copy: on a gap,
re-read `GET /api/v1/runs/:id` for authoritative status and keep streaming.

The same explicit gap is how slow-client backpressure surfaces — a client too
slow to drain its buffer loses events and is told so, rather than costing the
server unbounded memory.

### Shutdown

On `SIGTERM`/`SIGINT`/`SIGQUIT` the server ends every open run stream with
`stream.end{"reason":"draining"}` **before** the HTTP drain aborts in-flight
requests, so a watcher gets a reason instead of an `ECONNRESET`. A second
signal force-exits without that courtesy.

A run whose process outlives the drain window is killed
(`SIGTERM`, then `SIGKILL` after `m3l.console.runs.kill.timeout.ms`) and
recorded `interrupted`.

A drain never _starts_ a queued run. Rows still `queued` at shutdown stay
`queued` on disk and are reconciled to `interrupted` by the next boot, rather
than being started by a process that is already going away.

## Concurrency and queueing

Three limits apply in order, and a rejection is always a typed error — never a
silently dropped request:

1. **Per-script mutex** — at most `m3l.console.runs.max.per.script` concurrent
   runs of the same script (default `1`).
2. **Global cap** — at most `m3l.console.runs.max.concurrency` runs across all
   scripts (default `4`).
3. **Bounded queue** — a run that cannot start waits, up to
   `m3l.console.runs.queue.capacity` deep (default `16`). A full queue is
   `ERR_CONSOLE_RUN_CAPACITY_EXCEEDED` (429).

A queued run that waits longer than `m3l.console.runs.queue.timeout.ms`
(default 30s) is transitioned to `interrupted` with `startedAtMs` left `null`
— it never started, so fabricating a start timestamp would be a lie in the
registry.

The queue is a single global FIFO with **skip-on-busy**: a queued run whose
script is still occupied is passed over rather than blocking the head of the
queue. With the default `maxPerScript: 1`, strict FIFO would deadlock the
queue behind any single busy script.

There is no queue table and no event table. The queue _is_ the set of rows
with `status = 'queued'`, and resume is the in-memory ring buffer ADR-0066
fixed — so there is no second copy of either to fall out of sync.

## Crash recovery

The console does not survive `SIGKILL` mid-run, and does not pretend to. On
the next boot, every row still `queued` or `running` is reconciled to
`interrupted` **before the listener binds**, so no client can ever observe a
row claiming to be running inside a process that has never executed it.

The killed script's own subprocess is not adopted — it is orphaned by the
kill, and the registry records the truth about the console's knowledge of it,
not a guess about the process.

## Configuration

Run-orchestration settings, all under `m3l.console.runs.*`. Every dotted key
maps mechanically to an env var (`.` and `-` become `_`, upper-cased).

| Setting                             | Env var                             | Default    |
| ----------------------------------- | ----------------------------------- | ---------- |
| `m3l.console.runs.scripts.dir`      | `M3L_CONSOLE_RUNS_SCRIPTS_DIR`      | — required |
| `m3l.console.runs.max.per.script`   | `M3L_CONSOLE_RUNS_MAX_PER_SCRIPT`   | `1`        |
| `m3l.console.runs.max.concurrency`  | `M3L_CONSOLE_RUNS_MAX_CONCURRENCY`  | `4`        |
| `m3l.console.runs.queue.capacity`   | `M3L_CONSOLE_RUNS_QUEUE_CAPACITY`   | `16`       |
| `m3l.console.runs.queue.timeout.ms` | `M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS` | `30000`    |
| `m3l.console.runs.stream.retention` | `M3L_CONSOLE_RUNS_STREAM_RETENTION` | `256`      |
| `m3l.console.runs.kill.timeout.ms`  | `M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS`  | `5000`     |

`scripts.dir` is resolved to an absolute path (a relative value resolves
against the process's working directory). Every other value is validated at
boot and a bad one is `ERR_CONSOLE_CONFIG_INVALID` naming the offending key —
the process never binds a socket on a bad config.

Transport, persistence, and lifecycle settings are in the package README.

## Known limits

Stated plainly rather than left to be discovered:

- **Ended streams are retained for the process's lifetime.** A run's ring
  buffer is never released, so a late watcher can always replay a finished
  run's tail. The cost is `O(total runs × stream retention)` memory until
  restart. This is a deliberate trade for a single-operator, loopback-bound
  console, not an oversight — it would not survive a multi-tenant deployment.
- **`?limit=` has no upper bound.** A caller may request more rows than is
  sensible; the value is forwarded to the registry as given.
- **`parameters` bounds neither key count nor value length** beyond the 64 KiB
  body cap that transitively limits both.
- **No cancellation route.** A running run can only be stopped by draining the
  server.
- **HTTP/1.1 per-origin connection limits** cap how many SSE streams one
  browser can hold open at once (six, typically). Moot behind HTTP/2.

## Links

- Contract: [ADR-0066](../adr/0066-console-api-rest-sse.md). Server
  architecture: [ADR-0065](../adr/0065-console-server-architecture.md).
  Deployment posture: [ADR-0071](../adr/0071-console-containerization-deployment.md).
- Persistence: [ADR-0069](../adr/0069-console-embedded-persistence.md).
  Payload governance: [ADR-0070](../adr/0070-console-audit-and-observability.md).
- Execution paths:
  [ADR-0054](../adr/0054-command-module-contract-and-hybrid-execution.md).
  Declarative operations (the `confirmed` unblock condition):
  [ADR-0055](../adr/0055-declarative-operation-introspection.md).
- Package README: [`packages/m3l-console-server/README.md`](../../packages/m3l-console-server/README.md).
