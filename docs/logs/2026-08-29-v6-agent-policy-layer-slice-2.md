# Work log — `core/agent` slice 2, budgets and dry-run-first (2026-08-29)

Successor to
[slice 1](./2026-08-29-v6-agent-policy-layer.md). Same issue (#543, V6,
ADR-0060), same submodule, same hub-and-spoke pipeline. This log covers the
second and final slice: per-run and per-day budgets, the dry-run-first
discipline, the declared cross-check on `kind`, and two security fixes the
review fan-out surfaced — one of them an authorization bypass.

## Summary

Four new exports (`M3LAgentBudgets`, `M3LAgentRunLedger`,
`M3L_AGENT_MAX_DRY_RUN_SHAPES`, `agentActionShapeKey`), taking the module
from 20 to **24**. Seven new `M3LAgentPolicyRuleId` members, taking it from
8 to **15**. No new submodule and no new `exports` subpath — Core stays at
25, the fleet at 45, and `check:api` did not move.

Step 3 compares declared ceilings against a caller-owned ledger; step 6
requires a mutating shape to have been dry-run in this run before it can
auto-approve. Both are **declaration opt-ins**, so a slice-1 policy reaches
exactly the arms slice 1 evaluated and gets the same verdict.

## What went as planned

- **The optional-`run` bet from slice 1 paid off.** `M3LAgentEvaluationOptions`
  was a single options bag specifically so slice 2 could add per-run state as
  an optional field. It did, and **no slice-1 call site changed** — the only
  churn in the two pre-existing test files was the rule-id list and the record
  fixtures.
- **The barrel absorbed four exports** with no `exports`-map change, exactly as
  ADR-0004 intends.
- **Budgets gate read-only actions**, per the maintainer decision recorded in
  slice 1's page: step 3 sits above step 4 because ADR-0025 records the repo
  has "no token/cost governance of any kind", and an unconditional read-only
  arm above the budget arm would leave an unbounded spend path open.

## What didn't go as planned, and why

### The contract had 19 gaps, and a reading-based reviewer found them

Slice 1's lesson was that reading is not review. Slice 2 inverted it: a
**read-only** `spec-conformance-reviewer` run against the freshly-written page
— before a single test existed — returned 19 defects in the _spec_. Four
would have produced working code with a wrong contract:

- **The ledger had a TOCTOU hole.** The page said the ledger was
  "caller-owned and immutable" and stopped there. But
  `dryRunCompletedShapes` is validated at step 0 and consulted at step 6, and
  nothing said the evaluator reads a _projection_ across that gap. This was
  written _after_ slice 1 fixed the same defect class (F5).
- **The shape key was not reproducible.** "Sorted" never said by which
  comparator — and `core/json` deliberately uses code-point order because
  `.sort()` uses UTF-16 code units. Since the page endorses seeding a ledger
  from a durable store, the key is a **stored value** and changing it is a
  breaking change. The page now pins the literal.
- **A claim that slice 2 added no required field**, immediately followed by
  adding one (`shapeKey`). It broke three of our own tests.
- **`readOnlyOperations` on an `allOperations` grant** was unspecified.

**Lesson: execution-based and reading-based review find different defect
classes.** Execution finds fail-open code. Careful reading finds
under-specified contracts. Slice 1 needed the first; the spec needed the
second. Neither substitutes for the other.

### A security probe found an authorization bypass

`security-reviewer`, probing built `dist/`, found that
`Object.prototype.toJSON = () => 0` collapses **every** `canonicalJsonHash`
digest to one value. Reproduced independently before acting:

```text
clean:    harmless=fac07ef1 dangerous=4987445a collide=false
          delete-table with only get-item dry-run -> escalate/dry-run-first
polluted: harmless=5feceb66 dangerous=5feceb66 collide=true
          delete-table with only get-item dry-run -> AUTO-APPROVED
```

A completed dry run of `get-item` auto-approved `delete-table` — different
script, operation and parameters.

