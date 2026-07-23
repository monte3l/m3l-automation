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
- **Don't pass `undefined` to an optional property.** Under
  `exactOptionalPropertyTypes`, an optional target field (`default?: number`)
  rejects an explicit `undefined` (TS2379). When forwarding optional caller
  options into a strict target (e.g. a third-party adapter config), **omit the
  key** with a conditional spread — `...(v !== undefined ? { k: v } : {})` —
  never `{ k: someValue | undefined }`.
- **Typed error hierarchy.** Throw subclasses of `M3LError`; never bare strings.
  Chain underlying failures with the `cause` option. Subclasses override `code`
  as a `readonly` **literal** (e.g. `M3LEnvironmentDetectionError`,
  `M3LPathResolutionError`) so the code narrows at the call site. **Register
  every new subclass's `code` in `M3L_ERROR_CODES`**
  (`core/errors/M3LError.ts`, alphabetically sorted) in the same commit that
  defines the class. The source-scan completeness guard (`errors.test.ts`)
  that catches an omission lives in `core/errors` and only runs as part of the
  full-workspace suite — a new submodule's own isolated test run gives no
  signal that this step was skipped (found on `aws/athena`, 2026-07-18).
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
- **Guard the parse step, not just the read and the validation around it.** A
  read-then-`JSON.parse`-then-shape-validate sequence needs the same typed-error
  treatment on all three steps — the `parse` call sitting between two already-guarded
  steps is the one most likely to be left bare, surfacing a raw `SyntaxError`
  instead of an `M3LError`. This matters doubly for any file that can hold
  caller/user data (a checkpoint, a cache): Node's `SyntaxError` message embeds a
  snippet of the malformed content, so an unguarded parse can leak that content to
  a log/stderr sink on an unhandled rejection. Wrap the parse, throw the same
  typed error the adjacent validation branch uses — and do **not** chain the raw
  `SyntaxError` as `cause` if the file may hold sensitive content, since the cause
  chain carries the leaking snippet forward.
- **Fail loud on caller/config errors; stay lenient only on external data.**
  Validate caller- and config-supplied input at the public boundary and throw an
  `M3LError` subclass on violation — never silently coerce or skip it. Reserve
  tolerant handling (skip / default / warn) for _external_ data you don't control
  (file contents, network payloads). Don't blur the two: a malformed caller
  argument is a bug to surface, malformed external data is a condition to absorb.
- **Narrow a `try`/`catch` to just the fallible call, never the
  post-processing.** Wrapping response-mapping/construction inside the same
  `try` as an async SDK/IO call means a future local bug in the mapping gets
  mislabeled as an upstream failure (`M3LSomeOperationError` chaining a
  `TypeError`, implying the call itself failed when it didn't). Assign the
  awaited result inside `try`/`catch`, then build the return value after the
  `catch` block resolves — see `aws/lambda/client.ts`'s per-method shape for
  the pattern (`docs/logs/2026-07-18-aws-lambda.md`).
- **`interface` for shapes callers implement/extend; `type` for unions,
  intersections, mapped/branded types.**
- **Constrain a row-shaped generic with `extends object`, not
  `Record<string, unknown>`.** If an impl treats `TItem` as a record (e.g. an
  exporter that reads its keys), bound the generic so a primitive instantiation
  (`Exporter<number>`) fails to compile instead of silently producing empty
  output. Use `extends object`: `Record<string, unknown>` rejects declared
  `interface` item types (no implicit index signature), a worse DX regression than
  the internal cast it removes.
- **Exhaustive `switch`** over finite sets; handle every case and fail on the
  unexpected.
- **Allowlist, never denylist, for a redaction or sanitization boundary.**
  Enumerate the fields you keep; drop everything else. A pattern that tries to
  _recognize_ what is unsafe (a regex over URLs, key-name heuristics) is a
  denylist against unbounded input and does not converge — `core/diagnostics`
  proved it across four adversarial rounds: every allowlisted surface leaked
  nothing, the denylist failed all four and regressed three times. Where the
  input is genuinely free text, say "best effort" in the TSDoc and reclassify
  the artifact instead of promising a guarantee.
- **A TSDoc sentence asserting a security property is a claim to verify, not
  prose to write.** Probe the built output before writing it; under-claim by
  default. A false mechanism in a doc comment propagates into the next
  reader's reasoning (three `core/diagnostics` fix rounds shipped ones that
  were wrong).
- **TSDoc on every exported symbol**, with an `@example` on primary entry points.
  Comment the _why_, not the _what_.
- **`internal/` is private.** Never re-export it through a public barrel; it has
  no `exports` entry and may change without a major bump.
- **The `exports` map is the public contract** (`.`, `./core`, `./aws`). Adding,
  removing, or retyping a subpath is a semver event — plan before editing it.
- **Dependency loading & declaration** (full rationale: ADR-0017). Classify a new
  external dependency by _required vs optional_, not by size:
  - **Required** (the library needs it for its purpose) → hard `dependencies`,
    **exact-pinned** (no `^`/`~`). Static `import` by default; a lazy
    `await import()` is allowed for cold-start reasons (a guaranteed-present dep
    loaded lazily is still required — don't relabel it "optional").
  - **Optional** (a feature only some consumers use; the library degrades without
    it) → `peerDependencies` **and** `peerDependenciesMeta.optional`,
    **caret-ranged**, and it **must** be lazy `await import()`-ed wrapped so an
    absent package throws a typed `M3LError` subclass with an `ERR_*_MISSING_DEP`
    code naming the package — never a raw `ERR_MODULE_NOT_FOUND`. The `core/text`
    extractors are the reference; `aws/clients` (required, hard, sync getters) is
    the documented first-class exception. `[enforced]` by `pnpm check:deps`.

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
