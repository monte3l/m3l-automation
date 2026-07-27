# Work log — `aws/codepipeline` submodule (2026-07-27)

This log covers shipping the `aws/codepipeline` operations wrapper —
`M3LCodePipelineOperations`, PR #1 of a two-PR chain unblocking the pending
`codepipeline-ops` consumer script (roadmap W3's last open item). The task
ran through the full `implementing-submodules` hub-and-spoke pipeline on
branch `feat/aws-codepipeline`: scaffold → contract review → RED → GREEN →
coverage-gap closure → 6-spoke review + mandatory adversarial security
refute → one fix round → doc sync → tracker close-out. It records what
shipped, what matched the plan, what diverged, and durable lessons for the
next AWS wrapper submodule (most immediately `aws/eks`, W4's remaining
Blocked item).

Plan of record: the plan-mode session for this task (no separate
`docs/plans/*.md` file was written — the plan was approved via `ExitPlanMode`
directly into the conversation, matching the `aws/ecs`/`aws/cloudformation`
precedent's third repetition of this convention).

## Summary

Shipped `M3LCodePipelineOperations` — 12 methods (`listPipelines`,
`getPipeline`, `getPipelineState`, `listPipelineExecutions`,
`getPipelineExecution`, `createPipeline`, `updatePipeline`, `deletePipeline`,
`startPipelineExecution`, `stopPipelineExecution`, `enableStageTransition`,
`disableStageTransition`), 35 exported symbols total (1 class, 1 error class,
29 plain types, 4 options interfaces), no waiter method (CodePipeline ships
no SDK-level `waitUntil*`). `M3LCodePipelineOperationError`'s
`ERR_CODEPIPELINE_OPERATION` registered in `M3L_ERROR_CODES`/
`M3L_ERROR_CATALOG`. No new runtime deps — `@aws-sdk/client-codepipeline` was
already a hard library dependency and `AWSClientProvider.codePipeline`
already existed.

119 tests in `codepipeline.test.ts`; `client.ts` at 100%
statements/branches/functions/lines; full workspace suite 5114 tests, all
green; `typecheck`/`lint`/`build`/`check:exports`/`check:doc-exports`/
`check:index`/`lint:md` all clean. Six commits on `feat/aws-codepipeline`:
scaffold, contract-review doc fixes, RED tests, GREEN implementation, one fix
round, doc-sync + tracker close-out. Not yet pushed or PR'd — that's the next
step.

Review verdicts (6-spoke fan-out, run in parallel, plus a mandatory
adversarial refute): `code-reviewer` A (reads/execution/transitions) — PASS,
no findings; `code-reviewer` B (declaration model + types) — PASS, 1
should-fix; `spec-conformance-reviewer` — conformant, 6 nits;
`security-reviewer` — PASS, 2 optional/fleet-wide nits;
`type-design-analyzer` — 1 must-fix, 3 should-fix (1 fixed, 2 left as
documented tradeoffs); `silent-failure-hunter` — PASS, 1 should-fix.
Adversarial `security-reviewer` refute pass — refutation failed, PASS
confirmed, but surfaced 1 real should-fix (a regression-lock gap, closed).
All must-fix/should-fix findings that required a code change were applied in
one fix round; nits and out-of-scope should-fixes are recorded below.

Skills used: `starting-work`, `scaffolding-submodules`, `syncing-docs`,
`writing-work-logs`. `implementing-submodules`'s pipeline was followed
manually (contract review → RED → GREEN → review fan-out → refute → fix)
rather than through the skill's own orchestration, since this session
composed the spokes directly.

Spoke incidents: 2 truncations (both `code-implementer` GREEN dispatches —
6a and 6b — returned abruptly-cut-off final summaries; verified directly via
`grep`/typecheck/lint/test rather than trusting the summary text, per this
repo's "trust but verify" standard) / 0 stalls / 0 resumes.

## What went as planned

- **The contract-extraction pass caught real gaps before RED/GREEN.** Front-
  loading three SDK facts (no waiters, modeled not-found exceptions, the
  `name`/`pipelineName` field-name split) into the `spec-conformance-reviewer`
  prompt and requiring it to verify each against `dist-types/` — rather than
  accept them — caught 3 blocking gaps (unspecified options-type fields, two
  unenumerated type field lists, unspecified absent-payload behavior) and
  several partial-truths in the per-method exception lists (e.g.
  `startPipelineExecution` can also throw `PipelineNotFoundException`;
  `stopPipelineExecution`'s not-found exception is `PipelineNotFoundException`,
  not `PipelineExecutionNotFoundException`) before a single test was written.
  This is the third submodule in a row (`aws/ecs`, `aws/cloudformation`, now
  `aws/codepipeline`) where this step paid for itself.
- **RED failed for the right reason.** Both test-author passes' failing tests
  rejected with the scaffold stub's `M3LCodePipelineOperationError("... not
yet implemented")`, not an import error or a test-file bug — confirmed by
  reading the actual Vitest failure output, not just trusting the spoke's
  self-report.
- **GREEN was clean on typecheck/lint on both passes.** Neither `code-
implementer` dispatch needed a lint/typecheck fix round; only the coverage
  gate needed a follow-up pass (see below), which is a coverage-authoring gap,
  not an implementation defect.
- **The 6-spoke review found only one blocking implementation issue** (the
  unearned enum casts) across two reviewers each covering roughly half the
  diff, a dedicated conformance pass, a dedicated security pass, a dedicated
  type-design pass, and a dedicated error-handling pass — a strong signal the
  contract-first RED/GREEN discipline is working as intended.
- **The adversarial refute pass justified its mandatory status again.** The
  first security pass was a clean PASS; the refute pass still found a real,
  fixable gap (see Divergence 2) by trying harder to break the claim rather
  than re-confirming it.

## What didn't go as planned, and why

### 1. Adding runtime enum validation broke the test file's SDK mock

Fixing the type-design-analyzer's must-fix (six unearned `as <SdkEnum>`
casts on write-path fields) required importing six SDK enum objects
(`ActionCategory`, `ActionOwner`, `ArtifactStoreType`, `EncryptionKeyType`,
`ExecutionMode`, `PipelineType`) as **values**, not just types, so
`Object.values(...)` could build the known-member sets `assertKnownEnumValue`
validates against. Moving them from the file's `import type {...}` block to
its regular `import {...}` block immediately broke every test:
`codepipeline.test.ts` reported `0 test` collected, because its top-level
`vi.mock("@aws-sdk/client-codepipeline", () => ({...}))` factory replaced the
whole module with an object that only provided the mocked command classes and
client — no `ActionCategory` etc. — so `Object.values(ActionCategory)` at
module-load time under the mock threw `Cannot read properties of undefined`
before a single test could even register.

**Why it happened:** The original mock factory was written when `client.ts`
only imported these six identifiers as types (erased at compile time, never
touching the mock). Adding a _runtime_ dependency on SDK-provided data
objects is a different kind of coupling than depending on SDK-provided
_classes_ (which the hoisted stub-class pattern already handles) — the
existing mocking convention had no precedent for "value export that's pure
data, not a class to stub."

**Fix for future:** Switch the mock factory to the async, `importOriginal`-
preserving form (`vi.mock("pkg", async (importOriginal) => { const actual =
await importOriginal<typeof PkgTypeNamespace>(); return { ...pickedRealValues,
...hoistedStubs }; })`) and pass through the real enum/constant objects
unchanged, keeping only the classes/functions that need mock behavior
replaced. `.claude/rules/tests.md` already documents this pattern for Node
built-ins (`fs`); this is the same pattern applied to an npm package with a
mixed class-and-data export surface — see the promoted addition below.

### 2. Branch coverage on `client.ts` regressed to 66.5% after GREEN, requiring a dedicated coverage-gap pass

Immediately after both GREEN passes landed, `pnpm test:coverage` failed the
80% branch-coverage gate at 66.54% for `client.ts` — statements 97/104,
functions 46/53, branches 179/269. Seven mapper functions (`mapActionExecution`
and its two split helpers, `mapActionState`, `mapTransitionState`,
`mapStageExecution`, `mapExecutionTrigger`) were **entirely unreached** —
0% — despite being correct and despite 102 tests passing. They're only
invoked via conditional spreads inside `mapStageState`/`mapExecution`/
`mapExecutionSummary` when a nested optional SDK field is present, and no RED
fixture happened to populate `stageStates[].actionStates[].latestExecution`,
`stageStates[].inboundTransitionState`, `stageStates[].latestExecution`, or
`.trigger` in a `getPipelineState`/`getPipelineExecution` success response.

**Why it happened:** Both `test-author` RED passes wrote fixtures that
exercised each field's presence _or_ absence, but not systematically enough
to guarantee every deeply-nested optional chain got a "populated" case
somewhere. A 12-method, 29-type contract has enough optional-field surface
area that a single test-author pass (even split into two) is more likely to
under-cover a nested field than a top-level one.

**Fix for future:** Treat the coverage-gap `test-author` pass as a **standing
fourth step** for any AWS wrapper module past a certain method/type count
(this is the third module in a row needing one — `aws/ecs` had a
`test-author coverage-gap` dispatch, `aws/cloudformation`'s doc records the
same pattern), not an exceptional recovery. Have the RED-phase dispatch
prompts explicitly require at least one "fully populated, every optional
field present" fixture per top-level method that returns a nested object
graph — not just "happy path + failure path" per field.

## Lessons learned

- **Mocking an SDK's mixed class-and-data export surface needs the
  `importOriginal`-preserving factory, not the plain object-literal
  factory.** A `vi.mock(pkg, () => ({...}))` object literal silently omits
  every export the factory doesn't list — fine when `client.ts` only imports
  types from `pkg`, a landmine the moment it starts importing a data constant
  as a value. Default to the async factory + `importOriginal` for any SDK
  package mock from the start, even if the current implementation only needs
  types — it costs nothing when unused and avoids this exact breakage on the
  next change. _(promoted → .claude/rules/tests.md)_
- **An unearned `as <ClosedUnion>` cast on a bidirectional type needs runtime
  validation, not type narrowing.** When a field is read via one method and
  written via another using the _same_ public type (here,
  `M3LCodePipelineDeclaration` serves both `getPipeline`'s result and
  `createPipeline`/`updatePipeline`'s input), narrowing it to the SDK's closed
  enum to "earn" the write-path cast reintroduces the read-path
  future-server-value lie the module's own enum-asymmetry rule exists to
  avoid. The fix is a runtime `assertKnownEnumValue`-style guard at the write
  boundary, keeping the public type `string` on both directions.
- **A regression-lock test needs a runtime fixture that actually carries the
  forbidden field, not just a type-level assertion against the declared
  interface.** `expectTypeOf<T>().not.toHaveProperty("secret")` only proves
  the _declared_ type is clean today — it says nothing about what a future
  `{ ...spread }` refactor of the _mapper_ would produce, since a spread
  expression is exempt from TypeScript's excess-property checking. Any
  "this field is deliberately never mapped" security claim needs a fixture
  where the mocked SDK response _includes_ the field, paired with a
  `toEqual`/`toStrictEqual` assertion on the resolved value — that's the only
  check that actually fails if a future mapper leaks it.
- **The mandatory adversarial refute pass is worth its cost even after a
  clean first pass.** This session's first `security-reviewer` run returned
  PASS with zero findings; the refute pass — explicitly told to try to
  disprove that verdict rather than re-confirm it — still surfaced the
  regression-lock gap above. A "PASS, so skip the refute" shortcut would have
  shipped a security claim that was true today but silently unverifiable
  tomorrow.
- **Sequential (not parallel) RED/GREEN dispatches on one file avoid
  concurrent-write collisions.** Both the RED test-authoring and the GREEN
  implementation were split into two halves (reads/execution/transitions vs.
  the declaration model) and run **sequentially**, each extending the file
  the prior pass left rather than both writing to the same file at once. This
  is the same seam used for `aws/cloudformation`'s RED split and continues to
  be the right call whenever two spokes must edit one shared file — a
  parallel dispatch would have needed a merge step this approach avoids
  entirely.
- **Budget a coverage-gap pass into every AWS wrapper module's plan, not just
  when the gate fails.** Three modules in a row (`ecs`, `cloudformation`, now
  `codepipeline`) have needed a dedicated coverage-gap `test-author` dispatch
  after GREEN. It is cheap (one focused dispatch, no source changes) and
  entirely predictable once a module crosses roughly ten methods /
  twenty-five types — scope it as a planned step, not a surprise fix round.
