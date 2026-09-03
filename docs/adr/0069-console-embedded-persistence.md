# 0069. Console embedded persistence: `node:sqlite` behind a repository seam

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The console needs queryable persistent state the flat-file world cannot
serve: workbench sessions with addressable steps, a run registry with
filters ("runs this week", "failures by script"), a human-action audit
index, and self-telemetry with aggregations. The audit confirmed the
current stores are all flat files (checkpoints, JSONL logs, the CLI's
best-effort history), the only in-boundary database is Aurora via the
shipped `aws/rds-data` wrapper ([ADR-0031](./0031-relational-and-document-data-engine-access.md)),
non-AWS drivers are out-of-boundary (DocumentDB's pre-clearance
withdrawn), and Node 24 — this repo's floor, [ADR-0003](./0003-node-24-floor.md) —
ships **`node:sqlite`**, an embedded SQL engine with zero package
dependencies.

## Decision drivers

- **Minimal dependencies** is the non-negotiable — a builtin beats any
  package.
- **Local-first** (ADR-0071): the console must work with no cloud
  infrastructure running.
- **ADR-0017/0029 boundaries untouched**: no new runtime dependency
  tiers, no boundary re-litigation.
- **The decision log's semantics survive**: ADR-0061's append-only JSONL
  stream is an audit source of truth; a database must not quietly become
  the authoritative copy.

## Considered options

1. **Files only** (JSONL + in-memory indexes). Rejected: every query
   feature is hand-built and rebuilt on restart; sessions' addressable
   steps and telemetry aggregations become bespoke index code.
2. **Aurora via `aws/rds-data` from day one.** Rejected as the default:
   in-boundary and multi-instance-ready, but makes the console require
   always-on cloud infrastructure for local use and puts an API
   round-trip in every UI query.
3. **A packaged embedded engine** (better-sqlite3 etc.). Rejected: a
   native-module dependency where a builtin exists.
4. **`node:sqlite` behind a repository seam, with a recorded Aurora
   gate.** Chosen.

## Decision

We chose **option 4**.

- **Store**: one SQLite database file per deployment under the
  workspace-anchored `data/` tree (volume-mounted in containers,
  ADR-0071), holding sessions + step/binding metadata, the run registry,
  the human-action audit index, and self-telemetry. Bulk artifacts stay
  files referenced from the store (ADR-0068).
- **Repository seam**: console modules speak only to typed repository
  interfaces; SQLite is an implementation detail behind them. This is
  what keeps both the fallback and the Aurora gate cheap.
- **Source-of-truth discipline**: ADR-0061's JSONL decision log (and any
  append-only audit stream ADR-0070 adds) remains authoritative; SQLite
  _indexes_ audit streams for query and can be rebuilt from them. State
  that is genuinely relational-first (sessions, registry, telemetry)
  lives natively in the store.
- **Stability checkpoint (X3)**: `node:sqlite`'s API surface is
  confirmed against the Node 24 floor at implementation. If it proves
  unstable/insufficient, the **recorded fallback options** are: accept a
  packaged sqlite dependency (console-server's own dependency, a dated
  Update here), or a degraded JSONL-only mode behind the same
  repositories — options named now, chosen only if the checkpoint fails.
- **The Aurora gate (X16)**: if multi-instance deployment or a
  cloud-hosted console fires (the X14/X15 gates), specific hot tables
  migrate to Aurora via the already-shipped `aws/rds-data` wrapper —
  ADR-0031 is consumed through its own decision, not reopened. The
  repository seam is the migration boundary; single-writer SQLite
  semantics are accepted until then (one backend container, ADR-0064).

## Consequences

- **Positive:** real SQL (filters, ranges, percentiles) with **zero new
  dependencies**; local-first containers get durable state via one
  volume-mounted file with trivial backup; the minimal-deps culture
  survives contact with a stateful application; both escape hatches
  (fallback, Aurora) are pre-scoped behind one seam.
- **Negative / trade-offs:** single-writer semantics cap the
  architecture at one backend instance until X16; a young builtin API
  carries the stability checkpoint's real (if small) risk; rebuildable
  indexes over JSONL add a reconciliation path that needs tests.
- **Semver impact:** none from this ADR (docs only). X3 is
  console-server-internal; no `m3l-common` or exports-map change.

## Update (2026-09-03) — "volume-mounted" becomes `hostPath`

[ADR-0091](./0091-podman-replaces-docker.md) replaces Docker with Podman and
`compose.yaml` with a `podman kube play` pod manifest. The `data/` tree
described above as "volume-mounted in containers" is now mounted as a pod
`hostPath` volume — a mechanism change only; the file, its location, and the
single-writer semantics this ADR decided are all unchanged.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Consumers:
  [ADR-0065](./0065-console-server-architecture.md) (run registry),
  [ADR-0068](./0068-workbench-sessions.md) (sessions),
  [ADR-0070](./0070-console-audit-and-observability.md) (audit index +
  telemetry).
- Engine change: [ADR-0091](./0091-podman-replaces-docker.md).
- Boundaries respected: [ADR-0017](./0017-dependency-loading-standard.md)
  (a builtin adds no dependency tier),
  [ADR-0031](./0031-relational-and-document-data-engine-access.md) (the
  Aurora path consumed via its own gate),
  [ADR-0061](./0061-agent-decision-log.md) (source-of-truth discipline).
