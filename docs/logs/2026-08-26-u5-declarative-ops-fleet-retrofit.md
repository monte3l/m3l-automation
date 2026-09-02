# Work log — U5 declarative-operations fleet retrofit (2026-08-26)

This log covers **U5** (issue #529), the fleet half of ADR-0055: retrofitting all
13 selector-bearing consumer scripts from an opaque `oneOf` closure onto the
declarative operation model that landed in `core/config` at U4 (#666). It ran
through the hub-and-spoke model across three PRs by script cluster, and records
what shipped, what matched the plan, the twelve divergences worth remembering,
and the durable lessons — three of which were promoted into rules/agents in the
same change set.

Plan of record: [`docs/plans/2026-08-20-cli-evolution.md`](../plans/2026-08-20-cli-evolution.md)

## Summary

**Shipped:** 13 of 13 selector scripts now declare their operation sets as data.
Three PRs, all `patch` semver (consumer scripts only; no public library surface
touched, so `check:api` reports no change):

| PR                                                         | Cluster                   | Scripts                                                                                                                      | Reviewable diff |
| ---------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------- |
| [#672](https://github.com/monte3l/m3l-automation/pull/672) | pilot                     | `ecs-ops`, `eks-ops`, `lambda-ops`                                                                                           | 41,718 chars    |
| [#675](https://github.com/monte3l/m3l-automation/pull/675) | enforcing                 | `sqs-etl`, `cloudwatch-logs-analysis`, `sqs-dead-letter-triage`, `rds-data-sql`, `cloudformation-stacks`, `codepipeline-ops` | 95,378 chars    |
| [#676](https://github.com/monte3l/m3l-automation/pull/676) | declare-only + census fix | `dynamodb-crud`, `s3-objects`, `eventbridge-schedules`, `api-gateway-client` + both U5 tracker rows → `Done`                 | 44,574 chars    |

**Enforcement split (ADR-0055's opt-in clause).** 10 scripts adopted
`deriveOperationValidators`, deleting their duplicated helpers; 3
(`dynamodb-crud`, `s3-objects`, `eventbridge-schedules`) declare
`requiredParameters` documentarily and keep run-start guards. **Failure timing is
unchanged everywhere** — PR3 touches no `steps/` file at all, so every run-start
guard is byte-identical.

**Three constraints are not expressible as `requiredParameters`** and stayed
hand-written: `rds-data-sql`'s `sql` XOR `sql.file`, `eventbridge-schedules`'
`eventPattern` XOR `scheduleExpression`, and every `yesSensitive`⇒`yes` pair.

**Tests:** +47 (PR1), test updates + new coverage (PR2), +26 (PR3). Full suite
8788 passing, 229 files. New coverage per script: `getOperations()` round-trip
against a hand-authored table (never re-derived from src, so a src typo fails),
subset check, membership rejection, and — for the three declare-only scripts — an
opt-in regression guard asserting config load still enforces nothing.

**Gates:** `typecheck`, `lint`, `build`, `test`, `format:check`, `lint:md`,
`check:script-docs`, `check:script-scaffold`, `check:review-size`,
`check:tracker-status`, `check:tracker-coverage`, `sync:docs` (13/13) all green on
every PR, plus all 12 pre-push gates. `check:hub-drift` confirms #529 correctly
queued to close.

**Independent verification (hub-run, not spoke-reported).** The decisive check was
mechanical, not review-based: for all 13 scripts, the enforced
parameter→requiring-operations mapping was extracted by parsing `origin/main`'s
config and diffed against the declarations imported from the **built artifacts** —
identical sets and identical order everywhere, so every generated failure reason
is byte-identical. Separately, all 17 documentary declarations in PR3 were diffed
against the `REQUIRED_FIELDS` guard tables they document.

**Spoke verdicts:** PR1 — code-reviewer 7/7 invariants VERIFIED, 0 Must-fix;
silent-failure-hunter clean. PR2 — both clean, 0 Must-fix, 0 Should-fix. PR3 —
silent-failure-hunter 7/7 VERIFIED with no findings at any severity; code-reviewer
found **1 Must-fix and 2 Should-fix, all in docs I authored** (all fixed before
push).

Skills used: `starting-work`, `writing-work-logs`.

Spoke incidents: 7 truncations (3 writer, 4 review) / 0 stalls / 8 resumes.

## What went as planned

- **The canonical transform held across all 13 scripts.** The worked `ecs-ops`
  example in the plan needed no structural revision; PR2 and PR3 spokes were
  pointed at the landed PR1 file (`git show <branch>:…`) as their reference and
  reproduced it faithfully.
- **Order preservation worked exactly as the plan predicted.**
  `deriveOperationNames`' `const TName` kept every literal union intact, so the
  exhaustive `Record<Op, …>` dispatch tables, `accessor.oneOf(…)` calls, and
  `M3LOperationPipelineOptions.operations` all kept compiling with no change.
- **The three declare-only scripts' existing tests passed completely unchanged**
  — the strongest available evidence that documentary declaration moved nothing.
- **Splitting each PR's implementation across two parallel spokes over disjoint
  files** (PR2's 3+3) worked with no collision, and roughly halved wall-clock.
- **`rds-data-sql`'s duplicated operation list was eliminated** as scoped — the
  second copy in `steps/resolve-settings.ts` now imports the exported projection,
  with a test guarding the order so they cannot drift again.

## What didn't go as planned, and why

### 1. `pnpm build` was omitted from the implementer's gate list, and `as const satisfies` broke the build

PR1's spoke reported green on `typecheck`, `lint` and `test` — the three gates my
prompt listed. `pnpm build` then failed with `TS9010: Variable must have an
explicit type annotation` on both the declaration array (`as const satisfies
Core.M3LOperationDeclarationList`) and the `deriveOperationNames` projection. Fix:
plain `as const` plus an explicit `readonly [Name, ...(readonly Name[])]`
annotation built from a `(typeof DECLS)[number]["name"]` union.

**Why it happened:** `isolatedDeclarations` is set only in each
`scripts/*/tsconfig.build.json`, never in `tsconfig.base.json`, so `typecheck` and
`build` check structurally different things. My spec's gate list simply didn't
include `build`. Compounding it: this exact failure is already documented in
`.claude/rules/tests.md`, citing `2026-08-19-a3-partial-run-outcome.md` — but that
file is path-scoped to `**/tests/**`, so it never loads while editing
`scripts/*/src/config.ts`.

**Fix for future:** promoted into `.claude/rules/scripts.md` (which does load on
`scripts/**`) and into `.claude/agents/code-implementer.md` as a standing gate.

### 2. A "byte-identical output" proof was run against a stale `dist/`

I captured the pre-change CLI baseline on `main`, then reported the post-change
output as byte-identical — but the build in that same command had failed
(divergence 1), so I had executed the **old** compiled artifact. The proof was
worthless. Caught only because I inspected the build output rather than the
diff result. Redone against a from-scratch rebuild, where it genuinely was
byte-identical.

**Why it happened:** the build and the binary invocation were chained in one
command block and I read the `diff` result without checking the build's exit
status first.

**Fix for future:** when a verification depends on a build, assert the build
succeeded as its own visible step before running the artifact — and prefer
`rm -rf dist` first so a stale artifact cannot silently answer.

### 3. The plan's census misclassified `api-gateway-client`

The plan listed it under PR3 with "**none** — no per-op enforcement". It in fact
enforces `path` for `command: request` and `input` for `command: batch` through a
wired `configValidators`. Under confirmed decision #1 — adopt wherever config-load
enforcement already exists — it therefore had to adopt the derived validators, not
merely declare. Its `auth`-keyed `requiredWhenEquals` pair stayed hand-written
because `auth` is a plain enum, not an operation selector.

**Why it happened:** the census classified by cluster/eyeball rather than by
checking whether `main.ts` actually wires `validate: configValidators`.

**Fix for future:** the `.claude/rules/scripts.md` rule "a `configValidators`
array being exported proves nothing about whether it's enforced — grep `main.ts`
for `validate:`" already exists and is exactly right; it needed applying to the
census, not just to review. Re-derive an authored census before generating code
from it.

### 4. Two scripts' validator emission order changed observably

The plan flagged emission order as a per-script check and named `eks-ops`,
`codepipeline-ops` and `rds-data-sql` as needing re-derivation. Re-deriving found
the change in a different pair: `eks-ops` (for `create-nodegroup`/
`update-nodegroup-config`, with both `nodegroup` and `input` missing, the reported
parameter flips from `'nodegroup'` to `'input'`) and `sqs-etl` (`transform` with
both `input` and `output` missing reports `'output'` instead of `'input'`).
`codepipeline-ops` turned out to have **no** observable change, because its only
reordered parameter is required by two operations that require nothing else.

**Why it happened:** `deriveOperationValidators` emits in first-encounter order
while walking operations in declaration order, which cannot be reordered without
changing the public operation list. It is observable only when two required
parameters are absent simultaneously.

**Fix for future:** the check is per-(script × operation), not per-script — for
each operation with ≥2 required parameters, compare the derived and hand-written
relative order. I proved the `eks-ops` case empirically rather than by argument,
which is what settled a reviewer's incorrect claim that it was unobservable.

### 5. `cloudwatch-logs-analysis` had a hidden `?? "analyze"` fallback

Its deleted `readOperation()` did `ANALYSIS_OPERATIONS.find(...) ?? "analyze"`,
enforcing `analyze`'s requirements for an **absent or unrecognised** operation.
The derived validator vacuously passes on a non-string selector. Both cases turned
out still covered — absent via the declared `defaultValue: "analyze"` that the
loader resolves before validators run (verified end-to-end against the built
script), unrecognised via the parameter-level membership check that runs inside
`resolveAsync` before anything is stored. But one existing test broke, because it
built `M3LConfig` directly and so bypassed default resolution.

**Why it happened:** the fallback was an implementation detail of a helper being
deleted, invisible from the config declaration and from the reference page.

**Fix for future:** when deleting a per-operation helper, read its **whole body**
for coercions and `??` fallbacks, not just the requirement table it consults.

### 6. Two scripts silently narrowed empty-string handling

`cloudwatch-logs-analysis` and `sqs-dead-letter-triage` treated `""` as missing
(`typeof v !== "string" || v.length === 0`); the derived validator only checks
`!== undefined`. Verified unobservable in practice — every parameter in both
requirement tables independently rejects `""` (`nonEmpty`, or in `rds-data-sql`'s
case an identifier regex) and per-parameter validation runs before the schema
validators. Observable only in direct-`M3LConfig` unit tests.

**Why it happened:** the library's derived check is presence-only by design; the
hand-written ones were stricter.

**Fix for future:** the silent-failure-hunter's framing is the durable one — this
is currently _masked_, not _absent_. A future operation naming a parameter without
an empty-rejecting validator reopens it. Worth a TSDoc warning on
`deriveOperationValidators` (noted in PR2's body as a library-side follow-up).

### 7. A scripted README rewrite clobbered a whole section

My PR2 README rewrite replaced everything between `### Operations at a glance`
and `### Operational flags`. In `cloudwatch-logs-analysis` a third section —
`### Trying it against the shipped examples`, carrying runnable examples — sat
between them and was destroyed. Caught by `check:script-scaffold`, not by me.
Restored from `origin/main`; I then diffed heading lists across all nine
rewritten READMEs to confirm only that one was hit.

**Why it happened:** the script assumed it knew which heading followed the table.

**Fix for future:** a scripted section replacement must locate the **next heading
of any level** by regex, never a named one. PR3's version did this and was clean.

### 8. A declaration reference was written into the wrong table column

I inserted `operations: TRIAGE_OPERATION_DECLARATIONS` into what I assumed was
`sqs-dead-letter-triage`'s `Validation` column. That table has no `Validation`
column — its fourth column is `Required for`, and a selector is not "required
for" anything. Moved to `Notes`; I then verified column-by-column that the other
eight insertions landed in a real `Validation` column.

**Why it happened:** the edit targeted "wherever `oneOf(...)` appears", which is
the `Validation` cell in 8 of 9 pages but a cell that didn't exist in the ninth,
whose selector row had `—`.

**Fix for future:** when scripting a table-cell edit across many docs, read each
table's **header row** and assert the target column exists and is named as
expected before writing.

### 9. A doc claim was true only after a sibling PR merged

PR3's `dynamodb-crud.md` said "Contrast `ecs-ops`/`lambda-ops`, which
additionally adopt the derived validators" — false on `main` until PR1 merges.
Caught by the PR3 code-reviewer. My own spot-check had _missed_ it, because my
`grep -c "operations:"` matched a function parameter named `operations` and I read
the non-zero count as evidence the retrofit was present. Rewritten to state the
ADR's rule without asserting any sibling script's current state.

**Why it happened:** writing docs for the end state of a multi-PR wave while
sitting on the first of those PRs to be authored but the last to merge.

**Fix for future:** in a multi-PR wave, keep each PR's docs true of _that PR's_
merge state — describe the rule, not the sibling. And when spot-checking with
`grep -c`, look at the matched lines, not just the count.

### 10. Four review spokes burned their entire turn budget re-running gates

Every code-reviewer dispatched (and one silent-failure-hunter) hit its 40-turn
limit. The first returned literally "Lint is clean. Now let's run the tests." —
no review at all. Each had to be recovered with a `SendMessage` asking for
findings only. Later prompts added an explicit "DO NOT run the test suite — I
already ran it, spend every turn reading" plus a turn-budget target, which
improved but did not eliminate it.

**Why it happened:** the reviewer prompt didn't forbid re-verification, and
re-running a multi-minute suite is an attractive first move for a spoke that
wants to ground itself.

**Fix for future:** promoted into `.claude/agents/code-reviewer.md` — don't
re-run gates the hub already ran; report partial results with per-item
VERIFIED/NOT-CHECKED verdicts when low on budget.

### 11. `origin/main` moved three times mid-session, and a reviewer misread the staleness as a revert

`main` advanced from `2194bf3` → `c4c3668` → `37593ff` → `8a885bd` → `04c15ea`
while this work was in flight. Two consequences: a pre-existing `sync:docs`
failure I had diagnosed and confirmed on pristine `main` was fixed upstream by
`c4c3668` and vanished on rebase; and the PR3 silent-failure auditor, reading
`git diff origin/main` from a branch one commit behind, reported a "full clean
revert of U8's `m3l-cli` feature" — an artifact, since GitHub diffs from the
merge base.

**Why it happened:** a shared checkout on an actively-moving `main`, plus
reviewers using `git diff origin/main` rather than a merge-base diff.

**Fix for future:** `git fetch` and rebase immediately before dispatching a
reviewer, and tell the reviewer to diff against the **merge base**
(`git diff $(git merge-base HEAD origin/main)`) so branch staleness cannot
masquerade as a change.

### 12. `pnpm knip` failed CI on both open PRs — a test-brief instruction stranded six exports

After PR1 merged, #675 and #676 both failed CI's Governance-gates lane on
`pnpm knip`: six unused exports in #675 (every PR2 declaration list) and one
in #676 (`S3_OBJECTS_OPERATION_DECLARATIONS`). The declarations are exported from
`src/config.ts` but had no consumer, so knip's static-reachability check flagged
them. Fixed by importing each declaration in its test and asserting projection
identity — the shape merged PR1 already uses — keeping the hand-authored tables
untouched.

**Why it happened:** my PR2/PR3 test briefs said to assert `requiredParameters`
against a table "hand-authored… **NOT** re-derived from the src export". That is
the right instruction on its own terms — it makes the test catch a `src` typo
rather than echo it — but the test file was the export's _only_ consumer, so the
instruction silently orphaned it. PR1's brief said the opposite ("`toEqual`
against the file's `*_OPERATION_DECLARATIONS` export"), which is exactly why PR1
passed and the other two didn't. `knip` is CI-only, absent from `pre-push`, so
all 12 local gates were green on both PRs. `.claude/rules/scripts.md` already
carries the rule ("knip fails … a consumer-less export — re-run `pnpm knip`");
I read it this session and still didn't run it.

**Fix for future:** keep both assertions — import the declaration for projection
identity _and_ hand-author the table for content. And treat `pnpm knip` as a
manual gate after any change that adds, removes, or orphans an export, because
no local hook runs it.

## Lessons learned

- **A test-authoring instruction can break a gate two lanes away.** Telling a
  test author not to import from `src` (so the test catches a typo instead of
  echoing it) orphaned six exports and failed `pnpm knip` on two PRs. Keep both
  assertions: import the export for projection identity, hand-author the table
  for content. And run `pnpm knip` manually — it is CI-only, so `pre-push` green
  means nothing for it. _(promoted → .claude/rules/tests.md)_
- **A rule in a path-scoped file only fires on that path.** The
  `build`-vs-`typecheck` / `as const satisfies` trap was already documented in
  `.claude/rules/tests.md` with a prior log cited — and recurred anyway, because
  that file doesn't load when editing `scripts/*/src/**`. When a lesson bites in a
  new path, the fix is to place it where that path loads it, not to write it down
  again. _(promoted → .claude/rules/scripts.md)_
- **Give writer spokes the whole gate set, including `pnpm build`.** Three of four
  gates green is not green. _(promoted → .claude/agents/code-implementer.md)_
- **Tell review spokes not to re-verify, and to report partial results honestly.**
  A reviewer that spends 40 turns re-running a suite the hub already ran returns
  nothing; one that reports "items 1–6 verified, 7–8 not reached" lets the hub
  re-dispatch precisely. _(promoted → .claude/agents/code-reviewer.md)_
- **Mechanical equivalence beats reviewed equivalence for a behaviour-preserving
  refactor.** Parsing the old requirement constants and diffing them against the
  declarations imported from the built artifacts settled the central question for
  all 13 scripts in one command, found the two real ordering changes, and was the
  evidence that overrode a reviewer's incorrect "unobservable" claim. Reviews
  found doc errors; the script found behaviour facts. Use both, for what each is
  good at.
- **Prove a behavioural claim, don't argue it.** Both times a claim about which
  parameter a validator names first was contested, running the validator settled
  it in one command. The same discipline caught the stale-`dist` proof.
- **Check the build succeeded before trusting anything it produced.** A failed
  build leaves the previous artifact in place, and every downstream assertion then
  describes the old code.
- **A scripted multi-file doc edit needs a structural precondition, not a
  positional guess.** Assuming which heading follows a section destroyed one;
  assuming a column exists put content in the wrong one. Assert the structure
  (next heading of any level; header row names the target column) before writing.
- **In a multi-PR wave, each PR's docs must be true at that PR's merge state.**
  Describe the rule, not the sibling script — a forward reference is a latent
  falsehood on `main` and its truth depends on merge order.
- **When deleting a helper, read its body, not just the table it reads.** A
  `?? "default"` coercion hidden inside a doomed function is invisible from the
  config declaration and the contract page.
- **"Masked" is not "absent".** The empty-string narrowing is currently harmless
  only because every affected parameter happens to carry `nonEmpty`. Recording it
  as masked-with-a-condition, rather than as a non-issue, is what makes the future
  regression findable.
- **Rebase before dispatching a reviewer on a moving `main`.** Branch staleness
  reads as a revert in `git diff origin/main` and will send a spoke chasing
  someone else's feature.

## Follow-ups surfaced (not yet filed)

Neither of these is a tracker row yet — **a follow-up that lives only in a work
log does not exist**, so both need filing (and `pnpm sync:hub`) before they count:

1. **`deriveOperationValidators` presence-only check.** It tests
   `!== undefined`, not emptiness. Safe across all 13 scripts today only because
   every named parameter independently rejects `""`. A future operation naming a
   parameter without an empty-rejecting validator reopens the gap silently.
   Call-site: any `scripts/*/src/config.ts` `requiredParameters` entry. Additive
   (TSDoc warning, or a `check:*` assertion).
2. **`M3LOperationDeclaration`'s TSDoc recommends `as const satisfies`** as _the_
   declaration idiom, with no `isolatedDeclarations` caveat — the exact form that
   fails `TS9010` in every `scripts/**` consumer. It will walk the next script
   author into divergence 1. Call-site:
   `packages/m3l-common/src/core/config/M3LOperationDeclaration.ts:57-69`.

## Adjacent state observed, deliberately not changed

**#532 (U8) appears prematurely closed.** `check:hub-drift` reports it as
closed-by-merged-PR with an unresolved tracker row, and suggests flipping U8's
Status to `Done`. PR #674's own body states it delivered only the `m3l inspect`
half and that "a second PR (wizard operation-scoping, the remaining half of U8)
follows separately" — so `Done` would over-claim. Surfaced to the maintainer, who
chose to leave it; U5's rows were flipped and U8's were not. This blocks a clean
`check:hub-drift` until #532 is reopened or U8's second PR lands.
