# Work log — consumer-script production pipeline (2026-07-09)

This log covers the construction of the deterministic consumer-script
production pipeline: the audit-driven plan, the scaffold generator + CI
conformance checker pair, the scripts catalog in the reference index, the
agent-system wiring (spoke rename + new `implementing-scripts` skill), and the
governance/drift cleanup (ADR-0022 acceptance, ADR-0019 supersession). It
records what shipped across PR #90 (merged) and PR #91, what matched the plan,
what diverged, and the durable lessons.

Plan of record:
[`docs/plans/2026-07-09-consumer-script-pipeline.md`](../plans/2026-07-09-consumer-script-pipeline.md)

## Summary

- **PR #90 (`feat: add deterministic consumer-script production pipeline`,
  merged):** `templates/script/` (10 `.tmpl` sources), the shared manifest
  `bin/lib/script-scaffold.mjs`, generator `pnpm scaffold:script <name>`
  (token substitution, prettier-formatted output, idempotent root-tsconfig
  wiring, input validation, atomic rollback), CI checker
  `pnpm check:script-scaffold` (forward + reverse + vacuous), a generated
  consumer-scripts catalog block in `docs/reference/README.md`
  (`gen:index`/`check:index`), the `submodule-implementer` →
  `code-implementer` rename with script-mode few-shot examples (also in
  `test-author`), the new `implementing-scripts` skill, and rewrites of
  `scaffolding-scripts` (generator-centric) and `syncing-docs` (script pass).
  50 new tests in `bin/tests/script-scaffold.test.ts`; suite total 2327.
- **PR #91 (`docs: ratify script pipeline in ADR-0022 …`):** ADR-0022 →
  Accepted with a §9 pipeline amendment; ADR-0019 → Superseded by ADR-0022;
  `writing-a-script.md` per-script-path claim corrected;
  `.claude/rules/scripts.md` enforcement-split correction; historical banner
  extension in `m3l-common-implementation.md`; stale untracked
  `scripts/example-automation/` artifacts removed.
- **Verification:** full E2E dry run (scaffold `sample-probe` → install →
  build → smoke run → smoke test → checker → index → knip → full deletion back
  to vacuous-green), five negative paths exercised (missing file, package
  contract violation, orphan contract page, stale tsconfig ref, duplicate
  refusal), plus injection repros. CI green on #90 including the blocking
  `review` gate; spoke reviews: code-reviewer (1 Must-fix, fixed),
  docs-consistency-reviewer CLEAN twice.

## What went as planned

- **The audit → plan → two-PR structure held exactly** — every planned
  deliverable landed in its planned PR, and the plan-persistence step
  (commit to `docs/plans/` on `main` before work) ran first as amended.
- **The shared-manifest seam worked as designed** — generator and checker
  never drifted because both consume `bin/lib/script-scaffold.mjs`; the
  checker's negative paths all fired correctly on first try.
- **Existing enforcement needed zero new ESLint zones or hooks** — the
  `bin/**`, scripts-design, and tests zones already covered every new artifact
  class; `check:agents` caught nothing after the rename because the reference
  cascade was completed in the same change.
- **Hub-and-spoke separation stayed structural** — test-author wrote the bin
  tests, code-reviewer found the one real bug, docs-consistency-reviewer
  verified both doc-heavy diffs; the hub never reviewed its own code.
- **The stacked-PR mechanics were clean** — PR #91 was opened against
  `feat/script-pipeline` and retargeted to `main` after #90 merged
  (`gh pr edit 91 --base main`), staying `MERGEABLE` throughout.

## What didn't go as planned, and why

### 1. The old SKILL.md templates carried three latent bugs that had never been executed

