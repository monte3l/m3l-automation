# @m3l-automation/m3l-console-server

Backend for the m3l operations console (ADR-0064): a modular monolith over
`node:http` with an internal router, health/readiness probes, and graceful
drain. It is the repo's first long-running process (ADR-0065) — everything
else here is batch-shaped.

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

Beyond those two probes there is nothing to call yet: the run-orchestration,
session, and audit routes arrive with X4 onward. What exists today is the
transport tier, the lifecycle, and the security posture the rest will be
built on.

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

| Setting                          | Env var                          | Default                            |
| -------------------------------- | -------------------------------- | ---------------------------------- |
| `m3l.console.db.path`            | `M3L_CONSOLE_DB_PATH`            | `<dataDir>/console/console.sqlite` |
| `m3l.console.db.busy.timeout.ms` | `M3L_CONSOLE_DB_BUSY_TIMEOUT_MS` | `5000`                             |

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
`isLoopbackHost`. Once the listener slice lands, the constraint is asserted a
second time at the only place that calls `listen`, so a programmatic caller
that bypasses config still cannot open a non-loopback listener (ADR-0071).

## Contract

The architecture record is ADR-0065 (modular monolith, layering, graceful
drain), the API shape is ADR-0066 (REST commands, SSE live streams, the error
envelope), and the deployment posture is ADR-0071 (loopback-only binding,
required operator profile). The REST/SSE contract ships as a
`docs/reference/` page with X4/X10, per ADR-0066.

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
  net                                        (m3l-common + node: only)
  errors                                     (m3l-common + node: only)
  config    -> errors, net
  auth      -> errors
  lifecycle -> errors, net
  store     -> errors                        (persistence; ADR-0069)
  http      -> errors, auth, lifecycle, net  (transport; may NOT import config)
  main.ts   -> everything                    (composition root; nothing imports it)
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

## Persistence

The console keeps an embedded SQLite database (ADR-0069) opened through
`node:sqlite`, the Node 24 builtin. `store/sqlite-driver.ts` is the only
module in the package that imports it — that single file plus a factory
injection is what ADR-0069's recorded fallbacks (a packaged sqlite
dependency, or a degraded JSONL-only mode) would replace.

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
