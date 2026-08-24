# `sqs-dead-letter-triage` — a codified DLQ triage and remediation procedure

**Status: shipped** — a four-PR chain under ADR-0072: #619 (the `aws/sqs`
`getQueueAttributes` widening), #621 (the offline spine), #622 (the read-only
`triage` path), and the `execute` slice carrying the destructive gate. Design
recorded as ADR-0077.

## Context

A body of operator runbooks described, in prose, how humans manually analyse and
remediate messages stranded in SQS dead-letter queues — a daily dump → filter →
console-lookup → hand-built deletion-manifest loop. That corpus is external,
uncommitted material; no part of this work cites, quotes, names or commits any
of it, and the committed example presets are wholly invented.

The extraction showed the same split ADR-0076 had already found for
`cloudwatch-logs-analysis`: the spine is near-identical across every document,
while everything that varies per queue is tabular data operators amend after
each incident. Five of the documents were near-verbatim clones differing only in
a queue name and a known-case table — the strongest available evidence for
"spine is code, cases are data".

## Approach and decisions

**The spine is codified, the cases are preset data** (ADR-0077). Nine steps, one
closed `stepId` union, so `jumpsTo` targets and build-time cycle detection keep
full compile-time checking. `caseId` stays `string` so rows can be declared in a
loop over a preset.

**Where it diverges from ADR-0076's precedent:** the matcher. W7 matches one
derived error signature; this matches a **predicate set over a state-transition
pair** — the entity's current state against the state the message tried to
apply — plus an ordered-progression containment check. One preset per queue with
routed event-type arms, rather than one preset per event type.

**`redrive()` is deliberately unused.** Its `move | drop | retry` vocabulary was
exactly right and is reused as the action type, but its control flow receives and
acts in a single pass, leaving nowhere for the ADR-0048 gate to sit between
analysis and action.

**Four decisions taken during implementation**, each because the plan's premise
turned out to be wrong on inspection:

- `ApproximateAgeOfOldestMessage` is not a `QueueAttributeName` at all, so the
  widening carried depth, identity, FIFO and both redrive policies instead.
- `M3LDynamoDBOperations.getItem` takes no `AbortSignal`, so cancellation is an
  honest pre-check with the in-flight bound documented rather than implied.
- Receipt handles cannot be held across an interactive gate, so `execute`
  re-receives and matches by `messageId`.
- `M3LDestructiveTarget.accountId` is populated nowhere in the library, so an
  account-keyed allow-list could never fire — the gate is unconditionally
  sensitive and `--apply` refuses to run without a resolved identity.

## Outcome

Five operations. `validate`, `explain` and `convert` need no credentials, which
is what makes `validate` a CI gate; `triage` is read-only against AWS; `execute`
mutates only behind `--apply` and the graded gate.

**What review caught, and the pattern in it.** Seven defects were found in
review rather than in production, and almost every one was an _invisible_
failure rather than a loud one: a cancelled run resolving as success (twice — the
guard was added on the triage path and not mirrored onto the execute path, which
could then apply a truncated plan); a drain that livelocked on a page of
already-seen ids, reachable through a documented `visibilityTimeout=0`; an
archive bounded by message count but not bytes, where a _correct_
archive-before-destroy guardrail amplified the failure by discarding the batch
after it had already gone invisible for thirty minutes; `--yes` bypassing the
gate entirely whenever no profile resolved, so the least identifiable credential
got the weakest gate; and ADR-0077's prohibition guarantee resting on substring
matching over operator prose, with an invariant check that was structurally
incapable of detecting the miss because it keyed on a flag set only in the same
return that performed the downgrade.

Three lessons worth carrying forward. **File boundaries must be set before the
file grows** — `check:file-budget` blocked work three times (`client.ts`,
`load-runbook.ts`, `execute-actions.ts`), and the one time the split happened
proactively it cost nothing. **A comment asserting a guarantee that lives in
another file is the most reliable source of falsehood in this codebase** — four
of them appeared here, including one dictated by the implementation spec itself
and one describing a parameter after its removal. And **a claim in a plan is a
hypothesis**: four separate premises failed verification, which is why the repo
rule is to re-derive rather than trust.

Related: [ADR-0077](../../adr/0077-dead-letter-queue-triage-procedure.md),
[ADR-0076](../../adr/0076-codified-runbook-analysis-presets.md) (the precedent),
[ADR-0046](../../adr/0046-codified-procedure-engine.md) (the engine),
[ADR-0048](../../adr/0048-target-graded-destructive-confirmation.md) (the gate),
[ADR-0072](../../adr/0072-reviewable-slice-discipline.md) (the landing shape).
