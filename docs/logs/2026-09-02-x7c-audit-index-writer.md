# Work log — X7c audit index writer & the `options.routes` boundary (2026-09-02)

This log covers tracker row **X7c — audit index writer & remaining action
kinds** and its hub-sync issue #834. X7b had shipped the human-action audit
layer live, but it wrote the **JSONL stream only** — half of ADR-0070's
dual-store audit. `console_human_actions` had a migration, a repository and a
full test file, and **no production caller**. This log records what closed that,
what the tests found that the plan did not predict, and the two guard failures
worth carrying forward.

Predecessor: [X7b audit wiring, view actions & correlation
threading](./2026-09-01-x7b-audit-wiring.md), which shipped the audit layer and
split this row out of its scope.

Plan of record: the four-PR implementation plan for issue #834.

## Summary

Four PRs, each merged to `main` before the next was cut:

| PR                                                         | What                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#853](https://github.com/monte3l/m3l-automation/pull/853) | The writer. `boot/audit-index.ts` — `projectHumanActionIndexInput`, `createIndexedHumanActionAuditPort`, `indexHumanActionAuditPort` — plus `M3LConsoleStoreUnit.audit` and `M3LConsoleRuntimeOptions.audit` |
| [#859](https://github.com/monte3l/m3l-automation/pull/859) | The rebuild path. `boot/audit-rebuild.ts`, `resolveHumanActionAuditRoot`, the boot trigger, and a v7/v8 migration TSDoc correction                                                                           |
| [#864](https://github.com/monte3l/m3l-automation/pull/864) | The `options.routes` audit boundary, stated on the option and in `docs/reference/console.md`, locked in both directions                                                                                      |
| this one                                                   | ADR-0070 dated Update, tracker flip, the new **X7d** row, this log                                                                                                                                           |

**Semver impact: none.** Console-server only throughout — no `m3l-common`
change, no `exports`-map change.

Three claims in #834 were re-derived against the working tree before planning;
all three were true. Claims 1 and 2 shipped as X7c. Claim 3 — four
declared-but-unwired action kinds — is **four new API endpoints, not audit
wiring**, and is split to X7d rather than absorbed.

Gates: `pnpm verify` green on every PR (57 steps passed, 10 skipped);
`pnpm test:coverage` green (14,574 + 2,699 + 260 + 31); `check:review-size`
35,227 / 12,133 / 7,060 chars against a 75,000 soft target. Review-bot verdict
**PASS** on all three code PRs, with six non-blocking findings acted on rather
than deferred.

Skills used: `starting-work`, `writing-commits`, `triaging-ci`,
`writing-work-logs`, `syncing-docs`.

Spoke incidents: none — this wave ran hub-only, with no writer or review spoke
dispatched.

## What went as planned

- **The zone analysis held exactly.** `src/boot/` is in no eslint zone's
  `target` and in no zone's `except`, so the composition could see both
  `audit/`'s and `store/`'s vocabularies with **zero** config or gate change.
  `audit/` stayed a pure leaf and `bin/check-eslint-zones.mjs`'s exact-length
  assertion was never touched — the same precedent `boot/human-action-audit.ts`
  set for the audit gate itself.
- **The lossy-projection finding was real and load-bearing.** The plan derived
  it by diffing `audit/record.ts` against `store/audit-repository-types.ts`:
  three of eleven record fields (`parameterNames`, `parameterRefs`, `detail`)
  have no column. That held, and it is what makes "the JSONL trail is the
  source of truth" operational rather than decorative — the rebuild can only
  run trail → index.
- **`tsc` enumerated the fan-out, as the plan predicted.** Making
  `M3LConsoleStoreUnit.audit` required rather than optional produced a
  compile-time list of exactly two affected test files; no grep was needed and
  nothing was missed.
- **The duplicated-union drift hazard was closable.** `expectTypeOf` equality
  assertions now pin kind, posture, outcome and target-kind across the two
  separately-declared vocabularies. Nothing had asserted that before, and a
  kind added to one and not the other would have compiled and then failed at
  the SQLite `CHECK` at runtime.

## What didn't go as planned, and why

### 1. Core's append-only reader hands back null-prototype nodes _(one-source vacuity promoted → .claude/rules/tests.md)_

`rebuildHumanActionIndex` passed each entry from
`Core.M3LAppendOnlyStream.read()` straight into `projectHumanActionRecord` —
the console's own narrowing boundary, which validates every field at runtime.
Every rebuild test failed with
`TypeError: values.slice is not a function`, thrown from `audit/limits.ts`'s
`boundedList` rather than as a classified `M3LConsoleError`.

Core's reader rebuilds every node with a **null prototype** — its
`toJSON`-gadget defence, mirroring the write path
(`internal/storage/append-only-projection.ts`). The consequence is easy to
miss: `Array.isArray` still answers `true`, but the array has no `.slice`. The
fix re-hydrates each entry with `structuredClone` before narrowing, which —
unlike a `JSON.parse(JSON.stringify(...))` round-trip — cannot quietly turn a
`-0` into `0` behind the narrowing layer's back.

**Why it happened:** the plan reasoned about the entry's _shape_ (field names
and types match, so the cast is safe) and not about its _prototype_. A cast
across a serialization boundary hides both.

**Fix for future:** when reading back through a primitive that documents a
prototype-stripping defence, treat re-hydration as a required step, not an
optimization. It surfaced only because the test used a real trail and a real
migrated store on both sides — a faked trail plus a faked repository can never
disagree about this.

### 2. A pre-bind `await` broke 26 tests, and the first fix passed locally then failed in CI

Placing the boot rebuild in `reconcileOnBoot`'s slot — a database write
strictly before the bind — added the first `await` between `startConsole()` and
`server.listen()`. Twenty-six tests across three files broke at once: their
fake-server doubles emitted `listening`/`error` in the same synchronous turn as
the `startConsole()` call, which had always been safe because nothing yielded
in between.

The first fix absorbed this with a **polling** helper that retried
`setImmediate` while no listener was attached, bounded at 200 attempts. Every
test passed locally. CI's Test job then failed with four 5-second timeouts,
because 200 event-loop turns is _microseconds_ on an idle loop, not a wait — on
a loaded runner the pre-bind trail read had not finished, the bound was
exhausted, and the emit went into the void.

The real fix removes the guesswork instead of raising the bound.
`lifecycle/http-server.ts` attaches **both** handlers before it calls `listen()`,
so `emitListening()`/`emitBindError()` now _arm_ the outcome and the fake's own
`listen()` flushes it — order-independent, with nothing to exhaust.

**Why it happened:** the doubles encoded an implementation-timing assumption
("boot binds within one synchronous turn") that was never a contract, and the
first fix replaced one timing assumption with a subtler one.

**Fix for future:** never make a test double wait by counting event-loop turns
— that is a latency guess dressed as a bound, and it fails only under load.
Anchor the emit to a structural guarantee in the code under test instead.

### 3. A guard that had been mutation-tested went vacuous later in the same wave

`main-runs.test.ts` gained an `auditReads` counter proving `startConsole` passes
`audit: store.audit` to `createConsoleRuntime`. It was mutation-tested when
written: deleting the hand-off failed it. One PR later the boot rebuild also
read `store.audit` (for its emptiness probe) and swallowed the stub's throw in
its degradation catch — so the counter stayed non-zero with the hand-off
deleted. The guard could no longer fail. The review bot caught it, re-mutation
confirmed it, and the test was deleted rather than contorted: the
non-vacuous proof already existed in `boot-audit-rebuild.test.ts`'s end-to-end
pass, which boots a real store, performs a real audited write and asserts a row
arrived.

**Why it happened:** mutation-testing proves a guard has teeth **at the moment
you run it**. Nothing re-runs that proof when the code under test grows a new
reader of the same signal.

**Fix for future:** when a change adds a new consumer of a value some test
observes indirectly (a property read, a call count, a log line), re-mutate the
tests that watch it. Prefer a guard that asserts an _outcome only the intended
path can produce_ over one that counts an access.

### 4. Two PRs were merged or moved externally while work was in flight _(promoted → .claude/skills/creating-prs/SKILL.md)_

PR #853 was squash-merged upstream while a follow-up commit addressing the
review bot's findings was still being pushed; the push was rejected because the branch
had been deleted, and the commit was carried onto the next branch. Separately,
someone merged `main` into #859's branch mid-flight, so a push was rejected as
non-fast-forward and the fix commit was rebased onto the merge.

**Why it happened:** this wave ran alongside other sessions on a shared remote.
Nothing was lost, but "the branch I pushed to still exists" is not a safe
assumption across a multi-minute `pre-push`.

**Fix for future:** before a follow-up push on an approved PR, check
`gh pr view --json state` rather than assuming the PR is still open; a rejected
push naming a deleted ref means the PR merged, not that something is broken.

### 5. A stale `dist` made ten unrelated tests fail after pulling a merge

Immediately after rebasing onto a `main` that had absorbed `rawKeys()` (#856)
and the flow loader (#861), `pnpm test:coverage` failed ten `m3l-cli`
flow-loader tests with `failed to read flow definition`. The cause was a stale
built `m3l-common` in the worktree: `rawKeys()` did not exist in `dist`, so the
loader's `catch` reported a read failure. `pnpm build` fixed it; nothing was
wrong with the code.

**Why it happened:** `m3l-cli` consumes `@m3l-automation/m3l-common` through
the workspace package's built output, so a merge that adds a library export
invalidates `dist` without invalidating anything the test runner checks.

**Fix for future:** after pulling or rebasing onto a merge that touches
`packages/m3l-common`, run `pnpm build` before trusting a local
`test:coverage` result. A failure in a package you never edited is the tell.

## Lessons learned

- **A cast across a serialization boundary hides the prototype, not just the
  shape.** `Array.isArray` can answer `true` on a value with no `.slice`.
  When a primitive documents a prototype-stripping defence on its read path,
  re-hydrate (`structuredClone`, not a JSON round-trip) before handing the
  value to a narrowing layer. _(promoted → .claude/rules/library-src.md)_

- **Never let a test double wait by counting event-loop turns.** A bound of
  "200 `setImmediate` retries" is a latency guess, not a wait: it is
  microseconds on an idle loop and fails only under CI load. Anchor the emit to
  a structural guarantee in the code under test — here, that
  `startConsoleServer` attaches its handlers _before_ calling `listen()`.
  _(promoted → .claude/rules/tests.md)_

- **A mutation-tested guard can go vacuous later, and nothing re-checks.**
  Mutation-testing proves teeth at the moment it runs. When a change adds a new
  consumer of a signal some test observes indirectly — a property read, a call
  count, a log line — re-mutate the tests watching it. Prefer asserting an
  outcome only the intended path can produce over counting an access.
  _(promoted → .claude/rules/tests.md)_

- **Assert both halves, or the test passes for the wrong reason.** "Serves
  normally and records no audit entry" needed the 200 _and_ the empty trail: a
  404 also records nothing, so the empty-trail assertion alone would have
  passed with the route never reached. The same shape recurs whenever a test's
  positive claim and its negative claim can both be satisfied by the request
  simply not happening.

- **A derived store's failure policy should match everywhere it can fail.**
  The ruling that an index-write failure degrades rather than refuses only
  holds together because the boot rebuild degrades too, and because the rebuild
  reads the whole trail before writing anything. A partial index that looks
  complete is the one outcome an audit index may never produce, and that
  constraint dictated the implementation order, not the reverse.

- **Rebuild after pulling a merge that touches the library.** Consumer
  packages resolve `@m3l-automation/m3l-common` through built output, so a
  merge adding an export leaves `dist` stale and makes tests fail in packages
  you never edited. _(promoted → .claude/rules/tests.md)_

- **A `DROP`+recreate migration's loss-free justification has an expiry date.**
  v7/v8 were justified partly because nothing wrote `console_human_actions`.
  X7c ended that, and the TSDoc still instructed the next author to write a
  copy-through. Correcting it — rather than annotating around it — mattered
  because the rebuild trigger now _is_ the justification, and that is a
  condition a future author must verify rather than inherit.
