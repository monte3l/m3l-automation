# @m3l-automation/m3l-console-server

Backend for the m3l operations console (ADR-0064): a modular monolith over
`node:http` with an internal router, health/readiness probes, run
orchestration with resumable SSE streams, and graceful drain. It is the repo's
first long-running process (ADR-0065) — everything else here is batch-shaped.

## Usage

```bash
M3L_CONSOLE_OPERATOR_NAME="your name" pnpm console:server
```

The operator name is required (ADR-0071) — without it `loadConsoleConfig`
throws and the process never binds a socket. The server listens on
`127.0.0.1:8787` by default, serves `/health` and `/ready`, and drains
gracefully on `SIGTERM`/`SIGINT`/`SIGQUIT`. A second signal force-exits.

```bash
curl -s localhost:8787/health   # {"status":"ok","uptimeMs":42}
curl -s localhost:8787/ready    # {"status":"ready","uptimeMs":57}
```

Add `M3L_CONSOLE_RUNS_SCRIPTS_DIR` to enable run orchestration (X4) — the
`/api/v1/runs` routes, the per-run SSE stream, the run registry, and the X10
script-discovery routes (`/api/v1/scripts`, `/api/v1/scripts/:name`):

```bash
M3L_CONSOLE_OPERATOR_NAME="your name" \
M3L_CONSOLE_RUNS_SCRIPTS_DIR="$PWD/scripts" \
  pnpm console:server
```

That variable is the whole gate — for discovery as much as for launching:
absent, the server boots with run orchestration disabled and logs that posture
once, rather than refusing to start over an optional subsystem. Discovery
deliberately shares it rather than taking a gate of its own, so the two halves
of the launch flow can never disagree about whether a script exists. The X6 workbench-sessions routes
(`/api/v1/sessions*`) have no separate enable/disable gate of their own — see
`docs/reference/console.md`'s Sessions section.

The full HTTP contract — every route, the error envelope, the SSE frame
vocabulary and its resume semantics — is
[`docs/reference/console.md`](../../docs/reference/console.md).

## Posture

Three controls are load-bearing rather than decorative, and each is
enforced in code rather than by convention:

- **The listener cannot bind beyond loopback.** `startConsoleServer` reads
  `server.address()` after `listening` fires and rejects anything that is
  not a verified loopback address, closing the socket before it throws. This
  holds even for a programmatic caller that never went through
  `loadConsoleConfig`. It matters because `listen()`'s host argument is a
  _request_: omitting it binds `::` — every interface — and `localhost`
  resolves to `::1`, not `127.0.0.1`.
- **A cross-origin request is refused.** Loopback binding does not stop a
  browser: a page on any site can issue requests to `127.0.0.1`, and Node
  serves a request bearing `Host: evil.example` with a 200 quite happily.
  `createOriginGuard` is the only thing that refuses it. It compares the
  `Host` hostname, and deliberately not the port — under rebinding the
  browser sends the attacker's hostname, so the hostname is the whole
  defence, while comparing the port would break a compose port remap
  (`9000:8787`). `Origin: null` — the sandboxed/`file://` origin — is
  rejected explicitly.
- **Secrets never reach the log.** The operator email, request headers, and
  cookies are named in an `M3LSecretNamesPort` at the logger's construction,
  so redaction is structural for every layer written later rather than a
  rule each one must remember. The library's own heuristic redacts a nested
  `authorization` header but not a `cookie`, which is exactly the gap this
  closes.

## Configuration

Every setting is one dotted `m3l.console.<area>.<name>` name, read through
`M3LEnvironmentConfigProvider`, whose `toEnvKey` derivation gives the
`M3L_CONSOLE_<AREA>_<NAME>` environment variable for free.

| Setting                        | Env var                        | Default     |
| ------------------------------ | ------------------------------ | ----------- |
| `m3l.console.host`             | `M3L_CONSOLE_HOST`             | `127.0.0.1` |
| `m3l.console.port`             | `M3L_CONSOLE_PORT`             | `8787`      |
| `m3l.console.operator.name`    | `M3L_CONSOLE_OPERATOR_NAME`    | — required  |
| `m3l.console.operator.email`   | `M3L_CONSOLE_OPERATOR_EMAIL`   | unset       |
| `m3l.console.drain.timeout.ms` | `M3L_CONSOLE_DRAIN_TIMEOUT_MS` | `15000`     |
| `m3l.console.log.level`        | `M3L_CONSOLE_LOG_LEVEL`        | `info`      |
| `m3l.console.max.body.bytes`   | `M3L_CONSOLE_MAX_BODY_BYTES`   | `65536`     |

