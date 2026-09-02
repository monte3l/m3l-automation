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
- **A public type over a third-party type needs that package's types at
  runtime.** `export type X = Lib.Thing` emits `from "lib"` into the `.d.ts`,
  so `lib` — plus `@types/lib` when `lib` ships none — must be in
  `dependencies`/`peerDependencies`, never `devDependencies`, or the consumer
  gets `Could not find a declaration file` (#798). A type-only import that
  never reaches a `.d.ts` is internal and fine. Gate: `pnpm check:dts-deps`.
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
- **Guard reads and writes together when mutating a property on an object you
  don't own — and verify success by reading it back, never by the absence of
  a throw.** Attaching a secondary failure onto a caught error's `cause`
  (e.g. chaining a rollback failure onto the error that triggered the
  rollback) can fail in more ways than an `=== undefined` check plus a
  guarded assignment accounts for: the property can be an accessor whose
  getter itself throws, the object can be frozen/sealed/non-extensible, or a
  setter can silently no-op without storing anything. Wrap the read AND the
  write for one link in a single `try`/`catch`, and after an
  assignment that didn't throw, compare `object.property === value` before
  reporting success — a non-throwing write is not proof the value was
  stored. Found on `aws/rds-data`'s `withTransaction`: a fix that guarded
  only the write crashed on a frozen `cause`, destroying both chained
  errors; the same fix, still missing a read-back check, then reported
  false success against a no-op setter (`docs/logs/2026-08-14-aws-rds-data.md`).
- **Never export error-constructor options interfaces.** Callers _catch_
  errors, they don't construct them — the options shape is an implementation
  detail of the constructor, not public API. This is scoped to `M3LError`
  subclass constructors only — a regular function's options bag that callers
  genuinely construct at the call site should still be exported next to the
  function (e.g. `M3LRunScriptOptions`), per "export each type next to the
  value it describes" below. Don't over-apply the constructor rule to every
  multi-field parameter object (found on `Core.confirmDestructive`'s
  promotion, 2026-07-24 — `M3LConfirmDestructiveOptions` was left unexported
  by default until two independent reviewers flagged the same fix).
- **Discriminate a swallow by `code`, not class.** When one `M3LError` subclass
  carries several `code`s, a `catch (e) { if (e instanceof X) skip }` drops the
  very failures the codes distinguish (a corrupt input vs. a merely-unsupported
  one). Narrow the skip to the specific benign `code` and **re-throw** the rest.
- **Filesystem error handling.** Ignore only `ENOENT` (denylist via a small
  `Set`) and **re-throw** `EACCES`/`EPERM`; scope any silent-skip to _parse
  failures only_, never a whole `catch`. The same rule applies to `bin/*.mjs`
  tooling, which this file's path scope doesn't cover but which has no rules
  file of its own: a directory read wrapped in `catch { return [] }` is only
  safe when that directory's _absence_ is itself a legitimate case (a package
  with no `tests/`) — a required root (e.g. the monorepo's `packages/`
  itself) needs the same `ENOENT`-only discrimination, or a broken scan
  silently reports a false-green "0 files checked" instead of failing loudly
  (`bin/check-file-budget.mjs`, found by review during F23/ADR-0072).
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
- **Pick a guard's comparison polarity from which direction is safe, not from a
  habit of strict equality.** `x === true` is correct for an **opt-in** (only an
  explicit `true` may bypass) and wrong for a **verdict** (anything unexpected
  must escalate, not silently downgrade). A2's
  `isSensitiveTarget?.(target) !== true` let a predicate returning a truthy
  non-`true` value (`1`, `"yes"`, `{}`) fall to the ungraded path where a plain
  `--yes` then bypassed — fail-open on the one check ADR-0048 calls load-bearing.
  Escalate on truthiness for a guard; require strict `true` for an opt-in. When
  both sit in one function the asymmetry is deliberate — comment it, or the next
  reader "harmonises" them and reopens the hole.
- **Never put a URL in TSDoc.** This repo references sibling modules with a bare
  `{@link Symbol}` or a backticked relative path (`` `docs/reference/core/x.md` ``).
  Nothing validates link targets, so an invented host survives review by eye:
  A2 shipped `https://m3l-automation.internal/...` and A1 left
  `https://m3l-automation.github.io/...` on `main`. Grep new source for `http`
  before committing.
