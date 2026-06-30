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

```typescript
import { expect, test } from "vitest";
import { paginate } from "../src/index.js";

test("paginate respects the limit", () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toHaveLength(2);
});
```
