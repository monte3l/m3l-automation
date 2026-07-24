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
- **Present-but-valueless is malformed input, not "absent" — fail loud.** A flag
  a parser yields as a boolean `true` because it carried no value (e.g. a bare
  `--log-level` with no `=value`) is malformed _explicit_ input; rejecting it with
  an `M3LError` beats silently falling through to a lower-precedence tier. When a
  value can arrive in a `string | boolean`-style union, the boolean arm is the
  tell that the caller supplied the key but not a value — validate it, don't
  treat it as unset (found A4b: a fall-through instruction let a valueless
  `--log-level` silently pick the wrong floor).
- **Discard the computation when the caller opts out.** Side-effecting resolution
  that only feeds an optional-default resource belongs _inside_ the
  `options.x ?? buildDefault()` branch, not eagerly above it — otherwise a caller
  who supplied their own `x` still pays its cost, and eats its throw, for a result
  that is then discarded (found A4b: an eager env/CLI floor resolve threw at
  construction even when `options.logger` was supplied and the floor unused).
- **Narrow a `try`/`catch` to just the fallible call, never the
  post-processing.** Wrapping response-mapping/construction inside the same
  `try` as an async SDK/IO call means a future local bug in the mapping gets
  mislabeled as an upstream failure (`M3LSomeOperationError` chaining a
  `TypeError`, implying the call itself failed when it didn't). Assign the
  awaited result inside `try`/`catch`, then build the return value after the
  `catch` block resolves — see `aws/lambda/client.ts`'s per-method shape for
  the pattern (`docs/logs/2026-07-18-aws-lambda.md`).
- **Co-locate by a shared value, not by shared code.** When two independent
  mechanisms must agree on a derived path/id/name, give ONE owner the raw value
  and have both derive the result through a single shared helper — never let each
  capture its own copy of the value and re-derive independently, which drifts
  silently. Found A5: `M3LScript.runStartedAt` is the one per-run `Date`; stage-9
  archival and the run reporter both run it through `runDirectoryName`, so their
  directories cannot disagree.
- **Migrate a relocated transform at every call site, or not at all.** Moving a
  sanitize/normalize/coerce step out of a callee and onto its call sites is only
  safe when EVERY caller moves in the same change and the in-callee version is
  deleted — a half-migrated transform leaves the callee double-processing some
  inputs and trusting others, and the parameter name silently lies about its
  contract (found A5: `run-report.ts`'s report-path builder sanitized for one
  caller and double-sanitized the other after a partial extraction).
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
- **Track a string-literal union at runtime with `Record<Union, true>`, not an
  `is`-predicate filter.** A `filter((x): x is T => …)` _looks_ derived but
  launders a runtime `Set`/array through an unchecked assertion, so adding or
  removing a union member drifts silently. Key a
  `const MEMBERS: Record<Union, true> = { … }` literal off the union and
  `Object.keys(MEMBERS)` it — the compiler then rejects both a missing and an
  excess key, the same guarantee `CATEGORY_RANK: Record<M3LLogEventCategory,
number>` already relies on (found A4b: `LOG_LEVEL_FLOORS`).
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
- **"Additive" is about construction, not just consumption.** Before calling an
  added field on an options/context type additive, grep the whole repo —
  `scripts/**` and `tests/**` included — for hand-construction of that type. A
  **required** field added to any type that a caller or a test fake _constructs_
  is source-breaking, even when production code only ever _receives_ it (found
  A4a: a required `dryRun` on `M3LScriptHookContext` broke 7 consumer test
  fakes). Reading the type in isolation hides the semver event.
- **In a top-level catch whose job is to set an exit code, set it first.**
  Assign `process.exitCode` (or the equivalent scheduler signal) immediately,
  before any report/log work that could throw — the exit code is the only thing
  a scheduler reads, and a throw in the reporting path must never cost it. A
  best-effort wrapper must guard the _construction_ of its payload, not only the
  I/O call: the input builder is as fallible as the write. Corollary: a wrapper
  that installs an `uncaughtException` guard _suppresses_ Node's default crash,
  so a lost exit code becomes a silent exit-0 **success** — verify the failure
  path by running built `dist/` in a child process and reading the shell's `$?`,
  never just `process.exitCode` in-process (found A4a).
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
