# Work log — `core/security` submodule (2026-06-30)

Implementation of the third library submodule, `@m3l-automation/m3l-common`
`core/security`, run end-to-end through the hub-and-spoke TDD pipeline. This
log records what shipped, what matched the plan, what diverged and why, and the
durable lessons for the remaining 19 submodules.

Plan of record:
[`docs/plans/security-submodule-implementation.md`](../plans/archive/security-submodule-implementation.md).

## Summary

The `core/security` submodule is implemented, tested, reviewed, and committed
(`feat: implement core/security prototype-pollution guard`, `346279a`) on branch
`feat/core-security-submodule` (PR #19).

- **2 public symbols** in a single implementation file (`DangerousKeys.ts`):
  `isDangerousKey(key: string): boolean` and
  `formatUnsafeKeyLocation(key: string): string`. Both are pure, synchronous,
  no-throw. The dangerous-key set (`__proto__`, `constructor`, `prototype`) is
  held in a private `ReadonlySet` (unexported).
- Surfaced through the `Core` namespace barrel; the three-entry `exports` map
  (`.`, `./core`, `./aws`) is unchanged — **minor** release, no breaking change.
- **28 tests** (164 across the suite), 100% statement / branch / function /
  line coverage on `DangerousKeys.ts`; `typecheck`, `lint`, `build`,
  `check:api`, `check:scaffold`, `check:provenance`, and `knip` all green.
- 4 review spokes ran in parallel: `spec-conformance-reviewer` (conformant),
  `security-reviewer` (secure), `type-design-analyzer` (9–10/10 across all
  dimensions), `code-reviewer` (one must-fix applied).

## What went as planned

- The **hub-and-spoke TDD loop** executed exactly as designed: contract →
  RED → GREEN → parallel review. The hub never wrote `src/` or test code; each
  spoke worked in isolation.
- **RED failed for the right reason** — `Cannot find module
'../src/core/security/index.js'` — not a logic or syntax error in the tests.
- **GREEN was clean on the first pass.** The implementer turned 161 tests green,
  ran lint in-loop (lesson baked in from `core/errors`), and delivered
  typecheck-clean code without requiring an extra implementer round.
- **Conformance came back conformant on the first pass.** All 2 documented
  symbols present with the correct signatures; dangerous-key set exact; barrel
  wiring correct with `.js` extension; TSDoc present on both functions.
- **All 4 review spokes found no Must-fix items in the implementation logic.**
  The one must-fix (from `code-reviewer`) was in the TSDoc `@example` blocks,
  not in any runtime behavior.
- **The `exports` map was never touched**; `check:api` stayed green throughout.
- **All logic in `DangerousKeys.ts`**, keeping `index.ts` as a pure barrel.
  Coverage-exclusion of `**/index.ts` never hides real code.
- **`pnpm lint` ran in-loop inside the implementer spoke** (lesson from
  `core/errors`). The implementer delivered lint-clean `src/` without a
  separate hub-gate failure.
- **Coverage confirmed at 100% on all four metrics** via `coverage-final.json`
  (lesson from `core/errors` — the v8 text reporter hides 100%-covered files).
- **The `security-reviewer` was apt and surfaced useful nits** (leading-whitespace
  test coverage, log-injection advisory on `formatUnsafeKeyLocation`) that
  improved the module beyond the strict spec.

## What didn't go as planned, and why

### 1. RED-phase eslint-disable blocks required a post-GREEN cleanup spoke

The test-author wrote two `eslint-disable` blocks to suppress
`@typescript-eslint/no-unsafe-*` and `import-x/no-unresolved` during the RED
phase — when the module didn't exist yet and the import was unresolved. After
the implementation existed, ESLint flagged them as "unused directives" (warnings
in this project's config). A separate test-author cleanup spoke was needed to
remove them and also strip an unnecessary `afterEach(() => vi.restoreAllMocks())`
teardown (dead code for pure functions with no mocks).

**Why it happened:** Writing RED-phase tests against a non-existent module
inevitably generates import-resolution errors. The test-author added disable
blocks to make lint pass in the RED state, but those blocks naturally become
stale the moment the module exists.

**Fix for future submodules:** The test-author should not add eslint-disable
blocks for import-resolution or type-inference errors during RED. The RED phase
only needs the tests to _fail_ for the right reason — lint warnings are
acceptable in the RED state and do not affect the test runner. This avoids the
cleanup spoke entirely.

### 2. The `@example` blocks showed `new Error()` instead of `M3LError`

The code-reviewer flagged a must-fix: both `@example` blocks in `DangerousKeys.ts`
used `throw new Error(...)`, directly matching the example in the spec doc
(`security.md`). The project rule (CLAUDE.md §Error Handling) requires all
thrown errors to use `M3LError` or a subclass; an `@example` is normative
guidance that consumers copy-paste, so showing `new Error()` actively propagates
the wrong pattern.

The plan had noted "No `M3LError` subclass is introduced" — this was accurate
(the guard itself never throws), but was misread by the implementer as permission
to use bare `Error` in examples. The spec document and the plan both showed
`new Error()`; the implementer followed the spec example verbatim.

**Why it happened:** The plan locked in the no-throw / no-subclass scope
correctly but didn't explicitly state that `@example` blocks must still model
project error-handling standards. The implementer had two conflicting signals
(spec doc, project rule) and defaulted to the spec doc.

**Fix for future submodules:** When the spec doc's code examples use a pattern
that conflicts with a project-wide rule (e.g. `new Error()` vs `M3LError`),
state the correct project pattern explicitly in the implementer prompt. Do not
assume the implementer will resolve the conflict in favour of the project rule
over the spec literal.

### 3. Adding a top-level `M3LError` import for a TSDoc `@example` caused an unused-import error

The initial implementer fix (dispatched to resolve the must-fix above) added
`import { M3LError } from "../errors/index.js"` at the top of `DangerousKeys.ts`.
This triggered ESLint's `no-unused-vars` rule immediately: `M3LError` is only
referenced inside a TSDoc comment block, which is not compiled code.

The implementer correctly self-corrected: a TSDoc `@example` block is a fenced
markdown code snippet — it does not compile and cannot reference runtime imports
from the surrounding file. The correct pattern is to embed the import statement
inside the fenced block itself, using the public consumer-facing path
(`@m3l-automation/m3l-common/core`), making the example self-contained and
portable for consumers who copy-paste it.

**Lesson:** Never add a top-level import of a symbol that is only referenced
inside a TSDoc `@example`. Embed the import inside the example block using the
public import path. This produces better documentation (the consumer sees exactly
what to import) and avoids the unused-import lint error.

### 4. The provenance sidecar's first draft referenced a private constant

The hub-authored `security.provenance.json` included `DANGEROUS_KEYS` (the
private `ReadonlySet`) as a `symbol` entry in the "The prototype-pollution guard"
section. `pnpm check:provenance` rejected it immediately: the validator checks
that all referenced symbols are exported from their source file. Private
constants do not appear in the module's exports.

The fix was one edit: replace the `DANGEROUS_KEYS` entry with
`formatUnsafeKeyLocation`, which is exported and covers the same spec section.

**Lesson:** Provenance sidecars must reference only exported symbols. The
natural candidate for a section about a private implementation detail is the
public function that exposes its behavior, not the internal constant.

### 5. An untracked plan file failed the pre-push format check

`docs/plans/security-submodule-implementation.md` had been sitting as an
untracked file in the working tree. The `pre-push` lefthook runs
`prettier --check` on the full workspace, and prettier found style issues in the
plan file. The push was blocked; a `prettier --write` and a separate `docs:`
commit were required before the push could proceed.

**Why it happened:** The plan file was created before the branch and left
untracked. It was only noticed at push time.

**Fix for future submodules:** Format and stage any plan or docs files at the
start of the branch, before implementation work begins. Alternatively, add
`docs/plans/**` to prettier's `--ignore-path` if plan files should be exempt
from format enforcement (though the current behavior — enforcing it on push — is
arguably correct).

## Lessons learned

- **Never add RED-phase eslint-disable blocks for import-resolution errors.**
  The test runner does not care about lint in the RED state; the tests fail
  because the module is absent, which is exactly the signal needed. Adding
  disable blocks creates cleanup work after GREEN. Leave lint warnings in the
  RED state; they self-resolve once the module exists.

- **`@example` blocks in library source are normative consumer guidance and
  must follow project standards, even when the spec doc shows a different
  pattern.** If the spec shows `new Error()` but the project requires `M3LError`,
  the `@example` must use `M3LError`. State this explicitly when the spec and
  project rules diverge — do not rely on the implementer resolving the conflict
  in the right direction.

- **Never import a symbol at the module level for use only inside a TSDoc
  `@example`.** TSDoc comment blocks are not compiled code. Embed the import
  statement inside the fenced code block using the public consumer path
  (`@m3l-automation/m3l-common/core`, not a relative `../errors/index.js`). This
  makes examples self-contained, portable, and lint-clean.

- **Provenance sidecars must reference only exported symbols.** The validator
  (`check:provenance`) rejects any `symbol` that does not appear in the file's
  named exports. For sections about private implementation details, use the
  exported function or type that exposes that behavior.

- **Format and commit plan/docs files at the start of a branch.** Untracked
  files that drift out of prettier compliance will block the pre-push hook. The
  cost of formatting up front is zero; the cost of a blocked push is an
  out-of-band commit.

- **A module with only 2 pure symbols is the right size for a pipeline smoke
  test.** The `core/security` module exercised every stage of the hub-and-spoke
  pipeline — contract extraction, RED, GREEN, 4 parallel review spokes,
  provenance sidecar, status file transitions — at minimal implementation
  complexity. All pipeline friction found here (RED disable blocks, @example
  standards, provenance validation) will recur in larger modules where the cost
  of a re-work round is higher.

- **Lessons from `core/errors` and `core/events` that continued to hold:**
  running `pnpm lint` in-loop (the implementer needed zero hub-gate rounds for
  lint), reading coverage from `coverage-final.json` (not the text table),
  trusting the CLI over the LSP (the IDE showed stale "Cannot find module"
  throughout), and front-loading the exact contract nuances into spoke prompts.
