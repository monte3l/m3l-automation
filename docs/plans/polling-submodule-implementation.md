# Plan: Implement `core/polling` Submodule

## Context

5 of 22 submodules are implemented (errors, events, security, environment, utils). The
`polling` submodule has a complete specification in `docs/reference/core/polling.md` — 13
exports, no external npm dependencies, and no dependency on any other unimplemented
submodule. This plan runs the full `implement-submodule` TDD pipeline (contract → RED →
GREEN → review → sync) to bring `polling` to ✅ status. The `/sync-docs` skill handles
provenance stamping and submodule count updates — no manual bumping.

**Pre-flight note:** The working tree contains uncommitted session work (5 re-stamped
provenance sidecars, `CLAUDE.md` revisions, updated `.claude/` hooks, `package.json` with
the new `check:test-counts` script, and untracked `bin/check-test-counts.mjs` +
`.claude/hooks/guard-red-phase-comments.mjs`). These should be committed as a `chore:`
commit before the polling pipeline starts to keep CI history clean.

---

## Step 0 — Pre-flight commit (chore)

Stage and commit all current working-tree changes as a single `chore:` commit:

- `CLAUDE.md` (revised template comments, guard-red-phase-comments hook entry)
- `.claude/settings.json` (new hook wired)
- `.claude/hooks/remind-sync-docs.mjs` (updated)
- `.claude/hooks/guard-red-phase-comments.mjs` (new hook)
- `.claude/skills/sync-docs/SKILL.md` (updated)
- `package.json` (added `check:test-counts` script)
- `bin/check-test-counts.mjs` (new validator)
- `docs/reference/core/*.provenance.json` (5 sidecars re-stamped to HEAD)

Suggested message: `chore: add check-test-counts script, guard-red-phase-comments hook, and re-stamp provenance sidecars`

---

## Step 1 — Extract the contract

Run `spec-conformance-reviewer` in **contract-producer mode** against
`docs/reference/core/polling.md`.

The 13 exports to enumerate (from the spec):

| Export                     | Kind          | Notes                                                                                                   |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `M3LPoller`                | class         | `poll<T>(check: M3LPollCheckFn<T>): Promise<T>`; per-call backoff state                                 |
| `M3LRetryRunner`           | class         | `run<T>(op: () => Promise<T>): Promise<T>`; per-call backoff state                                      |
| `M3LBackoff`               | factory class | static: `exponential(startMs, capMs)`, `exponentialJittered(startMs, capMs)`, `constant(delayMs)`       |
| `M3LPollingPolicies`       | factory class | static: `athenaQuery()`, `cloudWatchLogsQuery()`, `awsThrottling()`, `httpDownload()`, `sqsBatchSend()` |
| `M3LPollCheckFn`           | type          | `() => Promise<M3LPollDecision<T>>`                                                                     |
| `M3LPollDecision`          | type          | discriminated union: `{ type: 'success'; value: T } \| { type: 'failure' } \| { type: 'continue' }`     |
| `M3LRetryClassifier`       | type          | `(err: unknown) => M3LRetryDecision \| M3LRetryAdvice`                                                  |
| `M3LRetryDecision`         | type          | `'retriable' \| 'fatal' \| 'unknown'`                                                                   |
| `M3LRetryAdvice`           | type          | `{ decision: M3LRetryDecision; delayMs?: number }`                                                      |
| `combineClassifiers`       | function      | first non-`'unknown'` wins; pure                                                                        |
| `awsThrottlingClassifier`  | const         | detects AWS throttle/rate-limit error names + transient 5xx                                             |
| `awsNetworkClassifier`     | const         | detects network-level transient errors                                                                  |
| `httpRetryAfterClassifier` | const         | maps HTTP status codes; respects `retryAfterMs`                                                         |

Key behavioral contracts:

- Per-call backoff isolation: state lives in the call frame, not the instance — two concurrent calls on one instance do not interfere
- `unknownDecision` option on `M3LRetryRunner` defaults to `'fatal'`
- `M3LRetryAdvice.delayMs` overrides the configured backoff for that attempt
- `combineClassifiers` consults classifiers in order; first non-`'unknown'` decision wins

---

## Step 2 — Write tests (RED phase)

Run the **`test-author`** spoke.

Target file: `packages/m3l-common/tests/polling.test.ts`
Import pattern: `from "../src/core/polling/index.js"`

Test scenarios to cover (minimum):

