---
paths:
  - "packages/m3l-common/src/**"
---

# Library source rules (`packages/m3l-common/src/**`)

- **ESM imports carry `.js`.** Every relative import uses the `.js` extension
  (`./foo.js`), even though the file is `.ts`. tsc does not add it; Node will
  not resolve without it. (Also enforced by ESLint + a creation-time hook.)
- **No `any`.** Use `unknown` and narrow. No `any` in the public API.
- **No non-null `!` assertions.** Prove presence via guard, default, or control
  flow.
- **Named exports only.** No default exports (tree-shakeable, refactor-safe).
- **Export each type next to the value it describes.**
- **Prefer `readonly` / `const`.** Create new objects instead of mutating inputs.
- **Typed error hierarchy.** Throw subclasses of `M3LError`; never bare strings.
  Chain underlying failures with the `cause` option.
- **`interface` for shapes callers implement/extend; `type` for unions,
  intersections, mapped/branded types.**
- **Exhaustive `switch`** over finite sets; handle every case and fail on the
  unexpected.
- **TSDoc on every exported symbol**, with an `@example` on primary entry points.
  Comment the _why_, not the _what_.
- **`internal/` is private.** Never re-export it through a public barrel; it has
  no `exports` entry and may change without a major bump.
- **The `exports` map is the public contract** (`.`, `./core`, `./aws`). Adding,
  removing, or retyping a subpath is a semver event — plan before editing it.

```typescript
export type UserId = string & { readonly __brand: unique symbol };
export type Page<T> = { items: readonly T[]; total: number };

export class M3LError extends Error {}
export class NotFoundError extends M3LError {}

export function load(id: UserId): User {
  const user = repo.get(id);
  if (user === undefined) throw new NotFoundError(`user ${String(id)}`);
  return user;
}
```
