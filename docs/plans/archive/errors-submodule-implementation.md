# Plan: Implement the `errors` submodule (Core / errors)

## Context

`@m3l-automation/m3l-common` is a documented-but-empty scaffold: barrels are wired,
all 21 submodules are `❌ not-started` in `docs/implementation-status.md`. `errors`
is **first in the suggested order** — it is foundational and dependency-free, and
every later submodule throws `M3LError` subclasses and (optionally) returns
`M3LResult<T, E>`. Implementing it correctly unblocks the rest of the build.

**Goal:** implement the `errors` submodule to its documented contract
(`docs/reference/core/errors.md`, 22 public symbols), surfaced through the `Core`
namespace barrel, tested ≥80%, reviewed, and committed as a `feat:` — with the
three-entry `exports` map (`.`, `./core`, `./aws`) **unchanged**.

**Process:** the project's existing **hub-and-spoke TDD loop**
(`.claude/skills/implement-submodule/SKILL.md`). The main agent is the **hub**
(coordinates, owns only the `docs/implementation-status.md` bookkeeping write);
it **never writes `src/`/tests and never reviews**. All substantive work runs in
isolated spokes. **No dependency gate** — `errors` has zero runtime deps.

**Routing assumption:** spokes may route to **Haiku 4.5** (weakest routable model).
Therefore every spoke dispatch below is **self-contained**: it carries the full
contract, exact file paths, exact commands, the expected RED/GREEN signal, and the
inline few-shot examples — nothing is left to model inference.

---

## The contract (authoritative: `docs/reference/core/errors.md`)

Public surface of `errors/index.ts` — **22 symbols**. Phase 1 re-derives this
verbatim from the doc; it is reproduced here to ground the plan.

**Types & classes (5):** `M3LError`, `M3LErrorOptions`, `M3LResult<T, E>`,
`M3LResultOk<T>`, `M3LResultErr<E>`

**`M3LErrorUtils` functions (6):** `getErrorMessage(error: unknown): string`,
`toError(error: unknown): Error`,
`wrapError(cause: unknown, message: string, options?: Omit<M3LErrorOptions,"cause">): M3LError`,
`getErrorStack(error: unknown): string | undefined`,
`hasErrorName(error: unknown, name: string): boolean`,
`errorMessageContains(error: unknown, substring: string): boolean`

**Result operators (11):** `ok<T>(value): M3LResultOk<T>`,
`err<E>(error): M3LResultErr<E>`, `isOk(result): result is M3LResultOk<T>`,
`isErr(result): result is M3LResultErr<E>`, `unwrap(result): T` (throws on err),
`unwrapOr(result, default): T`, `map(result, fn): M3LResult<U,E>`,
`mapErr(result, fn): M3LResult<T,F>`, `andThen(result, fn): M3LResult<U,E>`,
`fromPromise(promise): Promise<M3LResult<T, M3LError>>`,
`tryCatch(fn): M3LResult<T, unknown>`

