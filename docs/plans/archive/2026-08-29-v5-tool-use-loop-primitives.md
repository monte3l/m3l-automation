# V5 — tool-use loop primitives (2026-08-29)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Issue:** [#542](https://github.com/enri3l/m3l-automation/issues/542) —
  the `V5 — tool-use loop primitives` row of
  [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) § _m3l-cli build-out_, parented
  to epic #609.
- **Decision:**
  [ADR-0059](../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md)
  § _Decision_ (option 3).
- **Predecessor:**
  [`2026-08-20-agent-operator.md`](./2026-08-20-agent-operator.md) carries
  the wave-level plan; this file carries V5's detail.
- **Semver:** additive minor. Every new symbol surfaces through the existing
  AWS namespace barrel — no new `exports` subpath, no doc-count change.

## Why this plan exists

V4 shipped `aws/bedrock-runtime` as a typed Converse wrapper across two PRs
(#725 `invoke()`, #728 `invokeStream()`). It deliberately stopped at
single-turn text: `M3LBedrockContentBlock` is a **single-member tagged
union**, and its TSDoc says why in as many words — "V5 widens this with
`toolUse`/`toolResult` members; the `type` discriminant exists from V4
onward specifically so that widening is additive"
(`packages/m3l-common/src/aws/bedrock-runtime/types.ts:20-28`).

V5 collects on that promise. It adds a tool vocabulary and a bounded,
cancellable invoke → `tool_use` → execute → `tool_result` state machine, so
the V8 `scripts/agent-operator` consumer — and the later V10 MCP surface —
do not each re-implement the loop, the ceiling, the cancellation semantics,
or the cost accounting.

**V5 is not a new submodule.** ADR-0059 option 3 places the loop primitives
in the _same_ `aws/bedrock-runtime` submodule as the V4 wrapper
(`../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md:53-54,58-62`).
AWS stays at 20 documented submodules; `check:api` and `gen:counts` are
both no-ops for this change. `check:doc-exports` is **not** — every new
export must appear on the reference page in the same change.

## Constraints that shape the design

These were verified against the tree at `1ce48c23`, not assumed. They are
recorded here so the implementation does not rediscover them.

1. **The ESLint AWS island blocks the obvious reuse.** `aws/**` may import
   only `core/errors`, `core/prompt`, `core/polling`, and three named files
   (`eslint.config.js:851-870`, asserted exactly by
   `bin/check-eslint-zones.mjs:105-111`). V5 therefore **cannot** import
   `core/utils/guards.ts`'s `isPlainObject`, nor `core/logging/redact.ts`'s
   `escapeRegExp` (module-private anyway). Shape-guards are module-local —
   the same thing `aws/sqs/attributes.ts:50` and `aws/athena/template.ts:207`
   already do with `Object.hasOwn`. A reviewer flagging the local guard as a
   "reuse the exported predicates" violation should be pointed here.
2. **A V4 type-level test pins the union and fails on widening.**
   `packages/m3l-common/tests/bedrock-runtime.test.ts:952-954` asserts
   `expectTypeOf<M3LBedrockContentBlock>().toEqualTypeOf<M3LBedrockTextBlock>()`.
   Slice A rewrites it into the widened assertion. This break is
   **intentional** — that pin exists to make the widening visible.
3. **File-budget headroom is tight and `stream.ts` is effectively frozen.**
   The ceiling is 25,000 bytes per `src` file with **no bedrock file
   baselined** (`bin/check-file-budget.mjs:50`; `bin/file-budget-baseline.json`
   has no bedrock entry). At `1ce48c23`: `stream.ts` 23,862 · `client.ts`
   14,274 · `error.ts` 12,993 · `shared.ts` 10,965 · `types.ts` 7,278 ·
   `index.ts` 1,232. `stream.ts` has ~1.1 KB of headroom — the mechanical
   reason streaming tool-use is out of scope, independent of the scope call.
4. **`ERR_BEDROCK_RUNTIME_STREAM` is missing from the errors registry doc.**
   Registered in code (`core/errors/M3LError.ts:119`, `catalog.ts:126`) and
   cited on `docs/reference/aws/bedrock-runtime.md:239`, but absent from
   `docs/reference/core/errors.md`'s table, whose rows jump from
   `ERR_BEDROCK_RUNTIME_OPERATION` straight to `ERR_BINARY_FILE_EXPORT`.
   Pre-existing V4-slice-2 drift; no gate cross-checks `M3L_ERROR_CODES`
   against that table, which is why it survived. Slice A fixes it, in the
   same table V5 edits anyway.
5. **`toSdkMessage` and `ConverseInput` are shared by both methods.**
   `shared.ts:154-162` maps `block.text` unconditionally and
   `ConverseInput.messages.content` is typed `{ text: string }[]`
   (`shared.ts:170-175`). Both need widening, and both sit on
   `invokeStream`'s path — so the request-type split below is load-bearing,
   not cosmetic.
6. **The SDK's document type has a mutable array member.**
   `__DocumentType` is `@smithy/types`' `DocumentType`, whose array arm is
   `DocumentType[]`, not `readonly DocumentType[]`. A `readonly` library
   value is therefore not assignable, forcing a copying mapper — the same
   reason `shared.ts:218` already copies `stopSequences` into a fresh array.

## Slice A — tool vocabulary (PR 1)

### New public types

In `src/aws/bedrock-runtime/types.ts` (7,278 → ~12 KB):

- `M3LBedrockToolUseBlock` —
  `{ type: "toolUse"; toolUseId: string; name: string; input: unknown }`.
- `M3LBedrockToolResultBlock` —
  `{ type: "toolResult"; toolUseId: string; content: readonly M3LBedrockToolResultContent[]; status?: "success" | "error" }`.
- `M3LBedrockToolResultContent` —
  `M3LBedrockTextBlock | { type: "json"; json: unknown }`. A deliberate
  2-of-6 subset of the SDK's `ToolResultContentBlock` union
  (`models_0.d.ts:2641`); image/document/video/searchResult are a documented
  scope boundary.
- `M3LBedrockContentBlock` widens to
  `M3LBedrockTextBlock | M3LBedrockToolUseBlock | M3LBedrockToolResultBlock`.
- `M3LBedrockToolDefinition` —
  `{ name: string; description?: string; inputSchema: M3LBedrockToolInputSchema }`,
  mirroring the SDK's `ToolSpecification` (`:3493`) minus `strict`.
- `M3LBedrockToolInputSchema` — `Readonly<Record<string, unknown>>`. The repo
  has no `JsonValue` type (`core/json/types.ts` exports only
  format/detection types), JSON Schema is an open, versioned vocabulary, and
  `no-any` forbids the SDK's `__DocumentType`.
- `M3LBedrockToolChoice` — `"auto" | "any" | { readonly tool: string }`,
  flattening the SDK's 3-member `ToolChoice` namespace union (`:3394`).
- `M3LBedrockToolInvokeRequest` —
  `M3LBedrockInvokeRequest & { tools?: readonly M3LBedrockToolDefinition[]; toolChoice?: M3LBedrockToolChoice }`.

### Discriminants are `"toolUse"` / `"toolResult"`

camelCase, mirroring the SDK member names exactly as V4's `"text"` does. The
stream events' kebab-case (`"message-start"`) is reserved for
library-invented _fusions_ — `"message-stop"` fuses two distinct SDK events,
so borrowing either name alone would mislead (`types.ts:131-138`). These two
are 1:1 with `ContentBlock.ToolUseMember` / `ToolResultMember`, so the
mirroring rule applies, and they land in the _same union_ as the
already-mirrored `"text"`. It is also the spelling
`docs/reference/aws/bedrock-runtime.md:26-27` already promised.

One consequence to state in TSDoc rather than let a reader trip over: after
V5, `stopReason === "tool_use"` (snake) and `block.type === "toolUse"`
(camel) coexist. That is the correct result of mirroring two different SDK
vocabularies verbatim; harmonizing them into a library dialect would make
both unpredictable.

### Why a separate request type

`invoke()` takes `M3LBedrockToolInvokeRequest`; `invokeStream()` keeps the V4
`M3LBedrockInvokeRequest`. Passing a tool-bearing literal to `invokeStream`
is then a **compile error** rather than a silent drop — and silently dropping
tool requests mid-stream is the exact failure class already documented for
reasoning deltas (`bedrock-runtime.md:686-691`). Structural typing still lets
a non-literal through, so `client.ts`'s thin `invokeStream` delegator adds a
cheap runtime guard that throws `M3LBedrockRuntimeOperationError`
(`origin: "caller"`) rather than ignoring the tools. The guard lands in
`client.ts`, **not** `stream.ts` — see constraint 3.

### Changed and new files

| File        | Now    | After        | Change                                                                                                                                                                               |
| ----------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`  | 7,278  | ~12,000      | The new block/definition/choice types; `M3LBedrockContentBlock` widens.                                                                                                              |
| `shared.ts` | 10,965 | ~14,000      | `toSdkMessage` becomes an exhaustive `switch`; `ConverseInput`'s content type widens; `buildConverseInput` gains a conditional `toolConfig`.                                         |
| `client.ts` | 14,274 | ~15,500      | `invoke`'s response mapping keeps `toolUse` blocks instead of dropping them; the `invokeStream` delegator guard.                                                                     |
| `tools.ts`  | —      | ~6,000–8,000 | **New.** Tool-definition → SDK `ToolConfiguration` mapping, SDK → library content-block mapping, the module-local shape guards, and the copying document mapper constraint 6 forces. |
| `index.ts`  | 1,232  | ~1,700       | New type exports.                                                                                                                                                                    |
| `stream.ts` | 23,862 | 23,862       | **Untouched**, and must stay so.                                                                                                                                                     |
| `error.ts`  | 12,993 | 12,993       | Untouched in this slice.                                                                                                                                                             |

### Tests

`packages/m3l-common/tests/bedrock-runtime-tools.test.ts` (~30–40 tests),
importing only the tool vocabulary and `invoke`'s tool path so `perFile` v8
coverage binds within the slice; plus the one-test rewrite at
`bedrock-runtime.test.ts:952`.

### Docs

Reference-page Overview + Public API + a V5 scope-boundary note replacing the
V4 one; the `ERR_BEDROCK_RUNTIME_STREAM` registry-table fix (constraint 4);
the `Landing plan` section gains slices 3 and 4.

## Slice B — conversation state + the loop (PR 2)

New files: `conversation.ts` (~5 KB) and `loop.ts` (~10–14 KB).

**Conversation state** is an explicit immutable value the caller holds
(ADR-0059:74-76, "no hidden client state") — a readonly record plus pure
helpers returning new values, not a stateful class. Grep confirms the repo
has no `with*` builder-method precedent anywhere; every _value_ here is a
`readonly` interface.

**The loop** mirrors `invokeStream`'s established shape: a thin entry point
delegating into `loop.ts`, exactly as `client.ts:355` delegates to
`stream.ts`, and for the reason `client.ts:8-16` states verbatim — ADR-0072's
per-file size ratchet. Whether the entry point is a method on
`M3LBedrockRuntimeOperations` or a free function is the one open type-level
question; it is **settled at Step 4 with a compile probe**, per
`implementing-submodules`' contract-settling rule, not during implementation.

**Options:** `{ maxIterations?; maxToolsPerTurn?; signal?; rates? }`. `rates`
is the optional caller-supplied per-model price table; absent, the outcome
carries token usage only and the cost key is **omitted**, not `undefined`
(`exactOptionalPropertyTypes`).

**Outcome:** final message, terminal stop reason, cumulative
`M3LBedrockTokenUsage`, iteration count, a per-iteration tool-execution
record — including any handler failure's cause, so a handler error surfaced
to the model as `status: "error"` is never _also_ invisible to the caller —
and the computed cost when rates were supplied.

**Cancellation** reuses `shared.ts:100-102`'s `isAborted` named-function
pattern and throws `M3LOperationAbortedError`, so a cancelled loop classifies
identically to a cancelled `invoke()` and is never double-classified.

**New error** `M3LBedrockToolLoopError`, code `ERR_BEDROCK_RUNTIME_TOOL_LOOP`,
registered in `M3LError.ts`, `catalog.ts`, and `docs/reference/core/errors.md`
in the same commit. The completeness guard lives in `core/errors`' own suite
and gives no signal from an isolated module run — so run `pnpm test`, not
just the bedrock files.

### Termination

The loop throws only when continuing is **structurally impossible**. Every
"the model or service made a judgement about this generation" outcome
_resolves_, because throwing would discard the cumulative usage the caller
was already billed for, and because `library-src.md` says to stay lenient on
external data. Over the closed nine-member union, as an exhaustive `switch`:

| `stopReason`                                                                                                                              | Loop does                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `tool_use` with ≥1 toolUse block                                                                                                          | **continue** — the only continuing arm         |
| `end_turn`, `stop_sequence`                                                                                                               | **stop, completed**                            |
| `max_tokens`, `content_filtered`, `guardrail_intervened`, `malformed_tool_use`, `malformed_model_output`, `model_context_window_exceeded` | **stop, early** — reason echoed on the outcome |
| `tool_use` with zero toolUse blocks                                                                                                       | **throw** `M3LBedrockRuntimeOperationError`    |

**`stopReason` is authoritative and content is advisory.** If the reason is
not `tool_use`, any toolUse blocks in the message are **never executed** — a
`max_tokens`-truncated block can carry a half-serialized `input`, and running
a destructive handler on partial arguments is the worst failure this module
has.

### Two ceilings, both mandatory

`maxIterations` (default 10) counts _model invocations_; `maxToolsPerTurn`
(default 8) bounds a single turn's tool batch — a turn's block count is just
as much an unbounded loop over model-supplied structure. Both validate
`Number.isInteger(n) && n >= 1` at the boundary, explicitly rejecting
`Infinity` so "no ceiling" is unrepresentable.

This is `library-src.md`'s unbounded-loop rule in its sharpest form: the
continuation count is chosen by _model output_, which the caller does not
control at all, and the failure mode is not a `RangeError` but silently
burning billed API calls forever. Ten, not
`M3L_PROCEDURE_MAX_ITERATIONS`'s 100 — that constant bounds in-process step
executions, which are free; each iteration here is a paid, latency-bearing
model call.

### Exactly two loop-owned abort checks, plus one consult

- **Before each invoke** — not redundant with `client.ts:226-228`. In the
  race where the signal fired _and_ the ceiling is reached, checking the
  ceiling first would report an operator cancel as a caller-origin failure
  instead of ADR-0049's `interrupted`. **Abort beats ceiling**; say so in the
  TSDoc or someone will "simplify" it away.
- **Immediately before every handler dispatch, including the first** —
  `invoke()` provably does _not_ re-check after `runner.run()` resolves
  (`client.ts:294`), and these handlers drive real AWS mutations.
- **On a handler rejection, consult `isAborted(signal)` first.** A handler
  that honours the signal and throws `M3LOperationAbortedError` must _not_ be
  converted into a `status: "error"` toolResult — that would continue the
  loop past a cancellation.

The loop never calls `isAbortError` or `classifySendFailure` (both live below
`invoke()`), and rethrows `M3LOperationAbortedError` first in any `try`, so a
cancelled loop is never double-classified. On abort mid-batch, **no partial
toolResult turn is appended** — a Converse turn whose toolResults don't cover
every toolUse block is invalid on resume.

### Handlers run strictly sequentially, in block order

This is what makes the per-dispatch abort check a _complete_ guarantee: at
most one handler is ever in flight, and none starts after the abort.
`Promise.all` is wrong twice over — it rejects while siblings are still
mutating AWS state, and its discarded sibling rejections surface as unhandled
rejections, the exact silent swallow the settled contract forbids. The
`signal` is forwarded into the handler so cancellation reaches inside it.
Named non-guarantee: **no per-handler timeout.**

### Model input dispositions

Unknown tool name and non-object `input` become `status: "error"`
toolResults and the loop continues — external data, and the protocol requires
a result for every block. Missing/empty `toolUseId`, a duplicate `toolUseId`
within one turn, and a missing `name` all **throw** before any handler runs:
no well-formed result set exists.

The tool registry is a `Map`, not a plain record, which makes the
`"__proto__"`/`"constructor"` hazard — resolving an inherited _function_ that
then gets called as a handler — structurally unrepresentable rather than
merely guarded.

The model's `toolUse.input` arrives already-decoded from the SDK, so V5
parses no model _text_; the obligation is shape-guarding, with `Object.hasOwn`
reads to avoid prototype pollution.

### Error-leak allowlist

`M3LError.context` is serialized **verbatim** by `toJSON()`, so the new
error's context is exactly: `maxIterations`, `iterationsCompleted`,
`lastStopReason`, the three `usage` numbers, `modelId`, `pendingToolCount`,
`toolErrorCount`. No conversation, no messages, no tool names or ids, no
handler cause.

Make it **structural rather than documented**: the constructor takes
primitives only and accepts **no `cause` parameter at all** — the
`M3LOperationAbortedError` precedent — a property verifiable by grepping one
constructor instead of auditing every call site. The message template
interpolates numbers only.

Audit **per channel**: a planted secret must be absent from `toJSON()`, from
`util.inspect`, _and_ from `formatErrorChain`/`serializeErrorChain`, which
walk the live chain and never call `toJSON()`.

The **outcome ledger is the other leak surface** — it deliberately carries
the conversation and the handler causes, so it is **not** redaction-safe and
must be documented as such.

### Tests

`packages/m3l-common/tests/bedrock-runtime-loop.test.ts` (~64 tests),
importing only the loop and conversation symbols so `perFile` v8 coverage
binds within the slice. Ten groups: loop control flow (6), a `test.each`
enumerating **all nine** stop reasons (11), ceilings (8), cancellation (7),
handler-failure feedback (6 — sequential execution proven by observed
start/end _interleaving_, not call count), untrusted model input (9 —
including `"__proto__"` as a tool name and ~500k-char adversarial padding),
usage/cost (5), the per-channel leak audit (5), catalog/barrel reachability
(4), and V4 interop (4).

Per `.claude/rules/subagent-dispatch.md`, a >40-test file is pre-split into
checkpointed `test-author` batches by group, never one unbroken pass.

### Known non-guarantee to document

A `NoModelError`/`ModelError` thrown from `invoke()` mid-loop propagates
unchanged and therefore does **not** carry the accumulated usage — only the
loop's own ceiling error does. Propagating unwrapped is worth more than
re-wrapping; the reference page says so rather than leaving it implicit.

### Also in PR 2

`docs/plans/IMPLEMENTATION.md`'s V5 row flips `To Do` → `Done` with both PR
numbers and both work-log paths, **keeping the Item cell byte-identical** so
the `m3l-hub-sync:impl:agent-operator:v5-tool-use-loop-primitives` join key
still resolves — the mechanic PR #729 called out.

`docs/implementation-status.md`'s bedrock-runtime row also updates: its Notes
cell is **stale**, still reading "slice 1 of 2 … streaming is slice 2,
tracked separately" and citing only 40 tests, from before PR #728.

## Execution

0. `pnpm worktree:new v5-tool-use-loop-primitives` →
   `../m3l-automation-v5-tool-use-loop-primitives`, branch
   `feat/v5-tool-use-loop-primitives` off `origin/main`.
1. Write and prettier-format this plan; commit it **before** implementation
   (`implementing-submodules` Step 2).
2. **No dependency gate:** `@aws-sdk/client-bedrock-runtime@3.1115.0` is
   already installed and carries every tool type V5 needs.
3. Per slice, run the `implementing-submodules` loop:
   `spec-conformance-reviewer` (contract) → `test-author` (RED) →
   `code-implementer` (GREEN) → the 5-spoke review fan-out + an adversarial
   `security-reviewer` refute pass → bounded confirmation re-review of every
   fix round. Each writer and reviewer spoke gets an explicit
   journal/scratchpad path and a tight file list.
4. Slice A ships as PR 1 and **merges before Slice B's RED begins**
   (ADR-0072: a multi-slice module is never one RED/GREEN pair).
5. After Slice B's review is clean: `/syncing-docs`, then
   `/writing-work-logs` → `docs/logs/2026-08-29-aws-bedrock-runtime-tools.md`
   and `…-loop.md`.
6. Flip the tracker row and the `implementation-status.md` row in PR 2.
   `git mv` this plan into `docs/plans/archive/`.
7. Merge PR 2, then from `main`: `pnpm sync:hub` (dry-run, confirm #542 is
   under "Issues to close"), then `pnpm sync:hub --apply`. Verify the close
   reason is `completed`, not `not planned`.
8. `pnpm worktree:remove v5-tool-use-loop-primitives`.

## Verification

Per slice, before opening its PR:

- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — the Definition
  of Done.
- `pnpm check:file-budget` **inside the GREEN dispatch**, not only at the
  end — the V4 streaming slice discovered the 25 KB ceiling after review had
  already signed off (`../logs/2026-08-28-aws-bedrock-runtime-streaming.md`).
- `pnpm check:zones` — proves the AWS island wasn't widened.
- `pnpm check:doc-exports`, `check:provenance`, `check:doc-counts`,
  `check:impl-counts`, `check:test-counts`, `check:scaffold-seam` — all via
  `/syncing-docs`, which owns the ordering.
- `pnpm check:review-size` — ADR-0072's 75,000-char soft target; the CI hard
  ceiling is 300,000 (`.github/workflows/claude-pr-review.yml:59`).
- `node bin/check-tracker-status.mjs` after the row flip.
- Full `pnpm verify` before the final push.
- Coverage: read `coverage-final.json` from the **first** `test:coverage`
  pass — the v8 text table hides 100%-covered files, and a later `bin/` run
  overwrites the JSON.

**End-to-end acceptance** (the doc is only correct if the mechanism runs):
drive a fake `BedrockRuntimeClient` through a two-tool, three-iteration
conversation and assert the outcome's cumulative token usage, the
iteration-ceiling throw, an aborted loop, and a throwing handler surfacing as
`status: "error"` — the same "run it once end-to-end" rule that caught two
shipped-but-unreachable features
(`../logs/2026-07-11-scripts-json-etl.md`).

**Host note:** `pnpm check:host-resources` warns at plan time — 2 other
`claude` processes on a 15 GiB/14-core host. Run `pre-push` in the background
rather than concurrently with another pipeline (ADR-0080), and expect the
known parallel-Vitest 5 s-timeout flake to need a retry, never `--no-verify`.
