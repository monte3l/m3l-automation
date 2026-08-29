# Work log — `core/agent` submodule, slice 1 (2026-08-29)

This log covers issue #543 (V6, ADR-0060) — implementing slice 1 of the
`core/agent` policy layer through the hub-and-spoke
`implementing-submodules` pipeline, plus the prerequisite `core/errors`
refactor it forced and the `pre-push` gate gap it exposed. It records what
shipped, what diverged, and durable lessons — particularly for slice 2
(budgets, rate caps, dry-run-first) in this same submodule.

## Summary

Shipped the Core namespace's 25th submodule: an **authorization control**
for an autonomous agent. ADR-0048's destructive gate is explicit that it is
"an operator-safety prompt, not an authorization control" — anyone holding
`--yes`/`--yes-sensitive` bypasses it — so an autonomous operator had no
safety layer at all, only a disabled prompt. `core/agent` is the layer that
says no.

20 public exports across `core/agent/` (9 files) plus `internal/agent/`
(5). `evaluateAgentAction` returns a typed `auto-approved | escalate |
denied` verdict naming the rule that produced it; `validateAgentPolicy`
turns a parsed JSON preset into a branded, deep-frozen policy. The module
performs no I/O, reads no clock, and holds no module-level state.

Landed across three PRs:

| PR          | Scope                                                              |
| ----------- | ------------------------------------------------------------------ |
| #736        | `refactor(core/errors)`: extract `M3L_ERROR_CODES` into `codes.ts` |
| _(this PR)_ | `feat(core/agent)`: slice 1, plus two `pre-push` gate additions    |

## What went as planned

- **The ADR-0048 ride.** `sensitiveTargets` is imported and called, never
  re-implemented. The module contains no matching logic and never emits
  `yesSensitive` on its own authority.
- **The ADR-0009 wall.** The allowlist keys on a plain script **name**
  string, because Zone B forbids `core/**` from importing `core/script` and
  `import-x/no-restricted-paths` is not type-aware — the same wall that
  forced `core/cli-contract` to drop its `M3LScript` composition. Predicted
  in the plan, hit exactly as predicted, no zone widening needed.
- **Additive-minor shape.** Barrel-surfaced only; `check:api` never moved.
  The type-design review verified slice 2's four planned widenings compile
  against the existing tests with only the intentional vocabulary snapshot
  needing an update.
- **File budgeting up front.** Largest source file 5.4 KB against a 25 KB
  ceiling; the `internal/agent/` split was designed before code was
  written, not retrofitted.

## What didn't go as planned, and why

### 1. A reading-based review cleared seven fail-open defects

The single most important finding of this task.

Four reviewers ran in parallel. `code-reviewer` read all 13 source files
carefully and returned **"no Must-fix"** — it verified guard polarity,
single-traversal projection, deep copying, and `Object.hasOwn` usage, and
each of those verifications was correct. The three reviewers that
**executed probes against built `dist/`** found seven defects between them,
four reachable from plain JavaScript with no cast:

| #   | Defect                                                                           | Effect                                                                                               |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1  | `grant.allOperations` read by dot access off a projection that omits absent keys | `Object.prototype.allOperations = true` bypassed the operation allowlist entirely                    |
| F2  | `policy.sensitiveTargets` likewise                                               | `Object.prototype.sensitiveTargets = {}` made an **ungraded** policy auto-approve a prod mutation    |
| F3  | Options bag had no key allowlist                                                 | a typo'd `additionalSensitiveTargets` silently dropped sensitivity grading; predicate called 0 times |
| F4  | The brand was type-level only                                                    | a plain object **spread** — no cast — took a script from `denied` to `auto-approved`                 |
| F5  | Ceilings checked `.length`, then iterated                                        | a hostile `Symbol.iterator` projected 5,000 entries past a 256 ceiling                               |
| F6  | Throwing accessors / `Proxy` traps                                               | escaped as raw `TypeError`, breaking the documented `instanceof` triage                              |
| F7  | `M3LAgentActionRecord.target` borrowed `M3LDestructiveTarget`                    | `"region" in t` narrowed to `string` unsoundly and threw                                             |

F2 is the one worth remembering: it bit **precisely the most cautious
deployment** — the one that declared no grading specifically so everything
would escalate.

The root cause of F1/F2 was a single inconsistency the module already knew
about. `internal/agent/validation.ts:8` documented that both boundaries
read presence with `Object.hasOwn`; `decide.ts` was the one file violating
its own module's stated invariant.

### 2. The fix for F6 was itself one trap short

The F6 fix wrapped both traversals and was verified by probing — with
`ownKeys`. But `isPlainObject` calls `Object.getPrototypeOf`, and that call
sat _outside_ the guarded region in the declaration walk, so a `Proxy` with
a throwing `getPrototypeOf` trap still leaked a raw `RangeError`. Caught by
`spec-conformance-reviewer` as the final gate, and only because it probed
a trap the previous pass hadn't.

Closing it required a 7×5 trap matrix (every hostile-reachable object ×
every reflective operation), not another single probe.