Grounding the new templates against the shipped library surfaced that the
hand-typed blocks in `scaffolding-scripts/SKILL.md` would not even compile:
`M3LScriptOptions.config` takes `{ params: [...] }` (the template passed the
bare array), `script.run`'s main function takes **no** context argument (the
template destructured `ctx`), and `config.ts`'s literal `100` / `range(1,
10_000)` violated the scripts zone's `no-magic-numbers`. All three were fixed
in the template sources.

**Why it happened:** the prose templates were written against documentation
examples and were never instantiated — nothing ever compiled them, so nothing
could fail.

**Fix for future:** template content must be grounded in the shipped API
(read the actual option types/accessors in `src/`), and every template change
must pass the E2E dry run before merge — prose that is never executed rots
silently.

### 2. The E2E dry run caught two more defects the first fix round introduced

After correcting the API shape, the scaffolded package still failed gates:
the starter step was `async` with no `await` (`require-await`, enabled via the
type-checked preset so a plain grep for the rule name missed it), and the
smoke test read `parameter.name`, which is **private** on
`M3LConfigParameter` (the public accessor is `getName()`). Both were fixed in
the templates and the two agent examples that had copied the same pattern.

**Why it happened:** the templates were reviewed statically; only
instantiating them and running the full gate set (`typecheck`, `lint`, the
suite) revealed rule- and visibility-level problems.

**Fix for future:** treat the scaffold-throwaway-then-delete dry run as a
mandatory gate for any template/manifest change, not an optional smoke test.
_(promoted → .claude/skills/scaffolding-scripts/SKILL.md)_

### 3. Code review found an injection hole in the generator the writer missed

`__PURPOSE__` was substituted verbatim into a JSON string and a TS doc
comment. A `"` crashed prettier mid-emission and left a half-scaffold that
permanently tripped the duplicate-guard on retry; a purpose containing the
comment-terminator sequence could silently inject live code into the emitted
step module. Fixed with `purposeErrors()` validation in the shared manifest
(mirroring `SCRIPT_NAME_RE`), atomic rollback of partial emission, and 17 new
tests. Fittingly, the first draft of the fix's own doc comment contained the
literal comment-terminator sequence and broke the parser — the exact bug class
being fixed.

**Why it happened:** token substitution was designed for trusted tokens
(name, already regex-validated) and the purpose free-text path inherited that
trust; the writer tested happy paths, the adversarial reviewer tested hostile
input.

**Fix for future:** every free-text value substituted into a structured
context (JSON, comments, code) needs context-aware validation or escaping at
the seam, plus rollback for multi-file emission — and adversarial review of
generators specifically should probe substitution inputs.

### 4. The script tsconfig shape had to diverge from the old SKILL template

The SKILL's single-tsconfig shape (include `src/` only) would have left the
mandated smoke test un-type-checked and — worse — a root project reference
pointing at a non-composite config breaks `tsc -b`. The templates adopted the
library's tooling/build split (`tsconfig.json` noEmit incl. tests;
`tsconfig.build.json` composite, referenced from the root), which the E2E run
validated.

**Why it happened:** the old template predated the smoke-test mandate and was
never built through the root `tsc -b` path.

**Fix for future:** when a package participates in root project references,
mirror the library's tooling/build tsconfig split from the start; a
referenced project must be composite.

### 5. A "fix the stale doc" plan item was better served by a banner than by edits

The plan called for removing `scripts/example-automation` references from
`docs/m3l-common-implementation.md`, but that file is an explicitly historical
build-phase record — rewriting its body would falsify history. The fix became
an extension of its existing historical banner (pointing at ADR-0019/0022 and
the pipeline as the current consumer story), leaving the body intact.

**Why it happened:** the audit flagged the references as drift without
classifying the document's historical status.

**Fix for future:** before editing a doc flagged as stale, check whether it is
a living document or a historical record — history gets a clarifying banner,
not content surgery.

## Lessons learned

- **Ground templates in the shipped API** — read the real option types and
  accessors in `src/` (e.g. `M3LScriptOptions.config` = `{ params }`,
  `getName()` not `.name`) instead of trusting documentation examples; three
  latent bugs shipped in prose templates precisely because nothing ever
  compiled them.
- **E2E dry run is the template gate** — scaffold a throwaway, run every gate
  (build, smoke run, tests, lint, typecheck, checker, index, knip), verify the
  negative paths, then delete back to vacuous-green. It caught five defects
  static review missed. _(promoted → .claude/skills/scaffolding-scripts/SKILL.md)_
- **Validate free text at substitution seams** — any user-supplied string
  injected into JSON/comments/code needs context-aware validation (or
  escaping) plus atomic rollback for multi-file emission; adversarial review
  should probe generator inputs with quotes, backslashes, and comment
  terminators.
- **Shared manifest kills generator/checker drift** — defining the shape once
  (`bin/lib/script-scaffold.mjs`) and having both tools consume it made the
  checker correct on first try and turns future shape evolution into a
  single-file + templates change.
- **Composite-reference rule** — a root `tsconfig.json` project reference must
  point at a composite build config; mirror the library's tooling/build split
  for any new workspace package.
- **Historical docs get banners, not surgery** — a document marked as process
  history is corrected by extending its disclaimer banner with pointers to the
  superseding decisions, never by rewriting its recorded content.
- **Resume truncated spokes, verify their claims** — both the reviewer and
  test-author spokes hit turn limits mid-report; `SendMessage` resumption plus
  independent verification (run the tests, read the file) recovered both
  without re-dispatch, confirming the existing verify-spoke-completion lesson.