**Root cause: hardening the module and routing its authorization token
through an unhardened primitive.** Slice 2 enforced `Object.hasOwn` on every
presence read and wrote into the page that this is "the rule the whole module
follows" — then pinned the shape key to `canonicalJsonHash`, whose `toJSON`
lookup walks the prototype chain. That is the one read in the path that is not
presence-checked.

The naive fix is a trap: `Object.hasOwn(value, "toJSON")` closes the hole and
breaks every `Date`, because `Date.prototype.toJSON` is inherited. The landed
fix resolves which prototype _owns_ the `toJSON` and ignores it only when that
owner is `Object.prototype` or `Array.prototype` — neither natively defines
one. Verified: clean-prototype hashes are **byte-identical** to pre-fix, so no
stored digest anywhere in the repo moved.

### A `length` trap defeated every list ceiling — including slice 1's

`Array.isArray` is `true` for a `Proxy` wrapping an array, and `value.length`
was read twice: once for the bound check, once per loop iteration. A trap
answering `1` then the real length projected **5,000 entries past a 256
ceiling**, producing a multi-megabyte frozen record bound for the ADR-0061
log.

The page claimed the indexed walk prevented this. That is true for a hostile
`Symbol.iterator` and false for a `length` trap. Fix: capture `length` once
and drive both the check and the walk from it. This was latent in **slice 1's**
`validation.ts`, so the review closed a pre-existing defect.

### Every spoke hit its 40-turn limit

Four of them — two RED authors, the GREEN implementer, and the silent-failure
reviewer. **The cause was brief sizing, not agent capability:** 41–45 numbered
contracts per RED author, a 7-file plan for GREEN. Nothing was lost (work
persists on disk and resumption continues from the same transcript), but it
cost four round-trips.

**Lesson: size a spoke brief to the turn budget, not to the work.** Split
GREEN by layer (types → validation → decision arms) rather than dispatching
the whole implementation at once.

### Two CI hazards that are invisible locally

Both cost a round on this slice, and neither is discoverable from the code.

**`check:review-size` diffs against the main tip, not the merge-base.** This
branch's true diff was 212,809 chars, comfortably inside the 300,000 ceiling.
CI computed **576,107** and rejected the PR, because `main` gained #741 while
the branch was open and every file that PR touched counted as a reversed
deletion. Slice 1 hit the identical failure against #737/#738.

The tell is the gate's own "largest contributors" list naming files the branch
never opened — here `bedrock-runtime-tools.test.ts`,
`bedrock-runtime-wire.test.ts`, `sessions-artifacts.test.ts`. **The gate's
remediation text actively misleads**: it says "Split it — docs vs. code", which
would mean carving up a correctly-sized PR to chase a phantom. The fix is
always `git rebase origin/main`, and the diagnosis is always comparing the
merge-base number against the main-tip number before touching anything.

**A rebase can silently drop entries from the generated reference index.**
Resolving `catalog.json` / `symbol-map.json` in main's favour dropped this
branch's four new symbols. Nothing a developer runs by reflex would notice: the
build passes, `tsc` passes, and all 11,805 tests pass, because those files are
documentation metadata rather than code. Only `check:index` and
`check:provenance` read them, and both source from the provenance sidecars, not
from `src/`.

The post-rewrite `regen` hook is what caught it. After any rebase that touches
a generated index, re-run the regen and diff before assuming the rebase was
clean.

## Lessons learned

1. **A guard documented on one module does not extend to the modules it
   calls.** Two of this slice's three security fixes were in _other_ modules
   (`core/json`, `core/prompt`) reached from `core/agent`'s authorization
   path.
2. **Fix a hashing primitive before it ships, not after.** The shape key is a
   normative stored value; had slice 2 merged and any deployment persisted
   keys, the `toJSON` fix would have been a major.
3. **A fix to a hash must prove existing digests did not move.** The
   byte-identical clean-prototype check is what made this safe to land.
4. **"Reject-above" and "reject-at" are different polarities and both are
   right.** Structural ceilings bound a thing that already exists (256 is
   fine). Budgets bound a run still going (10 of 10 spent means approving
   makes 11).
