---
paths:
  - "**/tests/**"
  - "**/*.test.ts"
---

# Testing rules (`tests/**`, `*.test.ts`)

> Canonical rationale + examples: [`docs/contributing/style-guide.md` §
> Writing new tests](../../docs/contributing/style-guide.md#part-2--writing-new-tests).
> This file is the terse checklist that auto-loads when you edit a test.

- **Vitest**, files named `*.test.ts`, importing from `src/` with the `.js`
  extension (`../src/index.js`).
- **Every exported function gets a happy-path test plus one failure path.**
- **Test observable behavior, not implementation details** or private paths.
- **Deterministic and isolated:** no network, no filesystem; mock collaborators.
  Prefer stubs unless interaction verification is required. Clean up side effects.
- **Name tests by behavior**, not by the unit under test.
- **Assert the named behavior, not a proxy.** A test titled "suggests the
  near-miss key" must assert the suggestion actually appears in the output — not
  `message.length > 0`, and not merely that the call "doesn't throw". A proxy
  assertion leaves the named path unexercised behind green coverage (a
  "did-you-mean" test built with an empty schema returned early and left the whole
  Damerau-Levenshtein helper at ~10%, asserting nothing). If a behavioral stage's
  only test is "doesn't throw", it is a coverage gap — read
  `coverage/coverage-final.json` to catch a named-but-unexercised path.
- **A test that names a precedence, an ordering, or an "every X" guarantee must
  make every arm reachable in its own setup.** Distinct from the proxy rule
  above: the assertion can be exactly right and still prove nothing, because the
  precondition that discriminates never exists. A test named "integrity check
  wins over meaning check" built its store with no `definition`, so the mismatch
  branch could never fire — it would have passed identically under the opposite
  implementation (`2026-08-19-a4-checkpoint-fingerprint.md`). Three assertions
  passed trivially because the fields under test are _omitted_ when invalid, so
  "the planted secret is absent" held whether validation ran or not
  (`2026-08-19-a3-partial-run-outcome.md`). An invariant named over a set has to
  **enumerate** the set — `test.each` over every exit path, not one of them — or
  it silently becomes a test of one member.
- **Never mock the behavior the test exists to validate.** A stub that hands
  back the outcome under question asserts the stub, not the code, and still
  reads as coverage. `sqs-dead-letter-triage`'s apply path had ten tests and
  could not have caught that the whole path was a guaranteed no-op, because
  `receive` was mocked to hand the planned messages straight back
  (`docs/logs/2026-08-24-w8-sqs-dead-letter-triage.md`); a retry suite passed
  78/78 against a permissive test-only classifier while the real classifier was
  a complete no-op (`docs/logs/2026-07-13-dynamo-crud.md`). Exercise the real
  collaborator at least once — and when the subject _is_ a committed artifact,
  read the real filesystem unmocked, or the test only validates a copy pasted
  into itself (`docs/logs/2026-08-23-w7-cloudwatch-logs-analysis.md`).
- **Assert barrel reachability through the package entry point.** Every test
  here imports `src/` paths directly, so none of them can observe a broken
  namespace re-export. A `core/index.ts` missing its
  `export * from "./<module>/index.js";` line once passed the entire suite green
  while nothing in that submodule was reachable as `Core.*`. `tests/index.test.ts`
  carries a table-driven check naming one load-bearing symbol per submodule
  barrel — add a row when you add a submodule.
- **Audit test vehicles when a fix narrows what a field accepts.** A test that
  can no longer fail reads as coverage but is worse than none: projecting
  `M3LRunReport.archive` to a known shape silently disabled two regression
  lock-ins that used `archive` to carry arbitrary values.
- **Type-level tests with `expectTypeOf`** where the type IS the contract.
  `toEqualTypeOf` is strict about `readonly` property modifiers — a type with
  `readonly` members is _not_ equal to one with mutable members, and the failure
  surfaces as a cryptic `never[]`/`never` constraint mismatch. When the
  implementation's interface is (correctly) `readonly`, the expected literal in
  the assertion must be `readonly` too, or use `toMatchTypeOf`. A type test that
  fails against a correctly-`readonly` implementation is a test-side defect.
- **A type-only `expectTypeOf` test still executes its expression at runtime.**
  If the asserted expression invokes a fallible async method, resolve the mock to
  a valid value first (e.g. `adapter.number.mockResolvedValue(5)`) — otherwise a
  rejecting, un-awaited promise surfaces as an unhandled rejection ("1 error")
  even though the type assertion itself passes. A resolved un-awaited promise is
  fine; a rejecting one is not.
- **Parameterize** when the same logic is exercised against multiple inputs.
- **Never tolerate flaky tests** — diagnose and fix; do not mute or retry-mask.
- **A gate failing outside your change's blast radius is presumed pre-existing
  until disambiguated.** `git status` and `git diff origin/main -- <path>`
  settle it in seconds — cheaper than debugging your own diff for someone
  else's breakage. This is not licence to retry: if the re-run goes green with
  no explanation, that is a flake, and per the rule above it gets diagnosed and
  filed rather than pocketed
  (`docs/logs/2026-07-11-prepush-parallelization.md`,
  `docs/logs/2026-07-18-aws-lambda.md`,
  `docs/logs/2026-08-19-hub-sync-key-namespace.md`).
- **Mock Node built-ins via the async-factory form** that preserves real
  exports, then `vi.spyOn` individual methods:
  `vi.mock("fs", async () => { const actual = await vi.importActual<typeof import("fs")>("fs"); return { ...actual }; })`.
- **Mock an SDK package the same way once it has a mixed class-and-data
  export surface.** A plain `vi.mock("pkg", () => ({...}))` object literal
  silently omits every export the factory doesn't list — harmless while the
  module under test only imports _types_ from `pkg` (erased at compile time),
  but the moment it imports a value (e.g. an SDK's data-only enum object, to
  validate a caller-supplied string against `Object.values(SomeEnum)`), that
  import resolves to `undefined` under the mock and throws at module-load
  time before a single test can even register. Default new SDK-client mocks
  to the `importOriginal`-preserving async factory from the start — pass real
  constants/enums through unchanged, keep only the classes/functions that
  need mock behavior replaced (`aws/codepipeline`, 2026-07-27: adding runtime
  enum validation broke a mock written when only types were imported).
- **A step module reached only via dynamic `import()` in production code can
  mock with a plain `const stepMock = vi.fn()`; the moment any production code
  adds a _static_ import of anything from that same module — even just a
  shared constant, not the mocked function itself — its `vi.mock` factory
  starts running eagerly at module-eval time and the backing mock must move to
  `vi.hoisted(() => vi.fn())`.** A plain `const` initializes after `vi.mock`
  calls are hoisted, so an eagerly-evaluated factory referencing it throws
  `Cannot access '<name>' before initialization`. This is the same rule that
  already applies to a statically-imported package (e.g. `@m3l-automation/m3l-common`)
  — it just isn't obvious that promoting a shared constant out of a
  dynamic-import-only step module retroactively applies it to that step's mock
  too (`scripts/codepipeline-ops`, 2026-07-27: exporting `FAILED_STATUSES` out
  of `watch-execution.ts` for the dispatcher to statically import broke
  `run-codepipeline-ops.test.ts`'s previously-fine plain-`const`
  `watchExecutionMock`). When you add a static import from a step module,
  check whether that step's own test mock needs the same promotion in the same
  change.
- **Mock a port with generic methods by inference, not `extends`.** A structural
  port whose methods are generic (`select<Value>(...)`) can't be mocked via
  `interface Mock extends Port { select: ReturnType<typeof vi.fn> }` — a
  non-generic `Mock` is an invalid override of a generic signature (TS2430). Let
  the factory return the inferred object of `vi.fn()`s; it keeps the `.mock*` API
  usable and stays structurally assignable to the port at the injection site.
- **Keep the mock target in sync with the implementation's I/O primitive.** If
  the impl moves from `readFile` to `open()`/`FileHandle`, re-mock the new
  primitive (the old mock intercepts nothing) and cover the **post-acquire**
  failure path — a `read()`/`stat()` reject after a successful `open()` — not
  just acquisition.
- **TTY-dependent code:** set `process.stdout/stderr/stdin.isTTY` with
  `Object.defineProperty` in a `beforeAll` block — CI is non-TTY, so the
  property may be absent entirely, not just `false`.
- **Local test doubles:** subclassing an abstract export to exercise it (e.g. a
  `TestEmitter` over the emitter base) is the sanctioned pattern; keep the
  double in the test file.
- **Test-first, not test-after.** The failing test defines the contract: write
  tests from the doc contract, watch them fail for the right reason (the symbol
  doesn't exist yet), then let the implementation make them pass — don't backfill
  a test that just mirrors an implementation you already wrote.
- **Update `docs/implementation-status.md` Notes count in the same commit as any
  new test.** `check:test-counts` asserts the "N tests" value in every ✅ row
  matches the live Vitest count; a mismatch discovered at `pnpm verify` time
  forces a standalone `chore:` commit. Include the Notes update in the same
  feat/refactor commit that adds the test.
- **Per-file test size is ratcheted, not capped (ADR-0072).**
  `pnpm check:file-budget` enforces test files ≤ 60,000 chars against a
  committed baseline; a baselined file may not grow, and any other file must
  stay under the ceiling from the start. When a module's seam plan
  (`implementing-submodules` Step 5) partitions its public surface into
  several independently testable slices, name each slice's test file
  `<mod>-<facet>.test.ts` (e.g. `procedure-conditions.test.ts`), and that
  file must import **only the symbols its own slice ships** — never the
  whole module's public barrel. `perFile` v8 coverage
  (`vitest.config.ts`) binds a `src/` file to every test file that imports
  from it; a slice's test importing outside its own slice defeats the split
  by re-binding coverage across the whole module. `check:test-counts` keys
  its recorded count on the file's path relative to the tests root (not a
  shared basename), so sibling files like this are counted independently,
  not summed into one row.
- **Justify intentional `eslint-disable` on the error channel.** A module that
  tests its error channel throws/rejects non-`Error` values to prove
  normalization, which trips `only-throw-error` / `prefer-promise-reject-errors`.
  Disable narrowly with a `--` rationale so it isn't "fixed" into a real `Error`:

```ts
// eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the unknown channel
throw "a string";
```

### Test-tooling gotchas

- **Runtime-green ≠ typecheck-green.** Vitest transforms without type-checking;
  a test file that passes (or fails RED for the right reason) can still fail
  `tsc -b`. Run `pnpm typecheck` as its own gate on every test file you touch —
  in RED, the only expected diagnostics are the not-yet-existing module's
  missing symbols; anything else is a test-file defect to fix now.
- **`pnpm build` is a distinct gate from `pnpm typecheck`, not a slower version
  of it.** `isolatedDeclarations` is set only in each package's
  `tsconfig.build.json` (deliberately kept out of `tsconfig.base.json` — see its
  own comment there), so the two commands check structurally different things: an
  additive `as const satisfies` formulation passed `typecheck` and failed `build`
  with TS9010 (`2026-08-19-a3-partial-run-outcome.md`). Any change touching an
  **exported type** needs both before you call it green.
- **eslint runs in-loop** (`post-edit-verify`: prettier → eslint → typecheck →
  vitest). Resolve eslint findings as you write — don't defer them to a later
  `pnpm lint` pass; that defeats the in-loop signal.
- **Read coverage from `coverage/coverage-final.json`, not the
  `pnpm test:coverage` text table.** The v8 text reporter omits files that are
  100% on all four metrics, so an "absent" file in the table is not an uncovered
  file — the JSON is the source of truth.
- **A suite that fails while a spoke fan-out is running may be contention, not
  a regression — re-run it alone before believing it.** `pnpm test:coverage`
  exited non-zero once with five review spokes in flight, then passed twice in
  isolation; three concurrent suites can fan out to ~42 workers on this box
  (`docs/logs/2026-08-19-a5-no-progress-detection.md`). Don't schedule
  `test:coverage` against a live fan-out in the first place. Note the converse
  too: `check:test-counts`'s own flake turned out to be redundant work rather
  than contention, and it also failed sequentially — so don't stop at
  "contention" as the diagnosis either
  (`docs/logs/2026-08-19-check-test-counts-contention.md`).
- Use `pnpm exec vitest` / `pnpm test:coverage`; bare `npx vitest` fails to
  resolve `@vitest/coverage-v8` under pnpm.
- **Brace void-union handler bodies.** When a handler type is
  `void | Promise<void>` (e.g. `M3LEventHandler` on the emitter base), an arrow
  whose body returns a value — `on("evt", () => arr.push(v))` — fails typecheck
  (TS2322, `number` not assignable). The void-returning-callback leniency applies
  only to a return type of _exactly_ `void`, not a union containing it. Wrap the
  body: `() => { arr.push(v); }`.
- **Never explicitly parameterize `vi.spyOn<T, S>`'s return type.** `vi.spyOn`
  is overloaded (get-accessor / set-accessor / plain method); TypeScript
  resolves an _explicit_ type-argument instantiation (`ReturnType<typeof
vi.spyOn<T, S>>`) against the first overload regardless of which one the
  actual call matches, so spying on a method (not an accessor) fails with
  `Type '"methodName"' does not satisfy the constraint 'never'` even though the
  runtime call `vi.spyOn(obj, "methodName")` is correct. Fix: drop the explicit
  return-type annotation on the helper that returns the spy and let TypeScript
  infer it from the `return` statement.
- **`bin/tests/**` is not type-checked by any gate.** `pnpm typecheck` runs
  `tsc` per package via turbo, and no `tsconfig` includes `bin/tests`, so a real
  type error there passes CI silently — only the IDE and type-aware ESLint see
  it (and `eslint.config.js` turns the `no-unsafe-*` rules off for this tree
  because it imports untyped `.mjs`). Read the editor diagnostics before
  declaring a `bin/tests` change green; a passing `pnpm verify` does not mean
  the file type-checks.
- **Test a `bin/` checker against synthetic state, not just the live repo.** A
  generator/checker whose correctness depends on current repo state (a count, a
  table's column order, an identifier pattern) can only be shown to pass
  _today_ by running it here — a bug that manifests on the _next_ change stays
  invisible. Drive its test with a synthetic bump: a differing total, a renamed
  column, a digit-bearing name. Three count/index gates shipped as latent
  no-ops for exactly this reason (`docs/logs/2026-07-02-core-polling.md`,
  `docs/logs/2026-07-13-aws-sqs.md`, `docs/logs/2026-07-13-aws-dynamodb.md`).
- **Type a `bin/` helper's JSDoc `@param` to the fields it actually reads**, not
  to a whole upstream return type. Declaring
  `@param {ReturnType<typeof actionableItems>}` when the function only touches
  two of its properties forces every test fixture to invent the rest; the real
  caller still satisfies a narrowed structural type unchanged.

```typescript
import { expect, test } from "vitest";
import { paginate } from "../src/index.js";

test("paginate respects the limit", () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toHaveLength(2);
});
```
