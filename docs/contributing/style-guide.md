# Style Guide

The single source of truth for **how code and tests are written and changed** in
`@m3l-automation/m3l-common`. It covers three things:

1. **[Part 1 — Writing new code](#part-1--writing-new-code)**
2. **[Part 2 — Writing new tests](#part-2--writing-new-tests)**
3. **[Part 3 — Refactoring existing code & tests](#part-3--refactoring-existing-code--tests)**

The library is TypeScript 6.x (`strict: true`), ESM-only, compiled with `tsc`,
targeting Node.js 24 LTS+. Formatting and import order are owned by Prettier and
ESLint — never hand-format.

## How to read this guide

Every rule is tagged with how it is enforced, so the guide never implies a
guarantee the tooling does not make:

- **[enforced]** — a linter, the type-checker, a Git hook, a Claude Code hook,
  commitlint, or CI blocks a violation. Listed for completeness; you rarely have
  to think about these because the machine catches them.
- **[advisory]** — there is **no automated guard**. These are the rules that need
  conscious care in authoring and review; the reviewer agents
  (`.claude/agents/*reviewer*`) are the backstop.

The terse, path-scoped extracts under `.claude/rules/` (which auto-load when you
edit a matching file) point back to the relevant section here. This document is
the canonical text; those are its checklists.

---

## Part 1 — Writing new code

### TypeScript strictness

- **No `any`.** Use `unknown` for untrusted or dynamic data and narrow it with a
  type guard before use. There is no `any` anywhere in the public API. **[enforced]**
  (`@typescript-eslint/no-explicit-any`)
- **No non-null `!` assertions.** Prove a value is present through a guard, a
  default, or control flow. **[enforced]** (`@typescript-eslint/no-non-null-assertion`)
- **`strict: true` is non-negotiable**, together with `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.
  **[enforced]** (`tsconfig.base.json` + `pnpm typecheck`)

```typescript
// Avoid: silences the type system without proving anything.
const first = items[0]!;

// Prefer: narrow explicitly.
const first = items[0];
if (first === undefined) throw new M3LValidationError("empty input");
```

### Imports & modules (ESM)

- **Every relative import carries the `.js` extension** (`./foo.js`), even though
  the source file is `.ts`. `tsc` does not add it and Node will not resolve
  without it. **[enforced]** (`import-x/extensions` + the `guard-js-extension.mjs`
  creation-time hook)
- **No CommonJS.** No `require`, `module.exports`, `exports.x`, `__dirname`, or
  `__filename`. **[enforced]** (`import-x/no-commonjs`, `no-restricted-globals`,
  the `guard-no-commonjs.mjs` hook)
- **No top-level side effects** — modules must be import-safe so consumers
  tree-shake cleanly. **[advisory]**
- **Declare & load dependencies per [ADR-0017](../adr/0017-dependency-loading-standard.md)** —
  required deps go in exact-pinned `dependencies`; optional deps go in
  caret-ranged `peerDependencies` + `peerDependenciesMeta.optional` and must be
  lazy-loaded behind a typed `ERR_*_MISSING_DEP` error. **[enforced]**
  (`pnpm check:deps`)

### Exports

- **Named exports only; no default exports** in shipped source. Named exports keep
  the surface explicit, tree-shakeable, and refactor-safe. **[enforced]**
  (`import-x/no-default-export`, scoped to `packages/*/src/**`;
  tests and config files legitimately use default exports.)
- **Export each type next to the value it describes**, so a consumer importing a
  function also finds its types. **[advisory]**

### Naming

- **Identifiers reflect the domain language, not the mechanism**, and are
  descriptive without external docs. Single-letter names only in scopes small
  enough to be unambiguous (a two-line loop index). **[advisory]**
- **Casing:** `camelCase` for variables/functions/parameters (`UPPER_CASE`
  permitted for module constants); `PascalCase` for classes, interfaces, type
  aliases, and enums. **[enforced]** (`@typescript-eslint/naming-convention`).
  Property names are deliberately **not** casing-checked because they mirror
  external shapes (JSON fields, env keys like `M3L_DEPLOYMENT_MODE`).
- **`M3L` class prefix.** Public classes — especially the error hierarchy — are
  prefixed `M3L` (`M3LError`, `M3LConfig`, `M3LPaths`, `M3LScript`). **[advisory]**
- **Function type-alias suffixes.** When a property or parameter takes a function,
  extract a **named** type alias whose suffix states the role rather than inlining
  the function type. Use `Fn` only when no suffix fits; avoid `Callback`/`Function`.
  **[advisory]**

  | Suffix        | Role                              |
  | ------------- | --------------------------------- |
  | `Handler`     | reacts to an event or value       |
  | `Validator`   | checks input, may throw or report |
  | `Transformer` | maps a value to a reshaped value  |
  | `Mapper`      | maps one item to another          |
  | `Predicate`   | returns a boolean                 |
  | `Formatter`   | renders a value to a string       |
  | `Hook`        | lifecycle callback                |

  ```typescript
  export type RowValidator<T> = (row: T, index: number) => void;
  export type RetryPredicate = (error: unknown) => boolean;
  export type LogFormatter = (event: M3LLogEvent) => string;
  ```

### Immutability

- **Prefer `readonly` and `const`; create new objects instead of mutating inputs.**
  Use `readonly T[]` / `ReadonlyArray<T>` for public return types and `as const`
  for literal tuples/objects that must not widen. `readonly`/`const` intent is
  **[advisory]**, but **never reassign a parameter or mutate its properties**.
  **[enforced]** (`no-param-reassign` with `props: true`)

```typescript
export function dedupe(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}
```

### `interface` vs `type`

- Use `interface` for object shapes callers implement or extend; use `type` for
  unions, intersections, mapped types, and branded types. **[advisory]** (the
  compiler cannot express this split as a single lint rule).

```typescript
export interface ConfigProvider {
  get(key: string): string | undefined;
}
export type LogLevel = "debug" | "info" | "warning" | "error";
```

### Control flow

- Use `===` / `!==`; `== null` only as the deliberate combined null/undefined
  check. **[enforced]** (`eqeqeq` with `{ null: "ignore" }`)
- A `switch` over a finite set must be **exhaustive** — handle every case and fail
  loudly in an unreachable `default` via a `never` binding. **[enforced]**
  (`@typescript-eslint/switch-exhaustiveness-check`)
- Prefer `for...of` over `forEach`; never use `for...in` on arrays. **[advisory]**

```typescript
function label(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "verbose detail";
    case "info":
      return "normal";
    case "warning":
      return "needs attention";
    case "error":
      return "failure";
    default: {
      const exhaustive: never = level;
      throw new M3LError(`unknown level: ${String(exhaustive)}`, {
        code: "UNKNOWN_LOG_LEVEL",
      });
    }
  }
}
```

### Public-API typing

- **Model the surface precisely.** Use **branded types** for values carrying an
  invariant the compiler should track, and **generic containers** for structured
  results. **[advisory]**
- **Give exported functions explicit parameter and return types.** Inference is
  fine inside a body; the module boundary must be spelled out. **[enforced]**
  (`@typescript-eslint/explicit-module-boundary-types`)

```typescript
export type UserId = string & { readonly __brand: unique symbol };
export type Page<T> = { items: readonly T[]; total: number };

export function paginate<T>(items: readonly T[], limit: number): Page<T> {
  return { items: items.slice(0, limit), total: items.length };
}
```

### Error handling

The library throws typed errors from a single hierarchy rooted at `M3LError`.
Subclass it per failure mode so callers can discriminate on a `readonly` literal
`code`. **[advisory]** (the type-checker enforces "throw an `Error`, not a string"
via `@typescript-eslint/only-throw-error`, but the `M3LError` subclassing, the
`code` literal, and `cause` chaining are advisory.)

- **Never throw bare strings; never swallow an error silently.**
- **Chain the underlying failure with the `cause` option** so the stack is not lost.
- **Do not export a subclass's constructor-options interface** — callers _catch_
  errors, they don't construct them. (The base `M3LErrorOptions` is the one public
  exception, because subclasses build on it.)
- **Filesystem errors:** ignore **only** `ENOENT` (via a small denylist `Set`) and
  **re-throw** `EACCES`/`EPERM`. Scope any silent-skip to _parse failures only_ —
  never wrap a whole `catch`.

```typescript
export class M3LError extends Error {
  readonly code: string;
  override readonly cause: unknown;
  constructor(message: string, options: M3LErrorOptions) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.cause = options.cause;
  }
}

export class M3LValidationError extends M3LError {
  override readonly code = "VALIDATION" as const;
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: "VALIDATION", cause: options.cause });
  }
}

// Preserve the original failure when wrapping a lower-level one:
try {
  return JSON.parse(text) as unknown;
} catch (cause) {
  throw new M3LValidationError("config is not valid JSON", { cause });
}
```

### TSDoc

- **TSDoc on every exported symbol**, with an `@example` on primary entry points.
  Comment the _why_, not the _what_. **[advisory]** — only TSDoc _well-formedness_
  is checked (`tsdoc/syntax`, a warning); _presence_ is not mechanized, so it needs
  conscious care and review.

```typescript
/**
 * Splits a list into a single page of at most `limit` items.
 *
 * The original list is never mutated; `total` reflects the full input size so
 * callers can drive pagination UIs without a second count.
 *
 * @example
 * paginate(["a", "b", "c"], 2); // { items: ["a", "b"], total: 3 }
 */
export function paginate<T>(items: readonly T[], limit: number): Page<T> {
  return { items: items.slice(0, limit), total: items.length };
}
```

### Privacy & the `exports` contract

- **`internal/` is private.** Never re-export it through a public barrel; it has no
  `exports` entry and may change without a major bump. **[enforced]**
  (`import-x/no-restricted-paths` on the three public barrels)
- **The `exports` map is the public contract** (`.`, `./core`, `./aws`). New
  Core/AWS submodules surface through the namespace barrel, **never** as a new
  subpath. Adding, removing, or retyping a subpath is a semver event — plan before
  editing it. **[enforced]** (`guard-exports-semver.mjs` flags drift; also
  `publint` + `attw` in CI)

### Complexity & size

- Functions must be small enough that their purpose fits one sentence; extract
  duplication into a single shared unit; flatten deep nesting with early returns.
  **[enforced]** (`complexity: 10`, `max-depth: 3`,
  `max-lines-per-function: 60`, scoped to source)
- No magic numbers/strings in logic — lift them to named constants. **[enforced]**
  (`@typescript-eslint/no-magic-numbers`, ignoring `-1/0/1`)

---

## Part 2 — Writing new tests

### Runner, layout & the unit-only policy

- **Vitest.** Test files are `*.test.ts`, placed at
  `packages/m3l-common/tests/<module>.test.ts`, importing from `src/` with the
  `.js` extension (`../src/core/foo/index.js`). **[enforced]** (discovery +
  `.js`-extension lint)
- **This library's suite is unit-only by design.** Tests are deterministic and
  isolated: **no network, no filesystem** — mock the I/O primitive instead. The
  broader test pyramid in `rules/02-testing.md` (integration/E2E layers exercising
  real databases/brokers/filesystems) describes general practice and is
  _aspirational_ here: a pure ESM utilities library has no such integration points,
  so those layers are intentionally absent. **[enforced]** (real `fs` mutation and
  bare `fetch()` are banned in tests by `no-restricted-syntax`)

### What to test

- **Every exported function gets a happy-path test plus at least one failure
  path**, and the edge/boundary cases the contract implies. **[advisory]**
- On the failure path, **assert the specific `M3LError` subclass and check the
  chained `cause`**. **[advisory]**
- **Test observable behavior, not implementation details** or private fields — so
  a test survives a refactor. **[advisory]**

```typescript
// bad — asserts a private field the contract never promised
expect((poller as unknown as { _attempts: number })._attempts).toBe(3);
// good — asserts the observable outcome
await expect(poller.poll(check)).resolves.toEqual({ status: "done" });
```

### Test body structure

- **Arrange–Act–Assert.** Set up inputs, execute the unit once, then assert on the
  result. Keep each test focused on **one behavior**: if the name needs "and",
  split it. **[advisory]**
- **Name tests by behavior, not by the unit under test** — `"returns the chained
cause when the source rejects"`, not `"fromPromise works"`. **[advisory]**

### Type-level tests

- Use **`expectTypeOf`** where the type _is_ the contract (branded types, generic
  containers, discriminated unions like `M3LResult`). **[advisory]**
- **`readonly` caveat:** `toEqualTypeOf` is strict about `readonly` modifiers — a
  `readonly` type is _not_ equal to a mutable one, and the mismatch surfaces as a
  cryptic `never` error. Against a correctly-`readonly` implementation, make the
  expected literal `readonly` too, or use `toMatchTypeOf`. On Vitest 4.x use
  `.toBeBigInt()` (not `.toBigInt()`) and `.toMatchTypeOf<T>()` for subtypes.

```typescript
expectTypeOf<M3LResult<number, Error>>().toEqualTypeOf<
  M3LResultOk<number> | M3LResultErr<Error>
>();
```

### Mocking & isolation

- **Prefer stubs over mocks** unless you are verifying an interaction. **[advisory]**
- **Mock Node built-ins via the async-factory form** that preserves real exports,
  then `vi.spyOn` individual methods. **[advisory]**

  ```typescript
  vi.mock("node:fs/promises", async () => {
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    return { ...actual };
  });
  ```

- **Keep the mock target in sync with the implementation's I/O primitive.** If the
  impl moves from `readFile` to `open()`/`FileHandle`, re-mock the _new_ primitive
  (the old mock intercepts nothing) and cover the **post-acquire** failure path — a
  `read()`/`stat()`/`close()` that rejects _after_ a successful `open()`, not just
  acquisition. Treat an I/O-primitive change as a coordinated implementer +
  test-author change. **[advisory]**
- **Only write teardown for collaborators you actually mock.** Do not add
  `afterEach(() => vi.restoreAllMocks())` to a suite of pure functions — a dead
  teardown is clutter that later needs removal. **[advisory]**

### Fixtures & test doubles

- **In-file doubles are the default.** Subclassing an abstract export to exercise
  it (e.g. a `TestEmitter` over an emitter base) is the sanctioned pattern; keep
  the double in the test file. **[advisory]**
- **Promote a helper to `tests/helpers/` only when it is shared across more than
  one test file** (e.g. `tests/helpers/fake-path.ts`). A double or fixture used by
  a single file stays in that file. **[advisory]**

### Parameterization & determinism

- **Parameterize with `test.each`** when the same logic is exercised over many
  inputs; a 2-tuple row callback must accept both params. **[advisory]**
- **Drive time explicitly** with `vi.useFakeTimers()` /
  `vi.advanceTimersByTimeAsync()` — never wall-clock `sleep`. **[advisory]**
- **TTY-dependent code:** set `process.stdout/stderr/stdin.isTTY` with
  `Object.defineProperty` in a `beforeAll` (CI is non-TTY, so the property may be
  absent entirely, not just `false`). **[advisory]**
- **Never tolerate a flaky test** — diagnose and fix the nondeterminism; do not
  mute or retry-mask it. (In this repo, "quarantine" is not an option: the suite is
  small and unit-only, so a flake is fixed immediately, not parked. Quarantine in
  `rules/05` is a general large-suite CI practice, not a licence to mute these
  tests.) **[advisory]**

### Coverage

- **80% per-file** on lines, functions, branches, and statements. **[enforced]**
  (`vitest.config.ts` thresholds; `pnpm test:coverage` in pre-push + CI)
- **v8 text-reporter caveat:** the terminal table _hides files at 100%_, so a
  missing row is not a missing gate. `coverage/coverage-final.json` is the
  authoritative source when auditing what is covered.

---

## Part 3 — Refactoring existing code & tests

Refactoring changes internal structure **without changing observable behavior**.
It is not feature work, performance work, or a behavior change — those are separate
commits.

### Preconditions

- **A passing automated test suite must exist before refactoring begins.** If the
  area lacks tests, **add characterization tests first** to capture current
  behavior, then refactor. **[advisory]**
- **State the intended outcome up front:** what improves (duplication, complexity,
  naming, type safety) and how the improvement is verified. Refactoring without an
  identified problem generates churn without value. **[advisory]**

### Procedure

- Proceed in **small, isolated steps** — one focused operation each (extract a
  function, rename an identifier, replace a conditional, consolidate a duplicate).
  **[advisory]**
- **Rerun the full relevant suite after every step;** treat any failure as a
  regression and revert before continuing. **[advisory]**
- **Commit each step individually** with a `refactor:` Conventional Commit so a
  regression can be bisected cleanly. `refactor:` does not trigger a release.
  **[enforced]** (commitlint validates the type)

### Opportunistic refactoring (the Boy-Scout rule)

- **Leave the code better than you found it.** When you touch a file for a feature
  or fix and see something unclear nearby, improve it right there — or do a
  **preparatory** refactor first if restructuring an API makes the change you came
  to do simpler. **[advisory]**
- **Know when to stop.** Opportunistic cleanup must stay bounded — do not chase one
  fix into an open-ended rewrite ("down the yak-hair rabbit hole"). Leave the rest
  better _next_ visit. Keep opportunistic changes in their own commit, separate
  from the feature/fix. **[advisory]**

### Scope boundaries — a refactor MUST NOT

- add new features or capabilities;
- alter observable behavior;
- introduce new external dependencies (and never without updating the lockfile);
- **change a public interface** unless that _is_ the explicit, coordinated purpose.
  **[advisory]**

### The library-specific hazard: semver

- **Changing an exported signature or the `exports` map is a semver event**, not a
  free refactor. A "pure refactor" that retypes a public function or a subpath is a
  breaking change for consumers. Keep the public surface stable, or plan the major
  bump explicitly. **[enforced]** (`guard-exports-semver.mjs`; `publint`/`attw` in CI)
- New Core/AWS capability still surfaces through the namespace barrel, never a new
  `exports` subpath.

### Refactoring tests

- **Tests are production code** — refactor, parameterize, and keep them healthy.
  **[advisory]**
- **Rename a test when the behavior it describes is renamed;** delete tests that no
  longer assert anything the contract promises; **refactor a shared fixture once**
  rather than editing every test that uses it. **[advisory]**
- When an implementation's I/O primitive changes, update the mock target in the
  same change (see Part 2) — a stale mock silently stops intercepting. **[advisory]**

### Validation

Before a refactor is accepted, at least one must be answerable "yes": does it make
error handling more consistent, make the code easier to test, reduce duplication
without obscuring logic, or solve a real problem the team has? If none hold, do not
merge it as a refactor. Rerun the full suite, update any docs referring to renamed
internals, and confirm the public surface is unchanged. **[advisory]**

---

## Alignment with external standards

Where they fit this library's constraints, these rules track current major style
guides: named-exports-only and namespace imports (Google TypeScript Style Guide);
`camelCase`/`PascalCase`, no leading/trailing underscores, small single-purpose
functions (Airbnb JavaScript Style Guide); `unknown`-not-`any`, strict flags,
`verbatimModuleSyntax` (TypeScript ESM authoring guidance); Arrange–Act–Assert,
one-behavior-per-test, behavior-named tests, fresh-instance isolation (Vitest);
and the Boy-Scout / preparatory / opportunistic model with a "know when to stop"
bound (Fowler, Martin).

## See also

- Deep rationale — [`rules/01-code-quality-and-standards.md`](../../rules/01-code-quality-and-standards.md)
  (quality hierarchy, anti-patterns, review checklist) and
  [`rules/02-testing.md`](../../rules/02-testing.md) (test pyramid theory, TDD cycle).
- Auto-loading extracts — `.claude/rules/library-src.md`, `.claude/rules/tests.md`,
  `.claude/rules/refactoring.md`, `.claude/rules/scripts.md`.
- [Contributing](./contributing.md) · [Architecture](../m3l-common-architecture.md)