- **`interface` for shapes callers implement/extend; `type` for unions,
  intersections, mapped/branded types.**
- **Constrain a row-shaped generic with `extends object`, not
  `Record<string, unknown>`.** If an impl treats `TItem` as a record (e.g. an
  exporter that reads its keys), bound the generic so a primitive instantiation
  (`Exporter<number>`) fails to compile instead of silently producing empty
  output. Use `extends object`: `Record<string, unknown>` rejects declared
  `interface` item types (no implicit index signature), a worse DX regression than
  the internal cast it removes.
- **Re-check a mutable external property through a function, never inline —
  TypeScript's narrowing is unsound across an `await`.** After
  `if (signal?.aborted) throw …`, TS narrows `aborted` to `false` and **keeps
  that narrowing past an `await`**, so a later re-check reports TS2367
  ("types 'false | undefined' and 'true' have no overlap") even though the value
  genuinely can have changed. The dangerous resolution is deleting the re-check.
  Route it through a module-private `function isAborted(signal: AbortSignal |
undefined): boolean` — a call returns a plain `boolean` TS cannot narrow away.
  This matters most where the re-check _is_ the contract: in `M3LRetryRunner`,
  the abort check in the `catch` must precede the classifier, because a
  classifier judging the abort "retriable" would retry the operation the operator
  just cancelled (ADR-0049, `2026-08-18-a1-cooperative-cancellation-seam.md`).
  Never "fix" a TS2367 on a mutable external property by removing the guard.
- **Enabling a previously unreachable branch means auditing it as new code.** A
  dead branch can carry a latent leak indefinitely because nothing can reach it.
  `aws/ecs` and `aws/cloudformation` built their waiter `reason` from the raw SDK
  error message — which `@smithy/core` constructs by serializing the entire
  waiter result, so it can embed the last observed response — and that arm was
  unreachable only because nothing passed an `abortSignal`. Threading one turned
  dead code into a live channel (`aws/eks` had already been hardened; the other
  two had not). Before wiring up an option that makes a branch reachable, review
  that branch as if it were being written now.
- **Prefer a constructor that cannot carry a payload over call sites that
  decline to pass one.** `M3LOperationAbortedError` accepts an optional message
  and **no `cause`** at all, so an SDK abort error whose message embeds a
  response body cannot enter the chain by any route — a property verifiable by
  grepping the constructor, not by auditing every call site. When a type's whole
  job is to be safe to log or persist, make the unsafe input unrepresentable.
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
- **Reuse `core/utils/guards.ts`'s exported type predicates** (`isString`/
  `isNumber`/`isBoolean`/`isArray`/`isPlainObject`/etc.) instead of writing a
  local module-level reimplementation. A local copy is a smell even when a
  sibling class (e.g. `M3LConfigAccessor`) already has one of its own — that's
  pre-existing debt to fix, not precedent to repeat (found promoting
  `M3LInputFileReader`'s record-field readers, 2026-07-28: a fresh
  `isString`/`isNumber`/`isBoolean`/`isArray` quartet duplicated the exported
  utility this same file already imports from).
- **`Object.hasOwn(record, field)`, not `record[field] !== undefined`, when
  reading a field off untrusted or partially-trusted input.** Bracket access
  walks the prototype chain, so a record with no own `field` (e.g. one
  literally named `"__proto__"`) can silently resolve an inherited —
  or, if `Object.prototype` is ever polluted elsewhere, attacker-controlled —
  value instead of the "absent" the caller expects. Default to the
  `Object.hasOwn` guard first unless own-vs-inherited is proven irrelevant for
  that specific field (found in `M3LInputFileReader`'s record-field readers,
  2026-07-28 security review: `optionalRecordField` returned `Object.prototype`
  itself for a non-own `"__proto__"` field before the fix).
- **A cast across a serialization boundary hides the PROTOTYPE, not just the
  shape.** `M3LAppendOnlyStream.read()` rebuilds every node with a null
  prototype (its `toJSON`-gadget defence), so `Array.isArray` answers `true`
  while the array has no `.slice` — handing that to a narrowing layer throws a
  raw `TypeError` from inside it instead of a classified error. Re-hydrate with
  `structuredClone` first, never `JSON.parse(JSON.stringify(...))`, which turns
  `-0` into `0` behind the narrowing layer.
