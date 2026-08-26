# @m3l-automation/m3l-console-server

Backend for the m3l operations console (ADR-0064): a modular monolith over
`node:http` with an internal router, health/readiness probes, and graceful
drain. It is the repo's first long-running process (ADR-0065) — everything
else here is batch-shaped.

## Status

This package is being built in slices. **It is not runnable yet** — there is no
process entry and nothing binds a socket. What ships today is the boot-time
configuration loader, the error vocabulary, and the composition root
(`createConsoleRuntime`). The `bin/m3l-console-server.mjs` entry, the
`pnpm console:server` script, and the HTTP listener land with the lifecycle
slice; that is deliberate, so no unauthenticated listener ever exists, even
transiently (ADR-0071).

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
  errors                                (m3l-common + node: only)
  config    -> errors
  auth      -> errors
  lifecycle -> errors
  http      -> errors, auth, lifecycle  (transport only; may NOT import config)
  main.ts   -> everything               (composition root; nothing imports it)
  ```
