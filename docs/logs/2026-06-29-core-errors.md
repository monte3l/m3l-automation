# Work log — `core/errors` submodule (2026-06-29)

Implementation of the first library submodule, `@m3l-automation/m3l-common`
`core/errors`, run end-to-end through the hub-and-spoke TDD pipeline. This log
records what shipped, what matched the plan, what diverged and why, and the
durable lessons for the remaining 20 submodules.

Plan of record: [`docs/plans/errors-submodule-implementation.md`](../plans/errors-submodule-implementation.md).
Follow-up plan (this cleanup + PR):
[`docs/plans/core-errors-coverage-log-pr.md`](../plans/core-errors-coverage-log-pr.md).

## Summary

The `core/errors` submodule is implemented, tested, reviewed, and committed
(`feat: implement core/errors submodule`, `1cdb305`) on branch `feat/core-errors`.

- **22 public symbols** across four files: `M3LError.ts` (`M3LError`,
  `M3LErrorOptions`), `M3LResult.ts` (`M3LResult`/`Ok`/`Err` plus `ok`, `err`,
  `isOk`, `isErr`, `unwrap`, `unwrapOr`, `map`, `mapErr`, `andThen`, `fromPromise`,
  `tryCatch`), `M3LErrorUtils.ts` (`getErrorMessage`, `toError`, `wrapError`,
  `getErrorStack`, `hasErrorName`, `errorMessageContains`), and a re-export-only
  `index.ts` barrel.
- Surfaced through the `Core` namespace barrel; the three-entry `exports` map
  (`.`, `./core`, `./aws`) is unchanged, so this is a **minor** release, not a
  breaking change.
- 101 errors tests (103 across the suite); coverage ~98% statements / ~94%
  branches / 100% functions; `typecheck`, `lint`, `build`, and `check:api` green.

## What went as planned

- The **hub-and-spoke TDD loop** ran exactly as designed: contract
  (`spec-conformance-reviewer`) → RED (`test-author`) → GREEN
  (`submodule-implementer`) → parallel review (`code-reviewer` +
  `spec-conformance-reviewer`). The hub never wrote `src/`/tests and never
  reviewed; spokes did the substantive work.
- **RED failed for the right reason** — the test suite errored on the missing
  module import, not on a typo.
- **Conformance came back conformant on the first pass** — all 22 documented
  symbols present, every behavioural contract met.
- The **`exports` map was never touched**; `check:api` stayed green throughout,
  confirming no accidental semver event.
- The **four-file layout** kept all logic out of the coverage-excluded
  `index.ts`, so the implementation is fully exercised by tests.

## What didn't go as planned, and why

1. **A separate lint round was needed after review.** The `post-edit-verify`
   hook runs prettier + typecheck + vitest-related, but **not eslint**, so six
   eslint errors (an unnecessary type assertion, an unused type parameter, and
   intentional `only-throw-error` / `prefer-promise-reject-errors` in tests) only
   surfaced at the hub's full-gate `pnpm lint` — after the spokes had reported
   "green". Cost: an extra implementer + test-author round.
2. **A suspected coverage gap turned out to be a reporter artifact.**
   `M3LErrorUtils.ts` was absent from the `pnpm test:coverage` text table, which
   looked like the file escaped the 80% threshold. Investigation against the raw
   v8 JSON (`coverage-final.json`) showed it is fully instrumented (18/18
   statements, 6/6 functions, 18/18 branches) and _is_ part of the threshold
   computation. The vitest 4 v8 **text reporter simply hides files that are 100%
   on every metric**. No fix was needed; `coverage.all` (the initially-proposed
   fix) was also **removed in Vitest 4** and would have been a type error.
3. **Editor LSP diagnostics were unreliable.** Recurring "Cannot find module
   ../src/core/errors/index.js" and shifting implicit-`any` flags contradicted a
   passing `pnpm typecheck`/`pnpm lint`. The CLI gate, not the LSP, was the
   source of truth.
4. **A review suggestion was rejected by the type system.** The reviewer asked
   for `fn: (_: never) => U` on `map`'s err-path overload; TypeScript 6.x
   (`TS2394`) rejected it as incompatible with the implementation signature, so
   the intent was preserved with a JSDoc comment instead.
5. **A contract nuance had to be relayed explicitly.** `cause` is typed `unknown`
   (not `Error`); this was fed verbatim to the test and implementation spokes to
   prevent the tests from over-constraining the type.

## Lessons learned

- **Run `pnpm lint` inside the spoke loop, or add eslint to `post-edit-verify`.**
  Eslint-only failures otherwise reach the hub gate and cost an extra round. This
  is the single highest-value process fix for the remaining submodules.
- **Read coverage from `coverage-final.json`, not the text table.** The v8 text
  reporter omits 100%-covered files; the table is not the set of gated files. Use
  `pnpm exec vitest` / `pnpm test:coverage` (bare `npx vitest` fails to resolve
  `@vitest/coverage-v8` under pnpm).
- **Trust the CLI gate over the IDE LSP** in this harness — diagnostics lag and
  misreport against the project `tsconfig`.
- **Front-load exact contract nuances into spoke prompts** (e.g. `cause: unknown`,
  pass-through semantics, which error `unwrap` throws). Precision up front avoids
  drift and re-work, especially for weaker routed models.
- **Modules that test error channels will trip `only-throw-error` and
  `prefer-promise-reject-errors`.** Plan for justified `eslint-disable` comments
  on intentional non-`Error` throws/rejections.
- **Keep logic out of `index.ts`** (coverage-excluded); split into named files so
  every line is gated.
- **Verify a tooling assumption before "fixing" it.** The coverage "gap" cost
  investigation time but no bad change — confirming a fix is necessary _and_ valid
  for the installed version is cheaper than shipping a no-op or invalid config.
