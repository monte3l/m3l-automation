# 0070. Console audit, self-observability, and the display-vs-persist rule

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The console's mandate is explicit: **everything the application does is
persistently logged for auditing** — every action performed at the user's
request, plus comprehensive internal self-monitoring for debugging and
troubleshooting. The audit confirmed the gaps: the ADR-0061 decision log
records _agent_ policy verdicts, but nothing records _human_ UI actions
with identity; a per-run `correlationId` exists inside `M3LScript.run()`
but no mechanism threads a request id UI → API → script; there is no
metrics surface (latencies, error rates, percentiles), no log query story
beyond grep, and no retention tooling.

It also confirmed a design-critical conflict trio: the UI must **display**
live dump values and run-report contents to be useful for
troubleshooting, while ADR-0035 classifies the run report as a sensitive
crash-dump artifact, ADR-0061 and the CLI history enforce
names-never-values, and breadcrumb data mixes allowlist-strong and
best-effort-redacted entries with no way to tell them apart.

## Decision drivers

- **Audit must cover refusals and views, not just executions** — the
  record answers "who did what, when, and what did the system decide".
- **Display and persistence are different exposure classes**: an
  authenticated operator looking at live data is not the same act as
  writing that data into a durable, broadly-readable record.
- **Reuse the existing vocabulary**: correlation ids, the artifact
  taxonomy (ADR-0035), append-only + loud-write semantics (ADR-0061).
- **Self-observability serves one operator debugging their own tool** —
  SQLite-grade aggregation, not an APM platform.

## Considered options

1. **Extend ADR-0061's decision log to also carry human actions.**
   Rejected: it would overload one artifact with two subjects (agent
   verdicts vs human actions) and two write paths; the taxonomy stays
   cleaner with a sibling class sharing the same semantics.
2. **Full observability platform (OTel exporters, external APM).**
   Rejected as the first step: the recorded later step (as in ADR-0061)
   — an export layer can read these stores when a real need fires.
3. **Console-owned audit + telemetry in the embedded store, plus an
   explicit exposure rule registered in the taxonomy.** Chosen.

## Decision

We chose **option 3**.

### Human-action audit

Every user-requested action — run launches, session steps, field
selections, decision answers, cancellations, and **sensitive-artifact
views** (opening a run report, viewing a dump) — writes an audit record
carrying: timestamp, the declared **operator identity** (ADR-0071's
profile, required), the correlation id, the action and its target
(script/operation/session/step), parameters **by name and by ADR-0068
reference — never by value**, the policy posture applied
(auto/confirmed/escalated), and the outcome. Semantics follow ADR-0061's
discipline: append-only JSONL stream as the source of truth with **loud**
write failure (an unauditable action is refused), indexed in the ADR-0069
store for query. The stream registers as a sibling artifact class beside
the agent decision log via ADR-0035's dated Update.

### Correlation

One correlation id per user action, generated at the UI/API edge
(ADR-0066's header), carried server-side through an
**`AsyncLocalStorage` request context**, and handed to script execution
so it becomes the `correlationId` that `M3LScript.run()` already
resolves — one id joins the UI click, the API request, the audit records,
the run report, and the telemetry rows. If threading it into the spawn
path needs a library seam beyond the existing options bag, that is a
flagged `m3l-common` additive-minor decision at X7, not an implicit
change.

### Self-telemetry and retention

The server measures itself into the ADR-0069 store: HTTP request
latencies and error rates by route, script-run durations/outcomes by
script and operation, SSE stream counts, policy-posture distribution,
store health. Queryable through ADR-0066 endpoints (the UI's own
monitoring pages). **Retention** becomes real tooling: declared policies
per artifact class (audit streams: segment + retain, ADR-0061-style;
telemetry: age-based rollup/pruning; session artifacts: ADR-0068 caps)
with an operator-run cleanup command — never silent deletion. An
external export layer (OTel-style) stays the recorded later step.

### The display-vs-persist exposure rule

**Display ≠ persist.** The authenticated console UI may **transiently
render** sensitive-class artifacts — live operation output (the dump's
actual values), run-report contents — to its operator; that rendering is
itself an audited _view_ action (by reference). **Persistent records
never absorb displayed values**: audit streams, telemetry, session
metadata, and API result envelopes stay names/references/allowlisted
scalars (bulk payloads live only as their governed artifact files).
Where the UI renders diagnostic data, it surfaces the provenance the
taxonomy already implies — allowlist-strong (built-in breadcrumb
summarizers, envelope scalars) vs best-effort-redacted (run-report
free text, custom breadcrumb events) — so an operator knows which
surfaces carry redaction guarantees. The rule registers in ADR-0035's
taxonomy (its fourth dated Update) as the exposure policy for every
sensitive-class artifact the console touches.

## Consequences

- **Positive:** the mandate is met without breaking the taxonomy — full
  who/what/when audit including refusals and views, one correlation
  thread end-to-end, self-monitoring queryable in the tool itself; the
  redaction trio resolves into one teachable rule instead of three
  contradictions.
- **Negative / trade-offs:** view-auditing adds write volume (bounded by
  retention policies); dual-store audit (JSONL truth + SQLite index)
  needs its rebuild path tested; provenance tagging in the UI is honest
  about best-effort surfaces rather than making them look guaranteed.
- **Semver impact:** none from this ADR (docs only). X7/X8 are
  console-server work; the flagged correlation seam would be an
  `m3l-common` additive minor decided at X7.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Store/index:
  [ADR-0069](./0069-console-embedded-persistence.md). Identity:
  [ADR-0071](./0071-console-containerization-deployment.md). Header:
  [ADR-0066](./0066-console-api-rest-sse.md). References:
  [ADR-0068](./0068-workbench-sessions.md).
- Taxonomy: [ADR-0035](./0035-failure-reporting-and-diagnostics.md)
  (fourth dated Update registers the exposure rule + the human-action
  stream); semantics precedent:
  [ADR-0061](./0061-agent-decision-log.md).
