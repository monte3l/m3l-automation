# 0076. A codified analysis spine with preset-driven known cases

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

`core/procedure` shipped as tracker item B2 (`docs/plans/IMPLEMENTATION.md:285`,
across PRs #580/#582/#583/#585/#586/#587). ADR-0046 admitted the engine on the
condition that a **named consumer** follow: an engine with no consumer is a
guess about what codified procedures need. W7 (`docs/ROADMAP.md:249`,
issue #466) is that consumer — `scripts/cloudwatch-logs-analysis`, which
analyses a CloudWatch alarm by walking its runbook's evidence chain and
reaching an operator verdict.

The question this ADR settles is **where the boundary between code and data
falls** for that script.

An alarm's analysis has two kinds of variation, and they behave very
differently:

- **Structural variation is small.** Every alarm runs the same spine: derive a
  window from the trigger time, query the alarm's own log groups, retry one
  severity rung lower if that finds nothing, optionally hop to an authorizer's
  log group, extract a correlation key, optionally follow that key down a
  service chain, derive an error signature, and match it against the runbook's
  known-cases table. What differs between alarms is only **which optional
  stages are active**.
- **Per-alarm variation is large and churns.** Log groups, query text, the
  status/severity filter, window offsets, the correlation field and its parse
  pattern, chain depth, latency thresholds, the escalation target, and — above
  all — the known-cases table, which operators amend after every incident.

Two obvious designs both fail, in opposite directions:

1. **A hand-written procedure per alarm.** Full compile-time checking, but one
   procedure covers one alarm, and every new known error is a code change and a
   release.
2. **A fully data-driven engine.** The whole step graph and condition algebra
   become untyped input. Every authoring error — a typo'd step id, a jump to a
   step that does not exist, two cases claiming the same priority — moves from
   compile time to run time. For this script, "run time" means _during an
   incident_, which is the worst possible moment to discover that the runbook
   you are relying on does not build.

## Decision drivers

- **A codified procedure's value is its compile-time guarantees.**
  `TShape["stepId"]` being a closed literal union is what makes `jumpsTo`
  targets checkable and build-time cycle detection possible at all
  (`packages/m3l-common/src/core/procedure/step-types.ts:129`). Erasing it to
  `string` throws that away.
- **A known-cases table cannot live in TypeScript.** The tables are amended by
  operators after incidents. Requiring a release per new known error means the
  script is stale exactly when it matters.
- **No authoring error may first surface mid-incident.** Whatever checking
  moves out of the compiler must be recoverable by something runnable
  beforehand, offline, in CI.
- **The library's public contract stays untouched.** W7 is a consumer, not a
  library change; `M3LLogsInsightsClient` already covers the whole log-analysis
  spine, so no new AWS wrapper is needed.

## Considered options

1. One hand-written `M3LProcedure` per alarm.
2. A fully data-driven procedure interpreter: steps, conditions and jumps all
   read from JSON.
3. **A codified spine with preset-driven cases** — the step graph in
   TypeScript, the known-case rows as data.
4. Option 3, plus `caseId` kept as a closed literal union by generating a
   TypeScript module from each preset at build time.

## Decision

We chose **option 3**.

**The spine is codified.** `AnalysisShape["stepId"]`
(`scripts/cloudwatch-logs-analysis/src/steps/preset.ts`) is a closed
ten-member literal union. Every step, every `jumpsTo` target and every
`loop.maxRevisits` is written in TypeScript, so the step graph keeps full
compile-time checking and `build()`'s cycle detection stays meaningful. A
stage the preset does not declare is not omitted from the graph — its step
runs and returns `{ flow: "continue" }` with the note
`"skipped: stage not declared"`, so a skipped stage is still visible in the
telemetry rather than silently absent.

**The cases come from the preset.** `AnalysisShape["caseId"]` is typed
`string`. `M3LProcedureBuilder.case()` narrows its pending-cases union by
`Exclude<TPending, TId>`, and `Exclude<string, "anything">` is still `string`,
so `.case()` can be called in a loop over a preset's rows. (Chaining does
collapse the union to `never` after the first call, so the rows are declared
one assignment at a time through an annotated binding — see
`build-procedure.ts`.)

**Option 4 was rejected** as a code-generation step that would put a build
between an operator amending a runbook and being able to use it — reintroducing
the release-per-known-error cost that motivated the split, for a compile error
that `validate` already catches offline.

### The accepted cost, and how it is contained

Typing `caseId` as `string` moves **case-id and priority uniqueness** from a
compile error to a `build()`-time `M3LProcedureValidationProblem`. That is a
real loss. It is contained by making the check impossible to discover
mid-incident:

- **`validate`** builds every preset in the runbook directory and reports every
  problem at once — `ERR_PROCEDURE_DUPLICATE_CASE_ID`,
  `ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY`, `ERR_PROCEDURE_INVALID_PATTERN` —
  with no AWS call and no credentials, so it runs in CI.
- **`explain`** prints `procedure.describe()`: every step with its kind, jump
  targets and loop bound; every case in priority order; the mandatory fallback;
  and the definition `digest`.

Two further checks are pulled forward to the **preset trust boundary**
(`load-runbook.ts`), ahead of `build()`, so the message names the preset field
rather than the engine's internal case table: a row claiming one of the
reserved terminal priorities (`1`–`9`), and a row claiming one of the three
codified terminal verdicts.

### The preset schema is a contract

`RunbookPreset` (`preset.ts`) is the script's public data contract, validated
field by field at the trust boundary. Its notable commitments:

- **`unsupported` is a first-class arm, not an absence.** An alarm whose
  evidence is not in a log group declares why, and its manual steps become
  report follow-ups. It is never guessed at, and never silently analysed into a
  wrong verdict.
- **Patterns are validated where they are authored.** Every regular expression
  is compiled and length-bounded at load, so a bad pattern is a preset problem,
  not a `SyntaxError` from inside a step.
- **Every value substituted into a query is allow-listed, not escaped.** Two
  values reach a Logs Insights query string: the extracted correlation key and
  the selected severity rung. Both are held to one shared rule,
  `SAFE_QUERY_VALUE` (`/^[\w.:/@#=+-]{1,256}$/`), which admits every shape
  these substitutions legitimately produce (severity levels, UUIDs, trace ids,
  request ids, ARNs) and nothing that can break out of a quoted literal. A key
  that fails it stops the analysis rather than running an altered query; a rung
  that fails it is rejected at whichever boundary it arrived through — the
  preset trust boundary for an authored ladder, `applyRunOverrides` for the
  `severityLadder` config override, whose schema validator only checks
  `nonEmpty`. Guarding one path and leaving the other open is worse than
  guarding neither, because it reads as if the boundary were closed.
- **`todos` is load-bearing.** `convert` records what it could not extract
  there, and a non-empty `todos` **fails** `validate` — a partially converted
  runbook cannot produce a confident wrong verdict.

### `convert` authors, it does not transcribe

Presets are typed JSON. `convert` reads one runbook markdown file and emits a
preset _skeleton_: the title, the entry query, the log groups, and one case row
per known-case table row, with descending unique priorities. What it cannot
read out of operator prose — the correlation rule above all — it records as a
`todo`. An author closes the gap either by editing the skeleton or by adding an
`m3l-preset` JSON fence to the runbook, which `convert` merges over the
extracted skeleton. `convert` reads from `M3L_INPUT_DIR` and writes to
`M3L_OUTPUT_DIR`, both of which an operator points at their own store outside
this repository.

### The step graph, and one divergence from the plan

| Step                      | Kind      | Flow                                                                                          |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `resolve-window`          | transform | `[start, end)` from `triggeredAt` ± preset offsets; `stop` for an out-of-scope alarm          |
| `widen-severity`          | control   | selects the rung; execution _n_ selects rung _n − 1_                                          |
| `gather-entry`            | gather    | the preset's entry query at the selected rung                                                 |
| `check-entry-evidence`    | check     | rows ⇒ `continue`; none + rung left ⇒ `{ goTo: "widen-severity" }`; none + exhausted ⇒ `stop` |
| `gather-authorizer`       | gather    | active only when declared **and** the latency threshold is exceeded                           |
| `extract-correlation`     | transform | no key, or an unsafe key ⇒ `stop`                                                             |
| `decide-trace-depth`      | decide    | `M3LPrompt` when interactive; the configured ceiling otherwise                                |
| `gather-trace-level`      | gather    | `jumpsTo: ["gather-trace-level"]`, capped by the preset's own depth                           |
| `extract-error-signature` | transform | the value the cases match on                                                                  |
| `match-known-cases`       | check     | `flow: "resolve"`                                                                             |

The plan for this work put `jumpsTo`/`loop` on `widen-severity` and placed it
**after** `gather-entry`. That ordering is wrong: `check-entry-evidence`
returning `"continue"` runs the next step in declaration order, which would
have been `widen-severity` — widening the severity on the success path. Moving
`widen-severity` ahead of `gather-entry` and putting the loop on
`check-entry-evidence` keeps the identical semantics with a correct linear
fall-through, and the back edge still originates from a step carrying `loop`,
so it stays excluded from cycle detection.

### Verdict vocabulary

`known-no-action`, `known-open-issue`, `known-closed-issue`,
`transient-downstream`, `no-correlation-id`, `no-evidence`, `unsupported`,
`unrecognised`. The first four and `unrecognised` are authorable per case row;
the other three are reserved for the codified terminal cases.

### Supported and unsupported alarms

**Supported:** any alarm whose evidence is in a log group. Event-schema and
firewall log groups are ordinary log groups with a different field shape, which
is preset data, not a structural difference.

**Declared `unsupported`, never guessed:** alarms whose evidence is not in a
log group at all — metric-only alarms, batch invocation failures,
synthetic-canary artifacts, data-lake SQL analyses.

**Emitted as report follow-ups, not executed:** key-value table lookups,
object-store artifact and checksum verification, relational read-model SQL,
metric-graph inspection, configuration checks, chat notification, ticket
creation. These are all _downstream of_ the log verdict. Keeping them out is
what keeps "no new AWS wrapper needed" true; the library already has
object-store, queue and relational wrappers if a later wave automates any of
them.

## Consequences

- **Positive:** the step graph keeps full compile-time checking and build-time
  cycle detection; a new known error is a preset edit, not a release; the
  engine's own features are genuinely exercised (`goTo` + `loop`, a self-jump
  capped by depth, `stop`, unique `priority`, the mandatory `fallback` carrying
  `investigated`, `decide` + prompt, `digest`, `script.signal`); `validate` is
  a CI gate that needs no AWS credentials.
- **Negative / trade-offs:** case-id and priority uniqueness is a build-time
  check rather than a compile error. Accepted, mitigated by `validate` and
  `explain`, and narrowed further by the two trust-boundary checks above.
  Preset authoring is now a real activity with its own failure modes — which is
  why the schema is validated field by field rather than cast.
- **Semver impact:** none. `packages/m3l-common` is untouched; W7 is a consumer
  script.

## Links

- Related: [ADR-0046](./0046-codified-procedure-engine.md) (the engine, and the
  named-consumer condition this ADR discharges),
  [ADR-0022](./0022-reintroduce-scripts-workspace.md) (fleet conventions),
  [ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md) /
  [ADR-0029](./0029-script-dependency-boundary.md) (the AWS boundary this
  script stays inside), [ADR-0028](./0028-aws-service-naming-convention.md)
  (the script's name), [ADR-0048](./0048-target-graded-destructive-confirmation.md)
  (no gate is configured — every operation is read-only against AWS),
  [ADR-0049](./0049-cooperative-cancellation-contract.md) (`script.signal` into
  the Logs Insights poller), [ADR-0072](./0072-reviewable-slice-discipline.md)
  (the landing shape).
- Implements: `docs/ROADMAP.md` W7, issue #466.
