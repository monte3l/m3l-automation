# Work log — `aws/dynamodb` submodule (2026-07-13)

This log covers the scaffolding + implementation of the new `aws/dynamodb`
submodule, run through the `scaffolding-submodules` → `implementing-submodules`
hub-and-spoke pipeline in the linked worktree at
`../m3l-automation-aws-dynamodb` (branch `feat/aws-dynamodb`). Unlike every
prior submodule, this one was **not** a pre-planned roadmap item — it is new
library friction surfaced mid-implementation of the `dynamo-crud` W2 consumer
script (a separate, paused worktree on `feat/dynamo-crud`), and it records what
shipped, what matched the plan, what diverged, and the durable lessons for the
next submodule.

## Summary

**Origin.** While extracting `dynamo-crud`'s contract, its steps needed to
construct AWS SDK v3 commands (`GetCommand`, `PutCommand`, `ScanCommand`,
`BatchWriteCommand`, `DescribeTableCommand`, …), which would have required the
script to depend on `@aws-sdk/lib-dynamodb`/`@aws-sdk/client-dynamodb`
directly. The user made an explicit architectural call: scripts depend **only**
on `@m3l-automation/m3l-common`; the library is the sole abstraction layer over
any external dependency. That decision is what created this submodule — the
`dynamo-crud` script itself is paused in its own worktree, waiting for this to
merge to `main` before it can resume against the new API.

**Shipped.** 10 public symbols from `@m3l-automation/m3l-common/aws`: 9
functions (`getItem`, `putItem`, `updateItem`, `deleteItem`, `queryItems`,
`scanSegment`, `batchWriteItems`, `batchDeleteItems`, `describeTable`) plus
`M3LDynamoDBOperationError`, wrapping the existing `dynamoDBDocument`/`dynamoDB`
clients from `aws/clients`. No new runtime dependency — `@aws-sdk/lib-dynamodb`
and `@aws-sdk/client-dynamodb` were already hard deps of the library at
`3.1079.0`.

**Pipeline:** contract extraction (`spec-conformance-reviewer`) → RED
(`test-author`, 34 tests) → GREEN (`code-implementer`) → a 5-spoke review
fan-out (`code-reviewer`, `spec-conformance-reviewer`, `security-reviewer`,
`type-design-analyzer`, `silent-failure-hunter`) → one fix round → a 2-spoke
confirmation pass. Final state: **49 tests, 100% statements/branches/functions/
lines**, full workspace suite green (2663 tests), `typecheck`/`lint`/`build`
clean, `docs/implementation-status.md` row ✅/✅/✅.

**Review verdicts:**

- `code-reviewer` — pass; 4 should-fix (all applied) + nits.
- `spec-conformance-reviewer` — conformant with nits (2 doc-staleness items,
  fixed).
- `security-reviewer` — clean pass, no findings (injection-safe
  placeholder-everything expression pattern confirmed).
- `type-design-analyzer` — no must-fix; 1 should-fix (the `ScanSegmentOptions`
  XOR invariant pushed into the type), applied.
- `silent-failure-hunter` — 2 must-fix (`UnprocessedItems` malformed-entry
  masking in `batchWriteItems`/`batchDeleteItems`), applied.
- Confirmation pass (`code-reviewer` + `spec-conformance-reviewer`) — both
  **PASS**, no remaining findings.

## What went as planned

- **Contract extraction was thorough and load-bearing.** The
  `spec-conformance-reviewer` pass before RED enumerated exact SDK command
  classes, input/output field mappings, and flagged nine underspecified edge
  cases (empty patch, empty batch, `segment`/`totalSegments` coupling, etc.)
  before any test was written — every one of those flagged gaps turned out to
  be real and needed a pinned decision.
- **RED failed for the right reason.** All 33 runtime tests in the first pass
  failed against the scaffold's "not yet implemented" throw, not against a
  malformed test; the one passing test was the compile-time-only `expectTypeOf`
  check, correctly a no-op at runtime.
- **GREEN was clean on the first pass** for the actual business logic — no
  re-dispatch needed to fix logic bugs, only the coverage-driven structural
  split (see divergence 1).