- **Allowlist, never denylist, for a redaction or sanitization boundary.**
  Enumerate the fields you keep; drop everything else. A pattern that tries to
  _recognize_ what is unsafe (a regex over URLs, key-name heuristics) is a
  denylist against unbounded input and does not converge — `core/diagnostics`
  proved it across four adversarial rounds: every allowlisted surface leaked
  nothing, the denylist failed all four and regressed three times. Where the
  input is genuinely free text, say "best effort" in the TSDoc and reclassify
  the artifact instead of promising a guarantee.
- **Every caller-supplied value crossing the public boundary is validated
  once, at the boundary — including depth and recursion bounds — and that
  validation's guarantee must hold all the way to where the value is used.**
  This is the general class behind two separate incidents, not one narrow
  rule: **(1) never validate a caller value and then let something else
  re-read it.** That is two observations of a mutable, caller-controlled
  graph, and it is defeated by making them disagree — a non-idempotent
  getter, a non-enumerable own `toJSON` invisible to `Object.keys` but
  applied by the serializer, an **inherited** `toJSON` that `Object.freeze`
  cannot stop `JSON.stringify` from dispatching to, own non-index properties
  on an array, a `length` re-read mid-loop. Do the traversal **once**:
  validate and project into a fresh structure, then derive the downstream
  artifact (hash, digest, persisted bytes) from the projection, never from
  the original.
  `core/checkpoint`'s A4 fingerprint proved it — three guards were refuted in
  a row, each by a new route from the caller's object to the hash, until the
  two reads were collapsed into one
  (`docs/logs/2026-08-19-a4-checkpoint-fingerprint.md`). **(2) an unbounded
  recursion or loop over caller-supplied structure is itself unvalidated
  input**, even when every individual read is guarded — depth and iteration
  count need their own explicit ceiling, checked before recursing, not
  discovered as a bare `RangeError`/stack overflow at runtime. The
  `core/procedure` review rounds (B2/#523 post-mortem, ADR-0072) found this
  same class **four separate times** across one module: unvalidated step
  `execute`/case `action` escaping as a bare `TypeError`; the first fix for
  that reintroducing the re-read hazard `f875c52` had already removed;
  unbounded recursion over caller `run()` parameters yielding a bare
  `RangeError`; and three further sites of unguarded caller reads found only
  by a dedicated follow-up audit. **A bare `TypeError`/`RangeError`/stack
  overflow escaping the public boundary is the defect itself**, not a missing
  message on an otherwise-acceptable throw — it means validation happened
  somewhere the boundary doesn't cover.
- **Two fix rounds bypassing the same mechanism means change the shape, not add
  a case.** A third patch to the same guard is a denylist by another name. Stop,
  name the structural property being violated, and fix that instead.
- **A moved or re-scoped `try` invalidates every claim made about it.** When a
  fix hoists a call across a guard boundary or changes call order, re-audit the
  surrounding TSDoc and re-run any leak/`cause` audit from scratch — do not
  carry the previous round's clean result forward. A4 shipped two regressions
  this way: a `cause` chained around `JSON.stringify` leaked caller property
  paths, and moving `JSON.stringify` ahead of `canonicalJsonHash` turned a loud
  non-finite rejection into a silent `null` substitution. V7 reproduced both
  halves (`docs/logs/2026-08-30-v7-agent-decision-log.md`); grep this file by
  mechanism (`try`, `stringify`, `cause`), not by the module you are editing.
- **`JSON.stringify` is typed `string` and returns `undefined`** — for a bare
  `undefined`, a function, a symbol, or a plain object whose `toJSON()` returns
  one. A template literal launders that into the text `"undefined"`, which
  writes and hashes cleanly and parses as nothing. Assert it is a string before
  measuring, writing, or digesting it.
- **Parse untrusted text (caller input, file/HTTP/SDK payloads, model output)
  with a string-first approach** (`indexOf`/`slice`/`startsWith`/`codePointAt`)
  where it suffices; when a regex is the right tool, keep it structurally
  non-backtracking — no nested quantifier, no same-text alternation branches,
  one non-overlapping character class per value — and never interpolate
  untrusted text into a `RegExp` source without escaping it first
  (`escapeRegExp` in `core/logging/redact.ts`). Reference precedent:
  `redact.ts`'s `BARE_KEY_VALUE_PATTERN`/`buildEmbeddedSensitivePattern` (regex
  form) and `internal/prompt/sanitize.ts`'s `escapeTerminalControls`
  (quantifier-free string-first form), both backed by adversarial-padding
  regression tests. Full rationale:
  [style guide § Parsing untrusted text](../../docs/contributing/style-guide.md#parsing-untrusted-text).
- **A TSDoc sentence asserting a security property is a claim to verify, not
  prose to write.** This extends to **any** documented guarantee, in TSDoc _or_ a
  `docs/reference` page — an invariant, an implication, a "confirmable by" claim.
  A2 shipped four over-claims in one run (a false
  `awsTarget === undefined ⟺ aws === undefined` biconditional; a "whitespace-padded
  profile is confirmable by typing it exactly" property that no input could
  satisfy; two mis-scoped statements about which state names the target), none
  caught by a gate and three written by the hub. Prose fails no test, so after the
  **last** contract change of a task, re-read every guarantee sentence against the
  code — not against the plan — and dispatch `spec-conformance-reviewer` after the
  final code change, never before
  (`docs/logs/2026-08-18-a2-target-graded-destructive-confirmation.md`).
  Probe the built output before writing it; under-claim by
  default. A false mechanism in a doc comment propagates into the next
  reader's reasoning (three `core/diagnostics` fix rounds shipped ones that
  were wrong). A "never surfaced to the caller"-style claim needs a
  **per-channel** audit, not a per-return-type one: a resolved value and a
  thrown error's `cause`/`message` are separate observable channels, and a
  claim proven true for one can still be false for the other (`aws/cloudformation`'s
  waiter doc correctly said its resolved `{state,reason?}` never carries a
  stack record, but the SDK's own waiter machinery embeds the full last
  `DescribeStacksCommand` response — including caller-supplied parameter/output
  values — into the thrown error's `cause` on the `FAILURE` path, which the
  wrapper then chains straight through).
