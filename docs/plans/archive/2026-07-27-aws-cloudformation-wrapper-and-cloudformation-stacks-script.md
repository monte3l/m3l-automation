# `aws/cloudformation` wrapper + `cloudformation-stacks` script (2026-07-27)

**Status: shipped** — PR 1 (`feat/aws-cloudformation`, `aws/cloudformation`)
merged as [#232](https://github.com/monte3l/m3l-automation/pull/232); PR 2
(`feat/cloudformation-stacks`, the consumer script) in this change set

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` + `docs/plans/
IMPLEMENTATION.md` to find the next unstarted fleet work. `cloudformation-stacks`
(W3) was the next item, Blocked on the raw `cloudFormation` getter — the AWS
getter reality table showed no `aws/cloudformation` wrapper existed, so
ADR-0027/ADR-0029 forbid the script from consuming the raw SDK client directly.
The user scoped this as a deliberate 2-PR chain (matching the `aws/ecs` +
`ecs-ops` precedent): PR 1 ships the wrapper only; PR 2, in a later session,
ships the script.

## Approach / Decisions

- **PR 1 — `aws/cloudformation` library submodule:** built in the shared
  checkout on `feat/aws-cloudformation` via `scaffolding-submodules` (inline) →
  `implementing-submodules`. Scoped to v1 stack CRUD + stack-event streaming +
  the three stack-lifecycle waiters (9 methods on `M3LCloudFormationOperations`,
  19 exports total). Two design decisions were made explicitly by the user:
  the v1 operation surface (stack CRUD + events + waiters, not the larger
  change-sets-included scope), and classifying both of CloudFormation's
  unmodeled `ValidationError`s as data rather than errors —
  `describeStack`'s "does not exist" resolves `undefined`, `updateStack`'s
  "No updates are to be performed" resolves `{ changed: false }`. A
  contract-extraction pass caught a blocking contradiction (the doc falsely
  claimed a waiter's internal poll resolves a stack record) plus 8
  unspecified-behavior gaps before RED/GREEN started. A security-reviewer
  finding refuted an overclaimed data-isolation property: a waiter's `FAILURE`
  path chains the SDK's full `DescribeStacksCommand` response as `cause`,
  which the doc's "never surfaced to the caller" claim hadn't accounted for —
  fixed as a doc-only correction. 76 tests, 100% coverage on `client.ts`. Full
  detail: `docs/logs/2026-07-26-aws-cloudformation.md`.
- **PR 2 — `cloudformation-stacks` script:** built in the shared checkout on
  `feat/cloudformation-stacks` (branched fresh off `origin/main` after PR 1
  merged) via `scaffolding-scripts` → `implementing-scripts`. Nine-operation
  1:1 dispatch over the wrapper's 9 methods (`list-stacks`/`describe-stack`/
  `create-stack`/`update-stack`/`delete-stack`/`describe-stack-events` + the
  three `wait-stack-*-complete` operations), destructive gate covering the 3
  mutating operations. `stackName` sources from a flat config parameter for
  every operation except `create-stack`/`update-stack`, which require it
  inside the parsed `input` JSON record instead — mirroring `ecs-ops`'s
  `cluster`/`service` split. An optional `template` config parameter fills
  `templateBody` from a separate file when the `input` record sets neither
  template field, keeping multi-KB YAML out of a JSON string; a record that
  already sets one is a config conflict, checked **before** the template file
  is ever read.
- **Contract-extraction-before-RED caught one blocking ambiguity.** The
  drafted contract page described the template/input conflict check and the
  template-file read in the same sentence without stating their order —
  `spec-conformance-reviewer` flagged this as something two independent
  spokes (test-author, code-implementer) could resolve differently. Fixed by
  making the "check before read" ordering explicit, plus two smaller
  non-blocking clarity passes (splitting a dense check-then-persist sentence
  into per-family orderings, restoring an `ecs-ops`-precedent test-construction
  caveat).
- **Full 3-reviewer fan-out returned PASS with zero must-fix.** `code-reviewer`
  (2 nits: unfilled README examples, a stylistic type-assertion),
  `silent-failure-hunter` (zero findings — every check-then-persist ordering
  and cause-chain verified against the doc and its tests), and
  `security-reviewer` (1 should-fix + 4 nits) all converged clean. The
  should-fix — `Core.confirmDestructive`'s gate description forwarding
  external record fields into the terminal prompt with no control-character
  stripping — was confirmed to be a pre-existing fleet-wide exposure already
  present in `ecs-ops`'s identical `buildRecordGateDescription` helper, not a
  regression introduced here; filed as library friction **F9** rather than
  patched per-script, since the durable fix belongs in `M3LPrompt`/
  `confirmDestructive`.
- No rebase conflicts on PR 2 — `origin/main` had not advanced since PR 1
  merged.

## Outcome

`aws/cloudformation` (`M3LCloudFormationOperations`, 19 exports, ADR-0027)
shipped on `feat/aws-cloudformation`, merged as PR #232.
`cloudformation-stacks` (9-operation op-dispatch script, 120 tests) shipped on
`feat/cloudformation-stacks` in this change set, closing out the W3
`cloudformation-stacks` row in both `docs/ROADMAP.md` and `docs/plans/
IMPLEMENTATION.md`, and the `cloudFormation` getter-reality row's consuming
script cell. See `docs/logs/2026-07-26-aws-cloudformation.md` and
`docs/logs/2026-07-27-scripts-cloudformation-stacks.md` for the full work logs.
