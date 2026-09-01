# Work log — V8 `agent-operator` health-checks workload (2026-09-01)

This log closes tracker row **V8 — `agent-operator` scaffold + health-checks
workload** and its hub-sync issue #545. The row read `To Do` when the session
started, which was stale — four PRs had already merged — but the issue was
genuinely open, and the row's own text said why: _"First workload: fleet health
checks (`doctor --json` + dry-runs, read-only)."_ That workload did not exist.

Plan of record: the session's implementation plan for issue #545 (two PRs, cut
independently from `main`, never stacked).

## Summary

Two PRs, both offline:

- **[#828](https://github.com/monte3l/m3l-automation/pull/828)** (merged
  `68e420e6`) — the cross-run daily invocation counter. Closed the
  `budget.invocations-per-day.unobservable` gap and nothing else. 523 → **583**
  tests.
- **[#830](https://github.com/monte3l/m3l-automation/pull/830)** — the Bedrock
  tool loop, the gated tool registry, the fleet-health workload, the anomaly
  report, the exit-code contract, the docs, and this close-out. 583 → **665**
  tests. Reviewable diff 202,652 chars — under the 300,000 ceiling, above the
  plan's ~200,000 soft cut trigger; not cut, because the cleanest candidate
  (`health-report.ts` to a PR 3) would remove the artifact the exit-6 contract
  derives its anomalies from.

Six PRs total across V8, in order: PR #769 (scaffold), PR #772 (the typed
`m3l` CLI seam), PR #778 (the audit spine), PR #787 (the metering seam and the
policy gate), PR #828, and PR #830.

Verification was offline and fakes-only throughout — **no live Bedrock call and
no AWS credentials at any point**, per the confirmed `starting-work` decision.

## The issue's claims, verified rather than trusted

Reproduced on `main` at `0ab922ec` before writing anything:

```text
$ node dist/main.js --command health-check --aws.profile dummy --modelId …
agent policy loaded
decision-log preflight complete
the run concluded without an auto-approved verdict: …
REAL_EXIT=1
```

The two entries it wrote to `data/agent-log/` named the cause exactly as the
plan predicted: `"rule": "budget.invocations-per-day.unobservable"`. So the
audit spine worked, the decision log was durable, and the single reason
`health-check` could not succeed was the unobservable per-day budget.

## What went as planned

- **The two-PR split held.** PR 1 measured 79,850 reviewable chars, PR 2 well
  under the 300,000 ceiling. Neither was stacked; PR 2 was rebased onto `main`
  with `git rebase --onto origin/main feat/v8-daily-invocation-counter …` once
  #828 squash-merged, exactly the flow `contributing.md` documents.
- **PR 1's acceptance criterion was a rule string, not "the run passes."** The
  escalation moved exactly one slot, from
  `budget.invocations-per-day.unobservable` to
  `budget.tokens-per-run.unobservable`, and that was verified by running the
  built script against the committed policy — not inferred from tests.
- **Mutation testing caught what it was meant to.** Five mutations against PR 1,
  each confirmed to fail the suite: deleting `counter.seed()` (2 tests), splitting
  the single ledger spread into two (7), rewriting `sameUtcDay` as
  `toDateString()` under `TZ=Pacific/Kiritimati` (6), degrading a corrupt counter
  file to `EMPTY_STATE` (11), and swapping `getDataDir()` for `getOutputDir()`
  (21).
- **Ordering constraint 1 is the seam where the two PRs meet.** PR 1's residual
  failure (`budget.tokens-per-run.unobservable`) is precisely what PR 2's
  "construct `createMeteredInvoker` before the preflight" closes. One test in
  PR 2 asserts that exact rule is _no longer_ reported.
- **The canary worked.** Exactly one PR 2 test runs against the real committed
  `data/input/agent-policy.json` and asserts the auto-approved path. It is the
  only thing that would have failed had PR 1 not landed, and it would have
  failed naming the exact rule.

## What didn't go as planned, and why

### 1. `undefined` is not a transmissible tool input

The first draft of the fleet-health tests scripted a no-argument tool call as
`toolUseReply("fleet_doctor", undefined)`. The library refuses:

> `toolUse` block … carries an unsafe input: … `bigint`, `function`, `symbol`,
> and `undefined` cannot round-trip through the Converse API's document type

So a real no-argument call arrives as `{}`, never `undefined`. This also
invalidated a planned test: the prototype-chain case
(`Object.create({scriptName: …})`) **cannot reach `describeAction` through the
loop** — the library rejects it one layer earlier. The boundary must still
refuse it, because nothing guarantees the next dispatcher is that careful, so
that assertion moved to `build-health-tools.test.ts` and exercises
`describeAction` directly. The test comment says why it is not driven through
the loop, so a future reader does not "fix" it back.

