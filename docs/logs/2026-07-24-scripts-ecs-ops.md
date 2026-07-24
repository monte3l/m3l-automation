# Work log — `ecs-ops` consumer script (2026-07-24)

This log covers scaffolding and implementing the `ecs-ops` consumer script
end-to-end in a single session, on branch `feat/ecs-ops`. This is **PR #2 of
a two-PR chain** unblocking roadmap item W3 `ecs-ops` — PR #1 (the `aws/ecs`
wrapper submodule, PR #224) merged earlier this same session. The pipeline
ran `scaffolding-scripts` followed by the full `implementing-scripts`
hub-and-spoke loop. It records what shipped, what matched the plan, one real
contract-resolution round, and durable lessons for the next AWS-ops script.

Plan of record: [`docs-roadmap-md-docs-plans-implementati-atomic-dream`](~/.claude/plans/docs-roadmap-md-docs-plans-implementati-atomic-dream.md)

## Summary

Shipped `scripts/ecs-ops/` (ADR-0022 shape) — a thin operations-dispatch
script over `AWS.M3LECSOperations`, dispatching 8 operations spanning ECS
**services** (list/describe/create/update/delete + `wait-services-stable`)
and read-only **cluster** context (list/describe).

- **Config**: 11 parameters in `src/config.ts`, plus `ECS_OPERATIONS` (a bare
  `as const` array, mirroring `lambda-ops`'s `LAMBDA_OPERATIONS` idiom).
- **Steps**: 6 modules — `run-ecs-ops` (dispatcher), `destructive-gate`,
  `read-services`, `write-service`, `wait-services`, `read-clusters`.
  `create-service`/`update-service`/`delete-service` are destructive-gated
  (bypassable via `yes`).
- **Error codes**: `ERR_ECS_OPS_CONFIG`, `ERR_ECS_OPS_ABORTED`,
  `ERR_ECS_OPS_WAIT_NOT_STABLE`, `ERR_ECS_OPS_NO_CORRELATION_ID`.
- **Tests**: 112 across 8 files + a `tests/support/ecsFakes.ts` fake
  `M3LECSOperations`. Full workspace suite: 4717 tests, all passing. Scripts
  are coverage-exempt (ADR-0022 §8).
- **Gates**: `typecheck`, `lint`, `test`, `build`, `check:script-scaffold`,
  `check:script-deps`, `knip`, `gen:index`/`check:index`, `lint:md` — all
  green.
- **Review verdicts**: `code-reviewer` — PASS, 0 must-fix, 2 non-blocking
  nits. `security-reviewer` — clean, 0 must-fix, 1 optional nit. Also ran
  `silent-failure-hunter` (steps carry try/catch, async, and the
  wait-services-stable poll path) — PASS, 0 must-fix. **No fix round
  needed** — unlike the `aws/ecs` wrapper PR (#224), which needed one.
- **Docs**: full spec `docs/reference/scripts/ecs-ops.md` written docs-first
  during scaffolding, then amended once to resolve 6 contract ambiguities
  (see below) before RED. `docs/plans/IMPLEMENTATION.md`'s AWS getter-reality
  `ecs` row flipped `To Do` → `Done`; the `ecs-ops` bullet `pending` → `done`.
  `docs/ROADMAP.md`'s W3 `ecs-ops` row `Blocked` → `Done`. The archived
  `aws/ecs` plan's status line and `docs/plans/README.md`'s archive row
  updated to record both PRs shipped, completing the chain.
- 4 commits on `feat/ecs-ops`: scaffold (`a89a7c3`), contract-ambiguity
  resolution (`80ea7e8`), RED+GREEN together (`9166b88`), tracker close-out
  (`9983e01`).

Skills used: `scaffolding-scripts`, `implementing-scripts`,
`writing-work-logs` (`starting-work` was run once at the top of the session,
covering both PR #1 and PR #2).

Spoke incidents: 2 truncations (both in the final wrap-up text of
`test-author` and `code-implementer`, not their substantive work) / 0 stalls
/ 0 `SendMessage` resumes.

## What went as planned

- **RED failed for the right reason across all 8 test files.** The 5 files
  testing not-yet-existing step modules failed with `Cannot find module`; the
  3 files testing already-scaffolded modules (`config.test.ts`,
  `hooks.test.ts`, `run-ecs-ops.test.ts`) failed on missing exports or
  unmet dispatcher behavior — never a logic error in the test itself.
- **GREEN was clean on the first pass.** `code-implementer` delivered a
  typecheck-clean, lint-clean implementation covering all 6 steps + config +
  hooks + main against the ratified contract, with all 112 tests passing on
  the first `pnpm --filter @m3l-automation/ecs-ops test` run after GREEN
  landed — no re-dispatch needed.
- **All 3 review spokes returned 0 must-fix and 0 should-fix.** The 3-way
  parallel review fan-out (code/security/silent-failure) surfaced only
  optional nits, all explicitly non-blocking and, in two cases, explicitly
  matching an intentional documented tradeoff (defensive exhaustiveness
  guards; no pre-flight validation on nested optional fields, mirroring the
  wrapper's own stance).
- **The persist-then-throw ordering for `wait-services-stable` held exactly
  as specified.** `silent-failure-hunter` independently confirmed the
  `output` write happens unconditionally before the
  `ERR_ECS_OPS_WAIT_NOT_STABLE` check, with no race and no swallow.
- **Security surface was clean on the first pass.** No hand-constructed SDK
  client, no path bypass of `M3LPaths`, no untrusted-input-influenced path or
  prototype-pollution vector, and the run-summary log carries only
  config-derived scalars — matching (in fact logging less than)
  `lambda-ops`'s established convention.

## What didn't go as planned, and why

### 1. A first-draft contract page had six real ambiguities, caught before RED

A `spec-conformance-reviewer` contract-extraction pass over the freshly
scaffolded `docs/reference/scripts/ecs-ops.md` surfaced six gaps that would
have let `test-author` and `code-implementer` guess divergently:

1. The "Validation" column conflated two distinct mechanisms — `config.ts`'s
   declarative `validate:` factories (which throw `M3LConfigValidationError`
   at config-load, and — confirmed by reading
   `M3LConfigParameter.getValueAsync` directly — only fire when a value is
   actually present) versus `run-ecs-ops.ts`'s own per-operation
   presence-only guard (`ERR_ECS_OPS_CONFIG`, absence only).
2. The doc said `write-service` "reads + parses `input`", contradicting both
   the doc's own "every step is a pure `deps -> result` function" principle
   and the `lambda-ops` precedent (`run-lambda-ops.ts`, not
   `write-function.ts`, does the file I/O). Resolved: `run-ecs-ops` reads and
   parses; `write-service` only narrows/validates the already-parsed record.
3. The destructive-gate description for `create-service`/`update-service`
   couldn't be built from `cluster`/`service` config values the way
   `delete-service`'s could — the target identity lives inside the `input`
   JSON file for those two operations, not a config parameter. Resolved: a
   best-effort, non-validating read of `record.serviceName`/`record.service`/
   `record.cluster`, falling back to a generic `"(see input file)"` phrase.
4. All 6 step deps-object/return-type signatures were entirely unstated in
   the first draft — ratified into a new "Step signatures" subsection.
5. The `services` comma-separated-string split semantics (trim, drop empty
   segments, throw if the result is empty) were unspecified.
6. Input-file read failure wasn't explicitly listed under the
   `ERR_ECS_OPS_CONFIG` bullet.

**Why it happened:** A hub-authored contract page written in one pass tends
to under-specify exactly the decisions two independently-dispatched spokes
would otherwise guess at differently — the same pattern already documented
in `implementing-scripts`'s `SKILL.md` from the `s3-objects` run.

**Fix for future:** Already covered by existing guidance (no new promotion
needed) — this run is the first confirmation that the
`implementing-submodules`-side "resolve contract ambiguity before RED, not
after" discipline (promoted after the `aws/ecs` wrapper PR, #224) generalizes
cleanly to the script pipeline too, whose `SKILL.md` already carries an
equivalent instruction. Continue running a contract-extraction pass on every
script's freshly-authored `docs/reference/scripts/*.md` page before RED,
especially for any script whose wrapper spans more than one resource type (as
`aws/ecs` does with services + clusters).

## Lessons learned

- **A hub-authored script contract needs the same pre-RED extraction pass a
  submodule contract does.** Six real, resolvable ambiguities surfaced from
  one `spec-conformance-reviewer` contract-mode pass over
  `docs/reference/scripts/ecs-ops.md`, all fixed in a single dedicated commit
  before `test-author`/`code-implementer` were dispatched. This confirms the
  existing `implementing-scripts` guidance rather than adding new guidance.

- **Never trust a spoke's final wrap-up text at face value, even when the
  substantive work is fine.** Both `test-author` and `code-implementer`
  returned a mid-thought fragment as their "final" message
  ("Now let's journal and run the tests." /
  "Let's also run a workspace-wide typecheck and test to be safe, and check
  knip."). In both cases, direct verification (`git status`, the spoke's own
  journal file, then re-running `typecheck`/`test`/`lint` myself) confirmed
  every file had actually been written and every test passed — no
  `SendMessage` resume was needed either time. The lesson is procedural
  discipline, not a defect: always verify on-disk state independently before
  treating a spoke's return as done, per the existing subagent-dispatch rule.

- **Split the destructive-gate's description-building rule by resource
  identity source, not by operation name.** When a script's operations span
  more than one config-parameter shape (here: `delete-service`'s identity is
  in config params, but `create-service`/`update-service`'s identity is
  inside an `input` file), the gate description logic needs an explicit,
  documented decision for each shape — don't assume every mutating operation
  can describe itself the same way.

- **`pnpm scaffold:script --purpose` rejects `/` characters.** A natural
  verb-list purpose string (`list/describe/create/...`) fails the
  generator's own validation ("purpose must not contain '/' — it can
  terminate the doc comment the purpose is emitted into"). Use commas
  instead for the next AWS-ops-style script scaffold.
  _(promoted → .claude/skills/scaffolding-scripts/SKILL.md)_

- **A predicted PR number is a best-effort placeholder, not a guarantee.**
  Writing `ecs-ops (done, PR #225)` into the trackers required knowing the PR
  number before `gh pr create` ran (so the trackers land inside the same PR
  they describe) — predicted via `gh pr list --state all --limit 3` against
  the highest existing number (#224). This holds only absent concurrent PR
  activity; verify the actual `gh pr create` output against the prediction
  before finalizing, and fix with a follow-up commit while the PR is still
  open if it's wrong.
