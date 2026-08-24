# Work log — A5 no-progress detection (2026-08-19)

Covers item **A5** of the codified-procedure-engine wave (issue #472): an opt-in
progress witness on `M3LPoller`/`M3LRetryRunner` that fails fast when a poll or
retry loop stops making progress, instead of burning the whole attempt ceiling in
real remote calls. Ran through the hub-and-spoke TDD pipeline — docs-spec first,
`test-author` RED, `code-implementer` GREEN, a five-spoke review round, then one
fix round. A5 is the last Wave-A prerequisite for **B2**, which reuses this as its
runtime loop guard.

Plan of record: [`docs/plans/2026-08-18-codified-procedure-engine.md`](../plans/archive/2026-08-18-codified-procedure-engine.md) §A5
Decision of record: [ADR-0046](../adr/0046-codified-procedure-engine.md) §Run time

## Summary

Shipped the library half of A5 as a **minor** bump, `4.1.0 → 4.2.0` (hand-managed
per ADR-0020). The fleet retrofit is filed as **A5b**, re-scoped — see the
corrections below.

**Public surface — 2 new exported symbols** (`M3LPollNoProgressPayload`,
`M3LRetryNoProgressPayload`; 630 → 632). `check:api` did not move: the option
itself rides on `M3LPollerOptions`/`M3LRetryRunnerOptions`, which are deliberately
**unexported**, so the three-entry `exports` map was never touched.

- Optional grouped `progress?: { witness, maxStalledAttempts }` on both options
  interfaces. Grouped rather than two flat fields so a witness without a bound —
  and a bound without a witness — are both unrepresentable.
- `witness` is typed `() => string | number | bigint | boolean`. This is the
  load-bearing type decision: an object witness returns a fresh reference every
  call, compares unequal under `Object.is`, and the guard would **silently never
  fire** — the exact failure the feature exists to catch.
- New `internal/polling/progress.ts`: `captureProgressConfig()` plus a per-call
  `ProgressTracker`. Shared rather than duplicated across the two primitives —
  `check:dup` covers `packages/*/src/**` at threshold 4.
- `ERR_NO_PROGRESS` (`M3LNoProgressError`, `internal/polling`, classified
  `{ origin: "external", retryable: false }`); built-in codes 82 → 83.
- Two telemetry events, registered as breadcrumb summarizers (17 → 19).

**Ordering is the contract.** The guard sits after the fatal and exhaustion checks
and re-checks the abort signal immediately before throwing, so cancellation, a
fatal verdict, and ceiling exhaustion all keep their existing behaviour exactly.
The witness can only ever _shorten_ a run that was going to continue.

**Gates.** `typecheck` 17/17, `build` 16/16, `lint`, `format:check`, `check:api`,
`check:zones`, `check:dup`, `check:exports`, `knip`, `check:doc-exports`,
`check:doc-counts`, `check:impl-counts`, `check:test-counts`, `check:hub-keys`,
`check:tracker-status`, `check:tracker-coverage`, `lint:md` — all pass.
`pnpm sync:docs` 13/13. Suite **7223** tests across 181 files.

**Review verdicts.** `code-reviewer` — PASS, 0 Must-fix, 2 Should-fix.
`spec-conformance-reviewer` — conformant, zero symbol drift, 2 doc over-claims.
`type-design-analyzer` — PASS, 0 Must-fix, 2 Should-fix.
`silent-failure-hunter` — **FAIL, 2 Must-fix**. `security-reviewer` — 0 Must-fix
on the leak surface, 1 reproducible defect.

Skills used: `starting-work`, `syncing-docs`, `writing-work-logs`,
`writing-commits`, `creating-prs`.

Spoke incidents: 1 truncation (`code-implementer`, mid-`M3LRetryRunner`), 1 resume.

## The issue's own evidence had rotted — twice

CLAUDE.md's "re-derive any authored claim you are about to act on" earned its keep
again. Two of the row's factual claims were wrong, and both changed the shape of
the follow-up work:

1. **"Polling and pagination bound only on an attempt/iteration ceiling."**
   Pagination is bound by _nothing_. Every continuation-token loop in the repo is
   `do … while (token !== undefined)` with no ceiling at all —
   `aws/dynamodb/operations.ts:340` (`scanSegment`) and `:264` (`queryItems`),
   `aws/s3/operations.ts:113` (`listObjects`),
   `scripts/eventbridge-schedules/src/steps/list-rules.ts:18`. A repeating page
   token spins forever; it does not "burn the ceiling".
2. **Neither named consumer routes pagination through `M3LPoller`.**
   `cloudwatch-logs-insights` uses the poller for _query-status polling_
   (`aws/cloudwatch-logs-insights/client.ts:234`), not window planning — window
   planning is a deterministic time-offset loop bounded by `endTime`. And
   `dynamodb-crud` scan pagination is hand-rolled generators
   (`scripts/dynamodb-crud/src/steps/scan-table.ts:207`) that never touch the
   poller at all.

The library capability is still exactly right — B2 consumes it directly and the
Logs-Insights poll is a genuine call site — but a witness on the two primitives
does **not** by itself close the pagination hole the row was reaching for. A5b was
re-scoped accordingly rather than inheriting the row's framing.

**Lesson:** a tracker row's _gap evidence_ rots the same way its line-number
citations do. Re-derive the claimed problem, not just the claimed location — the
fix's scope depends on it. _(A4 learned this for citations; A5 for the premise.)_

## What went as planned

- **Docs-spec-first paid for itself again.** The contract was committed before any
  spoke ran, and every later dispatch — RED, GREEN, both fix rounds — worked from
  that one file rather than from a review comment. No spoke needed a clarifying
  round.
- **`check:api` never moved**, as predicted: surfacing the option on an unexported
  interface and the payloads through the namespace barrel kept the `exports` map
  untouched.
- **The `M3LErrorCode` widening was fail-closed**, verified rather than assumed.
  The only derivation is `Record<M3LErrorCode, …>`; A3's `Exclude<…>` fail-open
  pattern does not recur here, and `M3LErrorExitCode` derives from the _exit-code_
  registry, so `ERR_NO_PROGRESS` cannot widen it.
- **Every fix was proved by executing `dist/`**, not by reading — 9 probes for the
  original implementation, 8 more for the fix round.

## What didn't go as planned, and why

### 1. The spec I wrote was ambiguous, and the RED spoke caught it

"Trips after `maxStalledAttempts` consecutive attempts" never said whether the
baseline sample counts. The spoke flagged it instead of guessing, and pinned its
tests to one reading. The doc now carries a worked-example table: the counter
counts unchanged _transitions_, so `maxStalledAttempts: 3` trips on attempt 4
reporting `{ attempts: 4, stalledAttempts: 3 }`.

**Fix for future:** any contract with a threshold needs a worked example with
concrete numbers. Prose describing a counter is ambiguous to at least one reader,
and that reader will be the implementer.

### 2. The repo's own promoted rule was re-broken in the fix I designed

`maxStalledAttempts` was validated in the constructor, but the tracker was built
with `new ProgressTracker(this.#progress)` on **every** `poll()` — re-reading the
value off the caller's still-mutable object. `security-reviewer` reproduced it with
**zero casts**, in code that typechecks under `strict`:

```ts
const cfg = { witness: () => Math.random(), maxStalledAttempts: 3 };
const poller = new M3LPoller({ backoff, maxAttempts: 8, progress: cfg });
cfg.maxStalledAttempts = 0; // legal: readonly is on the interface, not the literal
```

A poll whose witness changed every sample then rejected on attempt 2 with "no
progress for 0 consecutive attempts"; poisoning it to `NaN` disabled the guard
silently instead.

This is **A4's lesson verbatim** — "validate-then-re-read is two observations of a
mutable caller graph" — already promoted into `.claude/rules/library-src.md`, and
the hub's own dispatch brief walked into it anyway. Fixed with
`captureProgressConfig()`: validate once, copy by value, never touch
`options.progress` again.

**Why it happened:** the rule is filed under "hashing/fingerprinting", which is
where A4 hit it. The shape is actually _any_ option object retained by reference
and re-read later — a much wider class than the one the rule's examples describe.

**Fix for future:** when a constructor stores a caller's object, ask whether
anything re-reads it after validation. `readonly` on the interface does not make
the caller's literal immutable.

### 3. A safety guard whose own failure mode was un-audited

Three defects clustered around the same blind spot: the witness is _caller code_,
and nothing treated it as untrusted.

- A **throwing witness** propagated straight out of `M3LRetryRunner.run()` — from
  inside the `catch (error)` block holding the operation's real failure — silently
  replacing it with an untyped exception. Worse than a swallow: a substitution.
- **`M3LNoProgressError` could not carry a `cause`**, so a tripped retry loop
  reported "no progress for 3 consecutive attempts" with nothing about what was
  actually failing.
- An **object-returning witness** (reachable when the witness is typed `any`)
  silently disabled the guard: 11 invocations, never fired.

**Why it happened:** the design effort went into what the guard does when it
_works_. The type was treated as sufficient protection for the witness's return,
and the witness's _invocation_ was never considered a failure site at all.

**Fix for future:** for any feature that invokes a caller-supplied callback inside
a library loop, enumerate three cases before writing it — it throws, it returns the
wrong shape, it is invoked on an error path that already owns an in-flight error.
A guard that fails open is worse than no guard, because the operator believes they
are covered.

### 4. Four of my own doc sentences were false when written

`spec-conformance-reviewer` and `silent-failure-hunter` between them found: the
`poll:wait` row claimed emission "after a non-final `continue`" (a tripping attempt
emits no `poll:wait`); the worked example was only reachable at `maxAttempts >= 5`;
the throw-path sentence promised "the original error from `run()`" on a path that
discarded it; and the `-0` reset had a practical consequence the doc never drew out.

All four were **hub-written prose**. This is the third consecutive item in this
wave (A2, A3, A4) where the largest single defect class was the hub's own contract
claims rather than the spokes' code.

**Fix for future:** treat a contract page as assertions to be verified, not
description to be written. Every "always"/"never"/"before" in a doc is a claim a
reviewer can and should falsify.

### 5. Two spokes truncated or over-reached, both caught by checking real state

The `code-implementer` truncated with `M3LRetryRunner` half-wired — imports, option,
field, and tracker construction all present, guard body absent, so `tracker` was
"declared but never read". Checking `git diff` first showed the remainder was a
single insertion; the resume brief named that one edit and nothing else, which
avoided redoing seven finished files.

Separately, the `test-author` removed 33 now-unnecessary type assertions beyond its
four assigned edits. Correct and necessary — the casts only became redundant once
`progress` existed, and the full project-referenced `pnpm lint` was the only thing
that surfaced them — but it was scope the brief did not grant.

**Fix for future:** A4's rule held — check test run, typecheck, and `git diff`
before resuming a truncated spoke, then hand back the observed state rather than
re-issuing the brief.

### 6. A coverage failure that was infrastructure, not code

`pnpm test:coverage` exited non-zero once while five review spokes were running,
then passed twice in isolation, and each config passed individually. That is the
resource-contention flake `bin/check-test-counts.mjs` documents (F15, issue #489).

**Fix for future:** do not run `test:coverage` concurrently with a spoke fan-out,
and when a suite fails under load, re-run it alone before believing it. _(promoted → .claude/rules/tests.md)_

## Lessons learned

- **A tracker row's gap evidence rots like its citations do.** A5's row named a
  problem ("bound only on a ceiling") that was wrong in the more dangerous
  direction — unbounded — and named two consumers that do not use the primitive
  being changed. Re-derive the premise, not just the file:line.
  _(candidate → `.claude/rules/` / CLAUDE.md Task Workflow step 1)_
- **Validate-then-re-read is two observations, and it is not only about hashing.**
  Any constructor that retains a caller's options object and re-reads it later has
  the A4 shape. `readonly` on the interface does not freeze the caller's literal.
  _(candidate → `.claude/rules/library-src.md`, widening the existing rule)_
- **A caller-supplied callback has three failure modes, not one.** It throws, it
  returns the wrong shape, and it may be invoked on a path that already owns an
  in-flight error. Enumerate all three before shipping the happy path.
  _(candidate → `.claude/rules/library-src.md`)_
- **A guard that fails open is worse than no guard.** The operator believes they
  are covered. Anything that can silently disable a safety check must fail loud
  instead — which is why a non-primitive witness now throws rather than comparing.
  _(candidate → `.claude/agents/silent-failure-hunter.md`)_
- **A threshold contract needs a worked example with real numbers.** Prose
  describing a counter is ambiguous to at least one reader, and that reader
  implements it.
- **Hub-written contract prose is this wave's dominant defect class** — four false
  sentences here, after A2's four and A3's two. Docs authored by the hub deserve
  the same adversarial reading as code written by a spoke.
