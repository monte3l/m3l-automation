# W8 — `sqs-dead-letter-triage`

**Date:** 2026-08-24
**Item:** W8 of the consumer fleet (P1) — the second ADR-0046 consumer, and the first to _act_ on a codified verdict
**Decision of record:** [ADR-0077](../adr/0077-dead-letter-queue-triage-procedure.md); precedent from [ADR-0076](../adr/0076-codified-runbook-analysis-presets.md); engine from [ADR-0046](../adr/0046-codified-procedure-engine.md); gate from [ADR-0048](../adr/0048-target-graded-destructive-confirmation.md)
**Contract:** `docs/reference/scripts/sqs-dead-letter-triage.md`
**PRs:** #619 (`aws/sqs` widening) → #621 (offline spine) → #622 (read-only `triage`) → #629 (`execute`)

## What shipped

A sixteenth consumer script, replacing a daily manual dump → filter →
console-lookup → hand-built deletion-manifest loop. Given a queue, it drains,
archives, reaches a verdict per message through a codified nine-step procedure,
and — behind a graded destructive gate — applies the remediation that verdict
implies.

20 `src/` modules, 2 example presets, **274 tests across 14 files**. Library
surface: one additive method (`getQueueAttributes`) plus four types; the
three-entry `exports` map untouched, `check:api` did not move.

Five operations. `validate`, `explain` and `convert` need no credentials —
which is what makes `validate` a CI gate; `triage` is read-only against AWS;
`execute` mutates only behind `--apply` and the gate.

## What went as planned

The ADR-0076 code/data split transferred intact: the spine is codified so
`TriageShape["stepId"]` stays a closed union and cycle detection keeps working,
while per-queue variation is preset data. The `widen-lookup` /
`check-entity-present` ordering — widen **before** the gather, `loop` on the
**check** — reproduced W7's corrected shape and needed no rework.

`redrive()` was correctly predicted as unusable: its `move | drop | retry`
vocabulary is exactly right and is reused as the action type, but its
single-pass receive-and-act control flow leaves nowhere for the confirmation
gate to sit between analysis and action.

The four-PR split under ADR-0072 held. Each slice was knip-consumer-complete,
which is the constraint that actually determines where a slice can end.

## What diverged

**Four plan premises failed verification.** Each was stated as fact and was
wrong on inspection:

1. `ApproximateAgeOfOldestMessage` is not a `QueueAttributeName` at all — it is
   CloudWatch-only. Two plan features rested on it. The widening carried depth,
   identity, FIFO and both redrive policies instead.
2. `M3LDynamoDBOperations.getItem` takes no `AbortSignal`, so the plan's
   assumption that cancellation threads through was false. Cancellation is an
   honest pre-check with the in-flight bound documented rather than implied.
3. `M3LDestructiveTarget.accountId` is populated **nowhere** in the library, so
   the account-keyed allow-list specified for the gate could never fire.
4. `presetPathFor` was module-private, not exported.

**The matcher diverges from W7 by design.** W7 matches one derived error
signature; W8 matches a predicate set over a state-transition pair — the
entity's current state against the state the message tried to apply — plus an
ordered-progression containment check. One preset per queue with routed
event-type arms, rather than one preset per event type.

**`check:file-budget` blocked work three times** — `client.ts` (PR 1),
`load-runbook.ts` (PR 4), and `execute-actions.ts`. The first two each forced a
behaviour-preserving extraction mid-flight. The third was split proactively
while the file was still uncommitted and cost nothing. ADR-0072's own lesson,
learned reactively twice before being applied.

## What the review round changed

Ten defects were found in review rather than production. Nearly all were
**invisible** failures rather than loud ones, which is the pattern worth
recording:

