---
paths:
  - "packages/m3l-common/src/**"
---

# Library source rules (`packages/m3l-common/src/**`)

> Canonical rationale + examples: [`docs/contributing/style-guide.md` §
> Writing new code](../../docs/contributing/style-guide.md#part-1--writing-new-code).
> This file is the terse checklist that auto-loads when you edit source.

- **TypeScript strictness, ESM `.js` imports, named exports, exporting a type
  next to its value, `readonly`/`const`, `interface` vs `type`, exhaustive
  `switch`, TSDoc on every export, `internal/` privacy, the `exports`-map
  contract, and ADR-0017 dependency declaration** are covered in full by
  style-guide.md's Part 1 subsections above — this file only adds what that
  guide doesn't already say.
- **Don't pass `undefined` to an optional property.** Under
  `exactOptionalPropertyTypes`, an optional target field (`default?: number`)
  rejects an explicit `undefined` (TS2379). When forwarding optional caller
  options into a strict target, **omit the key** with a conditional spread —
  `...(v !== undefined ? { k: v } : {})` — never `{ k: someValue | undefined }`.
- **Register every new `M3LError` subclass's `code` in `M3L_ERROR_CODES`**
  (`core/errors/M3LError.ts`, alphabetically sorted) in the same commit that
  defines the class. The source-scan completeness guard for this lives in
  `core/errors` and only runs as part of the full-workspace suite — a new
  submodule's own isolated test run gives no signal that this step was
  skipped.
- **Guard reads and writes together when mutating a property on an object you
  don't own — verify success by reading it back, never by the absence of a
  throw.** The property can be an accessor whose getter itself throws, the
  object can be frozen/sealed/non-extensible, or a setter can silently no-op.
  Wrap the read AND the write in one `try`/`catch`, and after a non-throwing
  assignment compare `object.property === value` before reporting success
  (`docs/logs/2026-08-14-aws-rds-data.md`).
- **Never export error-constructor options interfaces.** Callers _catch_
  errors, they don't construct them. Scoped to `M3LError` subclass
  constructors only — a regular function's options bag that callers
  genuinely construct still gets exported next to the function.
- **Discriminate a swallow by `code`, not class.** When one `M3LError`
  subclass carries several `code`s, `catch (e) { if (e instanceof X) skip }`
  drops the very failures the codes distinguish. Narrow the skip to the
  specific benign `code` and **re-throw** the rest.
- **Filesystem error handling** (style-guide.md § Error handling) applies to
  `bin/*.mjs` tooling too, which this file's path scope doesn't cover: a
  required root's directory read wrapped in `catch { return [] }` must still
  discriminate `ENOENT` from everything else, or a broken scan silently
  reports a false-green "0 files checked" instead of failing loudly.
- **Guard the parse step, not just the read and the validation around it.**
  A read-then-`JSON.parse`-then-validate sequence needs the same typed-error
  treatment on all three steps. Do **not** chain a raw `SyntaxError` as
  `cause` when the file may hold sensitive content — Node embeds a snippet of
  the malformed content in the message, and the cause chain carries it
  forward to a log/stderr sink.
- **Fail loud on caller/config errors; stay lenient only on external data.**
  Validate caller- and config-supplied input at the public boundary and throw
  an `M3LError` subclass on violation. Reserve tolerant handling (skip /
  default / warn) for data you don't control (file contents, network
  payloads).
- **Present-but-valueless is malformed input, not "absent" — fail loud.** A
  flag a parser yields as boolean `true` because it carried no value (a bare
  `--log-level` with no `=value`) is malformed _explicit_ input; reject it
  with an `M3LError` rather than silently falling through to a lower-precedence
  tier.
- **Discard the computation when the caller opts out.** Side-effecting
  resolution that only feeds an optional-default resource belongs _inside_
  the `options.x ?? buildDefault()` branch, not eagerly above it — otherwise a
  caller who supplied their own `x` still pays its cost and eats its throw for
  a result that's discarded.
