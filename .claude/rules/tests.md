---
paths:
  - "**/tests/**"
  - "**/*.test.ts"
---

# Testing rules (`tests/**`, `*.test.ts`)

> Canonical rationale + examples: [`docs/contributing/style-guide.md` §
> Writing new tests](../../docs/contributing/style-guide.md#part-2--writing-new-tests).
> This file is the terse checklist that auto-loads when you edit a test.

- **Runner/layout, what to test, mocking basics, type-level tests, fixtures,
  and parameterization** are covered in full by style-guide.md's Part 2
  subsections above — this file only adds what that guide doesn't already
  say.
- **Assert the named behavior, not a proxy** — not `length > 0`, and not
  merely that the call "doesn't throw". A positive and a negative claim
  BOTH met by nothing happening need the positive one asserted explicitly
  too.
- **A test that claims to guard something must be mutation-tested before you
  believe it guards anything** — delete the guard clause, invert the flag,
  drop a wrapper, and confirm the test fails. Say in the log what you
  mutated and what you saw.
- **A surviving mutant is a question, not automatically a defect — and a
  mutation that never applied is not a survivor at all.** An _equivalent_
  mutant (both branches agree on every reachable input under a
  runtime-enforced invariant) needs a note, not a new test; verify a
  scripted mutation actually changed the file (e.g. after a Prettier
  reflow) before trusting a "survivor".
- **A check whose two sides come from ONE source can never fail** — a fake
  store that ECHOES the value under test passes either way. Pin at least
  one side by hand.
- **A mutation-tested guard can go vacuous LATER** — it proves teeth only at
  the moment you run it. When a change adds a consumer of a signal a test
  observes INDIRECTLY (a property read, a call count), re-mutate the tests
  watching it.
- **Never make a test double wait by counting event-loop turns** — a
  `setImmediate` retry-N-times loop is a latency guess passing locally and
  failing under CI load. Anchor the emit to a structural guarantee instead.
- **Consumers resolve `m3l-common` through `dist`, so run `pnpm build`
  before trusting any cross-package result** — a stale `dist` fails tests in
  an untouched package after a merge adds an export, and a `src/` mutation
  never reaches a consumer's suite until rebuilt.
- **Enumerate the gates from `package.json`, never a static list** —
  `pnpm verify`, `pre-push`, and CI are three different, nested sets; grep
  `scripts` for `check:*`, don't trust the cadence table.
- **A test naming a precedence, ordering, or "every X" guarantee must make
  every arm reachable in its own setup** — exactly right yet prove nothing
  if the discriminating precondition never fires. Enumerate the set
  (`test.each`), not one member of it
  (`docs/logs/2026-08-19-a4-checkpoint-fingerprint.md`).
- **Never mock the behavior the test exists to validate** — a stub echoing
  back the outcome under question asserts the stub, not the code, while
  still reading as coverage. Exercise the real collaborator at least once
  (`docs/logs/2026-08-24-w8-sqs-dead-letter-triage.md`).
- **Assert barrel reachability through the package entry point** — importing
  `src/` paths directly can't observe a broken namespace re-export.
  `tests/index.test.ts`'s table-driven check names one load-bearing symbol
  per barrel; add a row per submodule.
- **Audit test vehicles when a fix narrows what a field accepts** — a test
  that can no longer fail reads as coverage, but is worse.
- **A type-only `expectTypeOf` test still executes its expression at
  runtime** — if it invokes a fallible async method, resolve the mock to a
  valid value first, or a rejecting un-awaited promise surfaces despite the
  type assertion passing.
- **A gate failing outside your change's blast radius is presumed
  pre-existing until disambiguated** — `git diff origin/main -- <path>`
  settles it in seconds. Not licence to retry blind: an unexplained green
  re-run is itself a flake to diagnose and file
  (`docs/logs/2026-07-11-prepush-parallelization.md`).
- **Mock an SDK package the same way once it mixes class and data
  exports** — a plain `vi.mock("pkg", () => ({...}))` object literal
  silently omits unlisted exports, harmless for a type-only import but
  fatal once a value import (a data-only enum) resolves to `undefined` at
  module-load time. Default to the `importOriginal`-preserving async
  factory (style-guide.md § Mocking & isolation).
- **A dynamic-`import()`-only step module can mock with a plain `const
stepMock = vi.fn()`; once production code adds a _static_ import from that
  module, move the mock to `vi.hoisted(() => vi.fn())`** — a plain `const`
  initializes after `vi.mock` calls are hoisted.
- **Mock a port with generic methods by inference, not `extends`** — a
  generic method (`select<Value>(...)`) can't be mocked via `interface Mock
extends Port { ... }` (TS2430). Let the factory return the inferred
  `vi.fn()` object instead.
- **Test-first, not test-after** — write tests from the doc contract, watch
  them fail for the right reason, then implement — don't backfill a test
  that just mirrors code you already wrote.
- **Update `docs/implementation-status.md`'s Notes count in the same commit
  as any new test** — `check:test-counts` asserts it against the live
  Vitest count.
- **Per-file test size is ratcheted, not capped** (`pnpm check:file-budget`,
  ADR-0072). Name a seam-plan slice's test file `<mod>-<facet>.test.ts` and
  import **only** the symbols that slice ships — the whole barrel defeats
  `perFile` v8 coverage binding.
- **Justify intentional `eslint-disable` on the error channel** — a test
  proving normalization throws non-`Error` values on purpose, tripping
  `only-throw-error`. Disable narrowly with a `--` rationale:

```ts
// eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the unknown channel
throw "a string";
```

- **Assemble a planted secret-shaped fixture at runtime, never as a single
  source literal** — gitleaks scans source text, not runtime values, and
  this repo has no `.gitleaksignore`. Concatenate two substrings instead
  (`diagnostics-run-report.test.ts:144-148`).

### Test-tooling gotchas

- **`not.toHaveProperty` cannot prove own-key absence** — chai falls back to
  `"key" in Object(obj)` and walks the prototype chain. Assert
  `Object.hasOwn(result, "f")` instead, and restore a polluted prototype in
  an **unconditional** `afterEach` (`Reflect.deleteProperty`,
  `configurable: true`).
- **Runtime-green ≠ typecheck-green** — Vitest transforms without
  type-checking, so run `pnpm typecheck` as its own gate on every test file
  you touch.
- **`pnpm build` is a distinct gate from `pnpm typecheck`, not a slower
  version of it** — `isolatedDeclarations` (package `tsconfig.build.json`
  only) makes an additive `as const satisfies` pass `typecheck` and fail
  `build` with TS9010. Any exported-type change needs both
  (`docs/logs/2026-08-19-a3-partial-run-outcome.md`).
- **A test that deliberately avoids importing from `src` can strand an
  export and fail `pnpm knip`** — keep both the hand-authored table and an
  import for projection identity. `knip` is **not** in `pre-push` — run it
  yourself after touching any export under `scripts/**` or `packages/**`.
- **eslint runs in-loop** (prettier → eslint → typecheck → vitest) —
  resolve findings as you write, don't defer to a later `pnpm lint` pass.
- **Thread `now` as an injectable parameter on a time-dependent guard**
  rather than defaulting to `Date.now()` inside it — a sibling function's
  fixed-timestamp fixtures are the tell
  (`docs/logs/2026-09-02-spoke-inflight-status.md`).
- **Read coverage from `coverage/coverage-final.json`, not the
  `pnpm test:coverage` text table** (style-guide.md § Coverage). After a
  full-workspace run that JSON holds only the _last project to finish_ — scope
  the run instead.
- **A fix round adding branches isn't done until the _gated_ run passes** —
  per-file thresholds run only under `test:coverage`, never a scoped `vitest`
  call. Trace the gap from `coverage-final.json`'s uncovered-line list and
  cover any new ternary's non-`Error` arm in the same edit
  (`docs/logs/2026-09-03-x11c-json-tree-viewer.md`,
  `2026-09-04-x11e-sqs-drilldown-acceptance.md`).
- **A suite failing while a spoke fan-out is running may be contention, not
  a regression — re-run it alone first**
  (`docs/logs/2026-08-19-a5-no-progress-detection.md`).
- Use `pnpm exec vitest`; bare `npx vitest` fails to resolve
  `@vitest/coverage-v8` under pnpm.
- **Brace void-union handler bodies** — a handler typed `void |
Promise<void>` whose arrow body returns a value fails typecheck (TS2322);
  the leniency applies only to a return type of _exactly_ `void`. Wrap the
  body: `() => { arr.push(v); }`.
- **Never explicitly parameterize `vi.spyOn<T, S>`'s return type** — an
  explicit type argument resolves against the first overload regardless of
  which one the call matches, failing a method spy with a `never`-constraint
  error though the runtime call is correct. Let TypeScript infer it from the
  `return` statement instead.
- **`bin/tests/**` IS type-checked, but only by the top-level `pnpm
typecheck`, not any per-package turbo task** — it checks `.mjs` exported
  JSDoc _signatures_ against call sites, never a `.mjs` file's own
  internals. Run the full `pnpm typecheck` before declaring such a change
  green.
- **Test a `bin/` checker against synthetic state, not just the live repo** —
  correctness against current state only proves it works _today_. Drive it
  with a synthetic bump instead (`docs/logs/2026-07-02-core-polling.md`).
- **Type a `bin/` helper's JSDoc `@param` to the fields it actually reads**,
  not a whole upstream return type — the full type forces every fixture to
  invent fields the function never touches.
