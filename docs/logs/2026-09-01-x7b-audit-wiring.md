# Work log — X7b audit wiring, view actions & correlation threading (2026-09-01)

This log covers tracker row **X7b — audit wiring, view actions & correlation
threading** and its hub-sync issue #825. X7b was the half of X7 that never
shipped: the human-action audit layer was complete but **inert**, and the
correlation id ADR-0070 promised end-to-end stopped at a database column.

Predecessor: [X7 human-action audit
close-out](./2026-09-01-x7-human-action-audit.md), which shipped the machinery
and split the unshipped half into this row.

Plan of record: the six-stacked-PR implementation plan for issue #825.

## Summary

Five PRs, each merged to `main` before the next was cut:

| PR                                                         | Semver                | What                                             |
| ---------------------------------------------------------- | --------------------- | ------------------------------------------------ |
| [#826](https://github.com/monte3l/m3l-automation/pull/826) | patch (4.6.1 → 4.6.2) | Closed #823's two append-only read-path findings |
| [#827](https://github.com/monte3l/m3l-automation/pull/827) | minor (4.6.1 → 4.7.0) | The ADR-0070 correlation seam in `m3l-common`    |
| [#829](https://github.com/monte3l/m3l-automation/pull/829) | none                  | Correlation threaded into console run execution  |
| [#831](https://github.com/monte3l/m3l-automation/pull/831) | none                  | The audit port wired into all seven write routes |
| [#832](https://github.com/monte3l/m3l-automation/pull/832) | none                  | `view.*` kinds + the run-stream view audited     |

Outcome: the audit trail records human actions and the one sensitive view that
has a route; one correlation id joins the UI click → API request → queued row →
child process → `run-report.json`; the two #823 findings are closed.

## Declared but unwired — and why

Eight of twelve action kinds are wired. The other four have **no route to wire
them to**, which is a fact about the API surface, not an omission. Evidence, so
the next reader does not re-derive it — `grep -rhoE 'path: "[^"]+"'
packages/m3l-console-server/src/http/routes/*.ts` yields 15 unique paths across
17 method+path pairs, and the set contains no run-cancel route, no
binding-select route, no run-report route, and no session-artifact-content
route (`GET /sessions/:id/bindings` returns binding **rows**;
`src/sessions/artifacts.ts` has no route in front of it):

| Kind                     | Blocked on                          |
| ------------------------ | ----------------------------------- |
| `run.cancel`             | no cancel route exists              |
| `session.binding.select` | no binding-select route exists      |
| `view.run.report`        | no run-report endpoint exists       |
| `view.session.artifact`  | no artifact-content endpoint exists |

All three `view.*` kinds were declared in **one** migration even though only
`view.run.stream` is wired, so the report and artifact endpoints do not each
force another table recreate when they land.

Two further items were **not** absorbed into "X7b: Done" — they are recorded as
**X7c**, on the X7 → X7b precedent: the SQLite audit index still has no writer
(X7b writes the JSONL stream only), and a write route registered through
`M3LConsoleRuntimeOptions.routes` is not audited.

## What went as planned

- **The plan's own verification held.** Every claim in #825 was re-derived
  against `main` before work started, and the seven-row verdict table was
  accurate. The plan's seven corrections to the issue's framing were also all
  correct — including that `bin/check-api.mjs` does not exist (`check:api` is
  `bin/check-exports-snapshot.mjs`, which diffs only the `exports` map and
  fired for none of these PRs).
- **The zone constraint decided placement, as predicted.** `eslint.config.js`
  forbids `http/` from importing `audit/`, so the gate went in zone-free
  `src/boot/`. `check:zones` passed unchanged in every PR.
- **Both file-budget extractions were needed, and both were correctly sized**
  ahead of time.

## What diverged, and why

### `AsyncLocalStorage` would have been actively wrong

ADR-0070's Decision says the correlation id is "carried server-side through an
`AsyncLocalStorage` request context". The plan flagged this; implementation
confirmed it. `pumpQueue` starts a queued run from **inside a different run's
completion continuation** (`finishActiveRun`), so an ambient store would file
run B's audit records, logs and report under whichever request happened to
settle first. `onQueueTimeout` (a timer callback) and `reconcileOnBoot` have no
ambient context at all.

The id is therefore stored on `M3LPendingQueuedRun` and threaded explicitly.
The regression lock is `tests/runs-orchestrator-correlation.test.ts`'s "a queued
run is correlated to its OWN launch, not the run whose completion started it".
Recorded as a dated Update on ADR-0070 rather than left in a work log.

### A new action kind costs a table recreate

The kind vocabulary lives in an inline SQLite `CHECK` constraint, and SQLite
cannot `ALTER` a `CHECK`. Every new kind therefore forces a **new migration
that recreates `console_human_actions`** — v7 for `session.decision.raise`, v8
for the three `view.*` kinds. Both are loss-free only because nothing writes
that table yet (see X7c); both migrations' TSDoc records that a slice which
starts populating it makes a copy-through migration mandatory instead.

The v6 `CHECK`s on `target_kind` and `outcome` already admitted `'artifact'`
and `'served'`, so only the `action` list ever needed recreating.

### Two extractions the byte ratchet forced

- `packages/m3l-common/src/internal/script/correlationId.ts` — `M3LScript.ts`
  is frozen at its 69,512-byte baseline and could not absorb the environment
  tier. Extracting was a **net shrink** (69,512 → 69,105) and gave the
  precedence chain a directly unit-testable home.
- `packages/m3l-console-server/src/store/migrations/human-actions.ts` —
  `registry.ts` had 1,408 bytes of headroom against ~1,950 needed for one
  migration. The split freed 3,441 bytes and gave v8 somewhere to live.

### The exhaustiveness guard had to be narrowed

The gate throws `ERR_CONSOLE_INTERNAL` for a non-`GET` route with no spec
entry — that guard is what pays for moving the audit decision out of the route
modules. Applied to the **assembled** table it broke two existing `main.test.ts`
cases, which register a synthetic `POST /api/v1/echo` through the documented
`options.routes` seam. The spec table is keyed by _this console's_ path
templates and can never hold a spec for a caller-invented route, so enforcing
there would make that seam unusable. Scoped to the console's own routes, with
the consequence documented at the function and filed as X7c.

### Two type locks had to move out of a frozen test file

`M3LScriptRunOptions` and `M3LRunScriptOptions` both gained `correlationId`, so
both `toEqualTypeOf` locks in `script.test.ts` had to change — but that file is
byte-frozen at 264,181. Reclaiming bytes by rewording unrelated text would have
been evading the ratchet, so both locks moved to
`tests/script-correlation.test.ts`. The frozen file shrank (always allowed) and
`docs/implementation-status.md`'s `script` row went 318 → 316,
`cli-contract` 24 → 27.

## Lessons

- **A gate that "wasn't going to fire" is worth re-reading before you plan
  around it.** `run-script.ts` typed its forwarding literal
  `Required<M3LScriptRunOptions>` precisely so a new field breaks the build.
  Adding `correlationId` tripped it, which widened #827 to
  `M3LRunScriptOptions` and forced the exhaustiveness guarantee into a
  type-level test. The plan had not anticipated this; the guard was right and
  the plan was incomplete.
- **`expectTypeOf` guards are enforced by `tsc`, not by vitest.** Mutating
  `M3LScriptRunOptions` to add an unforwarded field left the suite green at
  16/16 while failing typecheck with two errors. "The tests pass" does not
  establish that a type-level guard is live.
- **Run lint and typecheck after writing tests, not just after writing
  source.** Both were green in #831 before its three test files existed; the
  files then carried 12 lint errors and 3 type errors, including
  `M3LConsoleResult` imported from the wrong module. `verify` caught them, but
  several cycles later than necessary.
- **A test that cannot observe the thing it names is not a test.** #829's
  "logger seeded with the run's id" was unobservable: `M3LLogger` exposes its
  correlation id only on events dispatched to handlers, and the executor builds
  it with none. The fix was a test-only `logHandlers` seam on the existing
  internals bag, keeping the seeding itself in the production path — confirmed
  by mutation.
- **Mutation-testing found nothing wrong but proved a phase choice.** Flipping
  the SSE spec from `phase: "after"` to `"before"` failed the 404 test, which
  is the evidence that the ordering is load-bearing rather than incidental.
- **The recorded flake list is accurate.** `script-aws-provisioning-failure`
  hit its 5-second timeout once under full-suite contention and passed on
  retry, exactly as `prepush-aws-provisioning-flake` describes. Backgrounded
  commands also reported `exit code 0` while the real exit was 1 — the
  `REAL_EXIT` logging habit is what caught a failing coverage gate. _(promoted → .claude/rules/subagent-dispatch.md)_

## Follow-ups

- **X7c** — the audit index writer, the `options.routes` audit boundary, and
  the four declared-but-unwired kinds.
- Migrate `aws/rds-data`'s `attachRollbackFailure` onto
  `internal/errors/chain-secondary-failure.ts` (deferred in #826: its caller
  branches on the boolean return and builds a different error per arm, so the
  migration is a behaviour review of its own).
- `packages/m3l-console-server/src/audit/record.ts` is at 24,579 of its
  25,000-byte ceiling and `internal/storage/append-only-reader.ts` at 24,833.
  The next change to either will need an extraction, not an inline edit.
