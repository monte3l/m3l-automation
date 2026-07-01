---
paths:
  - "**/tests/**"
  - "**/*.test.ts"
---

# Testing rules (`tests/**`, `*.test.ts`)

- **Vitest**, files named `*.test.ts`, importing from `src/` with the `.js`
  extension (`../src/index.js`).
- **Every exported function gets a happy-path test plus one failure path.**
- **Test observable behavior, not implementation details** or private paths.
- **Deterministic and isolated:** no network, no filesystem; mock collaborators.
  Prefer stubs unless interaction verification is required. Clean up side effects.
- **Name tests by behavior**, not by the unit under test.
- **Type-level tests with `expectTypeOf`** where the type IS the contract.
- **Parameterize** when the same logic is exercised against multiple inputs.
- **Never tolerate flaky tests** — diagnose and fix; do not mute or retry-mask.
- **Mock Node built-ins via the async-factory form** that preserves real
  exports, then `vi.spyOn` individual methods:
  `vi.mock("fs", async () => { const actual = await vi.importActual<typeof import("fs")>("fs"); return { ...actual }; })`.
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

```typescript
import { expect, test } from "vitest";
import { paginate } from "../src/index.js";

test("paginate respects the limit", () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toHaveLength(2);
});
```