5. **A test fixture chosen because "this value doesn't exist yet" has a
   half-life.** `agent.test.ts` used `"budget.tokens-per-run"` as its
   not-a-real-id negative case; slice 2 made it real.

### Mutation testing found a decorative test that CI would have shown as green

The two security regressions are invisible under ordinary input — one needs a
function-valued prototype pollution, the other a lying `Proxy` — so a test that
asserts the right outcome without exercising the hostile path passes
identically. Both fixes landed _before_ their tests, so the tests had only ever
been observed green, which proves a test ran and nothing about whether it can
fail.

Mutating each guard and watching the suite:

| Mutation                               | Tests broken   |
| -------------------------------------- | -------------- |
| Revert `hasToJSON` hardening           | 6 (both files) |
| Revert `projectStringList` `length`    | **1**, not 2   |
| Revert `projectGrants` `scriptsLength` | **0**          |

The second row exposed
`"the same length-trap Proxy against run.dryRunCompletedShapes"` as decorative:
its `else` arm asserted `expect(decision?.verdict).toBeDefined()`, which is
unconditionally true, so a real bypass passed. _(promoted → .claude/rules/tests.md)_ The `parameterNames` sibling
works only because the record echoes the array back and there is a length to
assert. Rewritten to discriminate on the **verdict** instead — the action's real
`shapeKey` planted at index 4999 behind 256 junk entries, so an enforced bound
never finds it and escalates while a bypassed one auto-approves — plus an
unconditional `not.toBe("auto-approved")` outside both branches. Re-mutating now
fails it with `expected 'auto-approved' to be 'escalate'`.

The third row is an **accepted gap, recorded rather than fixed**: the `scripts`
(128) length-trap test does not discriminate `projectGrants`' single-read
capture, because an unconditional `scripts.length === 0` check runs first and
consumes the trap's lying answer, so the bound check reads the true length
either way. The capture stays (it is correct and consistent with
`projectStringList`), but nobody should read that test as proving it. Chasing it
was judged not worth it: a declaration is a preset the deployment authored,
not agent-supplied input, so a `Proxy`-valued `scripts` is a far less realistic
shape than a hostile ledger.

Failure sets were disjoint across all three mutations, so no guard's tests fire
for another's defect.

### The semver call went the other way on review

Slice 2 was planned as an additive minor. It is not additive: the required
`M3LAgentActionRecord.shapeKey` is source-breaking for anyone hand-building a
record, which is how it broke three in-repo tests. The first commit therefore
carried a `!` and a `BREAKING CHANGE` block.

The maintainer reversed that, and the precedent supports it: `core/script`
shipped a **required** `M3LScriptHookContext.dryRun` under an ADR semver
carve-out on exactly this reasoning — a library-built value that appears only
in return position, source-breaking only for in-repo test fakes, all fixed in
the same change set. `M3LAgentActionRecord` is the same shape: no exported
function accepts one, so no caller _value_ is invalidated.

What the carve-out does not cover, and what the release note must therefore
say, is the quieter half: serialized decisions changed shape, so a golden-file
or snapshot assertion over a decision — or over an ADR-0061 log line — breaks
at **test** time rather than compile time.

## Follow-ups

- ~~Split "budget exhausted" from "ledger not wired up".~~ **Done in this
  slice**, on the maintainer's call. Each of the five budget ids gained a
  `.unobservable` sibling (20 rule ids total), so a working budget and a broken
  integration are distinguishable at the only place a consumer may branch. The
  earlier draft collapsed them and named the cost honestly — "a stream of
  escalations is easy to stop reading" — without fixing it; naming a cost is
  not the same as paying it.
- **Seeding a ledger past 256 shapes** is a deployment policy the library
  declines to choose; documented, but a helper may be warranted before a
  durable store ships.
- **`M3LAgentScriptGrant` as a discriminated union** and
  `allOperations?: true` — both next-major only.
