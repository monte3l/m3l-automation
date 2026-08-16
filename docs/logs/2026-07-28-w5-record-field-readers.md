# Work log — W5 record-field readers promotion (2026-07-28)

Promotes the record-field reader cluster hand-duplicated across 5 consumer
scripts' write steps (`readOptionalStringField`/`readOptionalNumberField`/
`readOptionalBooleanField`/`readRequiredStringField`/`requireInput` and
siblings) into 8 new methods on `Core.M3LInputFileReader`, then retrofits the
fleet onto them — the next unit in the standing W5 promotion pass, following
the same 2-PR-chain shape as the checkpoint-store and config-accessor
promotions before it. This log records what shipped, a pre-push review fan-out
finding and fixing a real prototype-chain security bug in the library seam
before merge, and the doc-drift the fleet retrofit surfaced.

Plan of record: `~/.claude/plans/on-docs-roadmap-md-docs-plans-implementa-jazzy-crystal.md` (session-local; not archived — routine W5 promotion, not a cross-cutting/governance change)

## Summary

- **PR 1 (#266, `feat(core)`):** added `requireRecord`/`requiredStringField`/
  `requiredArrayField`/`optionalStringField`/`optionalNumberField`/
  `optionalBooleanField`/`optionalArrayField`/`optionalRecordField` to
  `Core.M3LInputFileReader` (`packages/m3l-common/src/core/files/M3LInputFileReader.ts`).
  56 tests added/updated in `M3LInputFileReader.test.ts`. No new exported
  symbol, no `exports`-map change — additive `feat:`, minor bump.
- **PR 2 (#267, `feat(scripts)`):** retrofitted `ecs-ops`, `cloudformation-stacks`,
  `lambda-ops`, `codepipeline-ops`, `eks-ops` onto the new methods, deleting
  ~14 local helpers. Closes issue #262 and the "write-*.ts record-field
  reader cluster" row in `docs/plans/IMPLEMENTATION.md`.
- Full workspace suite: 5722 → 5740 tests (library + scripts), all passing.
  `pnpm check:dup`: 3.32%/99 clones (post-#261 baseline) → 3.23%/98 clones
  after both PRs. `pnpm typecheck`/`lint`/`build`/`check:exports`/
  `check:doc-exports`/`check:script-scaffold`/`lint:md`/`check:script-deps`
  all clean throughout.
- Review fan-out: PR 1 ran `code-reviewer`, `security-reviewer`,
  `silent-failure-hunter`, `spec-conformance-reviewer` (4 spokes, one fix
  round applied — see divergence #1). PR 2 ran `code-reviewer`,
  `spec-conformance-reviewer`, `silent-failure-hunter` (3 spokes, one fix
  round applied — see divergence #2). All spokes returned clean/conformant
  after their respective fix rounds. CI (`verify`, CodeQL, dependency-review,
  the mandatory `claude-pr-review` gate) passed on both PRs.
- Both PRs squash-merged to `main` by explicit user confirmation (asked
  separately for each, since merging is a shared-state action).

Skills used: starting-work, writing-commits, creating-prs (partial — gates run
manually inline rather than via full skill invocation), syncing-docs,
writing-work-logs.

Spoke incidents: none — all 7 review-spoke dispatches (4 on PR 1, 3 on PR 2)
completed normally; no truncations, no stalls, no `SendMessage` resumes.

## What went as planned

- **The `starting-work` decision gate correctly scoped this as a 2-PR chain**
  before any code was written, matching the precedent of the two prior W5
  promotions (checkpoint-store, config-accessor) rather than rediscovering
  the shape mid-task.
- **The design-decision AskUserQuestion calls resolved cleanly** — extending
  the existing `M3LConfigAccessor`-adjacent `M3LInputFileReader` (rather than
  a new class) and choosing fail-loud-on-wrong-type semantics were both
  confirmed up front, so the implementation had no ambiguity to resolve
  mid-flight.
- **4 of 5 scripts' retrofits were mechanical** — `ecs-ops`,
  `cloudformation-stacks`, `lambda-ops`, `codepipeline-ops` all needed the
  same shape of change (thread `reader` into the write-step's deps interface,
  delete local helpers, repoint call sites) with no design judgment required
  beyond wiring.
- **`eks-ops` needed zero dependency threading** — its `run-eks-ops.ts`
  already carried `deps.reader` from the prior config-accessor retrofit, so
  only the local `requireInputField`/`isNonEmptyArray` needed deleting and
  their one caller (the nested `resourcesVpcConfig.subnetIds` check) needed
  decomposing over existing primitives.
- **`codepipeline-ops`'s dual error-code split (`ERR_CODEPIPELINE_OPS_CONFIG`
  vs. `ERR_CODEPIPELINE_OPS_INPUT`) required no new design** — the reader was
  already constructed with the `INPUT` code from the prior retrofit, so the
  record-field methods inherited the correct code automatically; only the
  flat-config-value `requireString` guard (which throws `CONFIG`) needed to
  stay local.
- **All 5 scripts' full test suites passed on the first run** after each
  retrofit, with no iteration needed on the mechanical wiring itself (only
  the review-driven fix rounds below required a second pass).

## What didn't go as planned, and why

### 1. A pre-push review fan-out caught a real prototype-chain security bug in PR 1 before merge

`security-reviewer`'s fan-out on PR 1's diff found that `record[field]` is a
prototype-chain read, not an own-property read: a record with no own
`__proto__` key would silently resolve `Object.prototype` itself as the
field's value in `optionalRecordField`, and the same read pattern in
`#readOptionalField`/`requiredStringField`/`requiredArrayField` would have
silently accepted an inherited value had `Object.prototype` ever been
polluted elsewhere. `code-reviewer` independently flagged a second issue in
the same pass: four new module-level type guards (`isString`/`isNumber`/
`isBoolean`/`isArray`) duplicated the already-exported `core/utils/guards.ts`
predicates this same file already imports from.

Both were fixed in a follow-up commit (`96d6978`): every field read gained an
`Object.hasOwn(record, field)` guard before the bracket access, and the four
duplicated guards were replaced with imports from `core/utils`. Six new
regression tests locked the `Object.hasOwn` fix (a `__proto__`-named field
with no own slot now resolves `undefined`/throws-as-absent rather than
leaking `Object.prototype`). Duplication actually _improved_ as a side
effect (3.33%/100 clones → 3.30%/99 clones) from the guard dedup.

**Why it happened:** Writing a "read a field off a record" helper from
scratch (rather than composing over an existing, already-hardened primitive)
re-introduces exactly the property-access hazards a library's own utilities
already guard against. The four narrow type-guard functions were written
fresh because the pattern from `M3LConfigAccessor.ts` (which has its own
identical local `isString`/`isNumber`/`isBoolean`) was copied as precedent,
without checking that a shared, exported version already existed in
`core/utils`.

**Fix for future:** When writing a new field-reader/type-guard helper in this
library, grep `core/utils/guards.ts`'s exported predicates first — the
`isString`/`isNumber`/`isBoolean`/`isArray`/`isPlainObject` family is meant to
be the shared source, and a local reimplementation is a smell even when a
sibling class (`M3LConfigAccessor`) already has one (that's pre-existing debt,
not a precedent to repeat). Separately: any function that reads a field off
an untrusted or partially-trusted object via bracket notation (`record[field]`)
should default to `Object.hasOwn` first, not `!== undefined`, unless own-vs-
inherited is proven irrelevant for that specific field.

### 2. The fleet-retrofit PR left 5 script contract pages and 4 `@throws` blocks stale

`spec-conformance-reviewer`'s fan-out on PR 2 returned a **non-conformant**
verdict: the retrofit added a required `reader: Core.M3LInputFileReader`
field to 3 scripts' write-step deps interfaces but never updated the
corresponding documented signatures in `docs/reference/scripts/{ecs-ops,
cloudformation-stacks,codepipeline-ops}.md`; `lambda-ops.md`'s config-schema
prose still described the pre-retrofit "trusted as-is" silent-drop behavior,
which the retrofit made false. `code-reviewer` and `silent-failure-hunter`
separately converged on two more gaps: the in-source `@throws` TSDoc on 3 of
the 4 write-step exports didn't mention the new wrong-typed-field-throws
behavior, and `eks-ops`/`lambda-ops` were each missing one or two wrong-type
regression tests the other scripts already had.

All were fixed in a follow-up commit (`11cf8d8`): 5 doc pages updated (3
signature fixes, 1 stale-prose fix, plus enumerating every newly-throwing
optional field and the nested prototype-pollution-screen hardening on 4
pages), 3 `@throws` blocks updated, and 6 new regression tests added across
`eks-ops`/`lambda-ops`.

**Why it happened:** The retrofit's own diff review focused on behavioral
correctness (does the wrong-typed field actually throw?) and didn't
separately check each touched script's `docs/reference/scripts/*.md`
contract page — which is a different file from the ones being edited, so
nothing in the local diff view surfaced the drift. `write-pipeline.ts`
correctly needed no `@throws` update (codepipeline-ops only adopted the
required-field readers, whose throw conditions were unchanged), which the
review fan-out also confirmed rather than flagging by rote symmetry.

**Fix for future:** When a fleet retrofit changes a write-step's deps
interface shape (adding/removing a field) or its throw conditions, grep
`docs/reference/scripts/<name>.md` for the step's documented signature and
error-code bullet _before_ considering the retrofit done — don't rely on the
review fan-out to catch doc drift that a same-PR self-check could close
first. `spec-conformance-reviewer` is the right spoke for this, but running
it proactively during implementation (not only at the pre-push gate) would
have caught this before the first review round.

## Lessons learned

- **Grep `core/utils/guards.ts` before writing a new type-guard helper.**
  A local `isString`/`isNumber`/`isBoolean` reimplementation is a smell in
  this library even when a sibling class already has one — that's
  pre-existing debt, not precedent. _(promoted → `.claude/rules/library-src.md`)_
- **`Object.hasOwn`, not `!== undefined`, for a record-field read of
  untrusted/partially-trusted input.** Bracket access on a plain object walks
  the prototype chain; a field with no own slot can silently resolve an
  inherited (or, worse, polluted) `Object.prototype` value. Default to
  `Object.hasOwn(record, field)` first unless own-vs-inherited is proven
  irrelevant. _(promoted → `.claude/rules/library-src.md`)_
- **A fleet retrofit that changes a write-step's deps shape or throw
  conditions must self-check the script's own `docs/reference/scripts/*.md`
  page**, not just the touched `src/` files — the contract page lives outside
  the local diff view and won't surface as drift unless explicitly checked.
- **A 2-PR chain's pre-push review fan-out is worth running on both PRs
  independently**, not just the library seam — PR 2's fan-out caught doc
  drift and test-coverage gaps that PR 1's fan-out (scoped to the library
  change alone) had no visibility into.
- **Rebasing a stacked branch after the base PR squash-merges needs
  `git rebase --onto origin/main <last-shared-commit> HEAD`**, not a plain
  `git rebase origin/main` — the latter tries to replay the base PR's
  already-squashed commits again and hits spurious conflicts against content
  that's already identical in `main`. _(promoted → .claude/skills/resolving-merge-conflicts/SKILL.md)_
