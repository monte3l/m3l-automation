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

X6 shipped the workbench-sessions module: create/list/read/close/reopen a
session, append steps, raise and answer decisions, and read a session's
persisted binding audit trail:

| Method | Path                                          | Auth     | Shipped in |
| ------ | --------------------------------------------- | -------- | ---------- |
| `POST` | `/api/v1/sessions`                            | required | X6         |
| `GET`  | `/api/v1/sessions`                            | required | X6         |
| `GET`  | `/api/v1/sessions/:id`                        | required | X6         |
| `POST` | `/api/v1/sessions/:id/steps`                  | required | X6         |
| `POST` | `/api/v1/sessions/:id/steps/:stepId/decision` | required | X6         |
| `POST` | `/api/v1/sessions/:id/decisions/:decisionId`  | required | X6         |
| `POST` | `/api/v1/sessions/:id/close`                  | required | X6         |
| `POST` | `/api/v1/sessions/:id/reopen`                 | required | X6         |
| `GET`  | `/api/v1/sessions/:id/bindings`               | required | X6         |

X10 shipped script discovery: enumerate the launchable scripts under the
configured scripts directory, and read one script's declared parameters and
operations without running it.

| Method | Path                    | Auth     | Shipped in |
| ------ | ----------------------- | -------- | ---------- |
| `GET`  | `/api/v1/scripts`       | required | X10        |
| `GET`  | `/api/v1/scripts/:name` | required | X10        |

Cancellation and telemetry summaries remain deliberately absent — ADR-0066
describes them as the contract's eventual shape, not as anything the server
answers today.

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

The X6 session codes:

| Code                                     | Status | Meaning                                                                                   |
| ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `ERR_CONSOLE_SESSION_REFERENCE_INVALID`  | 400    | A step reference is malformed, or resolves to the wrong shape.                            |
| `ERR_CONSOLE_SESSION_NOT_FOUND`          | 404    | No session with that id.                                                                  |
| `ERR_CONSOLE_SESSION_STEP_NOT_FOUND`     | 404    | No step or decision with that id, or a decision naming a step in a different session.     |
| `ERR_CONSOLE_SESSION_TRANSITION_INVALID` | 409    | A guarded status transition matched no row (e.g. answering an already-answered decision). |
| `ERR_CONSOLE_SESSION_CLOSED`             | 409    | A step was appended to a session that is not `open`.                                      |
| `ERR_CONSOLE_SESSION_ARTIFACT_TOO_LARGE` | 413    | A step's recorded output exceeds the artifact or session-total cap.                       |
| `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED`     | 429    | The open-session cap (`m3l.console.sessions.open.max`) is reached.                        |

`ERR_CONSOLE_SESSION_ARTIFACT_CORRUPT` (500, `origin: "library"`) is a
server-fault code — a persisted artifact's on-disk bytes no longer match its
recorded digest, or its reference envelope cannot be parsed.

`ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED` (500, `origin: "library"`) is the
other server-fault code a caller can provoke: a script's config module exists
but will not load or does not export a well-formed `configParameters` array.
Its message names only the script, never a filesystem path — the underlying
`M3LError` is chained as `cause` and reaches the server's diagnostics, not the
response body.

Server-fault codes (`ERR_CONSOLE_INTERNAL`, the `ERR_CONSOLE_STORE_*` family,
`ERR_CONSOLE_STREAM_*`) map to 500/503 and are not caller-actionable.

## `GET /api/v1/scripts`

Lists every launchable script under `M3L_CONSOLE_RUNS_SCRIPTS_DIR`, sorted by
name. This is the read that populates the console's script list, and the
prerequisite for building a launch form without knowing a script's parameters
in advance.

```bash
curl -sS localhost:8787/api/v1/scripts
```

```json
[
  {
    "name": "json-etl",
    "description": "JSON and NDJSON file ETL: extract fields, filter records, export to json, jsonl, csv, or html",
    "hasCommandModule": true,
    "executionMode": "in-process"
  }
]
```