| Setting                          | Env var                          | Default                            |
| -------------------------------- | -------------------------------- | ---------------------------------- |
| `m3l.console.db.path`            | `M3L_CONSOLE_DB_PATH`            | `<dataDir>/console/console.sqlite` |
| `m3l.console.db.busy.timeout.ms` | `M3L_CONSOLE_DB_BUSY_TIMEOUT_MS` | `5000`                             |

Run orchestration (X4) is configured separately and read only when
`M3L_CONSOLE_RUNS_SCRIPTS_DIR` is set. What each limit _means_ for a caller —
which error code a full queue returns, what happens to a run that times out
while queued — is in
[`docs/reference/console.md`](../../docs/reference/console.md); this table is
just the knobs.

| Setting                             | Env var                             | Default |
| ----------------------------------- | ----------------------------------- | ------- |
| `m3l.console.runs.scripts.dir`      | `M3L_CONSOLE_RUNS_SCRIPTS_DIR`      | — unset |
| `m3l.console.runs.max.per.script`   | `M3L_CONSOLE_RUNS_MAX_PER_SCRIPT`   | `1`     |
| `m3l.console.runs.max.concurrency`  | `M3L_CONSOLE_RUNS_MAX_CONCURRENCY`  | `4`     |
| `m3l.console.runs.queue.capacity`   | `M3L_CONSOLE_RUNS_QUEUE_CAPACITY`   | `16`    |
| `m3l.console.runs.queue.timeout.ms` | `M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS` | `30000` |
| `m3l.console.runs.stream.retention` | `M3L_CONSOLE_RUNS_STREAM_RETENTION` | `256`   |
| `m3l.console.runs.kill.timeout.ms`  | `M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS`  | `5000`  |

`m3l.console.runs.scripts.dir` is the one setting with no usable default:
absent, empty, or whitespace-only, the whole subsystem stays off at boot. A
relative value resolves against the process's working directory. Every other
value is validated at boot, and a bad one is `ERR_CONSOLE_CONFIG_INVALID`
naming the offending key — the process never binds a socket on a bad config.

`m3l.console.db.path` is anchored to the workspace `data/` tree resolved by
`Core.M3LPaths().getDataDir()` — the same anchor every other data artifact in
the repo uses, honouring `M3L_DATA_DIR`. A relative value resolves against
that directory; an absolute one passes through. `:memory:` is **rejected**
here: in-memory is available only programmatically, which keeps an
operator's deployment and a test's fixture cleanly separated.

`m3l.console.operator.name` is **required at boot**, not per request: absent
it, `loadConsoleConfig` throws and the process never binds a socket. That is
ADR-0071's "a declared operator profile is required to use the console",
enforced earlier than a runtime 401.

`m3l.console.host` must resolve to a loopback address, rejected fail-closed by
`isLoopbackHost`. The constraint is asserted a second time inside
`startConsoleServer`, at the only place that calls `listen`, so a programmatic
caller that bypasses config still cannot open a non-loopback listener
(ADR-0071).

## Contract

**[`docs/reference/console.md`](../../docs/reference/console.md) is the wire
contract** — every route, the request/response shapes, the error envelope and
its code-to-status table, the SSE event vocabulary, and the resume semantics.
Read it before writing a client; this README covers how to run and reason
about the process, not what to send it.

The architecture record is ADR-0065 (modular monolith, layering, graceful
drain), the API shape is ADR-0066 (REST commands, SSE live streams, the error
envelope — see its 2026-08-29 Update for the four corrections X4 made), and
the deployment posture is ADR-0071 (loopback-only binding, required operator
profile).

Two properties of that contract are worth naming here, because they are
posture decisions rather than API details:

- **Every `/api/v1/*` route is `auth: "required"`, and nothing checks a
  credential.** The ADR-0071 seam is real and every route sits behind it, but
  the only wired `M3LOperatorProvider` resolves the configured operator for
  any request. Loopback binding plus the `Host`/`Origin` guard is what
  actually keeps the API private today.
- **Run parameters are persisted and echoed back.** They round-trip through
  SQLite and are returned by the read routes verbatim, so they must not carry
  secrets — pass a reference the script resolves itself (ADR-0070's
  display-vs-persist split).

## Boundaries

- Zero runtime dependencies: only `@m3l-automation/m3l-common`
  (`workspace:*`) and `node:` builtins, enforced by ESLint + `check:zones`.
  Adopting the routing-framework fallback ADR-0065 records requires widening
  that zone in the same PR as a dated ADR-0065 Update.
- No `exports` map and no barrels — this package is bin-first and nothing in
  it is importable by another package.
- `src/` modules are import-inert; when it lands,
  `bin/m3l-console-server.mjs` will be the only process entry.