- **Narrow a `try`/`catch` to just the fallible call, never the
  post-processing.** Wrapping response-mapping inside the same `try` as an
  async SDK/IO call mislabels a future local bug in the mapping as an upstream
  failure. Assign the awaited result inside `try`/`catch`, build the return
  value after the `catch` block resolves
  (`docs/logs/2026-07-18-aws-lambda.md`).
- **Co-locate by a shared value, not by shared code.** When two independent
  mechanisms must agree on a derived path/id/name, give ONE owner the raw
  value and have both derive the result through a single shared helper —
  never let each capture its own copy and re-derive independently, which
  drifts silently.
- **Migrate a relocated transform at every call site, or not at all.** Moving
  a sanitize/normalize/coerce step out of a callee and onto its call sites is
  only safe when EVERY caller moves in the same change and the in-callee
  version is deleted — a half-migrated transform leaves the callee
  double-processing some inputs and trusting others.
- **Pick a guard's comparison polarity from which direction is safe, not from
  a habit of strict equality.** `x === true` is correct for an **opt-in**
  (only an explicit `true` may bypass) and wrong for a **verdict** (anything
  unexpected must escalate, not silently downgrade) — a predicate returning a
  truthy non-`true` value must not fall through to an ungated path
  (ADR-0048). When both sit in one function the asymmetry is deliberate —
  comment it, or the next reader "harmonises" them and reopens the hole.
- **Never put a URL in TSDoc.** This repo references sibling modules with a
  bare `{@link Symbol}` or a backticked relative path. Nothing validates link
  targets, so an invented host survives review by eye — grep new source for
  `http` before committing.
- **Constrain a row-shaped generic with `extends object`, not
  `Record<string, unknown>`.** If an impl treats `TItem` as a record, bound
  the generic so a primitive instantiation fails to compile instead of
  silently producing empty output — `Record<string, unknown>` also rejects a
  declared `interface` item type (no implicit index signature).
- **Re-check a mutable external property through a function, never inline —
  TypeScript's narrowing is unsound across an `await`.** After
  `if (signal?.aborted) throw …`, TS narrows `aborted` to `false` and keeps
  that narrowing past an `await`, so a later re-check reports TS2367 even
  though the value genuinely can have changed. Route it through a
  module-private `function isAborted(signal): boolean` — a call returns a
  plain `boolean` TS cannot narrow away. Never "fix" a TS2367 on a mutable
  external property by deleting the guard
  (ADR-0049, `docs/logs/2026-08-18-a1-cooperative-cancellation-seam.md`).
- **Enabling a previously unreachable branch means auditing it as new
  code.** A dead branch can carry a latent leak indefinitely because nothing
  can reach it — an SDK waiter's `reason` built from the raw error message can
  embed a full response once an `abortSignal` makes that arm reachable.
  Before wiring up an option that makes a branch reachable, review that
  branch as if it were being written now.
- **Prefer a constructor that cannot carry a payload over call sites that
  decline to pass one.** A type whose whole job is to be safe to log or
  persist should make the unsafe input unrepresentable at the constructor —
  a property verifiable by grepping the constructor, not by auditing every
  call site.
- **Track a string-literal union at runtime with `Record<Union, true>`, not
  an `is`-predicate filter.** A `filter((x): x is T => …)` _looks_ derived but
  launders a runtime `Set`/array through an unchecked assertion, so adding or
  removing a union member drifts silently. Key a `const MEMBERS:
Record<Union, true> = { … }` literal off the union and `Object.keys(MEMBERS)`
  it instead — the compiler then rejects both a missing and an excess key.
- **Reuse `core/utils/guards.ts`'s exported type predicates** (`isString`/
  `isNumber`/`isBoolean`/`isArray`/`isPlainObject`/etc.) instead of writing a
  local module-level reimplementation, even when a sibling class already has
  one of its own — that's pre-existing debt to fix, not precedent to repeat.
