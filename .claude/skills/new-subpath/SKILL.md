---
name: new-subpath
description: >-
  Scaffold a brand-new Core or AWS submodule inside packages/m3l-common — the one that
  has NO docs/reference page or src directory yet. Creates the module folder, a failing
  placeholder test (the TDD seam), the namespace-barrel re-export, and a docs/reference
  stub, then hands off to implement-submodule to fill it in. Use when the user asks to
  add a new library module, capability, or feature area that does not already exist. If
  the submodule already has a docs/reference/{core,aws}/<name>.md spec, skip this and use
  implement-submodule directly.
---

# new-subpath

Scaffold a new submodule under the library's `core` or `aws` namespace. This is
the _greenfield_ entry point: it creates the seams (folder, failing test, barrel
re-export, doc stub) and updates the status tracker, then hands the actual
implementation to `implement-submodule`. The package `exports` map stays at three
entries (`.`, `./core`, `./aws`) — new submodules are surfaced through the
namespace barrel, never a new subpath entry (that would be a semver event; see
`docs/contributing/contributing.md`).

## Role boundaries (hub-and-spoke)

This skill runs in the **hub** (main agent) and only lays down scaffolding +
tracker rows. It does **not** implement the module or review code — that happens
in the spoke subagents (`test-author`, `submodule-implementer`, `code-reviewer`,
`spec-conformance-reviewer`) orchestrated by `implement-submodule`. The agent
that writes the implementation is never the one that reviews it; keep that
separation intact here by handing off rather than implementing inline.

## Steps

1. Ask for: the namespace (`core` or `aws`) and the module name (kebab-case).
2. Create `packages/m3l-common/src/<ns>/<module>/index.ts` with a minimal,
   spec-anchored skeleton — exported symbol _signatures_ with TSDoc and `@example`
   but throwing `M3LNotImplementedError` (or similar) bodies. Named exports only;
   relative imports carry the `.js` extension.
3. Re-export the module from `packages/m3l-common/src/<ns>/index.ts`
   (`export * from "./<module>/index.js";`).
4. Create `packages/m3l-common/tests/<module>.test.ts` with at least one
   **failing** happy-path test and one failing failure-path test (plus an
   `expectTypeOf` test where the type is the contract). These are meant to be red
   — they define the contract `implement-submodule` will satisfy. This is the TDD
   seam, not finished test coverage.
5. Add a `docs/reference/<ns>/<module>.md` stub capturing the intended exports and
   behavioral contracts (so the module has an authoritative spec to implement
   against), and add a row for it to `docs/implementation-status.md` with status
   🧪 (tests-written) and a note that scaffolding is in place.
6. Hand off: tell the user (or proceed, if asked) to run `implement-submodule`
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
// good — the type contract is honest; the body is unmistakably unfinished
export function navigateFieldPath(obj: unknown, path: string): unknown {
  throw new M3LNotImplementedError(
    "navigateFieldPath: see docs/reference/core/json.md",
  );
}
// bad — returning a fake value hides that it's unimplemented and may pass tests
export function navigateFieldPath(): unknown {
  return undefined;
}
```

**3 — Errors subclass the one hierarchy:**

```ts
// good
export class M3LJSONFormatError extends M3LError {}
// bad
export class M3LJSONFormatError extends Error {} // breaks the typed hierarchy + toJSON()
```

## Rules

- Do NOT add a new entry to the `exports` map — use the namespace barrel.
- Anything genuinely private goes under `src/internal/` (never re-exported).
- Don't implement the module here; hand off to `implement-submodule`.
- See `.claude/rules/library-src.md` and `docs/contributing/coding-standards.md`.
