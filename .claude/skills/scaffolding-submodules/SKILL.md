---
name: scaffolding-submodules
description: >-
  Scaffold a brand-new Core or AWS submodule inside packages/m3l-common — the one that
  has NO docs/reference page or src directory yet. Creates the module folder, a failing
  placeholder test (the TDD seam), the namespace-barrel re-export, and a docs/reference
  stub, then hands off to implementing-submodules to fill it in. Use this whenever the user
  asks to add, create, or scaffold a new library module, capability, or feature area that does
  not already exist — even when phrased casually like "set up a new cache module" or "add a
  polling thing", and even if they never say "submodule". If the submodule already has a
  docs/reference/{core,aws}/<name>.md spec, skip this and use implementing-submodules directly.
---

# scaffolding-submodules

Scaffold a new submodule under the library's `core` or `aws` namespace. This is
the _greenfield_ entry point for a **net-new** module — one beyond the bootstrap
catalog that has no `docs/reference` page and no `src/` directory yet. It creates
the seams (folder, failing test, barrel re-export, doc stub) and updates the
status tracker, then hands the actual implementation to `implementing-submodules`.
The package `exports` map stays at three entries (`.`, `./core`, `./aws`) — new
submodules are surfaced through the namespace barrel, **never** a new subpath
entry (that would be a semver event; see `docs/contributing/contributing.md`).
The skill's name is about adding a new module, not a new `exports` subpath — the
two are deliberately kept separate.

## Role boundaries (hub-and-spoke)

This skill runs in the **hub** (main agent) and only lays down scaffolding +
tracker rows. It does **not** implement the module or review code — that happens
in the spoke subagents (`test-author`, `code-implementer`, `code-reviewer`,
`spec-conformance-reviewer`) orchestrated by `implementing-submodules`. The agent
that writes the implementation is never the one that reviews it; keep that
separation intact here by handing off rather than implementing inline.

## Steps

0. **Run `/starting-work` first.** Scaffolding writes guarded paths
   (`packages/m3l-common/src/<ns>/<module>/index.ts` and
   `packages/m3l-common/tests/<module>.test.ts`), which
   `guard-branch-isolation.mjs` blocks while `HEAD` is `main`. `/starting-work` is
   the single source of truth for the branch/worktree, PR, and push decisions —
   it infers and confirms them up front so you branch proactively instead of
   hitting the block mid-scaffold.
1. Ask for: the namespace (`core` or `aws`) and the module name (kebab-case).
2. Create `packages/m3l-common/src/<ns>/<module>/index.ts` with a minimal,
   spec-anchored skeleton — exported symbol _signatures_ with TSDoc and `@example`
   but placeholder bodies that throw a **module-specific `M3LError` subclass**.
   There is no generic `M3LNotImplementedError` in this repo — every module defines
   its own error (e.g. `M3LPathResolutionError`, `M3LJSONFormatDetectionError`), so
   define one for the new module and throw it from the stubs. Named exports only;
   relative imports carry the `.js` extension. **`index.ts` must stay a thin
   barrel** (`export * from "./<file>.js";` per symbol group, mirroring
   `aws/clients/index.ts`) — real logic goes in sibling files (e.g.
   `operations.ts`, `provider.ts`). `vitest.config.ts`'s coverage config
   excludes **every** `**/index.ts` project-wide (barrels are assumed to carry
   no logic worth measuring); a module scaffolded with its real functions
   directly inside `index.ts` silently drops out of the 80% coverage gate
   entirely (found on `aws/dynamodb`, which needed a mid-implementation split
   into `operations.ts` + a thin `index.ts` to get its coverage measured at
   all — see `docs/logs/2026-07-13-aws-dynamodb.md`).
3. Re-export the module from `packages/m3l-common/src/<ns>/index.ts`
   (`export * from "./<module>/index.js";`).
4. Create `packages/m3l-common/tests/<module>.test.ts` with at least one
   **failing** happy-path test and one failing failure-path test (plus an
   `expectTypeOf` test where the type is the contract). These are meant to be red
   — they define the contract `implementing-submodules` will satisfy. This is the TDD
   seam, not finished test coverage.
5. Add a `docs/reference/<ns>/<module>.md` stub capturing the intended exports and
   behavioral contracts (so the module has an authoritative spec to implement
   against), and add a row for it to `docs/implementation-status.md` with status
   🧪 (tests-written) and a note that scaffolding is in place.
6. Hand off: tell the user (or proceed, if asked) to run `implementing-submodules`
   for `<module>` to turn the red tests green under review.

## What "good" scaffolding looks like

**1 — Surface through the barrel, never the exports map:**

```ts
// good — packages/m3l-common/src/core/index.ts
export * from "./retry/index.js";
// bad — editing packages/m3l-common/package.json "exports" to add "./retry"
//        (that's a semver event and breaks the three-entry contract)
```

**2 — Placeholder bodies fail loudly, signatures are real:**

```ts
// good — the body throws THIS module's own M3LError subclass (see example 3);
//        there is no generic M3LNotImplementedError in this repo
export function navigateFieldPath(obj: unknown, path: string): unknown {
  throw new M3LJSONFormatError(
    "navigateFieldPath: not yet implemented — see docs/reference/core/json.md",
  );
}
// bad — M3LNotImplementedError does not exist; this import will not resolve
export function navigateFieldPath(): unknown {
  throw new M3LNotImplementedError("navigateFieldPath");
}
// bad — returning a fake value hides that it's unimplemented and may pass tests
export function navigateFieldPath(): unknown {
  return undefined;
}
```

**For a placeholder returning `Promise<T>`, reject the promise — don't
`throw` synchronously.** A non-`async` method (needed to satisfy
`@typescript-eslint/require-await` when there's no real `await` yet) that
`throw`s synchronously crashes any test that passes the call expression
directly to `expect(fn()).rejects...` — the throw fires while evaluating the
argument, before `.rejects` ever gets a Promise to attach to, so the test
still "fails" but for a confusing, wrong reason (an uncaught exception, not a
clean rejected-promise assertion). Use `Promise.reject` instead — it stays
non-`async` (no unnecessary `await`) while genuinely returning a rejected
promise, matching the eventual real `async` implementation's calling contract
(found scaffolding `aws/ecs`, `docs/logs/2026-07-24-aws-ecs.md`):

```ts
// good — a rejected Promise, not a synchronous throw
export function fetchThing(id: string): Promise<Thing> {
  return Promise.reject(
    new M3LThingOperationError(`fetchThing: not yet implemented (id=${id})`),
  );
}
// bad — throws synchronously; expect(fetchThing(id)).rejects.toThrow(...)
//       crashes on the call itself instead of asserting a clean rejection
export async function fetchThing(id: string): Promise<Thing> {
  throw new M3LThingOperationError(
    `fetchThing: not yet implemented (id=${id})`,
  );
}
```

**3 — Errors subclass the one hierarchy (define the module's own error):**

```ts
// good — the placeholder above throws this
export class M3LJSONFormatError extends M3LError {}
// bad
export class M3LJSONFormatError extends Error {} // breaks the typed hierarchy + toJSON()
```

## Rules

- Do NOT add a new entry to the `exports` map — use the namespace barrel.
- Anything genuinely private goes under `src/internal/` (never re-exported).
- Don't implement the module here; hand off to `implementing-submodules`.
- See `.claude/rules/library-src.md` and `docs/contributing/coding-standards.md`.
