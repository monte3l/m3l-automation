# Work log — X3 console persistence foundation (2026-08-27)

This log covers X3 of the m3l console wave (issue #551): the embedded-SQLite
persistence foundation ADR-0069 decided, shipped as two stacked PRs — #706
(driver seam, failure mapping, query port, lifecycle wiring) and its follow-on
migrations PR. It ran through the hub-and-spoke TDD pipeline, and records what
shipped, what matched the plan, where the plan itself was wrong, and the durable
lessons.

Plan of record: [`docs/plans/2026-08-20-m3l-console.md`](../plans/2026-08-20-m3l-console.md)

## Summary

**Shipped.** A `store/` layer whose only `node:sqlite` import sits in one file:
structural driver ports, a pure failure classifier, a query port with
transactions and savepoints, `openConsoleStore`, forward-only migrations with a
drift-detecting audit trail, and `M3LConsoleMetaRepository`. Seven new
`M3LConsoleErrorCode` members with envelope classifications. `config/paths.ts`
plus two settings. `/ready` store health via a structural probe that needs no
ESLint zone edge. The shutdown sequence extracted to `lifecycle/shutdown.ts`.

**Tests.** 593 console-server unit tests + 17 integration; full suite 10,079 +
1,848 + 17. Coverage clean on the `perFile` gate (90/83/80/89) — `main.ts` ended
at 98.14% statements / 96.42% branches, `registry.ts` at 100%.

**Gates.** `typecheck`, `build` (`isolatedDeclarations`), `lint` (zero errors,
zero warnings), `format:check`, `lint:md`, `check:zones` (34 zones),
`check:file-budget`, `knip`, `check:dup` (3.96% against 4%),
`check:review-size`, `check:test-counts`. Full pre-push suite green on both
pushes that landed.

**The ADR-0069 stability checkpoint is discharged.** `tests/store-driver.test.ts`
drives the real builtin, so CI re-asserts it on the Node 24 floor every push
rather than resting on a one-off measurement. The open question the plan flagged
as unverifiable locally — whether Node 24 emits an `ExperimentalWarning` on
`import "node:sqlite"` — came back **negative on the floor**: the Node 24 `Test`
job passed with the probe in place. Neither ADR-0069 fallback was exercised, so
no ADR Update is required.

**Review.** Four internal reviewers (quality, silent-failure, type-design,
security) on PR A, then `claude-pr-review` on the PR itself. Internal reviewers
returned 1 + 3 + 2 Must-fix-equivalents and a large Should-fix set; the bot
returned FAIL with 2 Must-fix, 2 Should-fix, 1 nit. All resolved. Eleven
hand-run mutation proofs, each confirmed RED.

**Also recorded:** `better-sqlite3@13.0.3` is already a hard runtime dependency
of `m3l-common` (`core/storage/M3LFtsIndex.ts`), so it is already in
console-server's dependency closure — ADR-0069's fallback 1 is cheaper than the
ADR assumed. This does not reopen the decision (ADR-0069 is Accepted and
immutable, and `node:sqlite` still adds nothing). Its port types are direct
aliases (`export type M3LSqliteDatabase = BetterSqlite3.Database`), so nothing
there was reusable — which is exactly the mistake this work avoided.

Skills used: `starting-work`, `resolving-pr-comments`, `writing-work-logs`.

Spoke incidents: 12 truncations / 0 stalls / 9 resumes.

## What went as planned

- **RED failed for the right reason, every slice.** `Cannot find module` or a
  missing-union-member type error — never a defect in the test logic. The
  `Record<M3LConsoleErrorCode, …>` exhaustiveness trick worked exactly as
  designed: adding error codes broke the _test_ tables at compile time, twice.
- **The ESLint zone moved in lockstep with its checker, and was mutation-proven
  both ways** before any store code existed — widening `except` fails
  `check:zones`, removing the row fails it.
- **The structural-type trick held in both places it was needed.**
  `M3LReadinessProbe` in `http/routes/` and the disposable in `lifecycle/`
  avoided an `http -> store` and a `lifecycle -> store` edge with no zone change.
- **The byte-budget contingency paid off better than projected.** Extracting
  `runShutdownSequence`/`createShutdown`/`registerConsoleShutdownSignals` into
  `lifecycle/shutdown.ts` left `main.ts` at 18,496 bytes — _below_ its original
  20,926 — creating headroom for the migrations PR instead of spending it.
- **The migration convention shipped with a demonstration, not a promise.** PR B
  added v2 on top of v1 without touching the runner; `PRAGMA user_version` reads
  2 after open, verified against the built output.
- **Every measured `node:sqlite` fact was independently re-derived twice** —
  once by the hub before writing the contract, once by the test-author before
  encoding each assertion. All agreed.

## What didn't go as planned, and why

### 1. The plan's migration contract was internally contradictory

The plan specified `up(executor: M3LStoreQueryExecutor): void` **and** a
per-version SQL digest so "editing a released migration goes red." Those
conflict: with an `up` function the only thing available to digest is
`up.toString()` — the function's source text. So `prettier --write` on the
registry, or a TypeScript version that emits function bodies differently, would
change the digest for migrations nobody touched, and every existing deployment
would refuse to boot with `_SCHEMA_DRIFT`. Migrations now declare
`statements: readonly string[]`.

**Why it happened:** the two requirements were specified in different sections of
the plan and never checked against each other. The tension is only visible when
you ask "digest _what_, exactly?"

**Fix for future:** when a plan asks for a integrity digest over authored
content, name the exact bytes being digested at plan time. If the answer is "a
function's source text," that is a false-positive generator, not a digest.

### 2. `/ready`'s store probe was wired in the type system but not in the code

All four internal reviewers independently found that `buildDispatchRouter` never
passed the store to `createHealthRoutes`, so `/ready` returned 200 with a closed
store in every real deployment. `health.test.ts` passed because it drove
`createHealthRoutes` directly.

**Why it happened:** a unit test of the component was allowed to stand in for
proof that the system was connected. The structural `M3LReadinessProbe` made it
worse, not better: with no import, nothing in `src/` referenced the type, so
renaming `isOpen` would have left everything compiling and green.

**Fix for future:** a structural type used to avoid an import has **no**
compile-time conformance proof until some `src/` call site instantiates it from
the real object. Treat the absence of such a call site as an unwired feature. The
contrast within this very PR is the evidence: the `lifecycle/` disposable _was_
proven, because `main.ts` passed the real store to `createShutdown`.

### 3. Defensive guards were added without tests, failing the coverage gate twice

The first push was rejected: `sqlite-driver.ts` at 88.09% lines / 86.95%
statements. Cause — the review-fix commit added a `Number.isSafeInteger` guard
(correctly, at a security reviewer's prompting) with no test. The same pattern
recurred after the PR-review fixes: `main.ts` fell to 84.9% lines / 71.42%
branches because the new double-fault paths had no tests.

**Why it happened, twice:** the hub's "full gate sweep" ran `pnpm exec vitest run`
rather than `pnpm test:coverage`. Those are different gates. The second time was
worse: the hub had explicitly warned the spoke about this exact pattern _and_
told it not to run `test:coverage` (to avoid another turn-limit stall) _and_ asked
it to flag any unreachable branch — contradictory instructions that removed the
only tool that could answer the question.

**Fix for future:** `pnpm test:coverage` is not a slower `vitest run`; run it
before any push. And when adding a defensive branch, add its test in the same
change — a guard with no test _lowers_ per-file coverage, so the safety
improvement and the gate failure arrive together.

### 4. Parallel targeted fixes produced two solutions to one problem

The bot flagged `chainRollbackFailure` for overwriting an existing `cause`. The
fix was correct — a chain walk with cycle and hostile-getter guards. But the same
implementer, in the same pass, wrote a _second_ helper in `main.ts` for the
identical problem and made it single-level, so it silently **dropped** the close
failure whenever a cause already existed — reintroducing a variant of the very
bug the review had just caught, and violating CLAUDE.md's "never swallow errors
silently." Both are now one `errors/chainSecondaryFailure`.

**Why it happened:** each fix was locally correct and dispatched against its own
finding. Nothing compared them, and the second helper was new code in a file the
first fix did not touch.

**Fix for future:** when one review pass produces fixes for the same _class_ of
defect in more than one file, check for a shared implementation before
committing. A second, weaker copy of a just-fixed helper is the likeliest
regression a review cycle introduces.

### 5. PR B was built on PR A's branch, not stacked off it

The plan called for two stacked PRs. The hub decided location/branch once at
`starting-work` and never re-made the decision at the PR A → PR B boundary, so
PR B's work accumulated uncommitted on PR A's branch. It surfaced only when the
review-fix workflow wanted to commit and push — at which point PR B's
half-finished work would have gone into #706.

**Why it happened:** `starting-work` runs once per task, but a multi-PR task has
one branch decision _per PR_.

**Fix for future:** for a task with a planned PR sequence, re-run the
location/branch decision at each PR boundary, not just at task start. Recovery
cost here was low only because the two PRs touched almost disjoint files.

### 6. Squash-merge made the naive rebase of the stacked branch conflict

After #706 merged, `git rebase main` on the stacked branch tried to replay PR A's
five individual commits onto a main that already contained them squashed, and
hit an add/add conflict. `git rebase --onto main <PR-A-tip>` replayed only PR B's
commit, cleanly.

**Why it happened:** a squash merge means the stacked branch's base is no longer
an ancestor of `main`, so plain `rebase main` has no correct base to diff
against.

**Fix for future:** rebase a stacked branch after a squash merge with
`git rebase --onto main <the-branch-point>`, never bare `git rebase main`.

### 7. A spoke reverted a hub edit it had not made

The store implementer noticed a `README.md` change outside its write scope,
inferred a hook had produced it, and reverted it. It was the hub's deliberate
correction of an overstated seam claim.

**Why it happened:** the spoke was policing files outside its scope and treated
an unexplained change as an artifact rather than reporting it.

**Fix for future:** scope a spoke to its own files _and_ instruct it to report
unexpected changes rather than revert them. In a shared checkout with parallel
spokes, a well-meaning revert silently undoes hub work.

### 8. Two of the hub's own mutation proofs were worthless before being fixed

One `perl` expression hit a TSDoc mention instead of the code; another renamed a
port field, which Vitest does not typecheck, so runtime behaviour was unchanged.
Both reported "still green" and read as damning findings until the mutation
itself was verified.

**Why it happened:** a non-anchored regex matched documentation first, and a
type-level mutation cannot change a runtime test.

**Fix for future:** a mutation proof is meaningless until you confirm the
mutation _changed behaviour_. Diff the file, and prefer mutating a runtime
expression over a type or a comment.

### 9. A test documented a silent failure as intended behaviour

Asked to test a chained-cause helper, the test-author correctly discovered the
implementation was single-level and tested what the code actually did — which had
the effect of pinning a silent error-drop as the contract.

**Why it happened:** "test the real behaviour, not the brief" is the right
instinct, and here it collided with the behaviour being wrong.

**Fix for future:** when a test-author reports that actual behaviour diverges
from the brief, treat it as a _finding about the code_, not just a correction to
the test — decide which is wrong before letting the test enshrine it.

## Lessons learned

- **Digest the bytes, not the source text.** An integrity digest over authored
  content must name exactly what it hashes. Hashing a function's source makes
  reformatting indistinguishable from tampering — and if the check fails closed
  at boot, a formatter run bricks every deployment.

- **A structural type used to dodge an import has no conformance proof until
  `src/` instantiates it.** Until some production call site builds it from the
  real object, the compiler cannot see the claim, and a rename leaves everything
  green. Absence of that call site means the feature is unwired.

- **`pnpm test:coverage` is a different gate from `pnpm exec vitest run`, not a
  slower one.** Substituting the latter in a pre-push sweep hid two real
  failures in this task. _(promoted → .claude/rules/tests.md)_

- **A defensive guard with no test lowers per-file coverage.** The safety
  improvement and the gate failure arrive in the same commit, so add the branch's
  test in the same change that adds the branch. _(promoted → .claude/rules/tests.md)_

- **One review pass fixing the same defect class in several files invites a
  second, weaker copy.** Check for a shared implementation before committing; the
  likeliest regression a review cycle introduces is a re-implementation of the
  helper it just fixed.

- **Re-make the branch decision at every PR boundary, not once per task.**
  `starting-work` answers "where do I work" for the task; a planned PR sequence
  needs that answer per PR, or the second PR's work lands on the first's branch.
  _(promoted → .claude/skills/starting-work/SKILL.md)_

- **Rebase a stacked branch after a squash merge with `--onto`.** Bare
  `git rebase main` replays commits that main already contains squashed, and
  conflicts. _(promoted → .claude/skills/resolving-merge-conflicts/SKILL.md)_

- **A mutation proof proves nothing until the mutation is confirmed to change
  behaviour.** Anchor the pattern so it cannot match a comment, and prefer a
  runtime expression — Vitest does not typecheck, so a type-level mutation is
  invisible to it.

- **Instruct spokes to report unexpected changes, never revert them.** In a
  shared checkout with parallel spokes, a spoke policing files outside its scope
  can silently undo hub work. _(promoted → .claude/agents/code-implementer.md)_

- **Tell a spoke a short verification list and run the full sweep at the hub.**
  Twelve truncations in this task landed almost entirely in the verification
  tail, not while writing code — each spoke re-running seven gate commands is
  the single largest source of wasted cycles here.
  _(promoted → .claude/rules/subagent-dispatch.md)_

- **Read the gate's source, not the prose around it.** A spoke flagged that
  `docs/implementation-status.md` needed a matching test-count row per
  `tests.md`; `check:test-counts` in fact tracks only the 42 `m3l-common`
  submodules and exits 0 for console-server files.

- **Path-filtered coverage runs lie.** `vitest run --coverage <path>` reports
  spurious 0% for `m3l-common` files, because console-server tests import the
  library barrel and pull its source graph in while stranding that package's own
  tests. Only the unfiltered run is truthful. _(promoted → .claude/rules/tests.md)_
