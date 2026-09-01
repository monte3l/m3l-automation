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

## Update (2026-09-01) — correlation is threaded explicitly; `AsyncLocalStorage` would be wrong here

X7b implemented the correlation seam this ADR flagged. Two decisions
above did not survive contact with the code, and this Update supersedes
them; the original text stays as written, per this repo's dated-Update
convention.

### `AsyncLocalStorage` is not merely unnecessary — it would mis-attribute

The Decision says the id is "carried server-side through an
**`AsyncLocalStorage` request context**". It is not, and must not be.

The evidence is `pumpQueue` in `src/runs/orchestrator.ts`. It starts a
queued run from **inside a different run's completion continuation**
(`finishActiveRun`), not from the request that queued it. Under an
ambient store, run B — queued by request 2 — would execute inside
whatever context request 1's completion happened to be running in, and
every audit record, log line and run report for B would be filed under
request 1's id. That is not a missing feature; it is a silently wrong
trail, which is worse than none. Two further call sites have no ambient
context at all to read: `onQueueTimeout` fires on a timer callback, and
`reconcileOnBoot` runs before any request exists.

So the id is threaded **explicitly**, stored on `M3LPendingQueuedRun` so
it survives the queue, and passed as a required `correlationId` on the
executor's options bag. `M3LRequestContext` (`src/http/context.ts`)
already carried `correlationId`, `operator` and `accessMode` explicitly —
the seam existed; only the run path below it was missing.

The regression lock is
`tests/runs-orchestrator-correlation.test.ts`'s "a queued run is
correlated to its OWN launch, not the run whose completion started it",
which fails if the stored id is ever dropped in favour of an ambient one.

### The library seam: four tiers, and why the env tier exists

The flagged `m3l-common` additive minor landed as three optional fields
and one environment tier, resolving highest-first:

1. `M3LScriptOptions.correlationId` — the constructor value.
2. `M3LScriptRunOptions.correlationId`, **or** Lambda's
   `context.awsRequestId` (mutually exclusive entry points, one tier).
3. The `M3L_CORRELATION_ID` environment variable.
4. A generated `crypto.randomUUID()`.

Environment sits **below** both explicit values, matching this library's
existing precedent that an explicit `--log-level` beats `M3L_LOG_LEVEL`:
ambient environment must never override an id a caller wrote down. It
sits **above** generation because that is the only channel that reaches a
**spawned** script. `M3LScript`'s resolution had no environment tier, and
the console never touches a spawned script's `main.ts` — so writing the
variable without adding the tier would have repeated the
`M3L_RUN_PARAMETERS` mistake, a variable this server sets and nobody
reads. The env-var name is a deliberately mirrored literal in two
packages, each side carrying a test that exercises the exact spelling.

### Why `M3LCommandContext.correlationId` is optional

It breaks its own file's required-holding-`undefined` convention (the one
`signal` and `dryRun` follow) on purpose. Those two are values a command
must **branch on**, so the required form is right — it forces every host
to state them and every callee to narrow. `correlationId` is passed
**through**, and its absence has a safe fallback: the script resolves its
own id. There is nothing a callee can forget to handle.

It is also what kept this additive. An `M3LCommandContext` is
constructed at 15+ sites — the script template, four shipped scripts, the
CLI's in-process runner and their test fakes — so a required field would
have made this a **major** where this ADR budgeted a minor. The repo has
already paid that exact cost once: a required `dryRun` on
`M3LScriptHookContext` broke seven consumer test fakes.

### Surface accounting

- **`m3l-common` 4.6.1 → 4.7.0** (additive minor). Three optional fields
  through the **existing** Core barrel: no new `exports` subpath, no new
  named export. `check:api` — which is `bin/check-exports-snapshot.mjs`,
  and diffs only the `exports` map — did not move, and neither did
  `check:doc-exports` or `check:exports-semver`.
- Console-server changes are internal: `M3LRunExecutorOptions` is
  unexported, so its new required field is neither a semver nor a knip
  event.
- Promoting the env-var name to an exported constant later remains open
  and would itself be an additive minor — no lock-in either way. It is
  deliberately **not** exported now, because this library writes every
  env-var name as an inline literal (`errors.test.ts`'s source scan
  treats any `const NAME = "M3L_…"` as a declared error code).
- A CLI flag was considered and rejected for the spawn channel: the
  console spawns `dist/main.js` with a fixed argument list, and a script's
  own `argv` belongs to the script, not its launcher. An environment
  variable is the channel that does not collide with a consumer's flags.

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
