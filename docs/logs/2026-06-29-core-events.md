# Work log — `core/events` submodule (2026-06-29)

Implementation of the second library submodule, `@m3l-automation/m3l-common`
`core/events`, run end-to-end through the hub-and-spoke TDD pipeline. This log
records what shipped, what matched the plan, what diverged and why, and the
durable lessons for the remaining 19 submodules.

Plan of record: [`docs/plans/events-submodule-implementation.md`](../plans/events-submodule-implementation.md).

## Summary

The `core/events` submodule is implemented, tested, reviewed, and committed
(`feat: implement core/events submodule`, `2e6d9c3`) on branch `feat/core-events`.

- **3 public symbols** in a single implementation file:
  `M3LEventHandler<TPayload>` (type alias), `M3LEventEmitterBase<TEventMap>`
  (abstract class), `M3LEventEmitter<TEventMap>` (concrete class).
- Surfaced through the `Core` namespace barrel; the three-entry `exports` map
  (`.`, `./core`, `./aws`) is unchanged.
- **33 tests** (136 across the suite), 100% statement / branch / function coverage
  on `M3LEventEmitterBase.ts`; `typecheck`, `lint`, `build`, and `check:api` green.
- Two reference doc files corrected as part of the same commit:
  `docs/reference/core/events.md` and `docs/m3l-common-architecture.md` both
  stated `Promise.all` where the behavioral contract requires `Promise.allSettled`.

## What went as planned

- The **hub-and-spoke TDD loop** ran exactly as designed: contract
  (`spec-conformance-reviewer`) → RED (`test-author`) → GREEN
  (`submodule-implementer`) → parallel review (`code-reviewer` +
  `spec-conformance-reviewer`). The hub never wrote `src/`/tests and never
  reviewed; spokes did the substantive work.
- **RED failed for the right reason** — the test suite errored on
  `Cannot find module '../src/core/events/index.js'`, not on a logic error.
- **Conformance came back conformant on first pass** — all 3 documented symbols
  present, all behavioral contracts met. The one doc discrepancy
  (`Promise.all` vs `Promise.allSettled`) was correctly flagged and corrected.
- **The `exports` map was never touched**; `check:api` stayed green throughout.
- **All logic in `M3LEventEmitterBase.ts`**, keeping `index.ts` as a pure barrel
  so coverage-exclusion of `**/index.ts` never hides real code.
- **`pnpm lint` ran inside the implementer spoke** (lesson baked in from
  `core/errors`), so eslint failures surfaced in-loop rather than at the hub gate.
  This prevented the extra implementer round that `core/errors` needed.
- **The `void handler(payload)` pattern** satisfied `@typescript-eslint/no-floating-promises`
  without an eslint-disable comment — the cleanest possible outcome.

## What didn't go as planned, and why

### 1. Lint errors in the test file after the implementer spoke

The implementer correctly ran `pnpm lint` on `src/` and reported clean. However,
the `pnpm lint` scope it used covered `packages/m3l-common/src/` rather than the
full workspace. The test file contained two categories of lint violations that only
appeared when running the root-level `pnpm lint`:

- **`@typescript-eslint/no-redundant-type-constituents`** (2 occurrences) — the
  `TestEmitter` helper class bound `TEvent extends keyof TestEvents & string`.
  Since `TestEvents`'s keys are already string literals (`"ping" | "tick"`), the
  `& string` intersection was vacuous and flagged as redundant.
- **`@typescript-eslint/require-await`** (5 occurrences) — async arrow handlers
  that only threw synchronously (to exercise error-isolation paths) had no `await`
  expression.

A separate test-author spoke resolved both: removed `& string` from the two
`TestEmitter` helper bounds; converted the no-await async handlers to non-async
functions returning `Promise.reject(new Error(...))` (semantically equivalent for
`Promise.allSettled`). Cost: one extra spoke round.

**Why it happened:** The implementer's in-loop lint command targeted `src/` only.
The test file is under `tests/`, which the implementer correctly does not own, but
it also means the implementer cannot catch violations there.

**Fix for future submodules:** In the implementer's final verification step, run
`pnpm lint` (workspace root, full scope) and inspect the output for test-file
violations — even if the implementer cannot fix them, it should flag them to the
hub so the test-author can be dispatched immediately rather than discovered at gate.

### 2. The `Record<string, unknown>` constraint was rejected by the type system

Both the code-reviewer and spec-conformance-reviewer flagged that the implementer
used `TEventMap extends object` instead of the plan-specified
`TEventMap extends Record<string, unknown>`. The Phase 4b fix was dispatched to
apply the tighter constraint.

The implementer correctly blocked it: `interface TestEvents { ping: …; tick: … }`
is a plain object interface with no index signature. TypeScript does not consider
it assignable to `Record<string, unknown>` (`{ [key: string]: unknown }`) because
the latter requires an explicit index signature. Applying the change produced six
typecheck errors in the test file, and — more importantly — would mean
`new M3LEventEmitter<{ update: string }>()` fails at call sites too, since
`{ update: string }` similarly lacks an index signature.

