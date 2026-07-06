# Plan: deepen-first 1.1 wave — technical implementation

- **Date:** 2026-07-06 · **Baseline:** `main` at 1.0.0
- **Implements:** the 1.1 wave of
  [ADR-0021](../adr/0021-post-1.0-deepen-first-strategy.md), sequenced by
  `docs/plans/2026-07-06-post-1.0-deepen-first-roadmap.md`. This document is
  the per-workstream technical detail the hub dispatches spokes from.
- **Ground truth:** every signature quoted below was read from source at the
  1.0.0 baseline. If a seam has drifted when a workstream starts, the spoke
  re-reads the file first and the contract in `docs/reference` wins.

## Context

Six code workstreams (WS-A…WS-F) plus one tooling workstream (WS-G) deliver
the deepen-first wave: all additive-minor, `exports` map untouched, every new
symbol surfaced through `src/core/index.ts`. Each workstream runs the
standard pipeline: `/start-work` → branch → doc-first contract edit →
`spec-conformance-reviewer` (producer mode) seeds the contract →
`test-author` RED → `submodule-implementer` GREEN → reviewer fan-out →
`/syncing-docs` → PR (`claude-pr-review` PASS). Fixed doc overhead per
workstream: reference-page edit, `pnpm check:provenance --update`,
`check:doc-exports`, `pnpm gen:index` + `check:index`, `lint:md`.

Two Phase-0 design decisions gate later workstreams (see roadmap): preset
merge semantics (WS-F) and dependency-layering zones (WS-G).

## WS-A — registerable text extractors — `feat/text-extractor-registration`

**Goal:** promote the existing registration seam to a documented, tested
public extension point. Correction to the roadmap's sketch: `M3LTextExtractor`
and `M3LTextExtractorRegistry` are **already exported** through
`src/core/text/index.ts` — no barrel change is needed. The gap is contract
documentation and test coverage of the consumer-facing path.

**Current seam** (verified):

```typescript
// src/core/text/contract.ts:74-90
export interface M3LTextExtractor {
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
  extract(
    filePath: string,
    options?: M3LTextExtractionOptions,
  ): Promise<M3LTextExtractionResult>;
}

// src/core/text/registry.ts:59-73
constructor(extractors?: readonly M3LTextExtractor[]) // default: [PlainText]
register(extractor: M3LTextExtractor): void           // append; order = precedence
```

**Work items:**

1. `docs/reference/core/text.md`: add an "Extending the registry" section —
   the `M3LTextExtractor` contract as an implementable interface, precedence
   semantics (registration order; constructor array replaces the default
   PlainText-only set), and a complete custom-extractor `@example` (e.g. an
   HTML-table extractor stub).
2. TSDoc: enrich `M3LTextExtractor` (contract.ts) and
   `M3LTextExtractorRegistry.register()` with the consumer-authoring contract
   (dispatch by MIME first, then extension; what `M3LTextExtractionResult`
   fields an extractor must populate; error expectations —
   `M3LTextExtractionError` with `cause`).
3. Tests (`tests/text.test.ts`): custom extractor registered via `register()`
   wins/loses precedence as documented; constructor-injected custom set
   bypasses defaults; a custom extractor's thrown error surfaces wrapped;
   `expectTypeOf` assertion that a minimal object literal satisfies
   `M3LTextExtractor`.

**No new exports** → `check:doc-exports` and `check:api` unaffected.
**Spokes:** `test-author` → (TSDoc-only src edits by `submodule-implementer`)
→ `code-reviewer` + `spec-conformance-reviewer` + `docs-consistency-reviewer`.
**Commit:** `docs(text): document extractor registration as a public extension point`
(+ `test(text): cover custom extractor registration`).
**Semver:** none-to-patch (docs/TSDoc only). **Effort:** S.

## WS-B — coverage backfill — `test/coverage-backfill`

