# Work log — X7d remaining human-action kinds & their routes (2026-09-02)

This log covers tracker row **X7d — remaining human-action kinds & their
routes** and its hub-sync issue #868. X7b declared twelve
`M3LHumanActionKind` members and wired eight; X7c shipped the audit index and
explicitly declined the remaining four on the grounds that each needs a
**route** before it can be audited. That framing held. All twelve are wired
now.

Predecessor: [X7c audit index writer & the `options.routes`
boundary](./2026-09-02-x7c-audit-index-writer.md), which split this row out.

Plan of record: the five-PR implementation plan for issue #868.

## Summary

Five PRs, each merged to `main` before the next was cut:

| PR                                                         | What                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [#875](https://github.com/monte3l/m3l-automation/pull/875) | `boot/human-action-specs.ts` — the spec table extracted, buying the budget headroom the next three spent         |
| [#881](https://github.com/monte3l/m3l-automation/pull/881) | `GET /api/v1/runs/:id/report`, the `M3L_OUTPUT_DIR` pin and the runs-output root that makes a report addressable |
| [#884](https://github.com/monte3l/m3l-automation/pull/884) | `GET /api/v1/sessions/:id/steps/:stepId/artifact`                                                                |
| [#887](https://github.com/monte3l/m3l-automation/pull/887) | `POST /api/v1/runs/:id/cancel`, including queue eviction and the reversal of ADR-0066's recorded absence         |
| [#888](https://github.com/monte3l/m3l-automation/pull/888) | `POST /api/v1/sessions/:id/bindings` — the twelfth and last kind                                                 |
| this one                                                   | ADR-0070 dated Update, tracker flip, the X11 note, this log                                                      |

**Semver impact: none.** Console-server only throughout — no `m3l-common`
change, no `exports`-map change.

The plan budgeted four code PRs. It became five: the plan itself said to split
PR 4 along the cancel / binding-select seam if it exceeded ~35,000 chars, and
cancellation alone measured 53,731.

## The claim audit paid for itself

The plan re-derived four claims from #868 against the working tree before
anything was written. Three were true. **One was half wrong, and it was the
one that would have cost the most.**

The row said `run.cancel` "needs child-process kill plus queue eviction".
Child-process kill **already existed** — `M3LRunOrchestrator.cancel` aborted
an active run, `runs/executor.ts` already escalated `SIGTERM` to `SIGKILL`,
and a `run.cancelled` audit entry was already written. Queue eviction was
near-free too: `onQueueTimeout` was already the exact sequence, and became one
shared `abandonQueuedRun` both paths call rather than a second copy. What the
row described as the hard part was mostly done; the real work was the 409/404
split and two byte-budget extractions.

A fifth fact the row did not mention turned out to be the only substantial
engineering in the wave: **the console could not locate a run report.** That
is recorded in the ADR Update and is the reason PR #881 is the largest of the
five.

## What diverged from the plan, and why

### The filesystem read went into `runs/`, not into the route

The plan put the `run-report.json` read inline in `http/routes/runs.ts`. Every
route group in this package instead declares narrow structural ports and does
no I/O of its own; an inline `node:fs` read would have made that handler the
only one in the package touching disk. It went to `runs/report.ts` behind a
declared `M3LRunReportPort`. `check:zones` needed no edit — which the plan
itself named as the signal the code is in the right file.

### The 404s reuse `ERR_CONSOLE_RUN_NOT_FOUND`

The plan suggested `ERR_CONSOLE_NOT_FOUND` while preferring reuse. The
run-specific code is what `GET /api/v1/runs/:id` already returns for the same
condition, so both report 404s use it and differ by **message**: an operator
polling a still-running run has to tell "no such run" from "no report yet",
and an unauthenticated prober learns nothing either way.

### Two audit specs carry less than the plan asked for

The plan asked for the artifact **reference** in `view.session.artifact`'s
`parameterRefs`. The `(sessionId, stepId)` pair already **is** the reference —
it is the whole of what the request addressed — and the step's encoded
`resultRef` is read inside the service and never reaches the projection. The
only string available would have been one invented at the call site,
duplicating `target.id` under a grammar nothing else uses. Same call for
`session.binding.select`, which carries `parameterNames` only. **An audit
field that reads like a real artifact reference and is not is worse than an
absent one.**

### PR 4 split in two

As the plan directed for anything over ~35,000 chars.

## What the tests found that the plan did not predict

### Three tests were vacuous, and mutation testing is the only reason we know

This is the wave's most transferable lesson. Each looked like a real
assertion; none could fail.

1. **"Resolves through the store, not by inspecting the ref"** (#884). The
   default fake artifact store _echoes_ `ref.value` for an inline ref, so it
   could not distinguish delegation from a short-circuit — both sides of the
   check came from the same place. Fixed with a stub returning a value the ref
   does not contain.
2. **"Disarms the queue-timeout timer, so a later fire is a no-op"** (#887).
   `abandonQueuedRun`'s own `status !== "queued"` guard already makes a late
   fire a no-op, so deleting `clearQueueTimeout` entirely left the test green.
   Rewritten to spy on the global `clearTimeout` the orchestrator actually
   calls; the late-fire property kept its own separate case.
3. A third only surfaced as a _comment_ claiming mutation-testing that had not
   been done. The claim was removed and the test reshaped.

The pattern in (1) and (2) is the same one memory already records for X7c: **a
check whose two sides come from one source can never fail.** Writing the
mutation before writing the assertion is what catches it; running it
afterwards is what caught these.

### A file hit its budget mid-change

`runs/orchestrator.ts` reached **24,947 of its 25,000-char ceiling** while
cancellation was being written — 53 bytes of headroom. `check:file-budget`
runs no earlier than `pre-push`, so discovering it there is a rebase. It was
split on the spot into `orchestrator-context.ts` (types) and
`orchestrator-cancel.ts` (the cancellation path).

`http/routes/sessions.ts` had the same shape twice: the plan predicted moving
`GET …/bindings` out would shrink it, but the new port members offset that and
it landed at 24,495 — under the ceiling and still a trap. A third extraction
(`session-body.ts`, the shared field validators, as a **leaf** so two route
modules can depend on it without depending on each other) took it to 20,256.

**Five extractions in one wave, all budget-forced, all taken up front.** None
was discovered at push time.

### An extraction can fail the coverage gate by removing the denominator

Twice. In #875, moving the spec table out of `boot/human-action-audit.ts` took
most of its branches with it, and four already-uncovered defensive branches
stopped being diluted — the file fell to 78.94% against an 80% threshold
without anything getting worse. Fixed by folding two byte-identical `catch`
blocks into one helper and adding the missing `operatorOf` test.

In #887, `orchestrator-context.ts` initially kept `clearQueueTimeout`, making
it the one module whose entire executable surface was a single no-op guard. It
failed the gate, and the only "fix" would have been a test asserting that a
no-op does nothing. The helper moved beside its caller and the file went back
to carrying no behaviour at all — **a types-only file has no coverage to
fail.**

### The `verify` gate was reaped repeatedly under memory pressure

With three Claude sessions live, `pnpm verify` was killed three times on the
last PR — twice mid-`lint:library`, once at step 2. Both lint halves passed
standalone. Every `verify` step was then run directly, all green, and the full
`pre-push` suite ran to completion in one process and passed. Recorded in the
PR body rather than claimed as a clean `verify`. The coverage gate needed
`--maxWorkers=3` throughout; ADR-0080's "serialize, don't tune the heap" is
the right instinct, but the vitest fan-out is the thing to cap.

## What the by-hand verification actually proved

Two console boots against a temp data dir, per the plan's end-to-end step.

Cancellation, with `MAX_CONCURRENCY=1` and two launches of a script that never
exits:

```text
cancel A (running) -> 200   A after -> "interrupted", startedAtMs 1788343916672
cancel B (queued)  -> 200   B after -> "interrupted", startedAtMs null
cancel A again -> 409 ERR_CONSOLE_RUN_NOT_CANCELLABLE
cancel unknown -> 404 ERR_CONSOLE_RUN_NOT_FOUND
```

`startedAtMs: null` on the queued eviction is the assertion that matters: a run
that never executed was never given a fabricated start time.

Binding selection, on a real session with a real spawned step: the artifact
route returned the step's output, the selection returned `201` and listed back,
and each refusal behaved (`404` unknown ordinal, `400` wrong-shape value, `409`
closed session).

In both sessions the **JSONL trail and the SQLite index agreed exactly**, and
grepping the trail bytes found no binding reference and no report payload —
display-vs-persist checked against what is on disk rather than against an
in-memory record.

## Lessons

- **Re-derive a row's own claims before planning around them.** X7d's
  `run.cancel` finding was half wrong in the direction that inflates scope.
  The plan's claim-audit table is what caught it; without it the wave would
  have budgeted for work already done.
- **Mutation-test the assertion, not the feature.** Three vacuous tests in one
  wave, all of which read as thorough. The reliable move is to break the thing
  the test claims to protect and watch it fail — and to distrust any test
  whose two sides can be traced to one source.
- **Measure a file before growing it, and extract in the same change.** Five
  extractions, none discovered at `pre-push`. The one that came closest
  (`orchestrator.ts` at 24,947) had 53 bytes left.
- **An extraction moves coverage, not just code.** Twice a behaviour-preserving
  split failed the per-file gate because the denominator moved. Neither was a
  regression; both needed a real fix rather than a threshold edit.
- **A types-only file cannot fail a coverage gate.** When a split leaves one
  module holding a single unexercised guard, the guard is in the wrong module.
- **State a scope boundary in the code, the docs and the PR.**
  `session.binding.select` shipped its server seam while X11 keeps the UI;
  saying so three times is what stops X11 being re-scoped by surprise later.
