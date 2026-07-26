# Work log — `cloudformation-stacks` script (2026-07-27)

This log covers implementing the `cloudformation-stacks` consumer script
end-to-end in a single session, on branch `feat/cloudformation-stacks`. This is
**PR #2 of the two-PR chain** started in the previous session
(`docs/logs/2026-07-26-aws-cloudformation.md`, PR #232): the `aws/cloudformation`
wrapper unblocked this script's getter, and this session picked up exactly
where that one deferred. The pipeline ran `starting-work`, `scaffolding-scripts`
(via `pnpm scaffold:script`), then the full `implementing-scripts`
hub-and-spoke loop, closely mirroring `ecs-ops`'s own recent pipeline
(`docs/logs/2026-07-24-aws-ecs.md`'s script half). It records what shipped, the
contract-extraction pass's one blocking finding, the review fan-out's clean
convergence, and durable lessons for the next AWS-consumer script.

Plan of record: the plan mode session for this task (no separate
`docs/plans/*.md` file was written — the plan was approved via `ExitPlanMode`
directly into the conversation).

## Summary

Shipped `scripts/cloudformation-stacks/` — a 9-operation op-dispatch script
(`list-stacks`/`describe-stack`/`create-stack`/`update-stack`/`delete-stack`/
`describe-stack-events` + `wait-stack-create-complete`/`wait-stack-update-complete`/
`wait-stack-delete-complete`) over `AWS.M3LCloudFormationOperations`, never a
hand-constructed `@aws-sdk/client-cloudformation` client (ADR-0029). Files:
`src/{main,config,hooks}.ts` + `src/steps/{run-cloudformation-stacks,read-stacks,
read-stack-events,write-stack,wait-stack}.ts`.

- **Config**: 12 parameters (`aws.profile`, `operation`, `stackName`, `input`,
  `template`, `stackStatusFilter`, `retainResources`, `roleArn`, `nextToken`,
  `maxWaitTime`, `output`, `yes`). `stackName` sources from the flat parameter
  for every operation except `create-stack`/`update-stack`, which require it
  inside the parsed `input` JSON record instead (mirroring `ecs-ops`'s
  `cluster`/`service` split). An optional `template` file config populates
  `templateBody` when the `input` record sets neither template field.
- **Tests**: 120 in 7 files under `scripts/cloudformation-stacks/tests/` (up
  from the RED-phase 78 the test-author reported writing — the final
  hand-verified `vitest` run confirmed 120 passing, 7/7 files green). Full
  workspace suite: 4912 tests, all passing (up from 4792 before this session).
- **Gates**: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
  `pnpm format:check`, `pnpm check:script-scaffold`, `pnpm check:script-deps`,
  `pnpm knip`, `pnpm check:dup`, `pnpm lint:md`, `pnpm gen:index` +
  `pnpm check:index`, `/syncing-docs` (all 14 steps) — all green. Scripts are
  exempt from the 80% coverage gate and `check:exports` (publint/attw) —
  library-only gates, no `packages/m3l-common/**` change in this PR.
- **Review verdicts**: `code-reviewer` — PASS, 0 must-fix, 2 nits (unfilled
  README examples, closed in this session; a stylistic type-assertion left
  as-is). `security-reviewer` — PASS, 0 must-fix, 1 should-fix (see divergence
  below) + 4 nits (bounded/optional, none touching secrets or path safety).
  `silent-failure-hunter` — PASS, 0 findings. No fix round was needed for
  `src/**` — only the should-fix's filed-as-friction disposition and the
  README polish.
- **Docs**: full spec `docs/reference/scripts/cloudformation-stacks.md`
  (drafted before any code, then revised once by a contract-extraction pass).
  `docs/ROADMAP.md` W3 `cloudformation-stacks` row flipped To Do → Done;
  `docs/plans/IMPLEMENTATION.md`'s AWS getter reality table `cloudFormation`
  row's consuming-script cell flipped pending → done, and its W3 prose bullet
  updated to done with the op list and test count. New archived plan
  `docs/plans/archive/2026-07-27-aws-cloudformation-wrapper-and-cloudformation-stacks-script.md`
  covers both halves of the 2-PR chain retroactively, per the `s3`/`s3-objects`
  precedent.
- **No new runtime dependency** — the script's sole dependency stays
  `{"@m3l-automation/m3l-common": "workspace:*"}` (ADR-0029); no library change
  in this PR.

Skills used: `starting-work`, `scaffolding-scripts` (via `pnpm scaffold:script`),
`implementing-scripts`, `syncing-docs`, `writing-work-logs`.

Spoke incidents: none — no truncations, no stalls, no `SendMessage` resumes.
All five dispatched agents (1 contract-extraction, 1 test-author RED, 1
code-implementer GREEN, 3 parallel reviewers) completed cleanly in their first
dispatch.

## What went as planned

- **The contract-extraction pass earned its keep exactly once, precisely.**
  Unlike the wrapper's own contract-extraction pass (which caught a blocking
  contradiction plus 8 gaps), this one found exactly one blocking issue — an
  unspecified ordering between the `template`/`input` conflict check and the
  template-file read — and confirmed everything else (the `stackName` sourcing
  split, the `describeStack`-undefined classification, the waiter-dispatch
  mapping) as already internally consistent. A tighter, more scoped draft
  (informed by having just shipped the wrapper it depends on) produced a
  tighter set of findings.
- **RED failed for the right reason across all 7 files.** Four files failed
  with `Cannot find module` (step modules not yet implemented); `config.test.ts`
  failed on missing exports/parameters; `hooks.test.ts` failed with
  `getCorrelationId is not a function`; the dispatcher test failed because the
  placeholder step ignored all guard/gate/dispatch/persist logic. None failed
  on a test-logic bug.
- **GREEN was clean on the first pass.** `code-implementer` delivered a
  typecheck-clean, lint-clean, format-clean implementation reaching 120/120
  green with no re-dispatch needed, and reported zero test-vs-doc
  disagreements to resolve.
- **All three review spokes returned PASS with zero must-fix.** The 3-reviewer
  fan-out (code/security/silent-failure — no `type-design-analyzer`, since no
  public library types changed) surfaced only should-fix and nit-level
  findings, matching the `ecs-ops`/`s3-objects` precedent of a clean first
  implementation once the contract is settled up front.
- **The smoke run confirmed the composition root without needing real AWS
  credentials.** Running the built `dist/main.js` with no config produced the
  expected `configuration parameter 'aws.profile' is required` failure and
  exit 0 (not a crash) — proof the `M3LScript`/`Core.runScript` wiring is
  correct without needing a live AWS profile.

## What didn't go as planned, and why

### 1. A security finding surfaced a pre-existing fleet-wide gap this script didn't introduce, and routing it correctly required recognizing that

`security-reviewer` found that `Core.confirmDestructive`'s gate description —
built from operator-supplied record fields (e.g. a stack name) — is forwarded
to the terminal prompt with no control-character stripping, so a `stackName`
containing terminal escape sequences could visually rewrite what an operator
sees at confirmation time. The natural instinct was to patch
`buildRecordGateDescription` locally in this script. Checking first, though,
showed `scripts/ecs-ops/src/steps/run-ecs-ops.ts:321` has the byte-identical
helper with the identical exposure — this is a shared library-seam gap
(`M3LPrompt`/`confirmDestructive`), not something specific to
`cloudformation-stacks`.

**Why it happened:** A should-fix finding on a script's own file naturally
reads as "fix it here." It only becomes visible as fleet-wide friction once you
check whether the same code shape exists in a sibling script.

**Fix for future:** Before patching a should-fix finding locally, grep for the
same helper/pattern across other scripts in the fleet. If it's shared, file it
as library friction (this session added **F9** to
`docs/plans/IMPLEMENTATION.md`) rather than patching one script and leaving
the sibling exposed — patching locally would have given a false sense that the
gap was closed when it demonstrably wasn't.

## Lessons learned

- **A scoped, already-verified wrapper produces a scoped contract-extraction
  finding set.** Compare this session's single blocking finding against the
  wrapper's own contract-extraction pass (1 blocking + 8 gaps) — drafting a
  consumer-script contract against an already-shipped, already-reviewed
  wrapper API meant most of the hard behavioral questions (ValidationError
  classification, waiter defaults, optionality) were already settled and
  documented; the only genuinely new ambiguity was this script's own
  invention (the `template`/`input` conflict rule).
- **A should-fix finding on a script's own file is not automatically
  script-local — check the fleet before patching.** See divergence #1; filed
  as library friction **F9** in `docs/plans/IMPLEMENTATION.md` rather than
  patched per-script.
- **`stackName`-sourced-from-record-only for create/update, flat-config for
  everything else transferred cleanly from `ecs-ops`'s `cluster`/`service`
  split.** Reusing an established sibling script's parameter-sourcing pattern
  for an analogous "the mutating op's target lives in the record, the
  reads/deletes' target lives in flat config" shape needed no rediscovery —
  it's a shape general enough to expect on the next W3/W4 script too.
- **The 2-PR chain's archived-plan-written-once-at-PR-2 convention held up a
  third time.** Following the `s3`/`s3-objects` and `ecs`/`ecs-ops` precedent —
  write the archived narrative retroactively, covering both halves, only when
  the second PR lands — kept the archive from carrying a stale mid-chain
  snapshot the way a plan written at PR 1 would have.