**Goal:** close the known per-file soft spots with narrow tests. Tests only —
no src edits.

| Target                                          | Gap                                 | Test to write                                      |
| ----------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| `src/core/polling/M3LPoller.ts` (88.2% lines)   | lines 117–118, attempt-counter edge | `maxAttempts: 1` exhaustion boundary via `poll()`  |
| `src/core/prompt/M3LPrompt.ts` (86.1% branches) | lines 206, 229–294                  | spinner/multi-spinner input-validation error paths |
| `src/core/text/email.ts` (88.5% stmts)          | uncovered branches                  | malformed-message / missing-part paths             |

Read results from `coverage-final.json`, not the text table (work-log
lesson: the v8 text reporter hides 100% files).

**Spokes:** `test-author` only → `code-reviewer`.
**Commit:** `test: backfill coverage on poller, prompt, and email extractor`.
**Semver:** none. **Effort:** S.

## WS-C — polling/retry telemetry — `feat/polling-telemetry`

**Goal:** typed, opt-in observability events from `M3LPoller` and
`M3LRetryRunner`. Neither class emits anything today; both are plain classes
(no base). The house pattern for event surfaces is extending
`M3LEventEmitterBase<TEventMap>` (precedent: exporters'
`M3LListExporterEvents`), which keeps `emit` protected while exposing
`on`/`off`.

**Design:**

1. New file `src/core/polling/events.ts` with two event maps, following the
   exporters naming shape:

   ```typescript
   export interface M3LPollerEventMap {
     readonly "poll:attempt": M3LPollAttemptPayload; // { attempt, maxAttempts }
     readonly "poll:success": M3LPollSuccessPayload; // { attempt }
     readonly "poll:wait": M3LPollWaitPayload; // { attempt, delayMs }
     readonly "poll:exhausted": M3LPollExhaustedPayload; // { attempts }
   }
   export interface M3LRetryEventMap {
     readonly "retry:attempt": M3LRetryAttemptPayload; // { attempt, maxAttempts }
     readonly "retry:scheduled": M3LRetryScheduledPayload; // { attempt, delayMs, classification }
     readonly "retry:fatal": M3LRetryFatalPayload; // { attempt, classification }
     readonly "retry:exhausted": M3LRetryExhaustedPayload; // { attempts }
   }
   ```

   Error-bearing payloads carry a **summary** (name/code/message), not the
   raw error object — the raw error already travels via the throw path, and
   payloads must stay redaction-safe.

2. `export class M3LPoller extends M3LEventEmitterBase<M3LPollerEventMap>`
   (same for `M3LRetryRunner` with its map). Additive: adds public
   `on`/`off`; existing constructor options
   (`M3LPollerOptions { backoff, maxAttempts? }`,
   `M3LRetryRunnerOptions { classifier, backoff?, unknownDecision?, maxAttempts? }`)
   are unchanged. Emission points: attempt start, post-backoff scheduling
   (delay from the strategy before `delay()` in
   `src/internal/polling/delay.ts` is awaited), terminal success/fatal/
   exhausted.
3. Emitter-base semantics apply as documented in `core/events` (handler
   failures are contained per the events spec) — telemetry must never alter
   poll/retry outcomes. `silent-failure-hunter` verifies this explicitly.
4. Export the event maps + payload types through `src/core/polling/index.ts`.

**Docs:** `docs/reference/core/polling.md` — new "Events" section per map,
mirroring the exporters page's event documentation.
**RED tests:** handler receives ordered events for a 3-attempt success and an
exhaustion run (fake timers); payload shapes via `expectTypeOf`; a throwing
handler does not change `poll()`/`run()` results.
**Spokes:** full fan-out incl. `type-design-analyzer` (new public types) and
`silent-failure-hunter` (event path must not swallow or alter outcomes).
**Commit:** `feat(polling): emit typed poller and retry telemetry events`.
**Semver:** minor. **Effort:** M.

