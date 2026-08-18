# Work log — A2 target-graded destructive confirmation (2026-08-18)

This log covers item **A2** of the codified-procedure-engine wave (issue #469):
giving `Core.confirmDestructive` an optional target dimension so the fleet's
confirm-before-destroy gate grades on blast radius rather than only on how
dangerous the verb is. It ran through the hub-and-spoke TDD pipeline
(`starting-work` → spec-first docs → RED `test-author` spokes → GREEN
`code-implementer` spokes → four review spokes → `syncing-docs`). It records what
shipped, what matched the plan, what diverged, and the durable lessons — which
this time cluster almost entirely around **documented guarantees that the code did
not actually provide**.

This is the **library PR only**; the fleet retrofit of the 11 call-site scripts is
tracked as **A2b**, following the A1/A1b two-PR precedent.

Plan of record: [`docs/plans/2026-08-18-codified-procedure-engine.md`](../plans/2026-08-18-codified-procedure-engine.md)
(item A2). Decision: [ADR-0048](../adr/0048-target-graded-destructive-confirmation.md).

## Summary

Eight commits on `feat/target-graded-destructive-confirmation`:

| Commit    | Contents                                                  |
| --------- | --------------------------------------------------------- |
| `735f224` | Spec-first: 4 reference pages, no code                    |
| `66211a1` | `core/config` — `M3LConfigSchemaValidators.requires`      |
| `86423e0` | `core/prompt` — the target-graded gate                    |
| `92ed1a4` | `core/pipeline` — gate-phase forwarding                   |
| `6d4b629` | `core/prompt` — region optional + blank echo fails closed |
| `735dd11` | `core/script` — `M3LScript.awsTarget`                     |
| `799f284` | Review round: fail-open predicate + 4 doc over-claims     |
| `5e588ee` | Provenance/counts/tracker reconciliation                  |

**Public surface:** 5 new exported symbols — `M3LDestructiveTarget`,
`M3LDestructiveTargetPredicate`, `M3LSensitiveTargetSpec`, `sensitiveTargets`
(`core/prompt`) and `M3LConfigSchemaValidators` (`core/config`) — plus one class
accessor (`M3LScript.awsTarget`) and optional fields on two existing options
interfaces. All surface through the namespace barrels; the three-entry `exports`
map is untouched. **Additive minor.** Symbol count 621 → 626.

**Tests:** full suite **7925 passing** across 217 files (was 7869 at A1).
Per-module: prompt-destructive-target 59 (new file), pipeline 88, config 344,
script 290.

**Coverage:** clears every per-file threshold (lines 90 / functions 83 /
branches 80 / statements 89). `M3LDestructiveGate.ts` and
`M3LConfigSchemaValidator.ts` at 100% statements and 100% branches;
`M3LOperationPipeline.ts` 100% statements / 96.4% branches.

**Gates:** `pnpm verify` — **38 passed, 3 skipped**, including `check:zones`
(23 zones, none widened), `check:api` + `check:exports` (exports map unchanged),
`check:index` (626 symbols), `check:provenance` (41 sidecars), `check:test-counts`
(41 submodules), `lint:md` (242 files), `jscpd`, `knip`. All 13 `sync:docs` steps
pass.

**Review verdicts:**

- `security-reviewer` — **PASS**, 0 must-fix, 2 should-fix (both fixed). Verified
  all eight assigned claims **by executing probes against built `dist/`**.
- `type-design-analyzer` — 0 must-fix, 2 should-fix (1 deferred with rationale,
  1 declined), 4 nits. Additive-minor confirmed.
- `silent-failure-hunter` — 0 must-fix, 2 should-fix (both fixed). No path fails
  open.
- `spec-conformance-reviewer` — conformant, no symbol drift; 2 must-fix doc
  sentences + 4 doc nits (all fixed).

**Skills used:** starting-work, writing-commits, syncing-docs, writing-work-logs,
creating-prs.

**Spoke incidents:** 4 truncations / 0 stalls / 0 resumes / 0 API failures.

## What went as planned

- **Spec-first paid off again.** All four reference pages landed as the first
  commit and every RED spoke wrote its tests from them without a clarifying
  round — the same result A1 recorded.
- **The Plan agent was skipped deliberately, per A1's lesson.** ADR-0048 already
  pinned the contract, so the time went into targeted verification reads instead.
  Those reads are what found the `region`-required defect and the blank-echo hole
  before any spoke was dispatched for them.
- **RED failed for the right reasons, verified rather than trusted.** Failure
  causes were grouped from the hub every time: `sensitiveTargets is not a
function` ×10, `TS2724` for the missing config symbol, `TypeError … reading
'replace'` for the region-less banner. The gate's state-1/state-2 tests
  _passed_ in RED, which was itself the signal that the compatibility guarantee
  held.
- **No zone was widened.** Keeping the schema-validator factory in `core/config`
  meant `core/prompt` never needed a `core/config` edge, and `core/script →
core/prompt` already existed via `script.prompt`.
- **The `exports` map never moved**, and `check:api`/`check:exports` stayed green
  throughout.
- **An implementer refused to edit a test to fit its implementation.** Handed two
  contradictory type assertions, it stopped and reported instead of relaxing one —
  exactly the desired behaviour from that spoke.
- **The barrel↔sidecar trap was avoided.** The 5 new exports were hand-added to
  the sidecars' `sections[].sources[]` _before_ re-stamping, so `gen:index`
  produced a real diff (621 → 626) rather than the silent no-op A1 hit.

## What didn't go as planned, and why

### 1. Two parallel RED spokes wrote contradictory assertions in one file

Two `test-author` spokes were dispatched in parallel against the same contract.
The first pinned `M3LDestructiveTarget.region` as a required `string`; the second,
written after the contract changed, pinned it optional. Both landed in
`prompt-destructive-target.test.ts`, and `pnpm typecheck` then failed with
`TS2344` no matter what the implementation did. The GREEN implementer correctly
stopped rather than picking a side, and a third spoke reconciled the stale
assertion.

**Why it happened:** parallel RED on _disjoint files_ worked fine all session; the
failure came from two spokes touching the **same file's shared type** with no
knowledge of each other. The second spoke was told the new contract but the first
spoke's assertion was already on disk.

**Fix for future:** parallelise RED by file, never by concern within a file. When
a contract changes mid-run, re-dispatch the spoke that already pinned the old
shape rather than adding a second spoke alongside it.

### 2. Four documented guarantees did not match the code

This was the dominant defect class of the run, and none of it was caught by a
green gate:

- `M3LScript.awsTarget`'s TSDoc and reference page both asserted the biconditional
  `awsTarget === undefined ⟺ aws === undefined`. False in one direction:
  `provisionAws` still provisions on a declared-but-empty `aws.profile`, deferring
  to the SDK default credential chain, so `script.aws` is set while `awsTarget` is
  `undefined`. No test covered that case.
- `runEscalatedEcho`'s TSDoc claimed a whitespace-padded profile was "confirmable
  by typing it exactly". The comparison is `input.trim() !== token` — input
  trimmed, token not — so such a profile is confirmable by **no** input.
- `pipeline.md` said the bypass warning names the target "when one is supplied";
  only a _sensitive_ bypass names it.
- `prompt.md` attributed the typed echo to state 5 alone, when states 4 **and** 5
  both use `prompt.text`.

**Why it happened:** the docs were written first (correctly, per A1's lesson), the
contract then changed twice mid-implementation, and prose does not fail a gate.
Three of the four were written by the hub itself.

**Fix for future:** after the last contract change of a run, re-read every
sentence in the affected pages that states a guarantee, and check each against the
code rather than against the plan. `spec-conformance-reviewer` is the backstop
that catches the rest — dispatch it _after_ the final code change, never before.

### 3. The sensitivity check failed open

`deps.isSensitiveTarget?.(target) !== true` meant a predicate returning a truthy
non-`true` value (`1`, `"yes"`, `{}`) fell to the ungraded path, where `yes: true`
then bypassed outright — the exact direction ADR-0048's load-bearing clause
forbids. Reachable from an untyped JS consumer or a cast.

**Why it happened:** `=== true` was written as defensive strictness, and it _is_
correct for `yesSensitive` (where strict means "only an explicit opt-in bypasses").
Applied to the sensitivity verdict the polarity inverts: strictness there means
"anything unexpected is not sensitive", which is the unsafe default.

**Fix for future:** when hardening a boolean against untyped input, decide the
polarity from which direction is safe, not from a habit of strict equality. For a
guard, escalate on truthiness; for an opt-in, require strict `true`. The two are
deliberately asymmetric and the asymmetry now carries a comment saying so.

### 4. The type-design reviewer cleared the line the security reviewer failed

Both spokes read `isSensitiveTarget?.(target) !== true`. `type-design-analyzer`
called it "belt-and-braces… a stray falsy value degrades to state 2, not to an
unsafe bypass" — true, but it only considered _falsy_ returns.
`security-reviewer` executed probes against built `dist/` and found the truthy
case bypassing.

**Why it happened:** reading code answers "is this defensible?"; executing it
answers "what does it do?". A reviewer reasoning from the type signature assumes
the type holds, which is precisely what a defensive guard exists to doubt.

**Fix for future:** for a security-shaped guard, weight the reviewer that
executes over the reviewer that reads, and treat a "this is fine" on a defensive
comparison as unverified until something ran it.

### 5. A spoke invented a URL in shipped TSDoc

`core/pipeline/types.ts` acquired
`{@link https://m3l-automation.internal/core/prompt | confirmDestructive}` — a
host that does not exist. The repo convention is a bare `{@link}` or a backticked
relative path. Found incidentally by `type-design-analyzer` as an out-of-scope
aside, not by any gate.

**Why it happened:** nothing validates TSDoc link targets, and a plausible-looking
internal URL passes review by eye. A **pre-existing** instance of the same defect
sits on `main` at `core/errors/M3LOperationAbortedError.ts:12`
(`https://m3l-automation.github.io/...`), shipped by A1 and missed by its review.

**Fix for future:** grep new source for `http` before committing — the repo links
by relative path, so any URL in a TSDoc block is suspect. The `main` instance
needs a separate cleanup.

### 6. Two `A2` rows exist in IMPLEMENTATION.md

The tracker flip initially targeted the wrong row: `IMPLEMENTATION.md` carries an
`A2` in this wave's table _and_ an `A2` in the ADR-0035 rollout table
(`core/errors` origin/retryable). Selecting the first match hit the already-Done
rollout row. An assertion in the edit script caught it.

**Why it happened:** the item-id namespace is flat across every table in the file
— the same collision **F13** (#480) already tracks for `sync:hub`.

**Fix for future:** scope any tracker edit to the section heading first, then the
row id, and assert the current cell value before writing. Never select a row by id
alone in this file.

## Lessons learned

- **A documented guarantee is a claim to verify against the code, not prose to
  write.** Four separate over-claims shipped into commits this run — a false
  biconditional, a false whitespace property, and two mis-scoped statements — none
  caught by a gate, three written by the hub. After the last contract change,
  re-read every guarantee sentence against the implementation.
  _(promoted → .claude/rules/library-src.md)_

- **Parallelise RED spokes by file, never by concern within a file.** Two spokes
  on one file's shared type produced contradictory type assertions that no
  implementation could satisfy. Disjoint files parallelised cleanly all session.
  _(promoted → docs/contributing/subagent-context-management.md)_

- **Choose a guard's comparison polarity from which direction is safe.** `=== true`
  is right for an opt-in (only an explicit `true` bypasses) and wrong for a
  sensitivity verdict (anything unexpected must escalate, not downgrade). The same
  operator hardens one and breaks the other.
  _(promoted → .claude/rules/library-src.md)_

- **For a security-shaped guard, trust the reviewer that executes over the reviewer
  that reads.** Two spokes examined the same line; the one running probes against
  built `dist/` found a fail-open bypass the one reasoning from the type signature
  pronounced sound. This confirms the existing "Execute, do not read" rule in
  .claude/agents/security-reviewer.md rather than adding a new one — the rule was
  already right; this run is evidence of its value.

- **An implementer that stops on contradictory tests is working correctly.** Handed
  two irreconcilable assertions, the GREEN spoke reported instead of relaxing one.
  That refusal is worth more than a green gate — treat it as a signal to fix the
  tests, never as a spoke failure to work around.

- **Grep new source for `http` before committing.** A spoke invented an
  internal-looking URL in TSDoc; nothing validates link targets, and an identical
  defect from the previous wave is still on `main`. This repo links by relative
  path, so any URL is suspect.
  _(promoted → .claude/rules/library-src.md)_

- **Relax an over-strict field while the branch is still unpushed.** `region` was
  shipped required and made optional twenty minutes later; had it reached `main`,
  the majority of consumer scripts would have found grading silently unavailable
  and the fix would have been a semver event.

- **Scope a tracker edit by heading, then by row id, and assert before writing.**
  `IMPLEMENTATION.md`'s item ids are not unique across its tables — two `A2` rows
  exist — so an id-only selector silently edits the wrong wave.

- **A no-op `gen:index` right after adding an export means the sidecar is missing
  it.** Hand-adding the 5 new symbols to `sections[].sources[]` before re-stamping
  produced the expected 621 → 626 diff; `check:doc-exports` would have been green
  either way.

- **Truncation remains the default spoke failure mode, and verification remains
  cheap.** 4 of 11 dispatches stopped mid-turn on a narration fragment; every one
  had in fact completed its edits. Re-running the gates and `git diff --stat` from
  the hub distinguished finished from truncated every time, and cost seconds.
