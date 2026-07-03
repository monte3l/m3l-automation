# Work log — `core/prompt` submodule (2026-07-02)

This log covers the end-to-end implementation of the `core/prompt` submodule
through the `implementing-submodules` hub-and-spoke TDD pipeline
(Contract → RED → GREEN → Review), run inside a dedicated linked worktree on
`feat/prompt-submodule`. It records what shipped, what matched the plan, the
four divergences that required spoke re-dispatches, and the durable lessons for
the next submodule.

Plan of record: [`docs/plans/prompt-submodule-implementation.md`](../plans/prompt-submodule-implementation.md)

## Summary

Shipped `core/prompt`: an interactive-CLI submodule surfaced through the Core
namespace barrel (exports map unchanged at three entries → `feat:` minor).

- **12 public exports**: classes `M3LPrompt`, `M3LMultiSpinner`, `M3LLoadingBar`,
  `M3LPromptValidationError`; types `M3LPromptOptions`, `M3LPromptAdapter`,
  `M3LMultiSpinnerOptions`, `M3LLoadingBarOptions`, `M3LChoice`, `M3LChoices`,
  `M3LNumberPromptOptions`, `M3LSuggestFn`.
- **1 new runtime dep** (dependency gate, user-approved): `@inquirer/prompts@8.5.2`
  (exact). Spinner + loading bar built in-house (pure ANSI) — no spinner lib.
- **80 tests** (module) / **1042 full-suite**; per-file coverage ≥ 80%
  (internal `ansi.ts` + `inquirerAdapter.ts` at 100% after targeted tests).
- **Gates green**: `build`, `typecheck`, `lint`, `test:coverage`, `knip`,
  `check:deps`, `check:exports`, `check:scaffold`, `check:api`,
  `check:doc-exports`, `check:impl-counts` (10 of 22), `check:index`, `lint:md`,
  `check:doc-provenance` (10 sidecars verified).
- **5-spoke review, zero Must-fix**: spec-conformance (conformant, 12/12
  documented), silent-failure (PASS — no swallowed errors), type-design (PASS —
  `asserts`-narrowed `number`, literal error `code`), security (PASS — password
  confined to caller return path), code-review (PASS with follow-ups). Two
  low-risk Should-fix/Nits actioned (DRY the TTY/stream resolution; a
  password-mask why-comment).

## What went as planned

- **Contract phase firmed up the open shapes.** The spec was prose-only; the
  `spec-conformance-reviewer` (producer mode) returned an exact 12-symbol
  surface and surfaced 11 genuinely-undecided choices (D1–D11) back to the hub
  before tests froze — exactly the intended division of labour.
- **RED failed for the right reason** — `Cannot find module '../src/core/prompt/index.js'`,
  not a logic error, with all 962 pre-existing tests still green.
- **Constructor-injected adapter paid off.** Mocking `@inquirer/prompts` via a
  plain object of `vi.fn()`s (no TTY) made every prompt method unit-testable,
  and the `interactive`/`stream` injection made the live-vs-plain branch
  deterministic without touching `process.stdout`.
- **All five review spokes returned zero Must-fix**, and the two actioned
  follow-ups were behaviour-preserving polish, verified green.
- **`/syncing-docs` reconciled cleanly** once the numerator was bumped —
  provenance re-stamp, counts, exports, index, and markdown lint all passed in
  one pass.

## What didn't go as planned, and why

### 1. `exactOptionalPropertyTypes` rejected `default: value | undefined` at the adapter boundary

The GREEN implementer's first pass built adapter config objects with optional
keys set unconditionally to `optionValue | undefined` (e.g.
`{ message, default: options?.default, … }`). Under `exactOptionalPropertyTypes: true`,
an optional target prop like `default?: number` does **not** accept an explicit
`undefined`, so `typecheck` failed with five TS2379 errors across
`number`/`confirm`/`select`/`multiselect`/`autocomplete`. The spoke had run out
of turn while chasing an unrelated red herring, so the hub resumed it with the
exact fix.

**Why it happened:** the repo's strict TS config forbids passing explicit
`undefined` to an optional property; the natural "spread the option through"
pattern violates it.

**Fix for future:** when forwarding optional caller options into a strict target
type, **omit the key** rather than pass `undefined` — conditional-spread each
one (`...(v !== undefined ? { k: v } : {})`). Front-load this in the implementer
prompt for any submodule that adapts caller option bags into a third-party API.

### 2. Generic adapter methods can't be mocked via `interface extends … { m: ReturnType<typeof vi.fn> }`