- **Execute, don't just read, when characterizing what an SDK error's message
  contains.** Reading a generated waiter's source is necessary to find the
  code path but not sufficient to prove a claim like "the common case is
  safe" — run a fixture carrying a planted secret through the real SDK and
  inspect the actual thrown/resolved value. `aws/eks`'s waiter doc reasoned
  from `@smithy/core`'s source that a `TimeoutError`/`AbortError`'s message
  stays a short literal string except when `$metadata` is absent from the
  observed response — true for the branch it traced, but a separate
  `$responseBodyText` deserialization-failure branch (reachable independent
  of `$metadata` presence) also serializes the full response into the
  message, leaking a cluster-registration secret the FAILURE path had
  already been correctly guarded against. Only the security review's
  execution-based check caught it.
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
- **Per-file size is ratcheted, not capped (ADR-0072).** `pnpm check:file-budget`
  enforces `src` ≤ 25,000 chars against a committed baseline
  (`bin/file-budget-baseline.json`): a baselined file may not **grow**; any
  other file must stay under the ceiling from day one. This exists because
  `vitest.config.ts`'s `perFile: true` v8 coverage threshold binds an
  implementation file to every test file exercising it — a large file with
  large tests can become structurally un-splittable after the fact
  (`core/procedure`/B2, ~375,000 irreducible reviewable chars once both grew
  past the point of retrofitting a split). Design a large module's file
  boundaries — and its test file boundaries, `tests.md` — before either grows
  past the ceiling, not after. Landing `internal/` helpers before the public
  symbols that use them is **not** an escape from this: tests exercise only
  the public barrel, so an internal-only slice ships `src/` with zero
  coverage and still trips `perFile` once the public symbol lands.
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

- **A mirrored constant's drift guard must enumerate every copy.** When a
  literal set must exist in two module graphs (e.g. `bin/` scripts vs a
  package), the guard test that compares copies has to list ALL of them —
  a two-of-three mirror test passes precisely while the third copy drifts
  (found on the m3l-cli reserved-name set, 2026-08-14: the suggestion pool
  missed two growth waves the guarded pair caught).
