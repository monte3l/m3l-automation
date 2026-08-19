# Work log — `core/checkpoint` fingerprinting, item A4 (2026-08-19)

Covers item **A4** of the codified-procedure-engine wave (issue #471): binding a
checkpoint to the configuration that wrote it, so resuming after an edited query
or window fails loud instead of continuing from a meaningless offset. Ran through
the hub-and-spoke TDD pipeline — docs-spec first, `test-author` RED,
`code-implementer` GREEN, a five-spoke review round, then three adversarial
refute passes. It records what shipped, what matched the plan, the four defects
and two regressions the refute passes found, and the one durable lesson this item
exists to teach.

Plan of record: [`docs/plans/2026-08-18-codified-procedure-engine.md`](../plans/2026-08-18-codified-procedure-engine.md) §A4

## Summary

Shipped the library half of A4 as a **minor** bump, `4.0.0 → 4.1.0` (hand-managed
per ADR-0020). The fleet retrofit is filed as **A4b**.

**Public surface — zero new exported symbols.** `check:api` did not move.

- `M3LCheckpointStoreOptions` gains an optional `definition: unknown`.
- `M3LCheckpointErrorCode` widens 4 → 6 with `ERR_CHECKPOINT_FINGERPRINT_MISMATCH`
  and `ERR_CHECKPOINT_DEFINITION`, both registered `{ origin: "caller",
retryable: false }` in `M3L_ERROR_CODES` and `M3L_ERROR_CATALOG`.
- The internal envelope gains `fingerprint?: string`; `checksum` semantics
  unchanged.

**Behaviour.** The definition is walked **once** at construction — each value read
exactly once, validated against a recursive allowlist, and copied into a fresh
plain-JSON projection — and the fingerprint is `canonicalJsonHash` of that
projection. `write()` stamps it; `read()` verifies the `checksum` first, then the
fingerprint. All four backward-compat axes hold: no fingerprint on the envelope,
no definition on the store, the legacy no-envelope path, and an explicit
`definition: undefined` all read exactly as before.

**A pre-existing data-loss bug fixed alongside** (maintainer-approved):
`write()` hashed the caller's checkpoint and serialised it separately for disk,
and the two views differ for a sparse array (`[1,,3]` vs `[1,null,3]`), so the
library wrote files whose stored `checksum` did not match their own `payload` —
every later `read()` rejected the library's own output with
`ERR_CHECKPOINT_CORRUPT`, a permanently dead resume. `write()` now snapshots once.
Verified byte-compatible across nine payload shapes, so existing checkpoints stay
readable.

**Gates.** `typecheck` 17/17, `build` 16/16, `lint`, `format:check`, `check:api`,
`check:zones`, `check:doc-exports`, `check:doc-counts`, `check:impl-counts`,
`check:test-counts`, `check:hub-keys`, `check:provenance`, `knip`, `lint:md` — all
pass. Suite **7157** tests (180 files) plus **1100** bin tests — the branch rebased
onto a `main` that stopped the primary vitest config from also executing
`bin/tests/**` twice (#493), so the totals moved without any test being lost.
`checkpoint.test.ts`
**134** tests; `M3LCheckpointError.ts` 100% on all four metrics,
`M3LCheckpointStore.ts` statements 93.5 / branches 98.7 / functions 100 (residue
is array-specific hostile-`Proxy` arms and three safety nets the projection makes
unreachable). `pnpm sync:docs` 13/13.

**Review verdicts.** `code-reviewer` — no Must-fix, 2 Should-fix.
`spec-conformance-reviewer` — conformant, zero symbol drift, all five contracts
verified true, 5 Should-fix all doc-side. `silent-failure-hunter` — no Must-fix.
`security-reviewer` — no Must-fix, 1 Should-fix (a real prototype-chain read).
`type-design-analyzer` — **2 Must-fix**. Then three adversarial refute passes:
**refuted, refuted, refuted**.

Skills used: starting-work, syncing-docs, writing-work-logs, writing-commits,
creating-prs.

Spoke incidents: 3 truncations / 0 stalls / 1 resume.

## What went as planned

- **The docs-spec-first sequence paid for itself four times.** Each fix round
  began by re-pinning `docs/reference/core/checkpoint.md` before dispatching, so
  every spoke worked from one authoritative contract rather than from a review
  comment. The A3 precedent held.
- **RED failed for the right reasons** — 5 genuinely failing tests plus 12
  expected `TS2353`/`TS2344` diagnostics, all "the option/code does not exist
  yet", none a defect in test logic.
- **`check:api` never moved.** Surfacing the change as a new field on an existing
  interface plus a widened union kept the three-entry `exports` map untouched
  through all four rounds.
- **The A3 fail-open class did not recur.** Adding two entries to
  `M3L_ERROR_CODES` was verified not to widen any derived type: `M3LErrorExitCode`
  derives from `M3L_EXIT_CODES`, and the only type derived from `M3LErrorCode` is
  `Record<M3LErrorCode, …>`, which is fail-**closed**.
- **Backward compatibility was asserted, not assumed.** The stored `checksum`
  was probed byte-identical to `canonicalJsonHash(payload)` across nine payload
  shapes after the write-path change — the difference between "should be
  compatible" and "is".

## What didn't go as planned, and why

### 1. The same mechanism was refuted three times

Rounds 1, 2 and 3 each shipped a definition guard, and each was defeated by a
new route for a `toJSON` to reach the hash: a top-level-only shape check (a
nested `Set` walked past it); a recursive allowlist (a **non-enumerable** own
`toJSON` was invisible to `Object.keys` yet applied by the serializer, and a
getter was read twice); then the projection (a polluted `Array.prototype.toJSON`
still collapses projected arrays). Round 2's failure was the worst: two
definitions differing only in a nested `Set` — the adopters' own named log-group
shape — fingerprinted identically and the second run resumed on the first's
offsets. A4's motivating defect, alive inside A4's own fix.

**Why it happened:** every round had the shape _validate the caller's object,
then separately hand it to `canonicalJsonHash`_. That is **two observations of a
mutable, caller-controlled graph**, and any such guard is defeated by making the
two observations disagree. Rounds 1 and 2 responded by naming more bad shapes —
a denylist, which cannot converge.

**Fix for future:** when a guard validates a caller value that is later
re-read by another component, the fix is not another case in the list — it is to
collapse the two reads into one and derive the downstream artifact from the
validated result. Two rounds bypassing the same mechanism is the trigger to stop
patching and change the shape.

### 2. Two of four fix rounds introduced a regression

Round 3's snapshot moved `JSON.stringify` ahead of `canonicalJsonHash` — and
`JSON.stringify` renders `NaN`/`Infinity` as `null` instead of throwing, so a
previously loud `ERR_CHECKPOINT_IO` became a **silent value substitution**:
`write({ z: Infinity })` succeeded, persisted `{"z":null}`, and `read()` returned
`{ z: null }`. Round 2's fix likewise widened a leak: its `cause`-chaining `try`
wrapped `JSON.stringify(envelope)`, so a payload whose getter throws put the
caller's property path into `err.cause`.

**Why it happened:** both regressions came from moving a call across a `try`
boundary or a call-order boundary without re-deriving what the _other_ side of
that boundary guaranteed. In both cases the TSDoc written in the same commit
asserted the old, now-false behaviour.

**Fix for future:** when a fix reorders or re-scopes a `try`, explicitly re-audit
every claim the surrounding TSDoc makes — and re-run the leak audit rather than
carrying forward the previous round's clean result. A moved call invalidates the
audit that covered it.

### 3. Every defect was found by execution; none by reading

Four defects and two regressions, all found by probing built `dist/`. Each had
already been read over — by a review spoke, and in the round-1 case by the hub
itself — and pronounced sound. The prototype-chain read, the nested-`Set` bypass,
the `length` re-read, and the non-finite coercion are all invisible to a careful
reading and obvious to a five-line probe.

**Why it happened:** each defect lives in the gap between two components'
assumptions (`Object.keys` vs the serializer; canonical stringification vs
`JSON.stringify`), and a reader naturally checks each component against its own
contract rather than against the other's.

**Fix for future:** point refute passes at **seams, not diffs**. The
self-corrupting-write bug predated A4 entirely and surfaced only because the pass
was told to attack the interaction between checksum computation and
serialisation.

### 4. A test could not catch the regression it was named for

The round-1 test "both checksum and fingerprint are wrong → `ERR_CHECKPOINT_CORRUPT`
(integrity check wins over meaning check)" built its store with **no
`definition`**, so `#fingerprint` was `undefined` and the mismatch branch could
never fire. It would have passed identically under a fingerprint-first
implementation — exactly the ordering it claimed to prove.

**Why it happened:** the test asserted the right _outcome_ without establishing
the precondition that makes the outcome discriminating.

**Fix for future:** for any test whose name asserts a precedence or ordering
guarantee, verify both arms are actually reachable in that test's setup —
otherwise it is a tautology that looks like a guarantee.

### 5. The issue's own cited evidence had rotted

Issue #471, the tracker row, and ADR-0045 all cited
`M3LCheckpointStore.ts:258-263` as "the legacy no-envelope path". Those lines are
**TSDoc prose** inside `read()`'s doc comment. The real path is the implicit
`else` of `isCheckpointEnvelope`. The ADR also authorised one new error code
where the shipped surface needs two, and named three adopters where a fourth
(`rds-data-sql`, two stores) exists.

**Why it happened:** line-number citations rot as files change; the ADR was
written before implementation surfaced the second code.

**Fix for future:** CLAUDE.md's "re-derive any authored claim you are about to act
on" earned its keep again — the check cost about two minutes and changed what the
tracker row says. Prefer citing a symbol or a guard's name over a line range.

### 6. Three of eight writer spokes truncated mid-turn

Two truncated after their work was complete (tests green, typecheck clean) and one
before any edit landed. Only the last needed a `SendMessage` resume.

**Why it happened:** the known context-exhaustion failure mode, aggravated by
large test files (`checkpoint.test.ts` grew past 2 700 lines).

**Fix for future:** check **real state** — test run, typecheck, `git diff` — before
resuming a truncated spoke. Twice here a resume would have duplicated finished
work. When resuming, hand back the observed state and a numbered
save-after-each-step plan rather than re-issuing the brief.

## Lessons learned

- **Validate-then-rehash is two observations** — any guard that checks a caller
  value and then lets another component re-read it is defeatable by making the
  two reads disagree (non-idempotent getter, non-enumerable `toJSON`, properties
  one traversal enumerates and the other does not). Collapse the reads into one
  and derive the downstream artifact from the validated result.
  _(promoted → .claude/rules/library-src.md)_
- **Two rounds on one mechanism means change the shape** — a third patch to the
  same guard is a denylist, and denylists over open-ended caller input do not
  converge. ADR-0035 reached this for redaction; A4 re-learned it for
  fingerprinting. _(promoted → .claude/rules/library-src.md)_
- **Point refute passes at seams, not diffs** — the highest-value findings here
  lived between two components' assumptions, and the pre-existing
  self-corrupting write surfaced only because a pass was aimed at the
  checksum-versus-serialisation interaction rather than at the new lines.
  _(promoted → .claude/agents/security-reviewer.md)_
- **A moved `try` invalidates the audit that covered it** — reordering or
  re-scoping a guarded call changes what the surrounding TSDoc guarantees and
  what a previous leak audit proved. Re-audit both; do not carry the prior clean
  result forward. _(promoted → .claude/rules/library-src.md)_
- **An ordering test must make both arms reachable** — a precedence assertion
  whose losing branch cannot fire in that test's setup is a tautology wearing a
  guarantee's name. Establish the precondition, then assert the winner.
  _(promoted → .claude/agents/test-author.md)_
- **Check real state before resuming a truncated spoke** — run the tests, run
  typecheck, read `git diff`. Two of three truncations here had already
  completed their work, and a blind resume would have duplicated it.
- **Claim only what you can defend** — the honest scope limit (a poisoned
  `Array.prototype` defeats the fingerprint, and equally defeats the hash, the
  logger and the run report) is more useful than a guarantee that reads as
  absolute and is not. Documenting the precondition beat a fourth architectural
  round.