The test file declared `interface MockPromptAdapter extends M3LPromptAdapter`
and overrode each method with `ReturnType<typeof vi.fn>`. Because
`M3LPromptAdapter` has **generic** methods (`select<Value>`, `checkbox<Value>`,
`search<Value>`), a non-generic `Mock` is not a valid override — TS2430 plus
~30 cascading TS2322 at every injection site. The implementer correctly flagged
it as a test-file issue (out of its write scope); the hub routed it to the
test-author.

**Why it happened:** `vi.fn()` produces a non-generic `Mock`; re-declaring a
generic method as a `Mock` under an explicit `extends` breaks the override
relation.

**Fix for future:** to mock an adapter/port with generic methods, **do not
`extends` and re-type**; let `makeMockAdapter()` return the inferred object of
`vi.fn()`s. Inference keeps each `.mock*` API usable, and an object of
`(...args: any[]) => any` mocks is still structurally assignable to the generic
port at the injection site.

### 3. A pure type-level test left a floating rejected promise (unhandled rejection)

The `expectTypeOf`-only test for `number()`'s return type called
`prompt.number(...)` without awaiting it; the default `vi.fn()` resolved
`undefined`, so `number`'s re-validation threw and the returned promise rejected
with nothing to catch it — surfacing as a vitest "1 error" (unhandled rejection)
even though all 62 assertions passed.

**Why it happened:** a type-only assertion still **executes** the expression at
runtime; when that expression returns a promise that rejects, the rejection
floats.

**Fix for future:** in a type-level test that invokes a fallible async method,
make the mock resolve a valid in-range value first (or otherwise avoid a
rejecting call). A resolved un-awaited promise is fine; a rejecting one is not.

### 4. A DRY refactor concentrated already-uncovered branches below the coverage gate

A post-review Should-fix extracted the duplicated stream/`isTTY`/`resolveInteractive`
block from `M3LMultiSpinner` and `M3LLoadingBar` into one `resolveRenderTarget`
helper in `internal/prompt/ansi.ts`. Both classes went to 100%, but the two
branches they had each left uncovered (the `?? process.stdout` fallback and the
`isTTY === true` arm) **concentrated** into the small helper, dropping `ansi.ts`
to 75% branch — below the 80% per-file gate. Fixed with two direct
`resolveRenderTarget` unit tests.

**Why it happened:** per-file coverage thresholds are sensitive to where shared
logic lives; moving lightly-tested branches from large files (with lots of other
covered branches) into a small helper raises that helper's uncovered-branch
ratio above the gate.

**Fix for future:** when a DRY extraction moves conditional logic into a new
small internal helper, **add direct unit tests for the helper's branches in the
same change** — don't assume the callers' existing tests still cover them at the
per-file granularity.

## Lessons learned

- **Omit, don't pass `undefined`** — under `exactOptionalPropertyTypes`,
  forward optional caller options with a conditional spread
  (`...(v !== undefined ? { k: v } : {})`), never `{ k: someValue | undefined }`.
  _(promoted → .claude/rules/library-src.md)_
- **Mock generic ports by inference** — a port with generic methods
  (`select<Value>`) cannot be mocked via `interface extends … { m: ReturnType<typeof vi.fn> }`
  (TS2430). Return the inferred object of `vi.fn()`s from the factory instead;
  it stays structurally assignable at the injection site.
  _(promoted → .claude/rules/tests.md)_
- **Type-only tests still run** — an `expectTypeOf` assertion executes its
  expression; if it calls a fallible async method, resolve the mock to a valid
  value first so no rejected promise floats as an unhandled rejection.
  _(promoted → .claude/rules/tests.md)_
- **DRY moves coverage** — extracting shared conditional logic into a new small
  helper can push that helper below the per-file coverage gate even when the
  callers hit 100%. Add direct tests for the helper's branches in the same change.
- **Verify the writer spoke's real state** — both implementer turns returned
  truncated mid-thought summaries; reading its journal + running
  typecheck/lint/coverage from the hub (not trusting the report) caught the real
  blockers each time. The pipeline's "trust the CLI, not the summary" rule held.
- **In-house ANSI over a spinner lib** — building `M3LMultiSpinner`/`M3LLoadingBar`
  with pure ANSI (one `\r\x1b[K` write per state change, no timers) kept the
  dependency to a single `@inquirer/prompts` and made rendering synchronous and
  trivially testable via an injected capture stream.
- **Numerator bump is required despite the plan's note** — the plan said not to
  touch the "N of 22" numerator, but that assumed `prompt` stayed unimplemented.
  Once its row flips to ✅, `check:impl-counts` is a hard gate that requires the
  bump across README ×2, `docs/README.md`, and the status intro.