| Defect                                                                 | Why it was invisible                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cancelled run resolved as success (twice — `triage`, then `execute`) | `runScript` classifies `interrupted` only on a rejection; breaking a loop and returning normally reads as success                                                       |
| `execute --apply` was a guaranteed no-op                               | The drain's own `visibilityTimeout` hid the messages from the re-receive; every id was marked `skipped` and the run still passed                                        |
| `--yes` bypassed the gate entirely                                     | `confirmDestructive` skips grading with no `target`, and `awsTarget` is undefined whenever no profile resolves — the least identifiable credential got the weakest gate |
| Prohibitions were inert unless the prose happened to contain a keyword | And the invariant check keyed on a flag set only in the same return that performs the downgrade, so it guarded a state the code cannot produce                          |
| `drainQueue` could livelock                                            | A page of already-seen ids makes no progress and is not empty; reachable via the documented `visibilityTimeout=0`                                                       |
| The archive was bounded by count, not bytes                            | A **correct** archive-before-destroy rule amplified it: the batch is discarded after already going invisible for 30 minutes, so retries never converge                  |
| A partial-failure run exited 0                                         | `failed` was collected and logged but never demoted the outcome                                                                                                         |
| `sourceQueueUrl` validated only the queue name                         | Queue names are routinely identical across dev/staging/prod                                                                                                             |
| `MessageOutcome.conclusion` lied via `undefined as unknown as T`       | A double cast defeats strict null checking; the type claimed a value that was absent                                                                                    |

**Two tests were worse than none.** The apply path had ten tests and could not
have caught the no-op, because `receive` was mocked to hand the planned
messages straight back — the mock asserted the behaviour under question. And
`resolveSourceQueueUrl` had four failure-path tests that all returned at an
early exit before any check ran, so its accept path had never executed while
reading as covered. _(promoted → .claude/rules/tests.md)_

**Five stale or false comments**, all the same anatomy: a comment asserting a
guarantee that lives in another file. One was dictated by my own implementation
spec (claiming the traversal guard assumed a single interpolation, when three
existed in the same slice); one described a parameter after its removal; three
described the deleted re-receive design.

## Confidentiality

The design derives from operator runbooks in a gitignored `tmp/` tree (167
files). Nothing from that material is in the repository. Containment and two
mechanical sweeps, all scripted rather than eyeballed:

- **Containment:** `tmp/` is covered by `.gitignore`, `.prettierignore` and the
  `lint:md` exclude; `git ls-files tmp` returns zero.
- **Structured identifiers** across the whole four-PR diff: the only 12-digit
  values are `000000000000`, `111111111111`, `222222222222` and `123456789012`
  (AWS's own documentation account); every ARN uses that example account with a
  generic queue name; hosts are standard public SQS endpoints. Zero emails,
  zero UUIDs.
- **Vocabulary diff** — corpus tokens ∩ tokens this chain added, minus
  everything already on `main` before it: **8 survivors**, all generic
  (`accessdeniedexception`, `coincide`, `eventtype`, `msg1`, `priorit`,
  `queuename`, `reinsert`, `suspended`). No organisation-specific vocabulary,
  no product names, no identifiers.

## Re-derived claims

Beyond the four failed premises above, two authored claims were checked and
found stale:

- **No W8 row existed** in `docs/ROADMAP.md` when ADR-0077 was drafted, despite
  the plan referring to one. The ADR was reworded to say so rather than cite a
  row that did not exist; the row landed with the final slice.
- **`AWSServiceProvider` already exposed `sqsOperations` and
  `dynamoDBOperations`**, so the plan's instruction to construct
  `new AWS.M3LSQSOperations(aws.clients.sqs)` would have bypassed the tier
  ADR-0038 added for exactly that purpose.

## Follow-ups

- `M3LSQSOperations` has no `changeMessageVisibility`. Its absence is what makes
  handle reuse the only viable strategy for `execute`; adding it would allow a
  visibility reset, at the cost of re-exposing messages to other consumers
  mid-remediation.
- `M3LDestructiveTarget.accountId` is never populated. Until it is (STS
  `GetCallerIdentity`), no account-keyed gate policy is expressible anywhere in
  the fleet — this script is not the only potential consumer of one.
- `execute` is the first fleet consumer of `M3LScript.reportRecovery`. If the
  `partial` outcome proves useful here, the four scripts that currently absorb
  per-item failures silently are candidates for the same treatment.
- The DynamoDB lookup key lives in the error's `context`. Nothing serialises it
  today (no trace sink, no `persist`), but adding either would make it a live
  leak; the seam carries a comment saying so.
