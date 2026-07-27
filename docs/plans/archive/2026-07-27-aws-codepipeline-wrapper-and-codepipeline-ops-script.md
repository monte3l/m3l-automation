# `aws/codepipeline` wrapper + `codepipeline-ops` script (2026-07-27)

**Status: shipped** — PR 1 (`feat/aws-codepipeline`, `aws/codepipeline`)
merged as [#251](https://github.com/monte3l/m3l-automation/pull/251); PR 2
(`feat/codepipeline-ops`, the consumer script) in this change set

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` + `docs/plans/
IMPLEMENTATION.md` to find the next unstarted fleet work. `codepipeline-ops`
(W3, the wave's last pending item) was To Do, blocked on the raw `codePipeline`
getter — the AWS getter reality table showed no `aws/codepipeline` wrapper
existed, so ADR-0027/ADR-0029 forbid the script from consuming the raw SDK
client directly. Scoped as a deliberate 2-PR chain (matching the `aws/ecs` +
`ecs-ops` and `aws/cloudformation` + `cloudformation-stacks` precedents): PR 1
ships the wrapper only; PR 2, in a later session, ships the script.

## Approach / Decisions

- **PR 1 — `aws/codepipeline` library submodule:** built via
  `scaffolding-submodules` (inline) → `implementing-submodules`. Full
  read+write declaration model: 12 methods on `M3LCodePipelineOperations`, 35
  exports total. Two design decisions made explicitly by the user: full
  read+write scope (not a reads-only v1), and including both
  `listPipelineExecutions`/`stopPipelineExecution` in scope. A
  contract-extraction pass caught 3 blocking doc gaps plus several
  partial-truths in the SDK exception lists before RED/GREEN started. A
  type-design review's must-fix — six unearned `as <SdkEnum>` casts on
  bidirectional write-path fields — was fixed with runtime validation
  (`assertKnownEnumValue`) rather than narrowing the public type, preserving
  the module's own enum-asymmetry rule (a closed union on a read path would
  make a future server value a type-level lie). A mandatory adversarial
  security refute pass found a real regression-lock gap: the two documented
  security omissions (`ActionExecution.token`,
  `PipelineExecution.variables`/`.artifactRevisions`) were previously asserted
  only via `expectTypeOf` against the declared interface, never against a
  runtime SDK response fixture — closed by adding the fields to two
  "fully populated" test fixtures and relying on `toEqual` to prove they're
  stripped. 119 tests, 100% coverage on `client.ts`. CI's gitleaks scan
  false-flagged a fixture value in an early commit; resolved via a
  `.gitleaksignore` fingerprint entry after a rename-only attempt failed
  (gitleaks scans the full PR commit range, not just the final tree). Full
  detail: `docs/logs/2026-07-27-aws-codepipeline.md`.
- **PR 2 — `codepipeline-ops` script:** built via `pnpm scaffold:script` →
  hand-authored implementation (see the divergence noted below) →
  `test-author` ×2 → 5-spoke review fan-out → fix round. Full 13-operation
  1:1 dispatch over the wrapper's 12 methods plus a script-owned
  `watch-execution` (no SDK waiter exists for CodePipeline). `pipeline`
  sources from a flat config parameter for every operation except
  `create-pipeline`/`update-pipeline`, which take the name from the parsed
  `input` declaration's own `name` field instead — mirroring `ecs-ops`'s
  `cluster`/`service` split and `cloudformation-stacks`'s `stackName` split.
  `create-pipeline`/`update-pipeline`/`delete-pipeline` are destructive-gated;
  `update-pipeline`'s gate description states the replace-not-patch risk
  explicitly (`UpdatePipeline` replaces the whole declaration and silently
  drops every field the wrapper doesn't model). `watch-execution` composes
  `Core.M3LPoller` around `getPipelineExecution` with a script-owned
  constant-delay policy, handling all seven `PipelineExecutionStatus` values
  explicitly — `Superseded` is logged as a warning and resolved as success
  (routine under CodePipeline's default execution mode), not misclassified as
  a failure the way a two-terminal-state CFN/ECS mental model would.
- **Process deviation: the hub wrote all `src/` implementation directly**,
  rather than dispatching a `code-implementer` spoke — a departure from
  CLAUDE.md's hub-and-spoke Agent Operating Model that no automated gate
  caught (`check:agents` validates spoke configuration, not who invoked what).
  Caught only on post-hoc review; flagged as the top lesson in
  `docs/logs/2026-07-27-scripts-codepipeline-ops.md` for the next session.
- **The `ecs-ops`-style single-switch dispatcher did not scale to 13
  operations.** A first-pass `dispatchOperation` (switch over a
  `DISPATCH_GROUP` table, mirroring `ecs-ops`'s 8-operation/4-family shape)
  blew ESLint's `max-lines-per-function`/`complexity` caps (ADR-0022 §2).
  Restructured into a two-function exhaustive type-predicate chain
  (`dispatchOperation` → `dispatchMutatingOperation`), where the second
  function needed a narrower parameter type
  (`Exclude<CodepipelineOperation, ...5 read ops>`) since TypeScript does not
  carry control-flow narrowing across a function-call boundary.
- **Full 5-spoke fan-out (2×`code-reviewer` split read/write, plus
  `spec-conformance-reviewer`/`security-reviewer`/`silent-failure-hunter`)
  plus a mandatory adversarial security refute pass** found: one HIGH
  must-fix (`watch-execution`'s `undefined`-branch silently polled with no
  log, and poll exhaustion carried no `pipeline`/`executionId` context —
  fixed); one must-fix doc drift (the contract page's `pipeline` "required
  for all but `list-pipelines`" claim was wrong for `create-pipeline`/
  `update-pipeline` — fixed); one code-review should-fix (a `FAILED_STATUSES`
  set independently duplicated in both `watch-execution.ts` and the
  dispatcher — fixed by exporting and sharing); one security should-fix (a
  `JSON.parse` `SyntaxError` chained as `cause` can leak up to ~10 characters
  of `input`-file content into a persisted run report) that the adversarial
  refute pass confirmed as real but corrected as bounded-severity and,
  critically, already present unfixed in three sibling scripts
  (`ecs-ops`/`cloudformation-stacks`/`lambda-ops`) — filed as fleet friction
  **F10** rather than patched per-script, mirroring F9's precedent from the
  `cloudformation-stacks` session.
- No rebase conflicts on PR 2 — `origin/main` had not advanced since PR 1
  merged.

## Outcome

`aws/codepipeline` (`M3LCodePipelineOperations`, 35 exports, ADR-0027)
shipped on `feat/aws-codepipeline`, merged as PR #251.
`codepipeline-ops` (13-operation op-dispatch script, 185 tests) shipped on
`feat/codepipeline-ops` in this change set, closing out W3 (6 of 6) in both
`docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md`, and the `codePipeline`
getter-reality row's consuming-script cell. Friction item **F10** filed
(P2, deferred — the fleet-wide `SyntaxError`-cause leak). See
`docs/logs/2026-07-27-aws-codepipeline.md` and
`docs/logs/2026-07-27-scripts-codepipeline-ops.md` for the full work logs.