- **`Object.hasOwn(record, field)`, not `record[field] !== undefined`, when
  reading a field off untrusted or partially-trusted input.** Bracket access
  walks the prototype chain, so a record with no own `field` (e.g. one
  literally named `"__proto__"`) can silently resolve an inherited — or,
  under prototype pollution, attacker-controlled — value instead of the
  "absent" the caller expects.
- **Validate a local copy, never the property expression — `Object.hasOwn`
  guards _presence_, not _stability_.** Each mention of `x.f` is a **separate
  read**, and an accessor may answer differently every time:
  ```ts
  // BAD — three reads; the value returned is not the value validated
  const bad = typeof e.n === "number" && Number.isFinite(e.n) ? e.n : null;
  // GOOD — one read
  const raw: unknown = e.n;
  const good = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  ```
  More than one mention of a property in a validate-then-return expression
  **is** the defect, whether or not a getter exists today; `try`/`catch` does
  not close it, since the reads are the bug
  (`docs/logs/2026-09-03-u11-retry-resume-cancellation.md`).
- **A cast across a serialization boundary hides the PROTOTYPE, not just the
  shape.** A stream that rebuilds nodes with a null prototype can answer
  `Array.isArray === true` while the array has no `.slice`. Re-hydrate with
  `structuredClone` first, never `JSON.parse(JSON.stringify(...))`, which
  turns `-0` into `0` behind the narrowing layer.
- **Allowlist, never denylist, for a redaction or sanitization boundary.**
  Enumerate the fields you keep; drop everything else. A pattern that tries
  to _recognize_ what is unsafe (a regex over URLs, key-name heuristics) is a
  denylist against unbounded input and does not converge — `core/diagnostics`
  proved it across four adversarial rounds: every allowlisted surface leaked
  nothing, the denylist failed all four. Where the input is genuinely free
  text, say "best effort" in the TSDoc and reclassify the artifact instead of
  promising a guarantee.
- **Every caller-supplied value crossing the public boundary is validated
  once, at the boundary — including depth and recursion bounds — and that
  validation's guarantee must hold all the way to where the value is used.**
  Two hazards: **(1) never validate a caller value and then let something
  else re-read it** — a non-idempotent getter, a non-enumerable own `toJSON`
  invisible to `Object.keys` but applied by the serializer, an inherited
  `toJSON` that `Object.freeze` cannot stop `JSON.stringify` from dispatching
  to. Do the traversal **once**: validate and project into a fresh structure,
  then derive the downstream artifact from the projection, never the
  original (`docs/logs/2026-08-19-a4-checkpoint-fingerprint.md`).
  **(2) an unbounded recursion or loop over caller-supplied structure is
  itself unvalidated input**, even when every individual read is guarded —
  depth and iteration count need their own explicit ceiling, checked before
  recursing, not discovered as a bare `RangeError`/stack overflow at runtime.
  A bare `TypeError`/`RangeError`/stack overflow escaping the public boundary
  is the defect itself, not a missing message on an otherwise-acceptable
  throw — it means validation happened somewhere the boundary doesn't cover.
- **Two fix rounds bypassing the same mechanism means change the shape, not
  add a case.** A third patch to the same guard is a denylist by another
  name. Stop, name the structural property being violated, and fix that
  instead.
- **A moved or re-scoped `try` invalidates every claim made about it.** When
  a fix hoists a call across a guard boundary or changes call order,
  re-audit the surrounding TSDoc and re-run any leak/`cause` audit from
  scratch — do not carry the previous round's clean result forward. Grep the
  file by mechanism (`try`, `stringify`, `cause`), not by the module you're
  editing (`docs/logs/2026-08-30-v7-agent-decision-log.md`).