- **The security review was genuinely clean**, not just absence-of-findings —
  it specifically verified the placeholder-everything
  `ExpressionAttributeNames`/`Values` pattern in `updateItem`/`queryItems`
  cannot be used to inject expression operators, which was the one plausible
  injection surface in this module.
- **The confirmation pass after the fix round found nothing new** — the
  targeted fix-round dispatch (bundling all must-fix + should-fix items into
  one `code-implementer` pass, then one `test-author` pass for the type-shape
  change) converged in a single round.

## What didn't go as planned, and why

### 1. The scaffold put real logic directly in `index.ts`, hiding it from the coverage gate entirely

`vitest.config.ts`'s coverage config excludes **every** `**/index.ts` file
project-wide (`exclude: ["**/index.ts", "**/*.d.ts"]`) — a convention that
assumes `index.ts` is always a pure re-export barrel, as it is in every prior
submodule (e.g. `aws/clients/index.ts` is five re-export lines; the real logic
lives in `provider.ts`, `multi-provider.ts`, etc.). The `aws/dynamodb` scaffold
violated that assumption: all 9 functions and their supporting types were
written directly into `index.ts`. GREEN completed and all tests passed, but
`pnpm test:coverage` showed `aws/dynamodb/index.ts` **not appearing at all** in
`coverage/coverage-final.json` — the entire module's logic was silently
excluded from both the coverage report and the 80% gate. This was caught only
because coverage was checked explicitly as part of the GREEN verification
step, not because any test failed.

Fixing it required a mid-implementation structural change: moving all 9
functions and their types into a new `operations.ts`, and rewriting `index.ts`
into a thin barrel (`export * from "./operations.js";`), matching the
`aws/clients` shape. This in turn surfaced a real coverage gap (76.78%
branches) once the logic was actually measured — 13 branches (the
"don't-double-wrap" guard in all 9 functions, plus 4 `?? []` fallback paths)
had zero test coverage, needing a follow-up `test-author` pass to close.

**Why it happened:** The `scaffolding-submodules` skill's step 2 instructs
creating `index.ts` with the module's skeleton, without stating that `index.ts`
must stay a thin barrel when the module has substantive logic — the "barrel
only" convention was implicit in every prior example, never written down as a
rule.

**Fix for future:** Documented explicitly in
`.claude/skills/scaffolding-submodules/SKILL.md` step 2: `index.ts` must stay a
thin barrel; real logic goes in sibling files, because the coverage config
excludes all `index.ts` files. Future scaffolds should lay down the real
implementation file (e.g. `operations.ts`) from the start, not `index.ts`.

### 2. The doc-provenance tool couldn't recognize this codebase's first standalone exported generator function

Writing the provenance sidecar for `dynamodb.md` failed with `"queryItems" not
exported from ... operations.ts` and the same for `scanSegment` — both are
correctly `export async function* queryItems(...)` / `export async function*
scanSegment(...)`. `bin/lib/doc-provenance.mjs`'s `isSymbolExported` regex
matched `export (async)? (class|function|type|interface|const|let|var|enum)
symbol`, with no `*` after `function` — so `export async function* foo` never
matched. This is a real, narrow, pre-existing gap: every prior async generator
in this codebase is a **class method** (`async *importStream(...)` on
`M3LJSONListImporter`/`M3LCSVListImporter`), whose provenance tracks the
containing class, not the method — so this exact regex path was never
exercised before `queryItems`/`scanSegment`, this module's first top-level
exported generator functions.

**Why it happened:** The regex was written against every export pattern that
existed in the codebase at the time, which happened to never include a
standalone exported generator function.

**Fix for future:** Fixed `bin/lib/doc-provenance.mjs`'s `isSymbolExported`
regex to accept `function\*?` in the keyword alternation, with a regression
test (`bin/tests/doc-provenance.test.ts`) covering both `function*` and `async
function*`. No further action needed for future submodules — the tool now
handles this pattern.

### 3. The submodule-count tooling had a latent bug that only a non-degenerate total≠implemented state could surface

