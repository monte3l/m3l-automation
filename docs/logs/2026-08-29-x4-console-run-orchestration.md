# Work log — X4 console run orchestration module (2026-08-29)

This log covers X4 of the m3l console wave (issue #552): the run-orchestration
module ADR-0065/0066 decided — a run registry, an admission governor, two
execution paths, a generic event-stream leaf, and the REST + SSE routes over
them. It shipped as nine stacked PRs through the hub-and-spoke TDD pipeline,
and records what shipped, what matched the plan, where the plan and the hub's
own briefs were wrong, and the durable lessons.

Plan of record:
[`docs/plans/2026-08-20-m3l-console.md`](../plans/2026-08-20-m3l-console.md)

## Summary

**Shipped.** Nine PRs, one per plan slice plus one unplanned: #716 (budget
refactor), #717 (`stream/` leaf), #718 (HTTP streaming contract), #719 (run
registry schema + repository), #720 (`runs/` zone, config, governor, resolver,
parameters, outcome), #721 (executor port, spawn + in-process), #730
(orchestrator, ports, boot wiring), #731 (HTTP request-body layer — unplanned;
see divergence 1), #732 (REST + SSE routes).

The resulting surface: `POST /api/v1/runs`, `GET /api/v1/runs`,
`GET /api/v1/runs/:id`, `GET /api/v1/runs/:id/stream`. Two new ESLint zones
(`stream`, `runs`), seven new `m3l.console.runs.*` settings, a v3 migration
with a `STRICT` `console_runs` table whose transitions are `WHERE`-guarded
rather than read-then-write, and ten new `M3LConsoleErrorCode` members across
the wave.