## WS-D — correlation-ID tracing — `feat/script-correlation-id`

**Goal:** one optional ID per script run, auto-threaded through hooks, logs,
and script-stage errors.

**Design (all fields optional — strictly additive):**

1. `M3LScriptOptions` (`M3LScriptOptions.ts:168-187`) gains
   `readonly correlationId?: string`. When absent, `M3LScript.run()`
   generates one per process run via `crypto.randomUUID()`;
   `createLambdaHandler()` generates one **per invocation**, preferring the
   platform request ID when the runtime context exposes one (align with the
   existing `setProcessGuardRequestId()` behavior in the lambda path).
2. `M3LScriptHookContext` (`M3LScriptOptions.ts:79-82`) gains
   `readonly correlationId: string` (always present on the context — the
   script has resolved one by the first hook).
3. `M3LLogger` (`M3LLogger.ts:34`) constructor widens additively from
   `(handlers)` to `(handlers, options?: M3LLoggerOptions)` with
   `M3LLoggerOptions { readonly correlationId?: string }`; `dispatch()`
   stamps it into a new optional `M3LLogEvent.correlationId?: string`
   (`M3LLogEvent.ts:26-37`). Handlers that ignore the field keep working;
   the JSON handler includes it.
   _Wiring note:_ `M3LScript` currently accepts an injected `logger` — when
   the consumer injects one, the script must not mutate it; instead the
   script stamps the ID into the hook context and into its own stage errors,
   and the docs show how to construct a logger with the same ID. (The
   implementer may propose a cleaner seam — e.g. an internal per-run child
   wrapper — `type-design-analyzer` arbitrates; no breaking change allowed.)
