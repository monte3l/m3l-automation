# Work log — `v9-workload-expansion` (2026-09-07)

This log covers the whole of V9 — the `agent-operator` workload expansion
tracked by `docs/plans/IMPLEMENTATION.md`'s V9 row and issue #546. It ran from
a design-plan slice through three workloads (preset ETL, log triage, queue
reconciliation), a behaviour-preserving extraction, and the close-out that
flipped the row.

Plan of record: `docs/plans/archive/2026-09-03-v9-workload-expansion.md`
(archived by this slice; it referenced `2026-08-20-agent-operator.md` as its
predecessor rather than editing it, since a plan file is immutable).

## Summary

Nine PRs, against a five-slice forecast:

| PR      | Slice                                        |
| ------- | -------------------------------------------- |
| #981    | 1 — the design plan (docs only)              |
| #1006   | 2a — the mutating-run CLI seam               |
| #1061   | 2b — the two-phase gated mutation seam       |
| #1062   | 3a — the `run_preset` two-phase ETL tool     |
| #1063   | 3b — declaring the `run-preset` operation    |
| #1081   | 4 — the policy-gated `triage-logs` operation |
| #1096   | A — extracting the shared conclusion tail    |
| #1106   | B1 — the `m3l flow` CLI seam                 |
| this PR | B2 — `reconcile-queue` + close-out           |

The overshoot matches V8 (forecast fewer, shipped 6) and U10 (projected 2,
shipped 10). Three consecutive rows have now under-forecast by 2-5x, which is
worth treating as the base rate rather than as three surprises.

## The defect class that recurred four times

Every workload hit the same shape: **the parent authorizes one read while the
child acts on another.** It appeared in a different disguise each time, and
each time the guard that was supposed to catch it was reading a different
value than the one that took effect.

1. **Slice 3 — the input snapshot.** Phase 1 authorized one preset while
   phase 2 could resolve another. Fixed by threading the snapshot rather than
   re-reading.
2. **Slice 4 — the verb.** A preset's own `operation:` key sits at config
   precedence 6 and the inherited environment at 4, so `OPERATION=convert`
   could re-verb an authorized read-only run into the one operation that
   writes. Fixed with a fixed `--operation=analyze` token at precedence 1.
3. **Slice 4 again — the profile.** The action graded the parent's
   `aws.profile`, resolvable from levels 1-3, while the child saw only the
   inherited environment at 4. `--aws.profile sandbox` with `AWS_PROFILE=prod`
   graded sandbox and read prod, defeating `sensitive-target-escalated`. Found
   by review, not by me. Fixed by emitting the profile at level 1 from the
   same local the judged action stamps.
4. **Slice 5 — the flow definition.** A flow's steps declare their own
   `aws.profile`, rendered as argv tokens at precedence 1 in the grandchild, so
   the operator's own profile would grade an account the child never touches.
   And unlike slice 4 no argv token can fix it, because `m3l flow` rejects
   every extra argument. Fixed by deriving the graded target from the verified
   definition and refusing any flow whose steps disagree.

**The lesson that generalises:** a guard is only sound if the value it reads is
the value that takes effect. Config precedence is where those two diverge, so
for any spawn seam the question to ask first is "at which precedence level does
the child bind this, and can anything above it win?" All four fixes reduce to
pinning the value at a level nothing else can outrank, or refusing the case
where two levels could disagree.

## Guards that could not fire

Three checks were specified, written, and then found to be unable to fail.
Each was caught by someone refusing to write a test for an unreachable branch.

- **A containment refusal in `verifyFlowNames`.** Copied from
  `verifyTriagePresets`, but the two are not analogous: a preset allowlist maps
  a name to an arbitrary _path_, while a flow allowlist holds only _names_, and
  the flow-name brand's slug pattern already forbids every `.` and `/`. The
  refusal would have asserted a condition that cannot occur.
- **A target-command refusal in `buildFlowTools`.** `buildTriageTools` can pin
  its target because `scriptName` is a per-call dependency; the flow tool has no
  equivalent field, since the command family is fixed by `buildArgv` and already
  pinned by the surface's argv tests.
