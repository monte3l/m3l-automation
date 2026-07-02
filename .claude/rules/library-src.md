---
paths:
  - "packages/m3l-common/src/**"
---

# Library source rules (`packages/m3l-common/src/**`)

> Canonical rationale + examples: [`docs/contributing/style-guide.md` §
> Writing new code](../../docs/contributing/style-guide.md#part-1--writing-new-code).
> This file is the terse checklist that auto-loads when you edit source.

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
  Chain underlying failures with the `cause` option. Subclasses override `code`
  as a `readonly` **literal** (e.g. `M3LEnvironmentDetectionError`,
  `M3LPathResolutionError`) so the code narrows at the call site.
- **Never export error-constructor options interfaces.** Callers _catch_
  errors, they don't construct them — the options shape is an implementation
  detail of the constructor, not public API.
- **Discriminate a swallow by `code`, not class.** When one `M3LError` subclass
  carries several `code`s, a `catch (e) { if (e instanceof X) skip }` drops the
  very failures the codes distinguish (a corrupt input vs. a merely-unsupported
  one). Narrow the skip to the specific benign `code` and **re-throw** the rest.
- **Filesystem error handling.** Ignore only `ENOENT` (denylist via a small
  `Set`) and **re-throw** `EACCES`/`EPERM`; scope any silent-skip to _parse
  failures only_, never a whole `catch`.
- **Fail loud on caller/config errors; stay lenient only on external data.**
  Validate caller- and config-supplied input at the public boundary and throw an
  `M3LError` subclass on violation — never silently coerce or skip it. Reserve
  tolerant handling (skip / default / warn) for _external_ data you don't control
  (file contents, network payloads). Don't blur the two: a malformed caller
  argument is a bug to surface, malformed external data is a condition to absorb.
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

// Subclasses inject their own `code` literal and forward an optional `cause`;
// the base M3LError constructor requires `{ code, cause? }`.
export class M3LNotFoundError extends M3LError {
  override readonly code = "NOT_FOUND" as const;
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: "NOT_FOUND", cause: options.cause });
  }
}

export function load(id: UserId): User {
  const user = repo.get(id);
  if (user === undefined) throw new M3LNotFoundError(`user ${String(id)}`);
  return user;
}
```

## Good vs. bad (the contrasts reviewers reject on)

The rules above state the "what"; these bad/good pairs show the failure mode so
you don't have to rediscover it under review.

**ESM relative imports carry `.js`** (tsc won't add it; Node won't resolve without it):

```ts
// bad — type-checks, then fails at runtime in Node
import { M3LError } from "../errors/index";
// good
import { M3LError } from "../errors/index.js";
```

**Typed errors with a cause, never bare strings** (one hierarchy, chainable):

```ts
// bad — loses the type and the underlying failure
throw `config ${name} not found`;
// good
throw new M3LConfigNotFoundError(`config ${name} not found`, { cause });
```

**Named exports only** (tree-shakeable, refactor-safe, matches the barrels):

```ts
// bad
export default class M3LPoller {
  /* … */
}
// good
export class M3LPoller {
  /* … */
}
```

**Trust the CLI gate over the IDE/LSP.** Editor diagnostics lag and misreport
against the project `tsconfig` in this harness. A passing `pnpm typecheck` /
`pnpm lint` is the source of truth — don't chase a red squiggle the CLI says is
clean.