### 2. The `modelRates` gap bites on the FIRST gated call, not the second

The plan predicted "a model without a rate makes the _second_ gated call
refuse". Wrong by one: the first tool call already arrives _after_ turn 1, so
`sumObservedCost` has already gone `undefined` by the time any gate runs. The
seeded `0` covers the **preflight** only. The corrected test asserts zero CLI
spawns and pins the refusal detail to `budget.cost-per-run.unobservable`. This
is the sharper statement of ordering constraint 2, and it is now in the contract
page: an operator who declares `costPerRun` but forgets a rate for one fallback
model gets a run that spends tokens and learns nothing.

### 3. The exit-code table was wrong about model exhaustion

The plan's table said "Bedrock unreachable / models exhausted → `failure` → 3".
`core/errors/catalog.ts` disagrees, and it is the authority:

- `ERR_BEDROCK_RUNTIME_OPERATION` → `origin: "external"` → exit **3**
- `ERR_BEDROCK_RUNTIME_NO_MODEL` → `origin: "caller"` → exit **2**

"Every model you declared is unavailable" is your model list being wrong, not
an external fault. Both arms are now pinned by a `test.each` through the real
`deriveCommandOutcome` → `mapCommandOutcomeToExitCode`, precisely because the
distinction is easy to assume the other way round.

### 4. The README's exit-code paragraph was wrong, and the fix was real

Confirmed by grep and by running the script: `M3LAgentOperatorCliError` never
passed an `origin`, and the `ERR_AGENT_OPERATOR_*` family is not in
`core/errors/catalog.ts` (zero hits). `mapErrorToExitCode` resolves from a
structural `origin` first and a catalog lookup second — both missed, so **every**
failure of this script exited `1`. The module-private `ORIGIN_BY_CODE` table
fixes it, with a `test.each` over all nine codes plus a test asserting the set of
produced exit codes no longer contains `1`. The plan listed this as the first
thing to cut if review-size got tight; it did not, so it shipped.

### 5. The counter write moved into a `finally`

PR 1's module doc promised that once the loop landed, `record()` would move
"next to the invocation site" so a crash mid-loop could not forget invocations
already made. Threading the counter through `gate-tool`'s deps would have been
invasive for the benefit; a `try`/`finally` around the loop achieves the same
guarantee with one edge. The write failure is logged and reported through
`reportRecovery` rather than rethrown, for the reason `gate-tool`'s
`recordExecutionFailure` already documents: a throw from a `finally` **replaces**
whatever the loop was throwing, discarding its classification. A test drives a
model that fails on turn 2 and asserts the counter still records turn 1's
invocation.

### 6. A pre-existing hermeticity gap

`run-agent-operator.test.ts` stubbed only `M3L_INPUT_DIR`. PR 1's counter writes
under `getDataDir()`, so the first green test run wrote
`data/agent-state/daily-invocations.checkpoint.json` into the checkout. Caught
by checking the worktree rather than by a failing assertion — the tests were
green. `M3L_DATA_DIR` is now stubbed too.

## Lessons learned

1. **A rule string is a better acceptance criterion than "it passes."** PR 1's
   criterion was `budget.tokens-per-run.unobservable` — the _next_ failure,
   named. It is mutation-resistant in a way "the run succeeds" is not: delete the
   seeding and the rule reverts, whereas a pass/fail assertion would also have
   been satisfied by seeding a fabricated zero.
2. **Verify a plan's causal claims, not just its facts.** Three of this plan's
   claims were checkable and two were wrong (the rates gap by one call, the exit
   code by one origin). Both were caught by tests that asserted the _mechanism_
   rather than the outcome.
3. **A library's own rejection can invalidate a security test.** The
   prototype-chain input never reaches `describeAction` through the loop. Testing
   the boundary directly keeps the guarantee; testing only through the loop would
   have produced a vacuous pass that looked like coverage.
4. **`--no-verify` is never the answer, but neither is retrying blindly.** The
   first push died on the known ESLint heap OOM (`FATAL ERROR: Reached heap
limit` at 2 GB inside `lint:library`). Re-running with
   `NODE_OPTIONS=--max-old-space-size=6144` passed unchanged. A backgrounded
   command that ends in a pipe reports exit 0 regardless, which is why every long
   command in this session wrote a real `REAL_EXIT` into its log. _(promoted → .claude/rules/subagent-dispatch.md)_
5. **Check the worktree for artefacts even when tests are green.** A test that
   writes into the checkout still passes.

## Follow-ups filed

None. V9–V12 remain as their own tracker rows; epic #609 (the V-series wave)
stays open.