- **The flow-name regex itself, as first specified.** `/^[a-z0-9-]+$/` was
  documented as forbidding a leading `-`. It does not — `-` is inside the
  character class, so `--dry-run`, `--json` and `trailing-` all match. Since
  `parseFlowArgs` skips any token starting with `-`, a flag-shaped name would
  have been silently read as a flag, and only allowlist membership was
  refusing it. Two checks that looked independent were one. Fixed with the slug
  form, which is deliberately stricter than the CLI's own pattern.

A guard that cannot fire is worse than no guard, because it reads as
protection. The regex case is the sharpest: the shape check was _documented_ as
the thing making the argv positional un-spoofable while not doing that at all.

## What review caught that the gates did not

- **A model-disclosure path.** Each step of a flow envelope embeds a complete
  run envelope verbatim, `reportPath` included — an absolute host path the CLI
  keeps deliberately so a _human_ operator can open it. A projection that
  spread the nested envelope would have handed the model one host path per
  step. Now recursed through the existing `projectRunEnvelope`, and
  mutation-tested.
- **A missing `MODEL_SAFE_BRAND`.** The new projected step type was the only
  exported `AgentOperatorProjected*` type without it, violating an invariant
  written in that file's own header — which names the four types that once had
  exactly this hole.
- **One unfrozen node** in an otherwise frozen projection tree. The reviewer
  mutated `branch.goto` back to a host path _after_ sanitization.
- **A vacuous test suite.** The `flowRun` tests asserted argv exhaustively and
  never asserted the forwarded `timeoutMs` — the single fact `flowTimeoutMs`
  was added for. A mis-wire to `dryRunTimeoutMs` would have passed every test.
- **An open outcome field.** `status` was read with a bare `requireString`, so
  any string reached the model. Closing it against the CLI's four-value
  vocabulary also _removed_ a sanitization step, and forced three tests off
  `status` as their free-text vehicle — which is exactly why it was a
  disclosure path.
- **A one-grant authority wildcard.** A flow's steps run as grandchildren of
  `m3l flow run`, so they were authorized solely by
  `{"script": "m3l", "operations": ["run"]}` — an effective wildcard over
  every script any allowlisted flow named, bypassing all seventeen per-script
  grants. Proven by executing `evaluateAgentAction` against the shipped
  policy: `sqs-etl` held only `inspect`/`dry-run` while `dlq-reconcile.yaml`
  ran `sqs-etl dump` and `sqs-etl redrive`. Closed with a refusal requiring
  each step script to hold its own `run` grant, which makes the authority
  model three explicit layers instead of one implicit one.
- **A whole operation that could not run.** The `reconcile-queue` dispatch arm
  was a placeholder that threw on every invocation, and the runner's judged
  action declared `operation: "queue-reconcile"` while the config command and
  policy grant both said `"reconcile-queue"` — a plain `includes()` match, so
  every real run would have been denied. Both shipped past a green 1345-test
  suite, and a `Done` tracker row was already written.

  The dispatch gap came from a sequencing error: the wiring slice was
  dispatched before the runner existed, so a placeholder was correct when
  written and stale by the time the runner landed. The name mismatch survived
  because its test fixture granted the same wrong name it asserted — both
  sides of the comparison from one source, the documented way to make a
  cross-check prove nothing. It now derives the expected value from
  `AGENT_OPERATOR_COMMAND_DECLARATIONS`, located by its `requiredParameters`
  rather than by re-typing the name.

## The timeout, and what is deliberately not fixed

`flowTimeoutMs` expiring does not merely mean "the mutation already happened".
`lib/cli-process.ts` resolves `"timed-out"` and signals only the direct child;
the `m3l` CLI installs a survival scope that traps SIGTERM and keeps
executing; the follow-up SIGKILL reaches only `m3l`, because flow steps are
spawned grandchildren with no process group. And nothing bounds them — neither
`flow/step.ts` nor `flow/types.ts` declares a per-step timeout, and
`flow/run.ts` threads no abort signal. So an AWS-mutating script can run to
completion unobserved, with no envelope and no step account.