4. Script-stage errors: errors raised through `M3LScript` stages get
   `correlationId` merged into `M3LError.context` (constructor option
   `M3LErrorOptions { code, context?, cause? }` — enrichment happens where
   the script already wraps stage failures, and in
   `internal/script/diagnostics.ts` serialization so the stderr diagnostics
   line carries it (post-redaction).

**Docs:** `docs/reference/core/script.md` (options, hook context, lambda
semantics) + `docs/reference/core/logging.md` (`M3LLogEvent.correlationId`,
logger options).
**RED tests:** supplied ID appears on hook context, log events (JSON
handler), and a stage-failure error's context; generated-ID path is a UUID
and stable across one run; lambda handler issues distinct IDs across two
invocations; `expectTypeOf` for the widened options.
**Spokes:** full fan-out **plus `security-reviewer`** — the ID flows through
the redaction path (`redactSensitiveLogText`/`redactSensitiveLogValue`,
`redact.ts:241,292`) and the best-effort stderr diagnostics; it must never
displace redaction.
**Commit:** `feat(script): thread an optional correlation id through hooks, logs, and errors`.
**Semver:** minor. **Effort:** M.

## WS-E — schema-time config validators — `feat/config-validators`

**Goal:** declarative post-coercion validation on config parameters.

**Current seam** (verified):

```typescript
// src/core/config/M3LConfigParameter.ts:18-35
interface M3LConfigParameterOptions<TType extends M3LConfigParameterType> {
  readonly name: string;
  readonly type: TType;
  readonly aliases?: readonly string[];
  readonly defaultValue?: M3LCoercedValue<TType>;
  readonly asyncFallback?: () => Promise<M3LCoercedValue<TType>>;
}
// coerceConfigValue.ts:191-234
export function coerceConfigValue<T extends M3LConfigParameterType>(
  raw: unknown,
  type: T,
): M3LCoercedValue<T>;
```

**Design:**

1. `M3LConfigParameterOptions<TType>` gains
   `readonly validate?: M3LConfigValidator<M3LCoercedValue<TType>>` where

   ```typescript
   export type M3LConfigValidator<T> = (value: T) => true | string;
   ```

   Returning a `string` is the human-readable failure reason (better
   diagnostics than a bare boolean; `true` is the only passing value so
   truthy-string bugs are impossible).

2. Execution points: in `M3LConfigParameter.getValueAsync()` after coercion
   of a provider-resolved value and after `asyncFallback` resolution;
   `defaultValue` is validated eagerly in the constructor (a bad default is
   a programming error — fail fast).
3. Failure throws a new `M3LConfigValidationError extends M3LError` with
   `code: "ERR_CONFIG_VALIDATION"` and context
   `{ parameter, reason, value: <redaction-safe repr> }`. The new code is
   appended to `M3L_ERROR_CODES` (`M3LError.ts:88-140`) — the source-scan
   completeness guard in `tests/errors.test.ts` must stay green.
   (Alternative considered: reuse `M3LConfigCoercionError`/
   `ERR_CONFIG_COERCION`; rejected in this plan because validation-vs-
   coercion is a caller-actionable distinction. Implementer may re-open with
   the reviewers if the split proves awkward.)
4. Stock helpers, exported through `src/core/config/index.ts` → core barrel:

   ```typescript
   export const M3LConfigValidators = {
     range(min: number, max: number): M3LConfigValidator<number>,
     regex(pattern: RegExp): M3LConfigValidator<string>,
     oneOf<T>(allowed: readonly T[]): M3LConfigValidator<T>,
   } as const;
   ```

   Secret values: validators receive the real value (they must — that is the
   point), so the docs warn that validator failure _reasons_ must not embed
   the value for `secretNames` parameters; the error-context `value` repr is
   omitted for secret-flagged parameters.

**Docs:** `docs/reference/core/config.md` — parameter options row, the
validator contract, helper table, `@example`
(`port` with `M3LConfigValidators.range(1, 65535)`).
**RED tests:** pass/fail per helper; custom validator failure reason
surfaces in error message + context; default-value eager validation throws
at construction; secret parameter failure omits the value; `expectTypeOf`:
validator input type follows `TType` (e.g. `INT` → `number`), and a
mismatched validator type fails with `// @ts-expect-error`.
**Spokes:** full fan-out incl. `type-design-analyzer` + `security-reviewer`
(secret-value handling in reasons/context).
**Commit:** `feat(config): add schema-time validators with stock helpers`.
**Semver:** minor. **Effort:** M.

## WS-F — preset inheritance — `feat/preset-inheritance`

**Depends on:** Phase 0 decision 1 (merge semantics). Plan assumes the
recommended **shallow merge** (derived top-level key wholly replaces base
key; arrays replace) — adjust here if the decision differs before
dispatching spokes.

**Current seam** (verified): `M3LScriptPresetLoader.load(filePath)` returns
`Record<string, unknown>` from a YAML/JSON file
(`M3LScriptPresetLoader.ts:196-280`); structure depth is guarded by
`isWithinMaxDepth()` (`src/internal/script/presetDepth.ts`,
`MAX_PRESET_STRUCTURE_DEPTH = 64`); unknown top-level keys throw
`M3LPresetUnknownKeysError`.

**Design:**

1. Recognize an optional top-level `extends: string` key — a path to the
   base preset, resolved **relative to the directory of the extending
   file**; same YAML/JSON extension dispatch as `load()`.
2. Resolution algorithm in `load()`: recursively load the base first
   (tracking a `Set` of `path.resolve()`d files), shallow-merge derived over
   base, strip `extends` from the returned record. A revisited path throws
   the new error; a chain longer than `MAX_PRESET_EXTENDS_DEPTH = 16` (new
   internal constant, sibling to the structure-depth guard) also throws it.
3. New error `M3LPresetCycleError extends M3LError`,
   `code: "ERR_PRESET_CYCLE"`, context `{ chain: readonly string[] }` —
   append the code to `M3L_ERROR_CODES` (completeness guard applies).
   Exported via `src/core/script/index.ts` beside
   `M3LPresetUnknownKeysError`.
4. Ordering constraints: the unknown-keys validation and depth guard run on
   the **merged** result (so a base may carry keys the derived file omits),
   and `extends` itself is exempt from unknown-key checking at every level
   of the chain.

**Docs:** `docs/reference/core/script.md` — preset section: `extends`
syntax, relative-path resolution, shallow-merge semantics with a two-file
example, cycle/chain-depth errors.
**RED tests:** two-level chain merges with derived-wins; three-level chain;
`extends` stripped from result; direct + transitive cycle throw
`ERR_PRESET_CYCLE` with the chain in context; chain-depth cap; relative
resolution from a subdirectory; unknown-keys still enforced post-merge;
YAML base + JSON derived cross-format chain.
**Spokes:** full fan-out; `silent-failure-hunter` on the recursive-load
error paths (fs failures must chain `cause`, never vanish).
**Commit:** `feat(script): support preset inheritance via extends with cycle detection`.
**Semver:** minor. **Effort:** M.

## WS-G — ESLint dependency zones — `chore/eslint-dependency-zones`

**Depends on:** Phase 0 decision 2 (layering rules). Tooling only — no
runtime or public-API effect (ADR-0009 execution).

**Design constraints discovered up front:**

- `import-x/no-restricted-paths` zones are **not type-aware**:
  `core/script`'s legitimate type-only imports from `aws/` (and its lazy
  `await import()` provisioning seam) must not be flagged. Zones therefore
  encode what the graph actually is: e.g. `aws/**` may import only
  `core/errors` (+ type-only surfaces); `core/*` (except `script`) must not
  import `core/script`; nothing imports `internal/` across module
  boundaries beyond the existing sealing rule.