### 3. A one-commit-old checkout produced two red CI runs

PR #736 went red twice, for the same class of reason both times:
`check:provenance` and `check:index` both anchor a symbol to a source
**file path**, and both are **CI-only** — absent from `lefthook.yml`. A
fully green `pre-push` was no evidence either would pass.

The second red run was avoidable and was my error: after the first, I swept
"the CI-only gates" using the list printed in the `triaging-ci` skill's
table. That table is illustrative, not an inventory. Enumerating from the
source of truth yields 43 `check:*` scripts, and `check:index` was not in
the prose list.

### 4. `main` moved twice underneath the branch

Between branching and rebasing, `main` gained not only #736 but **#733**,
which added a fourth `exports` subpath (`./core/errors`) as an ADR-0004
gated exception. It surfaced as a `CLAUDE.md` conflict asserting four
entries where the branch said "exactly three".

### 5. `M3LError.ts` blocked a mandatory registry addition

Adding two error codes pushed `M3LError.ts` 64 bytes past a ratchet
baseline set **one commit earlier** (#734). Rather than raise the baseline,
the tuple was extracted into `codes.ts` as its own PR — dropping the file
from 26,012 to 20,575 bytes, removing its baseline entry entirely, and
making every future error code free.

## Lessons learned

1. **On a security boundary, a review that does not execute is not a
   review.** The reviewer that read the code most carefully found nothing;
   the three that ran probes found seven defects. For any module whose
   purpose is to refuse, require probes against built `dist/` and treat a
   reading-only pass as unfinished.

2. **Prototype-chain reads are the fail-open shape in this codebase.** Any
   projection that _omits_ an absent key turns every later dot-read into a
   `Object.prototype` lookup. Either materialise own `undefined` keys (as
   `M3LAgentActionRecord` does) or read through `Object.hasOwn` — and note
   that materialising is unavailable on caller-facing declaration types
   under `exactOptionalPropertyTypes` without an unearned cast.

3. **A type-level brand is not an authorization control.** `as` is not the
   only forgery route — an object **spread** copies a phantom brand with no
   cast at all and compiles clean. If a branded type gates a security
   decision, back it with a runtime registry. A module-private `WeakSet` is
   the right shape: it survives serialisation-shaped tampering, adds no own
   key, and a `Proxy` over a real policy is a non-member.

4. **Enumerate gates from `package.json`, never from prose.**
   `node -e "console.log(Object.keys(require('./package.json').scripts).filter(k=>k.startsWith('check:')).join(' '))"`
   Documentation tables drift; the script list cannot.

5. **`check:*` gates that anchor to a file path break on any symbol
   relocation.** `check:provenance` and `check:index` are now in `pre-push`
   for exactly this reason. Note `check-doc-provenance --update` restamps
   blob hashes but never moves a `file` path — that is always a hand-edit.

6. **Mutation-test the guards, and distinguish a survivor from an
   equivalent mutant.** Flipping the sensitivity verdict to `=== true`
   kills 4 tests; reverting the `Object.hasOwn` read kills 1; weakening
   validator rule 8 kills 4; deleting rule 9 kills 2. One mutation
   _survived_ — `allOperations !== true` → `!allOperations` — and that is
   correct rather than a gap: for any validated policy the two agree on
   every reachable input, because the runtime brand guarantees validated
   input. A surviving mutant is a question, not automatically a defect.

7. **A test whose fixture cannot reach the code it names proves nothing.**
   Three tests used `Object.create({ key })` to simulate an inherited
   property, but that fails `isPlainObject` and threw at ACT-1 long before
   any presence read. Two of the three were _passing vacuously_. Real
   `Object.prototype` pollution — cleaned up in a `finally` — is both the
   only fixture that reaches the code and the actual threat model.

8. **`pnpm lint` OOMs on a memory-constrained host at Node's default
   heap.** `NODE_OPTIONS=--max-old-space-size=6144` fixes it; lowering
   `--concurrency` does not, because the ceiling is per-process. Distinct
   from ADR-0080's parallel-fan-out contention.

9. **`pre-push` exceeds a 10-minute command ceiling.** It runs ~200–380s
   plus install and packing. Drive the push through a long-lived monitor
   rather than a bounded background command, or the push is killed with no
   output and looks like a failure it isn't.

## Follow-ups

- **`core/prompt` has the same read-shape.** `sensitiveTargets()` reads
  `spec.regions` / `spec.accountIds` by dot access, so
  `Object.prototype.regions = [...]` flips a graded safe mutation
  `auto-approved → escalate`. It **fails closed**, so it is not a defect
  and was deliberately not touched here — but it is F1/F2's shape living in
  an ADR-0048 module.
- **Slice 2** — budgets, rate caps, dry-run-first. The maintainer decided
  budgets gate **read-only** actions too (step 3 above step 4), departing
  from ADR-0060's unconditional tier sentence to close ADR-0025's
  "no token/cost governance of any kind" gap. Recorded normatively on the
  contract page.
