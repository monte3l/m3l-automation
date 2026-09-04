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

## Update (2026-09-02) — the audit index is a lossy projection; an index-write failure is degraded, not fatal

X7c shipped the writer and the rebuild path the Consequences above called
for. Three things the Decision left open are now settled, and one Negative
consequence is discharged. The original text stays as written, per this
repo's dated-Update convention.

### The index is a projection, not a mirror

`M3LHumanActionRecord` carries eleven fields; `console_human_actions` has a
column for eight of them. `parameterNames`, `parameterRefs` and `detail`
have no column and are never indexed — so the index answers _who did what,
when, with what outcome_, and the JSONL trail is the only place a request's
parameter names, its ADR-0068 references and the console's own detail map
live.

That asymmetry is what makes "the JSONL trail is the source of truth"
operational rather than decorative: a rebuild can only run trail → index,
and a reader that needs the dropped three has to read the trail. A later
reader of this ADR must not assume the index is a copy of the trail.

### An index-write failure is a LOUD degradation, never a refusal

The Decision's "an unauditable action is refused" still holds for the trail:
`boot/audit-index.ts`'s dual-write port awaits the JSONL append FIRST and
lets it reject, so no index row can exist for an action whose trail entry
failed.

The index half is deliberately not symmetric. When the trail write succeeds
and the index insert fails, the operator's action SUCCEEDS and the failure
is logged at `error` with the correlation id and the action. The index is
derived and rebuildable; failing a real operator action because a derived
store hiccuped is worse than the missing row, and the rebuild below is the
recovery. A degradation, never a silent swallow — the `error` line carries
what is needed to correlate the miss back to the trail entry that did land.

### The rebuild path, and why its trigger is bounded

`boot/audit-rebuild.ts` reads the whole trail, projects each entry, then
truncates and reinserts inside ONE transaction. Two properties are load
bearing:

- **The whole trail is read before anything is written**, so a corrupt line
  leaves zero rows rather than an index holding a prefix of the trail that
  looks complete. A torn LAST line — a process that died mid-append — is
  tolerated and logged; the same fragment mid-stream still throws.
- **The trigger is "index empty AND trail not"**, at boot, strictly before
  the listener binds. An unconditional rebuild would be `O(trail)` on every
  start, forever, against an append-only file.

It never throws: a console that cannot rebuild a derived store must still
boot and serve, for the same reason an index-write failure does not fail an
action.

**This is also what keeps the v7/v8 migration property alive.** Those
migrations DROP and recreate `console_human_actions` (SQLite cannot alter a
`CHECK`), justified as loss-free partly because nothing wrote the table.
X7c ended that — but the empty table a recreate leaves behind is exactly the
rebuild trigger, so a future kind-widening migration may still drop rather
than needing a copy-through. Conditional on the trigger staying wired, which
`store/migrations/human-actions.ts`'s own TSDoc now instructs the next author
to verify.

### Discharged

The Negative consequence "dual-store audit (JSONL truth + SQLite index)
needs its rebuild path tested" is closed. `tests/boot-audit-rebuild.test.ts`
drives the rebuild against a real `M3LAppendOnlyStream` trail and a real
migrated store — idempotence, the corrupt-trail refusal, the torn-tail
tolerance and the trigger's bound — plus an end-to-end pass that performs an
audited write, finds it in BOTH stores, then opens an empty index and watches
a boot restore it from the trail.

### What X7c did not claim

A write route registered through `M3LConsoleRuntimeOptions.routes` is still
not audited: the audit spec table is keyed by the console's own path
templates and can hold no entry for a caller-invented route, and enforcing
its exhaustiveness guard against those would make that documented seam
unusable. That is now stated on the option itself and in
`docs/reference/console.md`'s Known limits rather than only in code.

The four declared-but-unwired kinds — `run.cancel`,
`session.binding.select`, `view.run.report`, `view.session.artifact` — need
routes before they can be wired, which is four new API endpoints rather than
audit work. They are split to tracker row X7d; `run.cancel` remains the
recorded deliberate absence ADR-0066 argued for, and
`session.binding.select` overlaps X11's declared drill-down scope.

## Update (2026-09-02, second) — all twelve kinds are wired; cancellation is un-deferred and the run report gains an address

X7d wired the four kinds the Update above split out, taking the twelve
declared in X7b from eight wired to twelve. Two of the four cost more than a
route, and one reverses a decision recorded under ADR-0066. The original text
stays as written, per this repo's dated-Update convention.

### A run report had no address, so the console now owns the output directory