The `extends object` constraint is the correct choice: it allows plain interfaces
(the overwhelmingly common usage pattern) while the per-method constraint
`TEvent extends keyof TEventMap & string` enforces string-key semantics at the
point of subscription/emission. The reviewers' suggestion was technically valid
against the spec's _text_ but would have broken the spec's _intent_ (and real
callers).

**Lesson:** When a reviewer suggests tightening a generic constraint, verify it
against the most common instantiation pattern before dispatching a fix spoke. A
constraint that the spec documents as `Record<string, unknown>` may still need to
be `object` in TypeScript if the spec was written without awareness of how
structural typing handles plain interfaces vs mapped types.

### 3. The `emitAsync` implementation quietly improved on the plan's skeleton

The plan's `emitAsync` skeleton called handlers directly inside `.map()`:

```typescript
await Promise.allSettled([...set].map((handler) => handler(payload)));
```

The implementer shipped:

```typescript
await Promise.allSettled(
  [...set].map((handler) => Promise.resolve().then(() => handler(payload))),
);
```

The `Promise.resolve().then(...)` wrapper is a correctness improvement: if a
handler is a plain synchronous function that throws, calling it directly inside
`.map()` would let the exception propagate _out_ of `.map()` and escape the
`allSettled` boundary entirely. Wrapping in `Promise.resolve().then(...)` converts
synchronous throws into rejected promises, which `allSettled` absorbs correctly.

The test file included a test for this case (`"a sync-throwing handler inside
emitAsync does not prevent others from running"`), which the implementer needed to
satisfy — so the fix was necessity-driven, not gold-plating. The plan's skeleton
was subtly wrong; the spoke caught it without being told.

The `catch {}` binding also improved: the plan suggested `catch (_err: unknown) {}`
to satisfy `no-empty`, but the implementation uses bare `catch {}` (valid in
ES2019+ / TypeScript), which is cleaner and avoids the unused binding.

### 4. The initial commit body diverged from the repo's established style

The commit body that came out of the implementation pipeline was dense prose with
semicolons, mixed process metadata ("33 tests, 100% coverage; code-reviewed and
spec-conformance-reviewed (no must-fix)"), and a run-on doc-fix sentence. A
separate planning + amend step was needed to reformat it to bullet-point style
matching the two prior substantive commits (`7e73818`, `6bc5c30e`).

**Why it happened:** The commit message was composed by the hub in the same turn
as the final gate run, without comparing against historical commit bodies. The
process metadata felt useful in-session but is noise in the permanent record.

**Fix for future submodules:** Before committing, run `git log --format="%B" -3`
and compare the structure of prior substantive commits against the draft message.
Strip process metadata (review outcomes, test counts, coverage percentages) — those
belong in the work log, not the git history.

## Lessons learned

- **The implementer's in-loop lint must cover the full workspace root (`pnpm lint`),
  not just `src/`.** The test file is outside the implementer's write scope but
  inside the lint scope; violations there will block the hub's gate. The implementer
  should flag any test-file lint errors to the hub immediately so a test-author
  spoke can be dispatched without an extra round.

- **Tightening a generic constraint requires verifying it against plain interfaces.**
  `Record<string, unknown>` and `object` are not equivalent in TypeScript's
  structural type system. Plain interfaces (the common usage pattern for event maps)
  do not satisfy `Record<string, unknown>` without an explicit index signature. When
  a review suggests `Record<string, unknown>`, verify `new Cls<{x:number}>()` still
  compiles before shipping the change.

- **`Promise.resolve().then(() => handler(payload))` is the correct primitive inside
  `emitAsync`, not `handler(payload)` directly.** The wrapper converts synchronous
  throws into rejected promises, keeping them inside `allSettled`'s isolation
  boundary. The `handler(payload)` direct call works for async handlers but silently
  breaks isolation for synchronous ones. Front-load this into future emitter-adjacent
  spoke prompts.

- **Bare `catch {}` (no binding) is valid ES2019+ / TypeScript** and is preferable
  to `catch (_err: unknown) {}` in swallow-by-design catch blocks. No eslint-disable
  needed; no unused-variable warning.

- **Process metadata does not belong in the commit body.** Review verdicts, test
  counts, and coverage percentages are ephemeral (they change as the module evolves)
  and add noise to `git log`. Put them in the work log instead. Check prior commit
  bodies before writing a new one.

- **Lessons from `core/errors` that worked perfectly here:** running `pnpm lint`
  in-loop (prevented a hub-gate failure), reading coverage from `coverage-final.json`
  (not the text table), front-loading the `Promise.allSettled` vs `Promise.all`
  nuance verbatim into the spoke prompt, and trusting the CLI over the LSP.