- `M3LPoller.poll()` resolves on `'success'`, rejects/throws on `'failure'`, loops on `'continue'`
- Per-call isolation: two concurrent `poll()` calls on one `M3LPoller` do not share state
- `M3LRetryRunner.run()` retries on `'retriable'`, propagates error on `'fatal'`
- `unknownDecision: 'fatal'` (default) stops on unclassified error; `'retriable'` retries
- `M3LRetryAdvice.delayMs` takes precedence over configured backoff
- `combineClassifiers` first-non-unknown-wins ordering
- Each built-in classifier recognises its target error class; returns `'unknown'` for foreign errors
- `M3LBackoff.exponential`, `M3LBackoff.exponentialJittered`, `M3LBackoff.constant` return valid strategy objects
- `M3LPollingPolicies.*()` returns an options object compatible with `M3LRetryRunner` constructor
- Type-level tests with `expectTypeOf` for `M3LPollDecision`, `M3LRetryDecision`, `M3LRetryAdvice`

Confirm all tests fail with the right reason (module not found or type error) before GREEN.

---

## Step 3 — Implement (GREEN phase)

Run the **`submodule-implementer`** spoke.

### New files (all under `packages/m3l-common/src/core/polling/`)

| File                    | Responsibility                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `M3LPoller.ts`          | `M3LPoller` class + `M3LPollCheckFn` + `M3LPollDecision`                                            |
| `M3LRetryRunner.ts`     | `M3LRetryRunner` class + `M3LRetryClassifier` + `M3LRetryDecision` + `M3LRetryAdvice`               |
| `M3LBackoff.ts`         | `M3LBackoff` factory class (three static methods)                                                   |
| `M3LPollingPolicies.ts` | `M3LPollingPolicies` factory class (five static policy methods)                                     |
| `classifiers.ts`        | `combineClassifiers`, `awsThrottlingClassifier`, `awsNetworkClassifier`, `httpRetryAfterClassifier` |
| `index.ts`              | barrel — `export * from "./M3LPoller.js"; ...`                                                      |

### File to edit

`packages/m3l-common/src/core/index.ts` — add:

```typescript
export * from "./polling/index.js";
```

### Conventions to enforce

- All relative imports carry `.js` extension (ESM rule; hook enforced)
- No `any`, no `!` assertions, no `require`/CommonJS
- Named exports only; TSDoc on every export; `@example` on `M3LPoller` and `M3LRetryRunner`
- Errors thrown must extend `M3LError` from `../errors/index.js`

---

## Step 4 — Review

Run all four review spokes **in parallel**:

- **`code-reviewer`** — SOLID, naming, structure
- **`type-design-analyzer`** — type encapsulation, branded types, illegal-state prevention
- **`silent-failure-hunter`** — swallowed errors, unchained causes, exhausted retries without surfacing
- **`spec-conformance-reviewer`** (conformance mode) — diff implementation against `docs/reference/core/polling.md`

Apply any must-fix items from reviewers before proceeding.

---

## Step 5 — Update implementation status

Edit `docs/implementation-status.md` polling row:

```
| polling | `core/polling.md` | 13 | ✅ | ✅ | ✅ | none |
```

Update the intro sentence's "5 of 22" count to reflect the new total **only by running `/sync-docs`** — do not edit the count prose manually.

---

## Step 6 — Doc sync

Run `/sync-docs` to:

1. Stamp `docs/reference/core/polling.provenance.json` (new sidecar, links section headings to source symbols and current git SHA)
2. Re-validate all existing provenance sidecars
3. Verify submodule counts in `README.md`, `docs/README.md`, and `CLAUDE.md` match the filesystem (`pnpm check:doc-counts`)
4. Run markdown lint (`pnpm lint:md`)

---

## Verification checklist

- [ ] `pnpm typecheck` passes (whole monorepo)
- [ ] `pnpm lint` passes (no eslint errors in polling src + tests)
- [ ] `pnpm test:coverage` passes (≥80% lines/functions/branches/statements package-wide)
- [ ] `pnpm build` succeeds (tsc emits `dist/core/polling/` with `.d.ts` + `.js`)
- [ ] `pnpm check:api` snapshot shows all 13 polling exports
- [ ] `pnpm check:scaffold` (barrel sync) passes — polling wired in core barrel
- [ ] `pnpm check:provenance` passes — `polling.provenance.json` created and valid
- [ ] `pnpm check:doc-counts` passes — submodule counts reconciled by `/sync-docs`
- [ ] `pnpm check:test-counts` passes (new gate; validates test coverage counts)