**Behavioral contracts (from the doc's "Notes and behavior"):**

- `M3LError extends Error` and adds `code: string`, `context: Record<string, unknown>`,
  a properly-typed `cause: Error | undefined` (set via options), and
  `toJSON()` that serializes **all fields including `stack`**. Constructor:
  `new M3LError(message, { code, context?, cause? })` — `code` is required in
  `M3LErrorOptions`. Subclasses (e.g. `RecordNotFoundError extends M3LError`) must
  keep working — set `name` from the actual constructor so `hasErrorName` and
  `instanceof` behave.
- `cause` is chained via the options object, never by re-throwing. `wrapError`
  produces an `M3LError` whose `cause` is the normalized caught value.
- `toError`/`getErrorMessage` are for `catch (error: unknown)` — they narrow
  `unknown` without `any`. `getErrorStack` returns `undefined` when absent.
- `M3LResult<T,E>` is a **discriminated union**; `isOk`/`isErr` narrow it. `unwrap`
  throws (an `M3LError`) on an err result; `unwrapOr` stays exception-free.
- `map`/`andThen` pass an err through unchanged; `mapErr` passes ok through
  unchanged. `fromPromise` turns a rejection into `err(...)`; `tryCatch` turns a
  throw into `err(...)`.

---

## File layout

```text
packages/m3l-common/src/core/errors/
  index.ts          # BARREL — re-export only (see coverage note); no logic
  M3LError.ts       # M3LError class + M3LErrorOptions
  M3LResult.ts      # M3LResult/Ok/Err types + ok,err,isOk,isErr,unwrap,unwrapOr,
                    #   map,mapErr,andThen,fromPromise,tryCatch
  M3LErrorUtils.ts  # getErrorMessage,toError,wrapError,getErrorStack,
                    #   hasErrorName,errorMessageContains
```

Then append **one line** to `packages/m3l-common/src/core/index.ts`:

```ts
export * from "./errors/index.js";
```

**Why split into named files (not a single `index.ts`):** `vitest.config.ts`
excludes `**/index.ts` from coverage (`exclude: ["**/index.ts", "**/*.d.ts"]`).
Logic placed in `index.ts` would be invisible to the 80% gate. File names follow
`docs/m3l-common-architecture.md`, which names `M3LError.ts` and `M3LResult.ts`.
`errors/index.ts` re-exports from the three sibling files; `core/index.ts`
re-exports the `errors` barrel. **No new `exports`-map entry** — surfaced through
the namespace only (a subpath change is a semver event).

Tests live at `packages/m3l-common/tests/errors.test.ts`, importing from
`../src/core/errors/index.js` (relative, `.js` extension).

---

## Hub-and-spoke execution (the loop, applied to `errors`)

| Phase      | Spoke                                                                                      | Writes                             | Hub bookkeeping after |
| ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------- |
| 1 Contract | `spec-conformance-reviewer` (contract mode)                                                | nothing                            | —                     |
| 2 RED      | `test-author`                                                                              | `tests/errors.test.ts`             | `errors` → 🧪         |
| 3 GREEN    | `submodule-implementer`                                                                    | `src/core/errors/**` + barrel line | `errors` → 🟢         |
| 4 Review   | `code-reviewer` + `spec-conformance-reviewer` (conformance) — **parallel, single message** | nothing                            | `errors` → ✅         |
| 4b Fix     | `submodule-implementer` (only if Must-fix found)                                           | `src/core/errors/**`               | re-review until clean |

`errors` is **not** in the documented security-sensitive list (`aws/*`, `config`,
`logging`, `security`, `text`, `importers`), so **no `security-reviewer`**. (Noted
for the record: `toJSON()` serializes `context`/`stack`; the contract is to serialize
faithfully, and redaction is `logging`'s responsibility, not `errors`'.)

**Hub rules:** never edit `src/`/`tests/` or review; never add an `exports` entry;
the only file the hub writes is `docs/implementation-status.md` (and this plan copy).
Guard hooks enforce the rest at write time (`.js` extension, no CommonJS, protected
paths; `post-edit-verify` auto-formats + typechecks + runs related tests).

### Step order

1. **Copy this plan** to `docs/plans/errors-submodule-implementation.md`.
2. **Phase 1** — dispatch contract spoke; keep its output text verbatim.
3. **Phase 2** — dispatch `test-author` with the contract; confirm RED (symbols
   absent / import fails). Mark `errors` 🧪 in `docs/implementation-status.md`.
4. **Phase 3** — dispatch `submodule-implementer` with contract + RED tests; drive
   GREEN. Mark 🟢.
5. **Phase 4** — dispatch the two reviewers in parallel. Route Must-fix back to the
   implementer (4b); re-run until clean. Mark ✅.
6. **Verify + commit** — full gate (below), then
   `feat: implement core/errors submodule` (minor; barrel surface, exports map
   unchanged). Small, meaningful commit.

---

## Few-shot examples (carry these inline into the spoke prompts)

These are **errors-specific** exemplars (the generic ESM/named-export rules already
live in the skill). They make the contract unambiguous for a Haiku-4.5 spoke.

### Example 1 — `M3LError` class shape (implementer)

```ts
// M3LError.ts
export interface M3LErrorOptions {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly cause?: Error;
}

export class M3LError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  // Node's Error already stores `cause`; re-declare it as the narrowed type.
  declare readonly cause?: Error;

  constructor(message: string, options: M3LErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name; // subclasses get their own name → hasErrorName works
    this.code = options.code;
    this.context = options.context ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
      cause: this.cause === undefined ? undefined : this.cause.message,
    };
  }
}
```

### Example 2 — `M3LResult` discriminated union + an operator (implementer)

```ts
// M3LResult.ts
export type M3LResultOk<T> = { readonly ok: true; readonly value: T };
export type M3LResultErr<E> = { readonly ok: false; readonly error: E };
export type M3LResult<T, E> = M3LResultOk<T> | M3LResultErr<E>;

export const ok = <T>(value: T): M3LResultOk<T> => ({ ok: true, value });
export const err = <E>(error: E): M3LResultErr<E> => ({ ok: false, error });

export const isOk = <T, E>(r: M3LResult<T, E>): r is M3LResultOk<T> => r.ok;

export function unwrap<T, E>(r: M3LResult<T, E>): T {
  if (r.ok) return r.value;
  // exception at the boundary — typed error, never a bare string
  throw new M3LError("called unwrap on an err result", {
    code: "RESULT_UNWRAP_ON_ERR",
    context: { error: r.error },
  });
}
```

### Example 3 — type-level test where the type IS the contract (test-author)

```ts
// tests/errors.test.ts
import { expectTypeOf, test } from "vitest";
import { ok, err, isOk } from "../src/core/errors/index.js";
import type { M3LResult, M3LResultOk } from "../src/core/errors/index.js";

test("isOk narrows the discriminated union", () => {
  const r: M3LResult<number, Error> = ok(1);
  if (isOk(r)) {
    expectTypeOf(r).toEqualTypeOf<M3LResultOk<number>>();
    expectTypeOf(r.value).toBeNumber();
  }
});

test("err carries the error channel type", () => {
  expectTypeOf(err(new Error("x"))).toMatchTypeOf<{
    ok: false;
    error: Error;
  }>();
});
```

### Example 4 — happy + failure path per export, deterministic (test-author)

```ts
import { expect, test } from "vitest";
import {
  M3LError,
  unwrap,
  ok,
  err,
  wrapError,
  fromPromise,
  isErr,
} from "../src/core/errors/index.js";

test("unwrap returns the value on ok", () => {
  expect(unwrap(ok(42))).toBe(42);
});

test("unwrap throws an M3LError on err (failure path)", () => {
  expect(() => unwrap(err(new Error("boom")))).toThrowError(M3LError);
});

test("wrapError chains the underlying cause", () => {
  const root = new Error("disk full");
  const wrapped = wrapError(root, "failed to write", { code: "WRITE_FAILED" });
  expect(wrapped).toBeInstanceOf(M3LError);
  expect(wrapped.cause).toBe(root);
  expect(wrapped.code).toBe("WRITE_FAILED");
});

test("fromPromise converts a rejection into an err result", async () => {
  const r = await fromPromise(Promise.reject(new Error("nope")));
  expect(isErr(r)).toBe(true);
});
```

---

## Spoke dispatch prompts (verbatim, self-contained for Haiku 4.5)

**Phase 1 — `spec-conformance-reviewer` (contract mode):**

> Contract mode. Read `docs/reference/core/errors.md` and the `errors` section of
> `docs/m3l-common-architecture.md`. Return the exact public surface of
> `errors/index.ts`: every one of the ~22 promised symbols with its kind
> (class/type/function), full signature, and type shape; the `M3LError` field/method
> contract (`code`, `context`, typed `cause`, `toJSON` serializes stack); the
> `M3LResult` discriminated-union shape and each operator's pass-through behavior;
> and which error is thrown by `unwrap` on an err result. Output a checklist. Do not
> review code or invent requirements beyond the doc.

**Phase 2 — `test-author` (RED):** pass the Phase-1 contract + Examples 1–4 above +
this instruction:

> Write `packages/m3l-common/tests/errors.test.ts` importing from
> `../src/core/errors/index.js`. Cover every exported symbol with a happy path and a
> failure path, plus `expectTypeOf` tests for `M3LResult`/`isOk`/`isErr` narrowing
> and the `ok`/`err` channel types. Tests must be deterministic and isolated (no
> network/filesystem). Run `pnpm vitest run packages/m3l-common/tests/errors.test.ts`
> and confirm it fails for the RIGHT reason — the `errors` symbols don't exist yet
> (import/resolution error), not a typo. Do not implement the module.

**Phase 3 — `submodule-implementer` (GREEN):** pass the contract + the RED tests +
Examples 1–2 + this instruction:

> Implement `packages/m3l-common/src/core/errors/` as four files —
> `M3LError.ts`, `M3LResult.ts`, `M3LErrorUtils.ts`, and a re-export-only
> `index.ts` barrel (no logic in the barrel; coverage excludes `index.ts`). Append
> `export * from "./errors/index.js";` to `src/core/index.ts`. Honor: ESM `.js` on
> every relative import; named exports only; no `any` (narrow `unknown`); no
> non-null `!`; `readonly`/`const`; throw `M3LError` subclasses with `cause`, never
> bare strings; TSDoc + `@example` on every exported symbol. Do NOT touch the
> `exports` map or `package.json` version. Drive
> `pnpm -C packages/m3l-common typecheck` and
> `pnpm vitest run packages/m3l-common/tests/errors.test.ts` to green. Stop if you
> would need a runtime dependency (you won't — this module is dep-free).

**Phase 4 — parallel, single message:**

- `code-reviewer`: review the `src/core/errors/**` diff against the four-part quality
  checklist + SOLID + project invariants (ESM `.js`, named exports, no `any`/`!`,
  TSDoc, `M3LError` + `cause`). Group Must-fix / Should-fix / Nits with file:line.
- `spec-conformance-reviewer` (conformance mode): diff `src/core/errors/index.ts` +
  the three files against `docs/reference/core/errors.md`. Report missing / extra /
  drifted symbols and unmet behavioral contracts (esp. `toJSON` serializes stack,
  `unwrap` throws on err, union narrowing). End with conformant / nits /
  non-conformant.

Route every **Must-fix** back to `submodule-implementer` (Phase 4b); re-run the two
reviewers until clean.

---

## Verification

**Per phase:**

- Phase 2: `pnpm vitest run packages/m3l-common/tests/errors.test.ts` → RED for the
  right reason.
- Phase 3: same command → GREEN; `pnpm -C packages/m3l-common typecheck` clean.

**Before commit (full gate):**

- `pnpm -C packages/m3l-common build` (tsc emits `dist/` ESM `.js` + `.d.ts`)
- `pnpm test` (suite green; ≥80% lines/functions/branches/statements — note coverage
  ignores `index.ts`, so the three logic files must be exercised)
- `pnpm lint` and `pnpm typecheck` clean
- `pnpm check:api` confirms the three-entry `exports` map is unchanged (no semver
  break)

**Bookkeeping:** update `docs/implementation-status.md` `errors` row across
`❌ → 🧪 → 🟢 → ✅` (Status, Tests, Reviewed columns) after each phase.

**Commit:** `feat: implement core/errors submodule` (Conventional Commit; minor —
new submodule surfaced through the barrel, three-entry exports map unchanged).
The hub does not bump `version` (semantic-release owns it).

---

## Critical files

- **Spokes write:** `packages/m3l-common/src/core/errors/{index,M3LError,M3LResult,M3LErrorUtils}.ts`,
  `packages/m3l-common/tests/errors.test.ts`, and one re-export line in
  `packages/m3l-common/src/core/index.ts`.
- **Hub writes:** `docs/plans/errors-submodule-implementation.md` (this plan),
  `docs/implementation-status.md` (status transitions).
- **Read-only authority:** `docs/reference/core/errors.md`, `docs/m3l-common-architecture.md`.
- **Never touch:** `packages/m3l-common/package.json` `exports`/`version`; `dist/`;
  `pnpm-lock.yaml` (no deps needed).

## Notes / risks

- **Coverage trap:** logic in `errors/index.ts` is invisible to the 80% gate — keep
  the barrel re-export-only. Mitigated by the four-file layout.
- **`cause` typing:** `Error.cause` is `unknown` in the lib types; re-declare it as
  `Error | undefined` on `M3LError` and only pass `{ cause }` to `super` when defined
  (`exactOptionalPropertyTypes` is on — passing `cause: undefined` differs from
  omitting it).
- **Subclass names:** set `this.name = new.target.name` so `hasErrorName` and
  monitoring see the concrete subclass, not `"Error"`.
- Foundational module: getting `M3LError`/`M3LResult` shapes right here is reused by
  every later submodule (importers/exporters/network/polling), so conformance review
  matters more than usual.
