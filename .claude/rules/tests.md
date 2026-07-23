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
- **Mock Node built-ins via the async-factory form** that preserves real
  exports, then `vi.spyOn` individual methods:
  `vi.mock("fs", async () => { const actual = await vi.importActual<typeof import("fs")>("fs"); return { ...actual }; })`.
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
- **eslint runs in-loop** (`post-edit-verify`: prettier → eslint → typecheck →
  vitest). Resolve eslint findings as you write — don't defer them to a later
  `pnpm lint` pass; that defeats the in-loop signal.
- **Read coverage from `coverage/coverage-final.json`, not the
  `pnpm test:coverage` text table.** The v8 text reporter omits files that are
  100% on all four metrics, so an "absent" file in the table is not an uncovered
  file — the JSON is the source of truth.
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

```typescript
import { expect, test } from "vitest";
import { paginate } from "../src/index.js";

test("paginate respects the limit", () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toHaveLength(2);
});
```