The maintainer's decision was **observability plus a structural no-retry**,
contained inside `agent-operator`: a `"timed-out"` disposition records the run
as INDETERMINATE and escalates rather than reporting a plain failure, and the
flow tool refuses a second invocation within a run. The no-retry half is the
load-bearing one — a retry would start a second concurrent mutating flow
against a queue the first may still be draining.

**Both halves were first built where they could never run**, and only
execution found it. The classifier sat at the runner's `catch`, which two
layers make unreachable: `steps/gate-tool.ts`'s `runApprovedExecution`
re-wraps the tool's rejection as a `Core.M3LError`, so the `instanceof` test
was already false; and `aws/bedrock-runtime/tool-dispatch.ts` converts a
non-abort handler rejection into a `status: "error"` toolResult and
**continues the loop**, so the runner's `catch` was never entered at all.
A reviewer drove the real registry through the real `runBedrockToolLoop` and
observed `catch block NEVER ENTERED` — plus three concurrent mutating flow
spawns in one run, because the same loop-continues behaviour is what makes a
retry expressible.

Both now live in `steps/build-flow-tools.ts`'s `execute`, the one point in
the chain still holding the original rejection: the INDETERMINATE entry is
recorded there before any re-wrap, and a per-run guard refuses a second call
without spawning. Mutation-proved both ways.

**The relocation had a second-order effect worth recording.** Moving the code
turned seven contrast assertions into tautologies. They asserted "no
indeterminate entry was recorded" for ordinary dispositions — trivially true
once the runner records nothing for any input, so they would have kept
passing while proving nothing. Moving code out from under a test is a way to
create a vacuous test that no gate detects.

Fixing the orphan itself means spawning `detached` and group-killing, which
changes signal semantics in `cli-process` shared by all seven surface methods,
and makes the child a session leader — affecting the Ctrl-C path ADR-0049 maps
to exit 5. Filed separately rather than shipped in the PR that closes a
tracker row.

## Process notes

- **The plan rotted between authoring and use, repeatedly.** Its §5/§6 claimed
  the triage target needed "an alarm name" when `analyze` requires
  `aws.profile` + `alarm` + `triggeredAt`; it specified an operation name with
  no grant shape; it named a tool-spec type (`AWS.M3LBedrockToolSpec`) that
  exists nowhere in the repo. Re-deriving every authored claim before acting on
  it caught all three, and is what the Task Workflow rule is for.
- **One new declared name touches far more than its declaration.** Adding an
  eleventh error code touched the union, `ORIGIN_BY_CODE`, a `toEqualTypeOf`
  pin, `ALL_CODES`, a second `EXIT_CODE_BY_CODE` enumeration, four stale
  numeral comments, and a documented table — seven sites, each failing a
  different gate. Adding the `reconcile-queue` operation broke three more pins.
  Those pins are doing their job: each forced a conscious decision.
- **A module-scope memoized environment detector breaks test isolation
  silently.** `M3LExecutionEnvironment.detect()` caches, so whichever test in a
  file constructs an `M3LPaths` first pins the deployment mode, and every later
  `vi.stubEnv("M3L_DEPLOYMENT_MODE", …)` in that file is a no-op. A test then
  passes or fails for reasons unrelated to its subject. The sibling suite
  already guarded it with `resetForTesting()`; the new one didn't, and the
  resulting `TypeError` was initially misdiagnosed as an ordering bug in the
  runner — which was correct all along.
- **Spoke dispatches failed hardest on the largest test harness.** Four
  consecutive attempts on `run-queue-reconcile.test.ts` produced no file,
  burning ~650k tokens between them, each exhausting its budget _verifying_
  before writing. Handing over the mock block verbatim was not enough; what
  worked was inverting the order — write first, guess-and-flag unknowns, cap
  the reading to named line ranges, and halve the scope. Richer instructions
  made it worse, because every added claim was one more thing to go confirm.
