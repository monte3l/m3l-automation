# 0077. Codified dead-letter-queue triage: one preset per queue, predicates as the matcher

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

[ADR-0076](./0076-codified-runbook-analysis-presets.md) settled where code
stops and data starts for the first codified-procedure consumer,
`scripts/cloudwatch-logs-analysis`. W8 is the second: a script that triages
messages stranded in SQS dead-letter queues and, unlike its sibling, **acts on
the verdict it reaches**.

The maintainer's review of the operator runbooks covering this work
established that the analysis spine is near-identical across every queue, while
everything that varies per queue is tabular data amended after each incident.
That is the same shape ADR-0076 already ruled on, so the split itself is not
relitigated here.

Four questions are genuinely new, and this ADR settles them:

1. **The script mutates.** `cloudwatch-logs-analysis` is read-only against AWS,
   so ADR-0076 records "no gate is configured". A triage script that deletes
   and re-sends messages needs a confirmation boundary, and needs it placed
   somewhere an operator can still inspect the plan.
2. **The matcher is not a single derived signature.** ADR-0076's known-cases
   table matches one error signature. Here a case is identified by a
   **state-transition pair** — the entity's current state versus the state the
   message tried to apply — sometimes qualified by an ordered-progression
   containment check.
3. **Not every queue is triageable the same way**, and one is explicitly barred
   from re-insertion. ADR-0076 has a binary supported/`unsupported` arm; this
   needs more arms plus an override that outranks them.
4. **One preset must cover several event types on one queue**, which ADR-0076's
   one-preset-per-alarm shape does not express.

## Decision drivers

- Reuse the engine and the conventions already ratified — ADR-0046's
  `core/procedure`, ADR-0048's graded confirmation, ADR-0049's cancellation
  contract — rather than growing parallel machinery.
- A new known case must stay a preset edit, not a release (ADR-0076's core
  driver, unchanged).
- **A wrong verdict here deletes a message.** The read-only sibling could
  afford to guess and be corrected; this one cannot.
- Keep the build-time checks out of an incident: whatever can fail must fail in
  CI, with no credentials.
- Set file boundaries before they grow (ADR-0072).

## Considered options

1. Extend `cloudwatch-logs-analysis` with queue-shaped presets.
2. A new script that analyses only, leaving remediation to `sqs-etl`.
3. A new script that analyses **and** executes, behind a graded gate.
4. Drive the whole thing from `M3LSQSOperations.redrive()`.

## Decision

We chose **option 3**.

Option 1 is rejected because the two spines differ structurally, not just in
data: this one routes on an event-type discriminator and widens a lookup tier
by tier, neither of which exists in the log-analysis graph. Option 2 is
rejected because the manual step it leaves behind — hand-building a deletion
manifest from an analysis report — is precisely the error-prone step the work
exists to remove.

`scripts/sqs-dead-letter-triage` is named per
[ADR-0028](./0028-aws-service-naming-convention.md) (full service name,
`<service>-<purpose>`, no `dlq` abbreviation). It is the _decision_ layer above
`scripts/sqs-etl`, which keeps the mechanical dump/send/redrive/delete/purge
operations; neither absorbs the other.

### `redrive()` is deliberately not used

`M3LSQSOperations.redrive()` (`packages/m3l-common/src/aws/sqs/client.ts`) has
exactly the right decision vocabulary — `M3LSQSRedriveDecision`'s
`move | drop | retry` (`packages/m3l-common/src/aws/sqs/types.ts`) — and this
script reuses that type as its action vocabulary rather than defining a fourth
one.

Its **control flow** is the mismatch: `redrive` receives a message and acts on
it in a single pass, driven by a per-message callback. That leaves nowhere to
put the confirmation gate, which by construction must sit _between_ analysing
every message and mutating any of them. The script therefore composes
`receive` / `sendBatch` / `deleteBatch` directly — the same three methods
`redrive` itself composes, so no new raw SDK call and no new Zone A edge — and
gets the FIFO path's sorted, one-entry-at-a-time send as a second consequence.

