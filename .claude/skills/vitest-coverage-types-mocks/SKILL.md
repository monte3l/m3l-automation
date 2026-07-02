---
name: vitest-coverage-types-mocks
description: >-
  How this repo runs Vitest — the vitest.config.ts coverage gate, the v8 per-file
  thresholds, and the mocking / type-testing patterns the tests rely on. Use
  whenever you are editing vitest.config.ts, changing coverage thresholds or
  include/exclude, writing or fixing a mock (vi.mock, vi.spyOn, vi.hoisted), adding
  expectTypeOf type-level assertions, or debugging a coverage-threshold failure or
  a hoisting/"cannot access before initialization" mock error in m3l-automation.
  Reach for it even when the user says "coverage is failing", "mock this module",
  "why is my spy not working", "test the types", or "adjust the vitest config" —
  anything touching Vitest here. Pairs with the tests.md rule (which carries the
  project's testing philosophy); this skill is the config + mocking mechanics. Not
  for generic Vitest questions unrelated to this repo (use the context7-mcp skill).
---

# Vitest coverage, types & mocks (m3l-automation)

Config lives in [`vitest.config.ts`](../../../vitest.config.ts). The suite runs
with `pnpm test` (once) / `pnpm test:coverage` (gated) / `pnpm test:watch`, on
Vitest 4 + the v8 coverage provider, ESM + TypeScript native (no CJS layer).

## When to use

Editing `vitest.config.ts`, writing/fixing mocks, adding `expectTypeOf` tests, or
diagnosing a coverage-gate or mock-hoisting failure. For _what_ to test (happy +
failure path, behavior over internals), see the `tests.md` rule — this skill is
the mechanics.

## How this repo's config works

- **`include`**: `**/tests/**/*.test.ts` and `**/*.test.ts`.
- **`exclude`**: `dist`, `node_modules`, and **`.claude/worktrees/**`** — those are
  nested checkouts of other branches; running their tests from the main tree is
  wrong.
- **Coverage** (`coverage: { provider: "v8", … }`):
  - `include: packages/*/src/**/*.ts`; `exclude: **/index.ts`, `**/*.d.ts`
    (barrels/type files carry no logic to cover).
  - `reporter: ["text", "html", "json"]`. The **`json`** reporter writes
    `coverage-final.json` — trust it as the per-file source of truth, because the
    v8 **text table hides files that are 100% on every metric**, which makes a
    real gap look absent.
  - `thresholds`: 80% `lines`/`functions`/`branches`/`statements`, with
    **`perFile: true`** so each file must clear 80% individually (not just the
    aggregate).
  - `coverage.all` defaults to **false** in v8, so only files that appear in the
    report (i.e. have at least one test) are gated — a not-yet-implemented module
    simply doesn't show up and won't trip the gate. Turning `all` on would gate
    every source file including untested ones.

## Coverage-gate mechanics to keep in mind

- Because `perFile` is on, adding code to a file without covering it can fail the
  file even if the repo aggregate is healthy. Read `coverage-final.json`, not the
  text table, when hunting the missing lines.
- Thresholds are deliberately modest for a young library — raise them as real code
  lands rather than lowering them to pass.

## Mocking patterns (Vitest 4)

- **`vi.mock` is hoisted** to the top of the file and runs before imports, so its
  factory can't close over file-scope variables. For values you need inside a
  factory, wrap them in **`vi.hoisted(() => …)`**; for conditional/lazy mocking use
  **`vi.doMock`** (not hoisted).
- **Partial mock via async factory** — preserve real exports, override a few:
  ```ts
  vi.mock(import("./thing.js"), async (importOriginal) => {
    const mod = await importOriginal<typeof import("./thing.js")>();
    return { ...mod, doNetwork: vi.fn() };
  });
  ```
- **Auto-spy without replacing** — `vi.mock("./thing.js", { spy: true })` calls the
  real implementation but wraps exports so you can assert on calls.
- **`vi.spyOn(obj, "method")`** observes/overrides a method on an existing object;
  supports `.mockImplementationOnce()` and the standard assertions. This is the
  preferred way to mock `node:fs` read methods in unit tests (ESLint bans real fs
  _mutations_ in tests — see `tests.md`).
- Keep the mock target in sync with the code's actual I/O primitive; a stale mock
  target silently tests nothing.

## Type-level tests

- **`expectTypeOf`** asserts types at compile time (e.g.
  `expectTypeOf(fn).parameter(0).toEqualTypeOf<string>()`). Use it where the type
  _is_ the contract; type assertions cost no runtime and run under `pnpm test`.

## Verify

`pnpm test` for correctness, `pnpm test:coverage` for the gate. If a mock "does
nothing", check hoisting (factory closing over an un-hoisted variable) and that
the mocked path matches the import specifier exactly.

## Full API reference

For the current Vitest 4 config/coverage/mocking API surface, see
[`references/vitest-coverage-types-mocks.md`](references/vitest-coverage-types-mocks.md).