A directory qualifies as a script when its name is a kebab-case identifier
**and** a config module resolves for it — `dist/config.js`, else
`src/config.ts` (`Core.resolveConfigModulePath`, the same dist-first rule the
CLI's `m3l inspect` uses). Anything else under the scripts directory is
skipped rather than reported: a file, a symlink, a `.`-prefixed directory, or
a directory carrying no config module. The list and
`GET /api/v1/scripts/:name` therefore always agree — the UI can never render a
row that then 404s.

`description` is read best-effort from the script's own `package.json` and is
`""` when that file is missing, unreadable, invalid JSON, or has no string
`description`. It is truncated at 500 characters.

`executionMode` is derived exactly as a launch derives it (ADR-0054):
`"in-process"` when `dist/command.js` exists, else `"spawn"`.

## `GET /api/v1/scripts/:name`

Reads one script's declared parameters and operations, loaded through
`m3l-common`'s `core/config` introspection seam. The script's config module is
imported, never executed as a command, and no value is resolved from any
provider — this describes what the script _declares_, not what it would
resolve to in a given environment.

```bash
curl -sS localhost:8787/api/v1/scripts/json-etl
```

```json
{
  "name": "json-etl",
  "description": "JSON and NDJSON file ETL",
  "hasCommandModule": true,
  "executionMode": "in-process",
  "parameters": [
    {
      "name": "input",
      "aliases": ["i"],
      "type": "string",
      "required": true,
      "description": "Source file to read",
      "secret": false,
      "operations": []
    }
  ],
  "operations": []
}
```

`parameters` is the `M3LConfigParameterDescriptor[]` the Core seam produces,
passed through verbatim. A parameter that declares no default has no
`defaultValue` key at all — `undefined` is dropped by JSON serialisation, not
rendered as `null`. `operations` is the de-duplicated union of every
operation any parameter declares (ADR-0055), in first-seen order, so a form
can build its operation selector from one field.

**A secret-flagged parameter's default is always the eight-asterisk mask**,
never its real value. The masking happens at the descriptor source in
`m3l-common`, not in this route, so every consumer of that seam inherits it.

Descriptors are cached in memory, keyed by the resolved config module's path
**and** its mtime — rebuilding a script or editing its `src/config.ts`
invalidates the entry on the next read, with no server restart.

| Failure                                         | Code                                      | Status |
| ----------------------------------------------- | ----------------------------------------- | ------ |
| `:name` missing, or not a kebab-case identifier | `ERR_CONSOLE_BAD_REQUEST`                 | 400    |
| No such directory, or no config module in it    | `ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND`        | 404    |
| Config module exists but will not load          | `ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED` | 500    |

The name is validated at the HTTP boundary, before the filesystem is touched
at all.

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

## Sessions

X6's workbench-sessions module (ADR-0068): an ordered, resumable record of
executed operations, each step's output addressable by a stable reference,
selected values persisted as typed bindings, and steps that can raise an
operator decision. The nine routes below all require an authenticated
operator; there is no separate enable/disable gate like run orchestration's
`M3L_CONSOLE_RUNS_SCRIPTS_DIR` — sessions are always available once the
session subsystem is wired (`main.ts`'s `sessions` composition input).

## `POST /api/v1/sessions`

Creates a new open session.

```bash
curl -sS -X POST localhost:8787/api/v1/sessions
```

On success, `201` with the session record:

```json
{
  "id": "session-1",
  "operator": "alice",
  "correlationId": "0f3c…",
  "status": "open",
  "createdAtMs": 1735689600000,
  "updatedAtMs": 1735689600000
}
```

`ERR_CONSOLE_SESSION_LIMIT_EXCEEDED` (429) when the open-session cap
(`m3l.console.sessions.open.max`) is already reached.

## `GET /api/v1/sessions`

Lists session records, checked before the write in every other route.

| Query      | Default | Rules                                       |
| ---------- | ------- | ------------------------------------------- |
| `status`   | unset   | `open` or `closed`; anything else is a 400. |
| `operator` | unset   | Exact match.                                |
| `limit`    | `50`    | Positive integer.                           |

## `GET /api/v1/sessions/:id`

Returns one session record, or `ERR_CONSOLE_SESSION_NOT_FOUND`. `closedAtMs`
is present only on the `"closed"` variant — the discriminated union mirrors
the store's own `CHECK` constraint, so a caller never sees a closed session
missing its close timestamp or an open one carrying a stale one.

## `POST /api/v1/sessions/:id/steps`

Resolves the request's bindings against prior steps' recorded output,
persists each resolved binding as an audit record, launches the operation,
and appends the step.

```bash
curl -sS -X POST localhost:8787/api/v1/sessions/$SESSION_ID/steps \
  -H 'content-type: application/json' \
  -d '{
    "operation": "sqs-etl",
    "bindings": [
      {
        "reference": "step-1.output.Queues[0]",
        "expectedType": "string",
        "multiSelect": false,
        "parameterName": "queueName"
      }
    ],
    "confirmed": true,
    "dryRun": false
  }'
```

| Field                      | Type    | Required | Rules                                                      |
| -------------------------- | ------- | -------- | ---------------------------------------------------------- |
| `operation`                | string  | yes      | Non-empty.                                                 |
| `bindings`                 | array   | yes      | May be empty; see Bindings below.                          |
| `bindings[].reference`     | string  | yes      | Must parse under the reference grammar.                    |
| `bindings[].expectedType`  | string  | yes      | One of `string`, `number`, `boolean`, `object`.            |
| `bindings[].multiSelect`   | boolean | yes      | See Bindings below.                                        |
| `bindings[].parameterName` | string  | yes      | The launch-parameter name the resolved value binds to.     |
| `confirmed`                | boolean | yes      | Same non-dry-run confirmation rule as `POST /api/v1/runs`. |
| `dryRun`                   | boolean | yes      |                                                            |

On success, `201` with `{ step, handle }` — the inserted step record (see
`GET /api/v1/sessions/:id/bindings` for the step's own status vocabulary,
shared with the run registry) and the launched run's handle, the same shape
`POST /api/v1/runs` returns.

`ERR_CONSOLE_SESSION_CLOSED` (409) when the target session is not `open`.
`ERR_CONSOLE_SESSION_STEP_NOT_FOUND` (404) when a binding's reference names
an ordinal with no step yet in this session. `ERR_CONSOLE_SESSION_REFERENCE_INVALID`
(400) when a binding's referenced step has no recorded result yet, or its
resolved value does not match the binding's declared shape.

### Reference grammar

A reference names a value nested inside a previously recorded step's output:
`step-<ordinal>.output(.<ident> | [<index>] | ["<quoted>"])*` — a 1-based
step ordinal, then zero or more path segments, each either a dotted
identifier, a quoted property name, or a bracketed array index.

| Reference                          | Meaning                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `step-1.output`                    | The whole of step 1's recorded output.                 |
| `step-1.output.Queues[0]`          | The first element of step 1's output's `Queues` array. |
| `step-2.output["a weird key"]`     | A property whose name is not a valid bare identifier.  |
| `step-3.output.messages[7].userId` | Nested arbitrarily deep.                               |

References are session-scoped and durable across `close`/`reopen` — the
underlying step output is a persisted artifact file, never held only in
memory. `ERR_CONSOLE_SESSION_REFERENCE_INVALID` (400) covers both a
malformed reference and a well-formed one that no longer matches the data it
names (including the three prototype-pollution property names, refused
outright).

### Bindings

Selecting a value creates a binding — a reference, the type the resolved
value must have, and whether it is a single value or an array
(`multiSelect: true`, which produces a launch-parameter array — several ids
resolved into one batch-query parameter). Every binding on a successful
`addStep` call is persisted as a session record **immediately after its own
resolution succeeds**, in submission order — so a later binding's failure
never rolls back an earlier one's already-persisted record. Read the audit
trail with `GET /api/v1/sessions/:id/bindings`.

**Known limitation:** a persisted binding record carries only `reference`/
`expectedType`/`multiSelect`/`createdAtMs` — no linkage to the step it fed
into, and no `parameterName`. A step whose launch subsequently fails (e.g.
`ERR_CONSOLE_RUN_CONFIRMATION_REQUIRED`) leaves its bindings' records
persisted; a client retry with the same bindings persists new records rather
than reusing the originals. No data is lost or corrupted — this is
non-deduplicated audit noise, not a correctness defect — but a step-linkage
column (a store migration) would be needed to close it.

## `POST /api/v1/sessions/:id/steps/:stepId/decision`

Raises a pending decision on a step: a free-text prompt, plus optional
caller-defined `options` the operator chooses among.

```bash
curl -sS -X POST localhost:8787/api/v1/sessions/$SESSION_ID/steps/$STEP_ID/decision \
  -H 'content-type: application/json' \
  -d '{"prompt": "Continue to the next queue, or stop here?", "options": ["continue", "stop"]}'
```

On success, `201` with the decision record (`status: "pending"`).
`ERR_CONSOLE_SESSION_STEP_NOT_FOUND` (404) when `stepId` names no step in
this session.

## `POST /api/v1/sessions/:id/decisions/:decisionId`

Answers a pending decision. The `:id` route parameter is unused — the real
service's `answerDecision` takes only the decision id.

```bash
curl -sS -X POST localhost:8787/api/v1/sessions/$SESSION_ID/decisions/$DECISION_ID \
  -H 'content-type: application/json' \
  -d '{"answer": "continue"}'
```

On success, `200` with `{ "applied": true }` — `false` when the decision was
already answered. `ERR_CONSOLE_SESSION_STEP_NOT_FOUND` (404) when
`decisionId` names no decision.

## `POST /api/v1/sessions/:id/close`

Closes an open session. `200` with `{ "applied": boolean }` — `true` when
this call's own write applied, `false` when the session was already closed.
`ERR_CONSOLE_SESSION_NOT_FOUND` (404) for an unknown id.

## `POST /api/v1/sessions/:id/reopen`

Resumes a closed session — ADR-0068's "reopen where you left off". `200`
with `{ "applied": boolean }`, the same idempotent shape as `close`: `true`
on a genuine `closed` → `open` transition, `false` when the session was
already open (a no-op, not an error). The open-session cap only gates the
count-increasing case — reopening an already-open session never counts twice
against `m3l.console.sessions.open.max`. `ERR_CONSOLE_SESSION_NOT_FOUND`
(404) for an unknown id; `ERR_CONSOLE_SESSION_LIMIT_EXCEEDED` (429) when the
target is genuinely closed and the cap is already reached.

References created before a session was closed still resolve after reopen —
the underlying artifact files and their store rows are untouched by a
close/reopen cycle.

## `GET /api/v1/sessions/:id/bindings`

Lists every binding persisted for `sessionId` via a prior `addStep` call,
created-ascending.

```bash
curl -sS localhost:8787/api/v1/sessions/$SESSION_ID/bindings
```

```json
[
  {
    "id": "binding-1",
    "sessionId": "session-1",
    "reference": "step-1.output.Queues[0]",
    "expectedType": "string",
    "multiSelect": false,
    "createdAtMs": 1735689600000
  }
]
```

`ERR_CONSOLE_SESSION_NOT_FOUND` (404) for an unknown session id — this route
is `:id`-scoped like `GET /api/v1/sessions/:id`, not a query-filtered scan
like `GET /api/v1/sessions`, so an unknown id is distinguishable from a real
session with zero bindings.

## Session limits

Four settings, all under `m3l.console.sessions.*`:

| Setting                                          | Env var                                          | Default               |
| ------------------------------------------------ | ------------------------------------------------ | --------------------- |
| `m3l.console.sessions.artifact.inline.max.bytes` | `M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES` | `65536` (64 KiB)      |
| `m3l.console.sessions.artifact.max.bytes`        | `M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES`        | `33554432` (32 MiB)   |
| `m3l.console.sessions.total.max.bytes`           | `M3L_CONSOLE_SESSIONS_TOTAL_MAX_BYTES`           | `268435456` (256 MiB) |
| `m3l.console.sessions.open.max`                  | `M3L_CONSOLE_SESSIONS_OPEN_MAX`                  | `32`                  |

A step's output under `artifact.inline.max.bytes` is stored inline in the
store row; larger, up to `artifact.max.bytes`, spills to a file artifact.
`total.max.bytes` caps one session's running total across every step's
file-artifact output — reached before an individual step's own cap, whichever
comes first. Every value must be an integer of at least `1`; a bad one is
`ERR_CONSOLE_CONFIG_INVALID` at boot, the same posture as the run-orchestration
settings above.

**Known limits, sessions:**

- **No age-based sweep or operator cleanup command.** A session's artifacts
  live until the process's data directory is cleared by hand — the
  age-based sweep and a cleanup command are X8's (ADR-0070's retention
  regime), not shipped here.
- **A step's addressable output is outcome-only** (`{ outcome, exitCode }`)
  — the canonical "select a field out of a real command's output dump"
  drill-down is not exercisable through the currently-shipped `run.ended`
  event payload; X11's Playwright acceptance exercises the full UI
  version once a script's real output flows through.
- **Session status is `open`/`closed` only** — a session blocked on a
  pending decision is not distinguishable from a normal open session at the
  session-record level, and there is no `GET` route to list a session's
  decisions; the service's `listDecisionsForSession` exists but is not yet
  exposed over REST.
- Binding audit records have no step linkage — see the Bindings section
  above.

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
- **`GET /api/v1/scripts` stats the scripts directory on every request.** It
  is deliberately uncached — a freshly scaffolded script must appear without a
  restart — so the cost is `O(scripts)` `stat` calls per call, synchronously,
  on the event loop, with no cap on entries or response size. Measured: 3,000
  script directories block the loop for ~48 ms and return a ~1.75 MB body per
  request. Only the per-script _descriptors_ are cached.
- **A parameter's own `description` and `defaultValue` are not length-capped**
  (only the `package.json` `description` is, at 500 characters). One declared
  parameter can therefore produce a multi-hundred-KB
  `GET /api/v1/scripts/:name` body. See the trust boundary below for why this
  is not treated as an attack surface.
- **Every distinct config-module mtime leaves a permanent entry in Node's ESM
  registry.** Reloading after a rebuild works by importing under a
  cache-busting `?mtime=` specifier, and an imported module is never
  unloadable, so a script rebuilt many times within one server lifetime grows
  process memory monotonically. Restart to reclaim it.
- **HTTP/1.1 per-origin connection limits** cap how many SSE streams one
  browser can hold open at once (six, typically). Moot behind HTTP/2.

## The scripts directory is a trust boundary

`GET /api/v1/scripts/:name` **imports and executes** a script's config module
inside the console-server process, with that process's environment and
credentials — including for scripts whose `executionMode` is `"spawn"`, where
ADR-0054 otherwise treats the process boundary as an isolation feature. A
read-shaped `GET` is the trigger, and `auth` has no read-only/read-write split,
so any authenticated operator can drive it. Imported modules are never
unloadable, so top-level side effects (timers, open handles, memory) persist
for the process's lifetime.

The consequence worth stating plainly: **anyone who can write into the scripts
directory already has in-process code execution by design.** The unbounded
listing and uncapped parameter strings above are therefore not attack surfaces
— an adversary who could trigger them could simply run code instead. The
controls that do matter are the ones keeping content _outside_ that directory
unreachable:

- `:name` must match `/^[a-z][a-z0-9-]*$/`, validated at the HTTP boundary
  before any filesystem call.
- The resolved script directory is `realpath`'d and must be a **direct child**
  of the `realpath`'d scripts root. A symlink inside the scripts root pointing
  anywhere else resolves to `ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND`, so it can
  neither be listed nor introspected.

## Links

- Contract: [ADR-0066](../adr/0066-console-api-rest-sse.md). Server
  architecture: [ADR-0065](../adr/0065-console-server-architecture.md).
  Deployment posture: [ADR-0071](../adr/0071-console-containerization-deployment.md).
- Persistence: [ADR-0069](../adr/0069-console-embedded-persistence.md).
  Payload governance: [ADR-0070](../adr/0070-console-audit-and-observability.md).
- Workbench sessions: [ADR-0068](../adr/0068-workbench-sessions.md).
- Execution paths:
  [ADR-0054](../adr/0054-command-module-contract-and-hybrid-execution.md).
  Declarative operations (the `confirmed` unblock condition):
  [ADR-0055](../adr/0055-declarative-operation-introspection.md).
- Package README: [`packages/m3l-console-server/README.md`](../../packages/m3l-console-server/README.md).