This is not a defect in `redrive`. A single-pass redrive remains the right
shape for `sqs-etl`'s mechanical use.

### The wrapper widening, and one correction

Per [ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md) the wrapper widens
before the script starts. `M3LSQSOperations.getQueueAttributes` returns
`M3LSQSQueueAttributes`: the three depth counters, `queueArn`, `fifoQueue`, and
the two redrive policies.

The planned surface also carried an oldest-message age. **It is not
implementable as a queue attribute**: `ApproximateAgeOfOldestMessage` is a
CloudWatch metric, and the `QueueAttributeName` enum of the pinned
`@aws-sdk/client-sqs` exposes no such name. The operator need behind it is met
instead from each drained message's `SentTimestamp` system attribute, which
`receive` already supports through
`M3LSQSReceiveOptions.systemAttributeNames` — an exact per-message age rather
than a queue-level approximation, and no CloudWatch dependency added to a
triage script.

The other fields each have a named consumer: `queueArn` is the resolved target
for the ADR-0048 gate, and `fifoQueue` cross-checks a preset's declared `fifo`
against the live queue.

The source-queue cross-check reads **`redriveAllowPolicy.sourceQueueArns`**,
not `redrivePolicy.deadLetterTargetArn`. The direction matters and is easy to
invert: `RedrivePolicy` is set on a _source_ queue and points at its DLQ, so a
DLQ generally does not carry one. `RedriveAllowPolicy` is set on the _DLQ_ and
enumerates the source queues permitted to use it, which is the queue this
script is pointed at. Both are parsed into library-owned types at the wrapper
boundary rather than handed to callers as raw JSON strings, so a malformed
policy is an `M3LSQSOperationError` there and not a `SyntaxError` in a step.

### One preset per queue, with routed arms

A preset is one queue. Within it, a codified `route` step reads an event-type
discriminator and selects one of N arms; each arm carries its own key rule,
lookup tiers, state field map and cases. An arm declaring no `match` value is
the default arm; no match and no default arm is a terminal case, never a
fallthrough.

This is the smallest departure from ADR-0076 that expresses a queue carrying
several event types, and it keeps the preset the unit an operator actually
edits.

### The spine, and the corrected loop ordering

Nine steps, one closed `stepId` literal union, identical for every preset —
only which optional stages are declared changes. The procedure is built once
per preset and run once per message; the queue-level run aggregates.

`widen-lookup` sits **before** `lookup-entity`, and the `loop` lives on the
`check-entity-present` step that follows it. This reproduces ADR-0076's
corrected ordering deliberately: with the loop on the check step, `"continue"`
falls through to the success path instead of re-widening, and the back edge
originates from a step carrying `loop`, which keeps it out of cycle detection.

### Five handling modes, and prohibitions that outrank them

`handling` classifies a queue as `runbook` / `redrive` / `script` / `ad-hoc` /
`under-analysis`. Only `runbook` proceeds past `resolve-mode`; the other four
stop into a codified terminal case. This is ADR-0076's `unsupported` arm
widened to five arms.

Orthogonally, a preset may declare `prohibitions`. A prohibition **downgrades a
verdict to a follow-up rather than executing it, and always wins** — including
over a `handling: "runbook"` queue whose case row reached `reinsert`. Encoding
"do not re-insert this queue" as a mode would let a later mode change silently
drop it; as an override it cannot be lost.

### Verdict vocabulary

Authorable per case row: `remove`, `reinsert`, `hold`, `escalate`,
`known-no-action`. Reserved for the codified terminal cases:
`not-runbook-managed`, `unparseable`, `unrouted`, `no-key`,
`entity-not-found`, `unrecognised` (the mandatory fallback).

