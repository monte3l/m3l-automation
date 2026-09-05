# Work log — `x11b-console-session-views` (2026-09-03)

This log covers X11 slice 2 (issue #559): the console web app's session
drill-down view layer, built in the `feat/x11b-console-session-views`
worktree/branch and shipped as PR #958. It records what shipped, a review
finding that turned out to be a false positive and why, three real findings
that got fixed, and a CI-only gate failure caught after push. Plan of record:
the external X11 plan at `~/.claude/plans/on-issue-559-floating-liskov.md`
(not a `docs/plans/` file, so not linked as one here); its slice 2 section
scoped this task, corrected mid-session against the actual server contract.

## Summary

Shipped: `packages/m3l-console-web/src/api/sessions.ts` (new — session/step/
decision types and fetchers), `src/routing/useHashRoute.ts` (extended with
`sessions`/`session` routes), `src/components/SessionList.tsx` and
`SessionDetail.tsx` (new), `src/components/AppShell.tsx` and `src/App.tsx`
(wired). 21 test files / 343 tests in `packages/m3l-console-web`, all
passing. Full `pnpm verify` (pre-push) green: build-exports, checks, format,
lint, test, typecheck.

Built through two TDD passes (RED via `test-author`, GREEN via
`code-implementer`): first the API client + routing layer, then the UI
components + App/AppShell wiring — split specifically to keep each spoke's
turn budget bounded after a prior dispatch on this same task (PR #946,
logged separately) hit its 40-turn limit.

Review fan-out after GREEN: `code-reviewer` (Pass, 0 must-fix, 3 nits),
`spec-conformance-reviewer` (Conformant, 0 must-fix), `type-design-analyzer`
(2 claimed must-fix, 1 real, 1 disproven — see below), `silent-failure-hunter`
(0 must-fix, 1 should-fix). Three real findings were fixed via their own
RED/GREEN round: a missing `resultRef?: never` type-level redaction ban, two
`?: never` discriminated-union guards that never verified the forbidden
field's absence, and a missing unmount guard on the "New session" create
handler.

Post-push, CI's `pnpm knip` gate (not part of `pre-push`) failed on three
newly-added exported types with no external consumer; fixed and re-pushed,
confirmed green before merge.

Skills used: `starting-work` (session start, not directly re-invoked mid-task
since the decision gate was already settled from the prior PR #946 work in
the same worktree), `triaging-ci`, `finishing-work`, `writing-work-logs`.

Spoke incidents: none (no truncations, stalls, or `SendMessage` resumes
during this slice's dispatches — distinct from the PR #946 work earlier in
this same session/worktree, which did hit a fork-vs-resume mistake, logged
separately in `2026-09-03-x11a2-session-steps-decisions.md`).

Compaction events: 1 compaction (automatic, mid-session) / 1 recovered via
handoff — the resumed session picked up the correct branch and last-commit
state with no observed loss.

## What went as planned

- **Both TDD passes were clean on the first GREEN.** Neither the API/routing
  pass nor the UI pass needed a second `code-implementer` dispatch — typecheck,
  the full `vitest.web.config.ts` suite, lint, and format all passed on the
  first submission each time.
- **The file-budget risk was designed out up front**, not discovered late.
  Knowing from the console-server's own PR #946 that a single `sessions.ts`
  covering session + step + decision resources could approach the 25,000-char
  ceiling, the scope was narrowed before writing the contract: bindings and
  artifact-reading were deferred to slices 3/4 (matching the console server
  doc's own scope note that the tree viewer, prefill, and decisions remain
  X11's later slices). `sessions.ts` landed at 14,432 chars — well clear.
- **The review fan-out caught real, independent findings** across three of
  four spokes with no overlap — a healthy signal that dispatching all four in
  parallel (rather than picking one or two per changed file) was worth the
  cost here.
- **`check:review-size`'s soft-target warning (96,153 of 75,000 chars) was
  handled as the skill intends**: evaluated against ADR-0072's split axes,
  judged genuinely unsplittable (the API layer has no caller without the
  components; the components don't compile without the API layer), and
  recorded as a rationale in the PR body rather than forced into an
  artificial split.

## What didn't go as planned, and why

### 1. A review spoke's "Must-fix" finding was internally inconsistent with a fact already established earlier in the same session

`type-design-analyzer` flagged the step/decision nullable-field typing as a
Must-fix, claiming the server omits unset fields (`undefined`, not `null`) so
the client's `T | null` guards would wrongly reject every queued step and
option-less decision as `malformed-body`. This directly contradicted
something this same session had already confirmed firsthand while building
PR #946 earlier the same day: `Core.safeJsonStringify` converts `undefined`
property values to `null` rather than omitting them, and
`docs/reference/console.md`'s own JSON examples (also written this session)
show exactly that. Rather than acting on the claim, `safeJsonStringify`'s
source was read directly (`packages/m3l-common/src/core/utils/
safeJsonStringify.ts:95-96`: `value === undefined` routes through `?? null`),
and `spec-conformance-reviewer`'s independent, concurrently-running review
had already verified the same thing end-to-end against the server row
projection. The finding was not applied.

**Why it happened:** The spoke reasoned about the serialization boundary from
general JSON.stringify semantics (which genuinely does omit `undefined` keys)
rather than this repo's specific `safeJsonStringify` wrapper, which
deliberately does not.

**Fix for future:** When a review spoke's finding makes a claim about a
cross-cutting library behavior (a serializer, a redaction helper, a shared
utility) that this session has _already established firsthand_ earlier in
the same task, verify against the source before acting — a second
independent spoke's contradicting result is a strong signal to check, not
just a tie to break by count. _(promoted → .claude/rules/subagent-dispatch.md)_

### 2. `pnpm knip` — not part of `pre-push` — failed in CI after a fully green local push

Three newly-exported types (`M3LSessionStatus`, `M3LSessionStepStatus`,
`M3LSessionStepOutcome`) had no consumer outside their own file; `knip`
flagged them as unused exports. This is a documented, known gotcha
(`.claude/rules/tests.md`: "knip is NOT in pre-push... run `pnpm knip`
yourself after adding, removing, or orphaning any export") that wasn't
followed at push time. Caught via `/triaging-ci` against PR #958's CI run,
fixed by dropping `export` from all three (confirmed via grep that nothing
outside the file referenced them by name), re-verified, and re-pushed.

**Why it happened:** The push-time verification ran `pnpm lint`, `pnpm
typecheck`, `pnpm test:coverage`/`pnpm exec vitest run`, and `pnpm build` —
the full `creating-prs` Step 4 gate sequence — but not `pnpm knip`, which is
correctly scoped out of `pre-push` for cost reasons but is still a CI-required
gate.

**Fix for future:** Run `pnpm knip` as an explicit step whenever a change adds
a new exported symbol, before pushing — not just after CI catches it. Given
this is the second time in this repo's history this exact gap is logged (per
the rule file's own citation trail), it may be worth promoting `pnpm knip`
into the `creating-prs` skill's Step 4 gate sequence directly rather than
leaving it to be remembered from a rules file.

## Lessons learned

- **A disproven review finding is still worth writing down.** Verifying and
  rejecting `type-design-analyzer`'s nullability claim cost one `Read` and one
  grep-equivalent check against `safeJsonStringify`'s source — cheap insurance
  against silently reverting a correct design because a review spoke sounded
  confident. _(promoted → this log serves as the record; no rule change
  needed since the underlying fact — `safeJsonStringify` converts `undefined`
  to `null` — was already established and is not itself in question.)_
- **Splitting a large TDD unit into two RED/GREEN passes (API+routing, then
  UI) by dependency layer, not by file count, kept both `code-implementer`
  dispatches clean on the first try.** The UI pass could consume the
  already-real API/routing layer instead of a placeholder, and the RED tests
  for it could exercise real imports throughout.
- **`pnpm knip` is not a "run it if you remember" gate — run it every time a
  new export lands, in the same breath as `pnpm lint`.** This is the second
  logged instance of this exact miss; see Divergence 2 above.
  _(promoted → `.claude/skills/creating-prs/SKILL.md`, Step 4's gate
  sequence)_