After marking `dynamodb`'s tests written (moving `total` from 22 to 23 while
`implemented` stayed at 22 — the module's first non-reviewed intermediate
state), `pnpm check:impl-counts` failed on `README.md` with "expected pattern
not found: `/modules-(\d+)%2F22/`". `bin/lib/count-sites.mjs`'s
`IMPLEMENTED_COUNT_SITES` patterns hardcoded the denominator as literal `22`
in four of six sites (`/modules-(\d+)%2F22/`, `/(\d+) of 22 submodules are/`,
etc.) — this worked by coincidence for the project's entire history because
`total` and `implemented` had always been equal (both 22), so the sibling
`TOTAL_COUNT_SITES` entry correctly bumped the denominator text to `23` while
the co-located numerator-tracking pattern, still expecting literal `22`, no
longer matched. Two of the four affected files
(`packages/m3l-common/README.md`, `docs/implementation-status.md`) had **no**
`TOTAL_COUNT_SITES` entry at all, meaning their denominator was never
independently verified or regenerated — a second, quieter gap in the same
system.

**Why it happened:** The counting tool was built and tested only against the
degenerate case where `total === implemented`, because that was true for every
submodule from the project's inception through submodule #22.

**Fix for future:** Wildcarded the denominator (`\d+`, uncaptured) in all six
`IMPLEMENTED_COUNT_SITES` patterns — each site's own denominator correctness is
now asserted by its sibling `TOTAL_COUNT_SITES` entry rather than baked into
the numerator pattern. Added two previously-missing `TOTAL_COUNT_SITES` entries
for `packages/m3l-common/README.md` so its denominator is generated/checked
too. Fixed the hardcoded `22` in `buildImplementedListBlock`'s generated
sentence and in `bin/check-impl-counts.mjs`'s own success log message. No
further action needed — the next non-degenerate state (any submodule scaffolded
but not yet reviewed) now round-trips correctly.

## Lessons learned

- **`index.ts` is coverage-invisible — never put real logic there.** The
  project's coverage config excludes every `**/index.ts` on the assumption it's
  a pure barrel. A module scaffolded with its functions directly inside
  `index.ts` passes every test yet silently drops out of the 80% gate. _(promoted
  → `.claude/skills/scaffolding-submodules/SKILL.md`)_
- **Verify coverage explicitly during GREEN, not just test pass/fail.** All 34
  RED tests passing at GREEN gave no signal that ~250 lines were coverage-blind;
  only an explicit `pnpm test:coverage` + `coverage-final.json` check surfaced it.
  Treat "all tests green" and "coverage actually measures the code" as two
  separate things to confirm.
- **A tool exercised only against a degenerate historical case can hide a real
  bug indefinitely.** Both tooling bugs found here (the coverage-config
  assumption and the count-sites hardcoded denominator) were latent for the
  project's entire history because no prior submodule had ever been a
  standalone exported generator function, and no prior state had ever had
  `total ≠ implemented`. When a new submodule is the "first" of some shape
  (first async generator, first non-reviewed intermediate state, first of
  anything), expect it to surface a tooling assumption baked in from a smaller
  sample.
- **Bundle a post-review fix round rather than fixing findings one at a time.**
  The 5-spoke fan-out returned 2 must-fix + 3 should-fix + doc nits across
  independent files; dispatching one `test-author` pass (for the type-shape
  change + new coverage) followed by one `code-implementer` pass (for all the
  logic fixes) converged in a single round, versus dispatching per-finding.
- **A confirmation pass after a fix round doesn't need the full 5-spoke
  fan-out.** Security, type-design, and silent-failure-hunter findings were
  narrowly scoped and directly addressed; a 2-reviewer confirmation
  (`code-reviewer` + `spec-conformance-reviewer`) was sufficient to catch any
  regression or incomplete fix without re-running the whole fan-out.
- **A new submodule started as unplanned library friction still needs the
  same rigor as a roadmap item.** This module wasn't in `docs/ROADMAP.md`
  before this session — it was discovered mid-task — but ran the exact same
  scaffold → RED → GREEN → review → confirm pipeline as any planned submodule,
  with no shortcuts taken on review depth or gate coverage.