- **`JSON.stringify` is typed `string` but returns `undefined`** — for a bare
  `undefined`, a function, a symbol, or an object whose `toJSON()` returns
  one. A template literal launders that into the text `"undefined"`, which
  writes and hashes cleanly and parses as nothing. Assert it is a string
  before measuring, writing, or digesting it.
- **Parsing untrusted text** (caller input, file/HTTP/SDK payloads, model
  output) follows style-guide.md's dedicated
  [§ Parsing untrusted text](../../docs/contributing/style-guide.md#parsing-untrusted-text)
  section — string-first by default, structurally non-backtracking regex
  when needed, and always `escapeRegExp` (`core/logging/redact.ts`) before
  interpolating untrusted text into a pattern source.
- **A TSDoc sentence asserting a security property is a claim to verify, not
  prose to write.** This extends to any documented guarantee — an invariant,
  an implication, a "confirmable by" claim. After the **last** contract
  change of a task, re-read every guarantee sentence against the code, not
  against the plan, and dispatch `spec-conformance-reviewer` after the final
  code change, never before. Probe the built output before writing it;
  under-claim by default. A "never surfaced to the caller"-style claim needs
  a **per-channel** audit: a resolved value and a thrown error's
  `cause`/`message` are separate observable channels, and a claim proven true
  for one can still be false for the other
  (`docs/logs/2026-08-18-a2-target-graded-destructive-confirmation.md`).
- **Execute, don't just read, when characterizing what an SDK error's
  message contains.** Reading a generated waiter's source finds the code
  path but doesn't prove a claim like "the common case is safe" — run a
  fixture carrying a planted secret through the real SDK and inspect the
  actual thrown/resolved value. A branch reachable independent of the one
  you traced can still serialize a secret into the message.
- **"Additive" is about construction, not just consumption.** Before calling
  an added field on an options/context type additive, grep the whole repo —
  `scripts/**` and `tests/**` included — for hand-construction of that type.
  A **required** field added to any type that a caller or a test fake
  _constructs_ is source-breaking, even when production code only ever
  _receives_ it. Reading the type in isolation hides the semver event.
- **Per-file size is ratcheted, not capped** (`pnpm check:file-budget`,
  ADR-0072). Design a large module's file boundaries — and its test file
  boundaries, `tests.md` — before either grows past the ceiling: `vitest`'s
  `perFile` coverage binding can make a large file structurally
  un-splittable after the fact. Landing `internal/` helpers before the
  public symbols that use them is **not** an escape from this — tests
  exercise only the public barrel, so an internal-only slice ships `src/`
  with zero coverage and still trips `perFile` once the public symbol lands.
- **A budget-forced extraction moves coverage, and can need TWO modules.**
  (1) The obvious split often creates an import cycle — check the direction
  of every edge before choosing the seam; a shared-primitives module that
  both halves depend on one-directionally is sometimes required. (2) The
  per-file coverage gate measures a RATIO, so moving covered code out can
  fail the file left behind without anything getting worse. Fix the real gap
  (fold duplicate branches, add the missing test); never edit the threshold.
- **In a top-level catch whose job is to set an exit code, set it first.**
  Assign `process.exitCode` immediately, before any report/log work that
  could throw. A wrapper that installs an `uncaughtException` guard
  _suppresses_ Node's default crash, so a lost exit code becomes a silent
  exit-0 **success** — verify the failure path by running built `dist/` in a
  child process and reading the shell's `$?`, never just `process.exitCode`
  in-process.
- **Trust the CLI gate over the IDE/LSP.** Editor diagnostics lag and
  misreport against the project `tsconfig` in this harness. A passing
  `pnpm typecheck` / `pnpm lint` is the source of truth — don't chase a red
  squiggle the CLI says is clean.
- **A mirrored constant's drift guard must enumerate every copy.** When a
  literal set must exist in two module graphs (e.g. `bin/` scripts vs a
  package), the guard test comparing copies has to list ALL of them — a
  two-of-three mirror test passes precisely while the third copy drifts.