- Module layering (leaf to root) is ESLint-enforced via the ADR-0009
  mechanism:

  ```text
  net                                                (m3l-common + node: only)
  errors                                             (m3l-common + node: only)
  config    -> errors, net
  auth      -> errors
  lifecycle -> errors, net
  store     -> errors                                (persistence; ADR-0069)
  stream    -> errors                                (generic event streams; no node:http)
  runs      -> errors, store, stream                 (run orchestration)
  http      -> errors, auth, lifecycle, net, stream  (transport; NOT config, runs, store)
  main.ts   -> everything                            (composition root; nothing imports it)
  ```

  `net/` holds the pure loopback-address predicates. They live in a leaf
  rather than in `config/` because all three of `config/` (validating the
  requested bind host), `lifecycle/` (re-asserting loopback against the
  address actually bound) and `http/` (the `Host`/`Origin` rebinding guard)
  need them — putting them in `config/` would have forced exactly the
  `http -> config` edge this table exists to forbid.

  `store/` is absent from every other row's allowance, so nothing outside it
  can reach a SQL seam. In particular `http -> store` is deliberately **not**
  granted: `http` may already import `lifecycle`, so admitting `store` there
  would hand every request handler a database handle — the inverse of
  ADR-0065's "modules speak only to typed repositories". `/ready` reports
  store health through a structural probe declared inside `http/routes/`,
  which needs no import and therefore no edge.

  `stream/` exists as its own leaf, generic over its payload type, precisely
  so `http/` can serve a run's SSE channel without an `http -> runs` edge. Had
  the ring buffer lived in `runs/` — its most obvious home — serving the
  stream would have forced exactly the edge this table exists to forbid. The
  run routes reach the registry and the orchestrator the same way `/ready`
  reaches the store: through narrow ports **declared** in `http/routes/`, with
  `main.ts` passing the real objects as the compiler-checked proof that they
  conform.

  The cost of that is real and worth naming: the run-status vocabulary, the
  `scriptName` pattern, and the launch-body validation rules each exist twice —
  once in `runs/`/`store/` and once, verbatim, in `http/routes/runs.ts`. Tests
  are exempt from the zone rules (they restrict `src -> tests`, not the
  reverse), so a duplication _can_ be pinned by a test importing both sides.
  Today only the status vocabulary is: `RUN_STATUS_VALUES` is asserted equal
  to `store/run-status.ts`'s `RUN_STATUSES`. The `scriptName` pattern and the
  body-validation rules are duplicated **without** such a guard, and are the
  obvious next thing to pin.

## Persistence

The console keeps an embedded SQLite database (ADR-0069) opened through
`node:sqlite`, the Node 24 builtin. `store/sqlite-driver.ts` is the only
module in the package that imports it, and its ports are structural
interfaces naming just the members this package consumes — never a direct
`= DatabaseSync` alias, which is what makes a seam unreplaceable.

What ADR-0069's recorded fallbacks would actually cost, stated honestly
rather than optimistically: a **packaged sqlite dependency** replaces
`store/sqlite-driver.ts`, `store/failures.ts`, and a factory injection —
the classifier is included because it branches on `node:sqlite`'s own error
vocabulary (`ERR_SQLITE_ERROR`/`ERR_INVALID_STATE`/`ERR_OUT_OF_RANGE` and a
numeric `errcode`), whereas `better-sqlite3` throws a string `.code` like
`SQLITE_BUSY` with no `errcode`. A **degraded JSONL-only mode**
additionally replaces `store/executor.ts`, which cannot sit on a
`prepare(sql)`-free backend and in any case encodes SQLite mechanics (the
per-statement bigint flag, the SQL-text statement cache, null-prototype row
normalization).

That is still a contained blast radius — three files, none of them visible
to a repository or to `main.ts` — which is the property the seam exists to
provide. It is simply not the one file an earlier draft of this README
claimed.

The database directory is created `0700` and the database file `chmod`ed to
`0600` before WAL is enabled, so the `-wal`/`-shm` sidecars inherit those
modes at creation. Without that, a default `umask 022` leaves operator
audit data (ADR-0070) world-readable, with recently written rows sitting in
cleartext in the `-wal`.

SQLite is an _index_ over authoritative JSONL, not the source of truth, so
migrations are forward-only with no `down`: recovery is "delete the file and
re-index", which is strictly safer than a reverse migration that has to be
correct under partial data. The schema version lives in `PRAGMA
user_version` (transactional, and readable on a schema-less database, so
there is no chicken-and-egg version table); `console_schema_migrations` is an
audit trail, not control flow.

The database file and its WAL sidecars are git-ignored at directory level
(`data/console/`) — a committed `-wal` would be replayed against a database
it does not belong to.