- Where a zone cannot express the type-only exception, the fallback is a
  justified inline `eslint-disable-next-line` (the repo already requires
  justification comments for error-channel disables) — prefer zone `except`
  entries first.

**Work items:** add the zone block to the `packages/*/src` section of
`eslint.config.js`; run `pnpm lint` across the repo to prove zero violations
at baseline (if a violation is real, it is a finding — report, do not
"fix" silently); document the layer diagram in a short comment above the
zone block.
**Spokes:** hub may edit config directly (not src/tests) →
`code-reviewer` post-edit.
**Commit:** `chore(lint): wire dependency-direction zones per ADR-0009`.
**Semver:** none. **Effort:** S–M.

## Execution order

```text
Phase 0 decisions (merge semantics → WS-F; layering rules → WS-G)
  │
  ├─ WS-A extractors ──┐
  ├─ WS-B coverage ────┤ independent; parallelizable in worktrees
  ├─ WS-C telemetry ───┤ (pnpm worktree:new <slug>, ADR-0013)
  ├─ WS-E validators ──┘
  ├─ WS-D correlation ← prefer after WS-C lands if both touch logging docs
  ├─ WS-F preset inheritance ← Phase 0 decision 1
  └─ WS-G eslint zones ← Phase 0 decision 2 (any time)
  │
  ▼
all merged + gates green → chore(m3l-common): bump version to 1.1.0
```

Two error-code additions (WS-E, WS-F) touch the same `M3L_ERROR_CODES`
tuple — if run in parallel worktrees, expect a trivial rebase on the tuple
and re-run the completeness guard.

## Wave-level proving gates

Per workstream: RED→GREEN, `typecheck`, `lint`, `test:coverage` (per-file
≥ 80% holds), `build`, `check:api` (exports map untouched),
`check:doc-exports`, `pnpm gen:index` + `check:index`,
`pnpm check:provenance --update` via `/syncing-docs`, `lint:md`, PR with
`claude-pr-review` PASS. Wave close: all seven merged, CI green on `main`,
`docs/implementation-status.md` notes updated by the hub, version bumped to
**1.1.0** in its own `chore` commit.