Authoring a reserved verdict is rejected at the trust boundary. The point is
narrow and load-bearing: it stops a row that only matches _when the entity was
found_ from claiming `entity-not-found`.

### Guardrails

- **Archive before destroy is mandatory, not optional.** The drained dump is
  persisted to `M3L_OUTPUT_DIR` before any mutating call, and `execute` aborts
  if that write failed.
- **`confirmDestructive` with a graded target** (ADR-0048), the resolved
  account + queue being the target. Note the polarity rule in
  `.claude/rules/library-src.md`: escalate on truthiness, require strict `true`
  only for the opt-in.
- **Non-empty `todos` fails `validate`.** A partially converted runbook must
  not produce a confident wrong verdict.
- **Every regex is compiled and length-bounded at the preset trust boundary**,
  so a bad pattern is a preset problem, not a `SyntaxError` from inside a step.
- **The extracted key is allow-listed before use.** No value is interpolated
  into a query string anywhere — the lookup is a typed key — which removes the
  injection surface rather than guarding it.
- `script.signal` is threaded into the drain loop (ADR-0049).

### The graph is split across three files from the start

`scripts/cloudwatch-logs-analysis/src/steps/build-procedure.ts` is 23,956 bytes
against the 25,000-byte `check:file-budget` ceiling, and this graph is strictly
larger because of the arms. The step factories, the case-row compiler and the
assembly therefore land as three files
(`steps-graph.ts` / `cases.ts` / `build-procedure.ts`) rather than one.

ADR-0072's lesson is that a file and its tests become structurally
un-splittable _after_ both grow, because `perFile` coverage binds them — so the
boundary is drawn before the growth, not after it.

## Consequences

- **Positive:** a daily manual dump → filter → console-lookup → hand-built
  deletion-manifest loop becomes one reviewable command; a new known case stays
  a preset edit; `validate` gates every preset in CI with no credentials; the
  confirmation gate has a real place to stand because analysis and action are
  separate passes; `M3LSQSRedriveDecision` is reused rather than duplicated.
- **Negative / trade-offs:** a second preset dialect now exists alongside
  ADR-0076's, and the two will drift unless a later wave unifies them —
  accepted, since forcing one schema over two differently-shaped matchers today
  would fit neither. Predicate-set matching is strictly harder to reason about
  than a single signature; it is contained by unique priorities and by
  `explain` printing every row in priority order. The script can delete
  messages, which is a genuinely new blast radius for the fleet.
- **Semver impact:** minor for `packages/m3l-common` — `getQueueAttributes`
  and the four new types (`M3LSQSQueueAttributes`, `M3LSQSRedrivePolicy`,
  `M3LSQSRedrivePermission`, `M3LSQSRedriveAllowPolicy`) are additive,
  reaching consumers through the existing `./aws` namespace barrel. The
  `exports` map does not change.

## Links

- Related: [ADR-0076](./0076-codified-runbook-analysis-presets.md) (the
  code/data split this reuses, and the loop ordering it corrects),
  [ADR-0046](./0046-codified-procedure-engine.md) (the engine),
  [ADR-0026](./0026-sqs-operations-wrapper.md) (the SQS wrapper `redrive` lives
  in), [ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md) (wrapper before
  script), [ADR-0028](./0028-aws-service-naming-convention.md) (the name),
  [ADR-0029](./0029-script-dependency-boundary.md) (the dependency boundary),
  [ADR-0048](./0048-target-graded-destructive-confirmation.md) (the gate),
  [ADR-0049](./0049-cooperative-cancellation-contract.md) (`script.signal`),
  [ADR-0072](./0072-reviewable-slice-discipline.md) (the landing shape and the
  file split).
- Implements: the W8 dead-letter-triage wave. Its `docs/ROADMAP.md` row and
  `docs/plans/IMPLEMENTATION.md` entry land with the script itself, not with
  this ADR — at the time of writing neither file carries a W8 row.