**Both** execution paths shipped. The plan's "spawn path first, in-process when
U7 lands" conditional had already resolved — U7 (#531) closed 2026-08-27 —
so in-process covers the 3 scripts exposing a `command.ts` (`dynamodb-crud`,
`json-etl`, `sqs-etl`) and spawn covers all 16. V6 (#543) and V7 (#544) remain
open, so escalate-by-default still governs: every non-dry-run launch requires
explicit `confirmed: true`, and there is deliberately no caller-supplied
`mutating` input that could bypass it.

**Docs.** `docs/reference/console.md` (new — the wire contract ADR-0066
promised), a dated ADR-0066 Update recording four corrections, and a rewritten
package README `Usage`/`Configuration`/`Contract`/`Boundaries`.

**Tests.** 1,257 console-server unit tests across 57 files (up from X3's 593).
Full suite green: 10,899 unit / 2,080 `bin` / 31 web / 17 integration.
Coverage clean on the `perFile` gate (90/83/80/89) — the main project at
97.91% statements, 94.63% branches, 99.33% functions, 98.5% lines.

One caveat worth recording: a path-filtered
`vitest run packages/m3l-console-server/tests` failed 1 test on its first
invocation and passed 57/57 on an immediate re-run, while the full
`pnpm test:coverage` was green throughout. That is the known order-dependent
flake in this package's `handler.test.ts`, still unfixed — see divergence 9's
point about never trusting a single run's numbers.

**Gates.** `typecheck`, `build` (`isolatedDeclarations`, run with `--force` to
defeat Turbo's cache), `lint` (zero errors, zero warnings), `format:check`,
`lint:md`, `check:zones`, `check:file-budget`, `check:review-size`, `knip`.

**Skills used:** `starting-work`, `resolving-pr-comments`, `writing-commits`,
`creating-prs`, `writing-work-logs`.

**Spoke incidents:** ~12 writer-spoke truncations across the wave (2 in the
final session) / 0 stalls / several `SendMessage` resumes. Truncation remains
this pipeline's dominant failure mode, unchanged by the guidance already in
`docs/contributing/subagent-context-management.md`.

## What went as planned

- **The one architectural conflict the plan resolved stayed resolved.** Putting
  the ring buffer in a generic `stream/` leaf rather than in `runs/` was the
  plan's single contested call. It held through six subsequent slices: `http/`
  serves the SSE channel without ever gaining a `runs/` or `store/` edge, and
  `check:zones` never had to be widened beyond the two new rows.
- **`WHERE`-guarded transitions were race-proof in practice, not just in
  theory.** `UPDATE … WHERE id=? AND status='queued'` returning
  `changes === 1` meant every lost race surfaced as a `false` return the caller
  had to handle, never a silent no-op. No transaction was needed anywhere in
  the run lifecycle.
- **The identity-mapped outcome vocabulary paid off exactly as predicted.** The
  five terminal statuses _are_ `Core.M3LRunOutcome`, so there is no translation
  table between the registry, the library, and the CLI — and therefore nothing
  to drift. The one place a vocabulary _did_ have to be duplicated (the HTTP
  layer's `?status=` check, which cannot import `store/`) is drift-guarded by a
  test that imports both sides.
- **The structural-port trick generalised.** `http/routes/health.ts`'s
  non-exported `M3LReadinessProbe` was written in X3 for one probe; X4 reused
  the shape four more times (`M3LRunLauncherPort`, `M3LRunReaderPort`,
  `M3LRunStreamRegistryPort`, and the shutdown drainable). `main.ts` passing the
  real object is the compiler-checked conformance proof in every case.
- **The plan's two predicted bugs were both real, and both were prevented.**
  The plan called out that `runRequest` removes its disconnect listener when
  the handler _returns_ (which for a stream is at open), and that
  `drain-middleware` releases its tracked unit at the same moment. Both would
  have been silent; both were designed around in slice 2 rather than debugged
  in slice 7.

## What didn't go as planned, and why

### 1. The plan had no slice for reading a request body

Slice 7 was specified as "routes + close-out", but `POST /api/v1/runs` needs a
parsed JSON body, and the HTTP layer had none — X2 shipped a transport tier
that only ever _wrote_ responses. This surfaced at the start of slice 7, after
six slices had been planned around it. It became an unplanned PR (#731: the
streaming size cap, `content-type` validation, and `ctx.body`), pushing the
final slice to 7a/7b.

**Why it happened:** the plan derived its slices from the _module_ boundaries
in ADR-0065 and from measured file budgets, but never walked a single request
end-to-end to check that each layer the request touches already existed. A
`POST` route was assumed to be reachable because the router could match it.

**Fix for future:** before committing to a slice sequence, trace one
representative request of each new shape through every layer it touches, and
name the layer that handles each step. A layer nobody can name is a missing
slice.

### 2. Two defects survived 1,224 unit tests and died in the first manual run

The end-to-end acceptance run in the plan's Verification section found two
defects that the full unit suite had not:

- **`Last-Event-ID` was silently ignored on a terminal run.**
  `buildTerminalStreamResponse` never received `ctx`, so `replayTerminalStream`
  hardcoded `lastEventId: 0`. Every resume against a finished run replayed the
  whole retained buffer instead of the missed tail.
- **No `stream.end` frame existed at all**, and the drain severed watchers
  _before_ the run finished — the captured timestamps were `06:53:20.833` for
  the stream response ending and `06:53:20.837` for the run ending, a 4 ms
  window in which a watcher saw an `ECONNRESET` instead of an outcome.

Both were fixed in #732 (the frame, plus reordering shutdown so
`endAll("draining")` runs before the HTTP drain aborts request signals).

**Why it happened:** every unit test constructed its own context object, so
each one supplied precisely the fields the code under test read. A field the
production caller _forgets to pass_ is invisible to a test that never models
that caller. And nothing tests "what does a watcher observe", because a watcher
is a socket, not a function return.

**Fix for future:** for any feature whose contract is observable only over the
wire — SSE framing, shutdown ordering, header handling — run the manual
acceptance script _in the same slice_, not at the end of the wave. Treat "N
unit tests pass" as evidence about functions, never about the protocol.

### 3. The hub's own brief was wrong about the terminal-resume fix

Dispatching the fix for divergence 2, the hub told the implementer that
omitting `lastEventId` was safe because `subscribe` substitutes `0` for an
ended stream. That is true only when the **hub stream** has had `.end()`
called; this route's "terminal" check reads the **registry**, and a watcher can
arrive in the window where the run is registry-terminal but the sink has not
yet ended the stream. In that window the omitted value stays `undefined` and
`dispatchResume` no-ops — dropping the entire backlog.

The test-author caught it by stashing the fix and watching the test still pass,
proving the assertion was vacuous. The brief was corrected to
`lastEventId: lastEventId ?? 0`.

**Why it happened:** the hub read `subscribe`'s defaulting behaviour correctly
but attributed it to the wrong subject — "the stream is terminal" and "the
registry says the run is terminal" are two different predicates that happen to
agree almost always.

**Fix for future:** when a brief asserts that some default makes an explicit
value unnecessary, name the exact predicate the default keys off and check it
is the same one the call site tests. Nearly-always-equal predicates are where
this class of bug lives.

### 4. Three slices in a row were reshaped by the per-file byte budget

`handler.ts` forced a preparatory extraction slice (#716) before any X4 code
could land; `orchestrator.ts` forced `runs/admission.ts` out mid-slice; and
`main.ts` came in 104 bytes over the 25,000 ceiling in slice 7a, forcing
`toRunsRouteOptions` into `built-in.ts`. The last of these was discovered at
the end of the slice, after the code was written and reviewed.

Every extraction produced a better module than the inline version — `admission`
really is a distinct concept from run lifecycle. But the _timing_ was driven by
a byte count, not by a design judgement, and twice the refactor had to be
retro-fitted into a finished slice.

**Why it happened:** the plan measured every relevant file's headroom up front
(`handler.ts` at 23,751/25,000 was in the plan's constraint table) but only
projected growth for the files it expected to _edit_, not for the composition
root that grows a little in every single slice.

**Fix for future:** treat `main.ts` (and any composition root) as growing every
slice, and check its headroom at the _start_ of each one. When headroom is
under ~1 KB, plan the extraction as an explicit step rather than discovering it
at the gate.

### 5. A parked draft was three facts out of date when it was unparked

Slice 7a's route code was drafted early and parked while earlier slices landed.
On unparking, three of its assumptions were stale: a patch for a `ctx.body`
field that #731 had since shipped for real; a TS2550 workaround for
`Object.hasOwn` that was never needed (`lib` is `es2025`); and — the real one —
a `?status=` port typed as `string` where the repository's `M3LRunListQuery`
takes a closed 7-member union. TypeScript's method-parameter bivariance let any
string through the port and into the repository, which silently returned `[]`.

**Why it happened:** a structural port is only as strong as the type it
declares, and a hand-written mirror of a real interface can be _weaker_ than
its subject without the compiler objecting. Bivariance makes the weakening
silent in exactly the direction that matters.

**Fix for future:** when declaring a structural port that mirrors a real
interface, mirror the _narrowest_ types, not the convenient ones, and add a
test importing both sides to pin them equal. Slice 7a does this for the status
vocabulary; the `scriptName` pattern and body-validation rules are still
duplicated without such a guard.

### 6. A bot finding was factually wrong and directionally right

`claude-pr-review` failed #732 on "two new exported functions in
`http/routes/built-in.ts` ship with zero test coverage". The file was in fact at
100% coverage — the v8 text reporter omits fully-covered files from its table,
which is what the bot read. But the underlying point was correct: the
_ordering_ invariant those functions guarantee (built-in routes merged before
caller routes, so a caller cannot shadow `/health`) was covered only
incidentally, by tests that would still pass if the order flipped.

The fix was a new `tests/routes-built-in.test.ts` pinning the invariant
directly — not a rebuttal, and not a capitulation to the literal claim.

**Why it happened:** the bot reasons from gate output, and this repo's coverage
gate reports in a format where "absent" and "zero" look identical.

**Fix for future:** treat every bot finding as a hypothesis with two parts — the
claim and the concern behind it. Verify the claim against the raw artifact
(`coverage-final.json`, not the text table); act on the concern regardless of
whether the claim survives.

### 7. Two test defects were initially diagnosed as implementation defects

A failing `toMatchObject({id:"run-1"})` against an array, and a resume test
sitting exactly on the `lastEventId === oldestRetainedId - 1` boundary that
slice 1's own TSDoc names as deliberately "still replayable". Both were briefly
treated as bugs in the code under test before being read carefully.

**Why it happened:** a red test is assumed to be right, because in TDD it
usually is. Neither failure was checked against the documented contract before
the implementation was suspected.

**Fix for future:** when a test fails against code whose TSDoc describes the
exact boundary in question, read the TSDoc first. A companion test now pins
that boundary explicitly so the next reader does not have to re-derive it.

### 8. Shell tooling repeatedly sabotaged the acceptance run

`pkill -f`/`pgrep -f` killed the hub's own shell three times, because the
pattern matched the command line of the very shell running it — including the
`bin/m3l[-]console-server` bracket trick. Separately, a timestamp instrumentation
printed `[0.00]` for every frame because `$START` was assigned after the
pipeline began, and a fixed `sleep` raced the server's bind and produced a
spurious "Failed to connect".

**Why it happened:** all three are the same mistake in different clothing —
trusting an implicit property of the shell (that a pattern won't self-match,
that assignments happen before a pipeline, that a process is up after N
seconds) instead of establishing it.

**Fix for future:** put process-management logic in a script file so the shell
command line cannot self-match; poll `/health` in a loop instead of sleeping;
compute timestamps in the process that emits them.

### 9. Spoke-reported counts were wrong twice, and the bounds fix never landed

Two spokes reported test counts that the gate contradicted ("8 tests total"
against vitest's 5; "63 files / 2,080 tests for console-server", which was the
`bin/` run misattributed). Neither changed an outcome, because the hub re-ran
the gate itself.

Separately, the Should-fix from #732's review — bounding `?limit=` and the
`parameters` key count and value length — was dispatched to two spokes that
were killed by an interrupt before either finished. It did **not** land, and is
recorded in `docs/reference/console.md` § Known limits rather than being left
implicit.

**Why it happened:** a spoke summarises from its own partial view; a killed
spoke leaves no artifact at all. Both argue for the same discipline.

**Fix for future:** never quote a spoke's numbers in a commit message, a PR
body, or a log without re-running the gate. When a dispatch is interrupted,
record the un-landed work somewhere a reader will hit it — a Known-limits
section or a tracker row — before moving on.

## Lessons learned

- **Trace a request, not a module list, when slicing.** Module boundaries make
  a good dependency order but a bad completeness check. Walking one
  representative request end-to-end and naming the layer that handles each step
  is what surfaces a missing slice (divergence 1) before it becomes an
  unplanned PR.

- **Unit tests are evidence about functions, never about the protocol.** 1,224
  of them missed two wire-visible defects, because every one of them
  constructed its own context and none of them was a socket. Run the manual
  acceptance script inside the slice that ships the wire behaviour (divergence
  2).

- **Name the predicate a default keys off.** "The default makes this explicit
  value unnecessary" is only true for the exact subject the default inspects;
  two nearly-always-equal predicates are where the silent bug lives (divergence
  3).

- **A structural port can be weaker than what it mirrors, silently.** Method
  parameter bivariance lets a hand-written `string` accept what the real
  interface's closed union would reject. Mirror the narrowest type and pin the
  duplication with a test that imports both sides (divergence 5).

- **Mutation-test the assertion, not just the code.** Stashing the fix and
  watching the test still pass is what proved the hub's brief wrong — a passing
  test is not evidence until you have seen it fail for the intended reason. _(promoted → `.claude/rules/tests.md`)_

- **Split a bot finding into its claim and its concern.** Verify the claim
  against the raw artifact and act on the concern independently; a wrong claim
  routinely wraps a correct concern (divergence 6). _(promoted → `.claude/skills/resolving-pr-comments/SKILL.md`)_

- **Treat the composition root as growing every slice.** Its byte-budget
  headroom should be checked at the _start_ of a slice, not discovered at the
  gate after the code is written and reviewed (divergence 4).

- **Never let a shell pattern match its own command line.** `pgrep -f` /
  `pkill -f` from an interactive shell will find the shell. Move the logic into
  a script file; the bracket trick is not sufficient (divergence 8).

- **Un-landed work must leave an artifact outside the log.** A killed spoke
  produces nothing; a follow-up that lives only in prose does not exist. The
  `?limit=`/`parameters` bounds are in the reference page's Known limits
  section for exactly this reason (divergence 9).

- **A guarded duplication can beat an unguarded import edge — but only if it is
  actually guarded.** X4 duplicated three things across the `http`/`runs` zone
  boundary and pinned one of them. The other two are a real, named gap, not a
  clean result.

### Promotion deferred to the sweep

Three of the lessons above generalise beyond X4 and were drafted into
`.claude/rules/tests.md` and `.claude/rules/library-src.md` at write time, then
reverted: both files are baselined by ADR-0078's context-budget **ratchet**,
which permits no growth, and paying for ~1.5 KB of new bullets would have meant
condensing unrelated prose in a docs close-out PR. They are left here for the
next `/promoting-work-log-lessons` sweep, which can rebalance a whole rule file
deliberately rather than as a side effect:

- unit tests are evidence about functions, never about a protocol
  (→ `.claude/rules/tests.md`);
- mutation-test the assertion, not just the code (→ `.claude/rules/tests.md`);
- a structural port can be silently weaker than what it mirrors
  (→ `.claude/rules/library-src.md`).