`view.run.report` was never blocked on an endpoint. It was blocked on the
console being unable to **locate** what it would serve.
`Core.M3LRunReporter` writes to
`<outputDir>/<runDirectoryName(startedAt)>/run-report.json`, where
`startedAt` is the **child's own clock** — a value the console never observes
and cannot reconstruct, since its own `started_at_ms` is written by the
orchestrator around the spawn rather than by the child. Every
console-launched run also shared one `data/output` tree, so even the right
timestamp directory could not be attributed back to a run id.

The run id is the only handle both sides agree on. So the console now pins
`M3L_OUTPUT_DIR` per run, to `<runs output root>/<run id>`, and reads the
report back from the single timestamp directory beneath it. Three
consequences a later reader must not have to rediscover:

- **Console-launched runs no longer write into the shared `data/output`.**
  Per-run isolation is not a side benefit here — it is the mechanism that
  makes the report addressable at all.
- **`m3l.console.runs.output.root` is a SIBLING** of the session-artifact and
  audit roots, never a child of either. A spawned script owns everything
  beneath its own per-run directory, so no other subsystem's data may sit in
  a tree a script can write to. Same rule, same reason, as the artifact/audit
  split this ADR already made.
- **An ADR-0054 in-process run has no report to serve.** A hosted command
  runs inside the console's own process, `Core.M3LPaths` snapshots the output
  directory at construction, and there is no per-call seam to hand it a
  per-run one; mutating `process.env` for one run would leak into every
  other. Those runs 404, and that asymmetry is documented on the route rather
  than hidden behind a distinct error code.

Nothing prunes the per-run directories. Same posture as session artifacts,
same eventual owner — X8's retention regime.

### The "No cancellation route" absence is REVERSED

`docs/reference/console.md` listed **"No cancellation route"** under Known
limits, on ADR-0066's reading that cancellation described the contract's
eventual shape rather than anything the server answers. That bullet is
removed. `POST /api/v1/runs/:id/cancel` ships.

The reversal was cheap, and the reason is worth recording because the tracker
row said otherwise. X7d's row claimed `run.cancel` "needs child-process kill
plus queue eviction". Child-process kill **already existed** —
`M3LRunOrchestrator.cancel` aborted an active run, the executor already
escalated `SIGTERM` to `SIGKILL`, and a `run.cancelled` audit entry was
already written. Queue eviction was near-free too: `onQueueTimeout` was
already the exact sequence, and is now factored into one `abandonQueuedRun`
both paths call. Re-deriving the claim before planning around it is what kept
this a small change; the row's own text would have justified a much larger
one.

Two properties of the shipped route belong here rather than only in the
reference page:

- **The two branches are asymmetric on purpose.** An ACTIVE run is only
  aborted — its own completion continuation still owns the terminal write,
  and racing it would produce two finish records for one run. A QUEUED run
  **is** the terminal write, through `abandonQueued`'s guarded
  `queued → interrupted` transition, never `claimForStart`-then-`finish`: a
  run that never executed must never be given a fabricated `started_at_ms`.
- **No new run status and no migration.** Both branches land on the existing
  terminal `interrupted`, the same status a signal death or a crash-recovery
  reconcile produces.

`ERR_CONSOLE_RUN_NOT_CANCELLABLE` (409) is new, and deliberately distinct
from `ERR_CONSOLE_RUN_NOT_FOUND` (404): collapsing them would make a run that
finished a second before the request indistinguishable from a typo'd id.

### `session.binding.select` shipped its SERVER seam; X11 keeps the UI

The Update above deferred this kind on the grounds that it "overlaps X11's
declared drill-down scope". Re-derived against the tree, that overlap was
partial: X11 is a **UI** row, and no server route created a binding —
bindings existed only as a side effect of `POST …/sessions/:id/steps`. X11
would have had to build the endpoint before it could build anything.

So `POST /api/v1/sessions/:id/bindings` lands here and X11 is **not**
re-scoped: the JSON tree viewer, the pre-filled next operation, the decision
prompts and the canonical SQS Playwright acceptance all remain X11's. X11
starts from an endpoint that exists instead of building one first.

### What the trail carries for the four new kinds

All four obey the display-vs-persist split the Decision states, and the two
non-obvious calls are recorded so a later reader does not read them as
oversights:

| Kind                     | Phase    | Target      | Carries                                                                             |
| ------------------------ | -------- | ----------- | ----------------------------------------------------------------------------------- |
| `run.cancel`             | `before` | the run     | posture pinned `confirmed` — the route takes no body, so the request IS the gesture |
| `view.run.report`        | `after`  | the run     | the run id only; never the report                                                   |
| `view.session.artifact`  | `after`  | the step    | the session id in `detail`; never the artifact                                      |
| `session.binding.select` | `before` | the session | `parameterNames` only                                                               |

