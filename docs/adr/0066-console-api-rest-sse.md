# 0066. Console API contract: REST commands, SSE live streams

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

`m3l-console-web` needs a wire contract to code against: discrete user
actions (launch a run, create a session, select a field, answer a
decision prompt) and queries (history, sessions, health), plus
**continuous server→client data** — live log tails, run progress, session
step results appearing as they complete. The audit confirmed no push or
streaming channel exists anywhere in the baselines; everything today is
pull-after-completion. This ADR fixes the contract; server internals are
ADR-0065's decision and the UI consuming it is ADR-0067's.

## Decision drivers

- **The identified traffic is asymmetric**: user actions are discrete
  request/response; only server→client data is continuous. Nothing in the
  console's scope needs client→server streaming.
- **Operable with plain tools**: curl-testable, proxy-friendly,
  reconnecting without a custom protocol.
- **One error vocabulary**: API errors must speak the ADR-0035 registry
  language the whole repo already uses.
- **The exposure model governs payloads** (ADR-0070): the API is a
  display channel, not a persistence channel.

## Considered options

1. **WebSocket for everything.** Rejected: full-duplex power the traffic
   shape doesn't need, at the cost of socket lifecycle, per-socket auth,
   and reconnect state machines on both sides.
2. **Polling only.** Rejected: live log tailing and progress become
   laggy and chatty — a poor "watch the run" experience.
3. **GraphQL.** Rejected: a query language + runtime dependency for an
   API whose shapes are known, few, and server-defined.
4. **REST + Server-Sent Events.** Chosen.

## Decision

We chose **option 4**.

- **REST** for commands (POST: launch run, create session, execute a
  session step, answer a decision prompt, cancel) and queries (GET:
  scripts/operations from discovery, run registry with filters, sessions,
  health/readiness, telemetry summaries).
- **SSE** for live streams, one channel per run and per session: output
  lines (through the ADR-0054 output port in-process, or spawn
  stdio-tailing until U7), run status transitions, and session step
  results. Typed event names; every event carries a monotonically
  increasing id.
- **Resume**: `Last-Event-ID` resumes within a bounded **in-memory ring
  buffer per stream** (size cap fixed at implementation). A gap beyond
  the buffer is signalled explicitly; the client re-syncs with a REST
  snapshot and continues — the stream is an accelerator over queryable
  state, never the only copy. Slow-client backpressure: events beyond
  the buffer drop for that client with the same explicit gap signal
  (never unbounded memory).
- **Error envelope**: one JSON error shape carrying the named `M3LError`
  code, the ADR-0035 origin classification where present, an HTTP-mapped
  status, and the correlation id — never a raw stack. Run results reuse
  ADR-0063's allowlisted-scalar envelope philosophy; free-form report
  content is never re-emitted through result payloads (display routes
  are ADR-0070's exposure-model concern).
- **Correlation**: requests accept/receive an `m3l-correlation-id`
  header; propagation mechanics through to script execution are
  ADR-0070's decision.
- **WebSocket is recorded, not built.** Unblock condition: a feature
  requiring client→server streaming or sub-event-granular bidirectional
  interaction that SSE + REST demonstrably cannot express — a dated
  Update here at that time.

## Consequences

- **Positive:** the browser's native `EventSource` does the client work
  (auto-reconnect + Last-Event-ID for free); every endpoint is
  curl-testable; the error vocabulary is the one the CLI, scripts, and
  agents already speak; the snapshot-plus-stream shape keeps SQLite the
  source of truth for state.
- **Negative / trade-offs:** HTTP/1.1 per-origin connection limits cap
  concurrent SSE streams (moot behind HTTP/2, documented for local
  setups); the ring-buffer gap semantics push occasional re-sync
  complexity to the client; any future bidirectional feature pays the
  WebSocket adoption cost then.
- **Semver impact:** none from this ADR (docs only). The contract ships
  with X4/X10 and becomes part of the console's reference docs then.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Server:
  [ADR-0065](./0065-console-server-architecture.md). Consumer:
  [ADR-0067](./0067-console-frontend-stack.md). Payload governance:
  [ADR-0070](./0070-console-audit-and-observability.md).
- Vocabulary: [ADR-0035](./0035-failure-reporting-and-diagnostics.md)
  (error registry), [ADR-0063](./0063-cli-structured-run-results.md)
  (allowlisted-scalar envelope philosophy).
