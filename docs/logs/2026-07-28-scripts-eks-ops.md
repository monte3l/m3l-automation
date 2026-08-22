# Work log — `scripts/eks-ops` (2026-07-28)

This log covers implementing `eks-ops`, W4's third and final consumer script
(closing W4 at 3 of 3), through the `starting-work` → `scaffolding-scripts` →
`implementing-scripts` (TDD + hub-and-spoke) → `syncing-docs` pipeline. Its
library prerequisite — the `aws/eks` operations wrapper (`M3LEKSOperations`,
PR #254) — had already landed on `main` before this task started, so this was
PR 2 of the 2-PR chain: scaffold the script, write its contract page, implement
16 operations over the wrapper, and close a 3-reviewer fan-out including a
mandatory adversarial security probe (justified by a documented waiter
secret-leak surface).

Plan of record: written via Claude Code plan mode to a session-local plan
file outside this repository (not a checked-in artifact); its content is
reproduced in this log's Summary and the tracker updates below.

## Summary

Scaffolded `scripts/eks-ops/` (`pnpm scaffold:script`), wrote its contract page
(`docs/reference/scripts/eks-ops.md`) covering 16 operations (8 cluster + 8
nodegroup, each spanning list/describe/create/update-config/update-version/
delete/wait-active/wait-deleted), then ran the TDD pipeline: `test-author` (RED,
150 tests) → `code-implementer` (GREEN) → a `check:dup` (jscpd) threshold fix
round → the 3-reviewer fan-out (`code-reviewer`, `security-reviewer`,
`silent-failure-hunter`, all PASS/zero must-fix on the first pass) → a
should-fix fix round (5 items, 2 requiring new regression tests first) → a
follow-on `knip` cleanup. Final state: **203 tests**, `typecheck`/`build`/
`eslint`/`format:check`/`check:dup` (3.92%)/`knip`/`check:script-scaffold`/
`check:script-deps`/`check:agents` all clean; full-repo `pnpm test` (5606
tests), `pnpm lint`, `pnpm build`, `pnpm typecheck` all clean; `/syncing-docs`
passed all 14 steps (36/36 submodules, 528 symbols, 13 consumer scripts).
Tracker rows updated in `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md`
(W4 closed 3/3, `eks` getter-reality row flipped to cite the consuming script,
F10 row annotated with `eks-ops`'s deliberate non-replication).

Skills used: starting-work, syncing-docs, writing-work-logs (this log).
(`scaffolding-scripts`/`implementing-scripts` were followed as a manual
hub-and-spoke pipeline rather than invoked as named skills — the plan mode
gate had already produced the full execution plan before this session reached
the skill-dispatch point.)

Spoke incidents: 1 truncation (the first `code-implementer` GREEN-phase report
was visibly cut off mid-sentence; verified directly via `vitest`/`typecheck`
rather than trusting the report) / 0 stalls / 4 resumes (2 to test-author to
fix a test-authoring defect and then correct an over-broad leak-test
assertion; 2 to code-implementer to correct the persist-allowlist scope and
drop a leftover unused export).

## What went as planned

- **The scaffold + contract-page-first sequencing worked cleanly.**
  `pnpm scaffold:script eks-ops` emitted a conformant skeleton on the first
  try (`check:script-scaffold` passed immediately), and writing the full
  16-operation contract page before any implementation gave `test-author` an
  unambiguous, complete spec to write RED tests from — no back-and-forth was
  needed to clarify what a step should do.
- **RED failed for the right reason.** The initial 150-test suite failed with
  "cannot find module" / missing-export errors against the still-scaffolded
  stub `src/`, not a defect in the tests themselves.
- **The two-level exhaustive type-predicate dispatcher scaled to 16 operations
  without a single complexity/line-cap violation on the first implementation
  pass** — the `codepipeline-ops` precedent (documented in
  `.claude/rules/scripts.md`) generalized cleanly to twice the operation
  count by splitting on the natural cluster/nodegroup seam first, then
  read/write/wait within each half.
- **All three review spokes returned zero must-fix findings on the first
  pass**, including the security reviewer's empirical probes (planted
  `connectorConfig.activationCode`/`activationId` secrets through the waiter
  and update paths) confirming the documented secret-leak surface was
  genuinely closed on the log channel from the very first implementation.
- **The F10 deviation (deliberately not chaining a raw `JSON.parse`
  `SyntaxError` as `cause`) was implemented correctly on the first pass** and
  survived all three reviews without a single reviewer flagging its absence
  as a defect — the explicit "do not replicate this" framing in the
  implementer prompt worked.

## What didn't go as planned, and why

### 1. A combined `test.each` block asserted requirements that didn't match the documented contract

Two `test.each(["update-cluster-config", "update-cluster-version"])`-style
blocks (and their nodegroup equivalents) in the RED-phase suite supplied
`kubernetesVersion` to every iteration but never `input` — so the
`update-*-config` iteration hit `ERR_EKS_OPS_CONFIG` (missing required
`input`) before ever reaching the `status === "Failed"` assertion the test
was meant to exercise. This is because `update-cluster-config`/
`update-nodegroup-config` need `input` (the VPC-config/label-diff payload)
while `update-cluster-version`/`update-nodegroup-version` need
`kubernetesVersion` instead — two operations sharing a test-table but not a
required-field shape.

**Why it happened:** `test-author` combined structurally-similar operations
into one parameterized test without checking that both members of the pair
had identical config requirements per the contract page's "Required for"
column — an easy thing to miss when two operations look alike (`update-*`)
but differ in what they mutate (config vs. version).

**Fix for future:** When parameterizing a test across operations from a
documented per-operation requirement matrix, verify each parameterized value
shares the exact same required-field set before combining them into one
`test.each` — don't rely on surface-level naming similarity (`update-cluster-*`)
as a proxy for identical requirements.

### 2. A fix-round instruction was scoped too narrowly and created a self-contradicting pair of tests

The security review's persist-channel-allowlist finding was fixed literally
per the hub's first instruction — reduce a persisted `M3LEKSUpdate` to
`{status, errors}` only — which is correct for stripping an undeclared
"leaked" field, but also stripped `id`, a legitimate, non-secret, documented
field of `M3LEKSUpdate`. This broke 4 pre-existing "persist-then-throw" tests
that correctly expected `id` to survive, while the newly-added leak-regression
test (also written to the same over-narrow spec) expected it stripped — two
tests demanding contradictory persisted shapes for the same operation family.
`code-implementer` correctly flagged the conflict rather than forcing one
test to pass at the other's expense; the hub then corrected the allowlist
scope to the type's full declared field set (`{id, status, type, createdAt,
errors}`) and had `test-author` fix its own over-broad assertion, resolving
both sides.

**Why it happened:** The hub's fix-round prompt treated "allowlist" as "the
smallest plausible shape" instead of "the type's own documented shape minus
anything undeclared" — conflating "defense against an undeclared field" with
"minimize persisted fields," which are not the same goal.

**Fix for future:** When writing a fix-round prompt for an allowlist/scrub
security fix, specify the allowlist as _the target type's full documented
field set_ (name every field from its `types.ts` definition), not an
example subset — and cross-check that subset against any pre-existing test
that already asserts a specific field's presence before treating it as the
target shape.

### 3. A leftover unused export surfaced only via `knip`, after the src-level gates were already green

After removing a dead re-import (`readInputFileText as _readInputFileText`)
from the dispatcher during the fix round, the now-internal-only
`readInputFileText` function in `config-helpers.ts` kept its `export`
keyword — invisible to `typecheck`/`eslint`/`vitest`, since nothing external
needed to fail, but flagged by a whole-repo `pnpm knip` run as an unused
export.

**Why it happened:** Removing a consumer of an exported symbol doesn't
retroactively un-export the symbol; `export` is a property of the
declaration, not inferred from usage, so nothing at the package level
signals the staleness — only a repo-wide reachability tool does.

**Fix for future:** After removing the last external consumer of an exported
helper (not just deleting a dead import, but specifically dropping the last
_use_ of an export), run `pnpm knip` before considering a fix round done —
`typecheck`/`build`/`lint`/`test` at the package level cannot catch a
now-superfluous `export` keyword.

## Lessons learned

- **Combined `test.each` blocks need a shared-requirements check.** Before _(promoted → .claude/rules/tests.md)_
  parameterizing a test across multiple operation names, verify every member
  shares the same required-config-field set from the documented "Required
  for" matrix — naming similarity is not evidence of shared requirements.
- **An allowlist-style security fix should name the target's full documented
  type, not an example subset.** Specify "every field of `<Type>`'s own
  declaration" rather than a shorthand subset — a subset invites the
  implementer (correctly) to strip a legitimate field the rest of the suite
  already depends on.
- **Run `pnpm knip` as a standing step of any fix round that removes a
  consumer, not just at final close-out.** A dead import's removal can leave
  its target export orphaned; only a whole-repo reachability check catches
  that, and catching it mid-fix-round is cheaper than catching it at
  final-gate time.
- **Trust subagent reports as intent, not fact — always re-run the gates
  yourself.** The first GREEN-phase report was visibly truncated; verifying
  `vitest`/`typecheck` directly caught 2 genuinely failing tests the
  truncated summary implied were passing. This matches the existing
  "Subagent mid-turn truncation" lesson in
  `docs/contributing/agent-operating-model.md` — recording it again here
  because it recurred, not because it's new.
- **The hub-and-spoke split is easy to violate accidentally under plan-mode
  momentum.** Coming out of an extended planning phase, the natural next
  motion is to just start typing the config/main.ts files — caught and
  reverted here before any spoke was dispatched, but worth a conscious pause
  at the plan→execution handoff on every task, not just this one.