The two `view.*` kinds are `phase: "after"` for the reason `view.run.stream`
already was: each handler does its own not-found checks, so recording first
would assert an operator saw something they did not. Both still refuse — the
response body has not been written when a rejected append throws.

`view.session.artifact` carries **no `parameterRefs`**, and
`session.binding.select` carries **no reference**. In both cases the target
already is the reference, and the only string that could have gone in those
fields would have been one invented at the call site under a grammar nothing
else uses. An audit field that reads like a real artifact reference and is
not is worse than an absent one.

### What X7d did not claim

`parameterName` is still not persisted on a binding row —
`console_session_bindings` has no column for it, and none was added. It
reaches the audit trail; it does not reach the table. The per-run output
directories have no retention story, and the report route does nothing for
in-process runs. All three are stated in `docs/reference/console.md`'s Known
limits.

## Update (2026-09-04) — the telemetry read path is deliberately unaudited, and the collection-endpoint exclusion is now enforced

X8 slice 4a shipped `GET /api/v1/telemetry` with no `view.*` audit. The X8
slicing document read that absence as a gap, to be closed by a 13th
`M3LHumanActionKind` plus a `CHECK`-widening migration. It is not a gap: the
exclusion follows from this ADR's own display-vs-persist rule, and it is now
enforced by a test instead of carried in a comment. **The vocabulary stays at
twelve kinds.**

### Why a telemetry read is not an audited view

The Decision's exposure rule makes the audit trigger the **rendering of a
sensitive-class artifact** — live operation output, run-report contents — and
in the same sentence names telemetry on the other side, among the persistent
records that "never absorb displayed values". Telemetry is a sink in that
rule, never one of the artifacts whose rendering is audited.

The rollup buckets carry server-generated counters over server-controlled
dimensions: no caller data, no script output, nothing redaction-bearing. Each
of the three audited GETs renders something an operator could not otherwise
see; a rollup query renders counts the console itself produced.

`boot/human-action-specs.ts` already stated the boundary, in the comment above
its `view.run.stream` entry — "`/health`, `/ready` and every list/collection
endpoint are out of scope by decision — `view.*` covers sensitive-class
renderings only". This Update promotes that from a comment to a decision of
record, because the slicing document reached the opposite conclusion without
contradicting it.

### The boundary is asymmetric by construction, and the asymmetry was silent

`applyHumanActionAudit` throws `ERR_CONSOLE_INTERNAL` when a route whose method
is not `GET` carries no spec, so **write** coverage is exhaustive by
construction — a new write route cannot ship unaudited. A `GET` with no spec is
returned undecorated, deliberately and without complaint.

The vocabulary could therefore drift in exactly one direction — a `view.*` spec
appearing on a collection endpoint — with nothing to detect it. Slice 4a's
route was correct under the decision and verified in neither direction. A test
now pins the set of GET-method spec keys to exactly the three sensitive-class
renderings; a fourth fails it and puts its author in front of this Update.

### What a 13th kind would have cost, recorded so the question is not re-asked

Two costs, either of which is reason enough on its own:

- **A fourth recreate of `console_human_actions`.** Its `action` column's
  `CHECK` enumerates the twelve kinds and SQLite cannot `ALTER` a `CHECK`, so a
  13th needs a full table recreate — after v6, v7 and v8. The bare `DROP` stays
  non-lossy only while `rebuildHumanActionIndexOnBoot` fires on the
  empty-index-beside-a-populated-trail state, which is a condition to re-verify
  rather than inherit.
- **A target the schema has no member for.** `target_kind`'s `CHECK` admits
  only `script`, `run`, `session`, `step` and `artifact`, and `target_id` is
  `NOT NULL`. A rollup query addresses none of those, so the kind could not be
  wired without widening a second `CHECK` and inventing an id — the same defect
  this ADR already rejects for `view.session.artifact`'s `parameterRefs`, where
  "an audit field that reads like a real artifact reference and is not is worse
  than an absent one".

### What this Update does not claim

It does not say collection endpoints are unobservable. The HTTP request
telemetry X8 slices 2b–3d added counts every request including these, and the
access-log path is unchanged; what is absent is a **human-action** record, the
by-reference trail of operator gestures this ADR governs.

It does not close a related gap it surfaced: a spec keyed to a route path that
no longer exists is never consulted and never reported, because
`applyHumanActionAudit` looks specs up per route rather than reconciling the
two sets. A typo'd key silently audits nothing. Out of scope here; not yet
owned by a tracker row.

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
