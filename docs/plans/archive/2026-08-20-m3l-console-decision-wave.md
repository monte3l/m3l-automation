# m3l console — exploratory design and decision wave

**Status: shipped** — PR `feat/m3l-console-docs` (X1 of the programme).

## Context

The third successive evolution request in one day, on the U-series
(CLI-first) and V-series (agent-operator) baselines: evolve the
application into a **full-stack application** for AWS monitoring,
operations, and troubleshooting — a web GUI launching tasks/scripts at a
button press, interactive drill-down workflows (canonically: list SQS
queues → dump → pretty JSON → select field values → DynamoDB query by
those keys → ask the user how to proceed), and comprehensive persistent
audit of every user action plus application self-monitoring. The
maintainer leans decoupled/containerized/microservice-oriented, not
mandatorily.

A five-facet `/auditing` fan-out (baseline seams, interactive-workflow
readiness, frontend/toolchain collisions, service/deployment surface,
audit/observability — 20 agents, adversarial verification) found the
baselines supply the right seams but none of the service substrate: no
HTTP server, daemon pattern, run registry, streaming channel, session
state, frontend toolchain, containers, or human-action audit anywhere;
sqs-etl lacks a list-queues operation; and the UI's need to display
values collides with the repo's redaction stances (run-report sensitive
classification; names-never-values) — a conflict needing an explicit
exposure model.

## Approach / Decisions

Two interview rounds settled every fork:

- **Modular core + frontend, two containers** over day-one microservices
  or a single deployable: `packages/m3l-console-server` (hard internal
  runs/sessions/audit/policy boundaries, microservice-READY; split is a
  recorded gate) + `packages/m3l-console-web`.
- **The ADR-0054 hybrid seam's third consumer** for execution — no new
  execution contract; policy (ADR-0060) and decision log (ADR-0061)
  apply with escalate-by-default until V6/V7 ship.
- **React 19 + Vite** with a **scoped bundler exception** to ADR-0001
  (browser-target packages only; explicitly does not unblock U14/SEA).
- **`node:sqlite` behind a repository seam** (Node 24 builtin, zero new
  deps) with a recorded Aurora migration gate via the shipped
  `aws/rds-data` (ADR-0031 consumed, not reopened).
- **REST + SSE** (Last-Event-ID resume, ring-buffer + REST-snapshot
  re-sync); WebSocket recorded-not-built.
- **Workbench sessions** as a new first-class concept — addressable step
  results, typed field-selection→parameter bindings, session→flow
  export — deliberately distinct from flows (predefined) and procedures
  (per-script); **its convention is what U10 consumes** (reversed
  dependency, recorded in ADR-0056's Update).
- **Local-first + identity seam**: compose on localhost, declared
  operator profile in every audit record, auth middleware seam with a
  single-operator provider; remote/multi-user gated on a future OIDC
  ADR.
- **Display-vs-persist exposure rule** resolving the redaction trio:
  authenticated transient display of sensitive artifacts (itself an
  audited view action); persistent records by name/reference only;
  provenance tagging (allowlist-strong vs best-effort).
- Authoring-time resolutions: `node:http` + internal router with a
  recorded framework fallback; console run registry distinct from
  `m3l history`; per-script mutex + bounded queue; ADR-0034 amendment
  scoping "container-free" to the toolchain; ADR-0015's "ships no
  images" Update deferred to the first image (X12).

## Outcome

Shipped as X1: ADR-0064…0071 + index rows; Update blocks on ADR-0001
(scoped bundler exception), ADR-0035 (fourth Update: exposure rule +
human-action stream), ADR-0056 (U10 consumes the 0068 convention); the
ADR-0034 amendment; the programme plan `docs/plans/2026-08-20-m3l-console.md`
(X1–X16); X-series tracker rows + ROADMAP wave subsection + filing-work
legend (A/B/C/U/V/X-series); U10's row gains the convention pointer. All
40 `pnpm verify` steps green; `sync:hub-issues` dry-run previews 15 new
X-issues with clean keys and zero collisions.
