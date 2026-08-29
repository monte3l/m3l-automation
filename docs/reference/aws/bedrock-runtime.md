# Bedrock Runtime Operations

`M3LBedrockRuntimeOperations` is a typed wrapper over a raw
`BedrockRuntimeClient`'s Converse API, so callers never import
`@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
types directly. See [ADR-0059](../../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md)
for why this module exists. ADR-0059 option 3 places V5's tool-use loop
primitives in **this same submodule** rather than a new one — so the tool
vocabulary below is an additive widening of the V4 surface, not a new
`exports` subpath.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LBedrockRuntimeOperations` wraps
one of those raw clients (`bedrockRuntime`), translating the Converse API's
request/response shapes into plain, library-owned types so a caller never
touches an `@aws-sdk/client-bedrock-runtime` type. Built on `Converse` /
`ConverseStream` (not the lower-level `InvokeModel` API) — the unified,
model-agnostic Messages surface, so the wrapper never hand-rolls or parses a
per-model JSON request/response body.

**Scope boundary (V5): `invoke()` is tool-aware, `invokeStream()` is not.**
V4 shipped `M3LBedrockContentBlock` as a deliberately single-member tagged
union so that V5's widening would be additive — that widening has now landed:
the union carries `toolUse` and `toolResult` members alongside `text`, and
`invoke()` accepts a `M3LBedrockToolInvokeRequest` carrying `tools` and
`toolChoice`.

`invokeStream()` deliberately stays **text-only** and keeps the narrower V4
`M3LBedrockInvokeRequest`. The Converse _stream_ event union has no tool-use
member in this wrapper, so forwarding a tool config into a stream would let
the model emit tool requests that are silently dropped mid-stream — the same
failure class already documented for reasoning deltas below. Keeping the two
request types distinct makes passing a tool-bearing **literal** to
`invokeStream` a compile error rather than a silent drop; because structural
typing still admits a non-literal, `invokeStream` **also** throws
`M3LBedrockRuntimeOperationError` (`origin: caller`) at runtime rather than
ignoring the tools. Streaming tool-use is out of scope for V5.

- `M3LBedrockRuntimeOperations` — the wrapper class, constructed from a raw
  `BedrockRuntimeClient` and an ordered model-id fallback list. Exposes
  `invoke()` (single-shot) and `invokeStream()` (streaming).
- `M3LBedrockRuntimeOperationError`, `M3LBedrockRuntimeModelError`,
  `M3LBedrockRuntimeNoModelError`, `M3LBedrockRuntimeStreamError` — thrown on,
  respectively, a transport/API-call failure, a model-side inference fault,
  fallback-order exhaustion, and a mid-stream lifecycle fault after at least
  one `M3LBedrockStreamEvent` has already been yielded to the caller.
- Plain types: `M3LBedrockMessage`, `M3LBedrockTextBlock`,
  `M3LBedrockContentBlock`, `M3LBedrockRuntimeRole`, `M3LBedrockStopReason`,
  `M3LBedrockTokenUsage`, `M3LBedrockInferenceConfig`,
  `M3LBedrockInvokeRequest`, `M3LBedrockInvokeOptions`,
  `M3LBedrockInvocationResult`, `M3LBedrockRuntimeOptions`,
  `M3LBedrockStreamEvent` (and its three members: `M3LBedrockStreamStartEvent`,
  `M3LBedrockStreamTextDeltaEvent`, `M3LBedrockStreamStopEvent`).
- Tool vocabulary (V5): `M3LBedrockToolUseBlock`, `M3LBedrockToolResultBlock`,
  `M3LBedrockToolResultContent`, `M3LBedrockToolResultJsonBlock`,
  `M3LBedrockToolResultStatus`, `M3LBedrockToolDefinition`,
  `M3LBedrockToolInputSchema`, `M3LBedrockToolChoice`, and
  `M3LBedrockToolInvokeRequest`.

## Public API

### `M3LBedrockRuntimeOperations`

**Constructor** — `new M3LBedrockRuntimeOperations(client, options)`, where
`client` is a raw `BedrockRuntimeClient` (e.g. `script.aws.clients.bedrockRuntime`
— the only Bedrock provider getter this slice adds; unlike every other
`AWSServiceProvider.*Operations` wrapper, there is **no** cached
`bedrockRuntimeOperations` convenience getter, since the model fallback list
is inherently caller-specific configuration with no library-owned sane
default — a caller constructs `M3LBedrockRuntimeOperations` itself, once,
with its own `models` list) and `options`
is `M3LBedrockRuntimeOptions` — `{ models: readonly [string, ...(readonly string[])] }`,
an ordered, **type-level non-empty** fallback list (`models[0]` is the
primary model id; later entries are tried only on a model-availability
fault). The non-empty-tuple type makes an empty array a compile error for a
caller passing a literal, rather than an invariant enforced only at runtime
— but a config- or JSON-sourced `string[]` can still arrive empty after
being downcast to satisfy the type, so the constructor **also** throws
`M3LBedrockRuntimeNoModelError` at construction if `models` is empty — this
is a caller/config error, not deferred to the first `invoke` call, and stays
as defense-in-depth for exactly that downcast case.

| Method                               | Retried? | Returns                                             | Throws / rejects with                                                                                                         |
| ------------------------------------ | -------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `invoke(request, options?)`⁴         | Yes¹     | `Promise<M3LBedrockInvocationResult>`               | `M3LBedrockRuntimeOperationError`, `M3LBedrockRuntimeModelError`, `M3LBedrockRuntimeNoModelError`, `M3LOperationAbortedError` |
| `invokeStream(request, options?)`² ⁵ | Yes¹ ³   | `AsyncGenerator<M3LBedrockStreamEvent, void, void>` | Same four as `invoke`, **plus** `M3LBedrockRuntimeStreamError` for a fault after at least one event has already been yielded  |

¹ `ThrottlingException`/`InternalServerException` retry on the **same** model
via `M3LRetryRunner` before any fallback is attempted; see "Fault handling and
model fallback" below for the retry classifier's exact scope.

² `invokeStream` is an `async function*`: calling it synchronously returns a
generator and does **nothing** yet — model selection, `client.send()`, and
every fault above surface only once the caller starts iterating (the first
`.next()` or `for await`), matching `Core.messaging`'s `M3LMessenger.read()`
convention. Every yielded `M3LBedrockStreamEvent` is one of three shapes —
see `M3LBedrockStreamEvent` below — there is no error-shaped event; every
fault is a rejection of `.next()`, never a yielded value.

³ Retry/fallback for `invokeStream` is possible **only until the first event
is yielded** — see "Fault handling and model fallback" below for the
`hasYielded` commit boundary and why nothing retries or falls back after
that point.

⁴ `invoke`'s `request` is `M3LBedrockToolInvokeRequest` — the V4
`M3LBedrockInvokeRequest` widened with optional `tools`/`toolChoice`. Since
every field it adds is optional, a V4 request literal still type-checks
unchanged.

⁵ `invokeStream`'s `request` stays the narrower `M3LBedrockInvokeRequest`, and
`invokeStream` **throws** `M3LBedrockRuntimeOperationError` (`origin: caller`,
`retryable: false`) in **two** cases: a structurally-typed value carrying an
own `tools` or `toolChoice` property (presence alone is enough, so `tools: []`
is refused too), **or** a `messages[].content` entry that is not a `text`
block. The second case matters because `M3LBedrockContentBlock` is shared by
both methods, so V5's widening would otherwise have let a `toolUse` block
reach `ConverseStream` — where this wrapper has no event for it. Both cases
throw the same message. Because `invokeStream` is an `async function*`, the
throw surfaces on the first `.next()`, not at call time.

**`AbortSignal` cancellation.** `options?.signal` is checked against a
module-private `isAborted(signal)` helper (the ADR-0049 named-function
convention — see `aws/athena/client.ts`; a bare `signal?.aborted` re-check
after an `await` produces a TS2367 false alarm) at every point an abort
could have occurred: before the initial `send()`, before advancing fallback
to the next model, and inside the retry/fallback catch block. The two
proactive checks (before `send()`, before advancing fallback) act on
`isAborted(signal)` alone — there is no caught error to correlate against
yet — and immediately throw `M3LOperationAbortedError`. The **reactive**
check inside the catch block is stricter, matching `aws/athena/client.ts`'s
precedent exactly: it promotes a caught rejection to
`M3LOperationAbortedError` only when **both** `isAborted(signal)` **and**
`isAbortError(error)` hold (`error instanceof Error && error.name ===
"AbortError"` — the shape the AWS SDK actually throws when its own
`abortSignal` fires mid-`send()`). A signal that happens to be aborted for
an unrelated reason at the same moment a genuine `ValidationException` or
other classifiable fault arrives does **not** get silently reclassified as
an abort — the real cause is preserved and classified normally. Abort
mid-fallback (the proactive checks) stops the walk entirely — it never
advances to the next model — and `M3LOperationAbortedError`
(`ERR_OPERATION_ABORTED`, `origin: caller`, `retryable: false`) is always
thrown unchanged, never wrapped as one of this module's own error classes.

**`invokeStream`'s mid-stream abort check is order-reversed from `invoke`'s.**
Once `client.send()` has resolved (at response headers, before `invoke`'s
reactive check would ever see it), the underlying Node HTTP handler's own
abort listener can no longer reject that already-resolved promise — it can
only `req.destroy()` the socket, which surfaces as an unpredictable,
not-reliably-`AbortError`-shaped rejection from the stream iterator (verified
against `@smithy/node-http-handler`'s `dist-es`, 2026-08-28). So the catch
block awaiting the next chunk checks **`isAborted(signal)` first, alone,
before any `isAbortError`/name-based classification** — a caller abort
mid-stream always produces `M3LOperationAbortedError`, regardless of what
shape the underlying socket error happens to take. This check re-runs after
every `yield` resumes and also gates the clean-drain path (see "Malformed
data or unexpected content" below), since a destroyed socket can otherwise
surface as an unremarkable end-of-stream rather than a rejection.

### `M3LBedrockInvokeRequest`

```ts
interface M3LBedrockInvokeRequest {
  readonly messages: readonly M3LBedrockMessage[];
  readonly system?: string;
  readonly inferenceConfig?: M3LBedrockInferenceConfig;
}
```

`system`, when present, is sent as a single Converse `SystemContentBlock`
text member (`[{ text: system }]`) — the SDK's richer system-block union
(guard content, cache points) is not exposed; a caller needing those
constructs a raw `ConverseCommand` directly.

This is the request type `invokeStream` accepts. `invoke` accepts the wider
`M3LBedrockToolInvokeRequest` below.

### `M3LBedrockToolInvokeRequest`

```ts
interface M3LBedrockToolInvokeRequest extends M3LBedrockInvokeRequest {
  readonly tools?: readonly M3LBedrockToolDefinition[];
  readonly toolChoice?: M3LBedrockToolChoice;
}
```

The request type `invoke` accepts. Both added fields are optional, so every
V4 `M3LBedrockInvokeRequest` remains a valid `invoke` argument — the widening
is additive for construction as well as consumption.

**One honest caveat on "additive".** `M3LBedrockContentBlock` also appears in
an _output_ position (`M3LBedrockInvocationResult.message.content`), and
widening a union is not free there: a consumer that `switch`es over
`block.type` with an exhaustive `never` arm, or writes
`content.map((b) => b.text)`, now fails to compile. Nothing in this repo does
either — verified — and V4 pre-announced the widening in the type's own TSDoc,
in this page, and in ADR-0059 precisely so that consumers could avoid those
two shapes. It ships as an additive minor on that basis, but the failure mode
is named here rather than left for a consumer to discover.

`tools` and `toolChoice` are mapped together into the Converse API's single
`toolConfig` field, and that field is **omitted entirely** when `tools` is
absent **or empty** — a conditional spread, never a key set to `undefined`
(`exactOptionalPropertyTypes`). For **mapping** purposes an empty `tools`
array is therefore equivalent to an absent one, so a caller building the list
programmatically does not have to special-case "I found no tools this run".

`invokeStream` is governed by a stricter **text-only policy**, applied by the
same request builder that serves `invoke` rather than by a separate pre-check
— so streaming inherits the identical reads, element budget, and
module-owned rebuild instead of re-deriving them. The policy has two halves:

1. A top-level refusal of any request carrying an own `tools` or `toolChoice`
   property, keyed off **presence, not emptiness**, so `tools: []` is refused
   too. The asymmetry against the mapping rule above is intentional: the
   mapping rule answers "how many tools did the caller end up with?", where
   empty and absent genuinely coincide, while the policy answers "did the
   caller reach for the tool surface on a method that cannot serve it?" —
   where passing the key at all signals an intent to refuse rather than
   quietly ignore.
2. A per-block refusal of any `messages[].content` entry that is not a `text`
   block. This half exists because `M3LBedrockContentBlock` is shared by both
   methods: without it, V5's widening would silently let a `toolUse` or
   `toolResult` block reach `ConverseStream`, which this wrapper has no
   stream event to represent.

Two caller errors, both `M3LBedrockRuntimeOperationError`
(`origin: caller`, `retryable: false`), both raised before anything is sent:

1. `toolChoice` present while `tools` is absent or empty — a choice
   constraining a vocabulary that isn't there. Forwarding it would earn a
   service-side `ValidationException` with a far worse diagnostic.
2. `toolChoice` of `{ tool: name }` naming a tool that is not in `tools`.

Validation of `tools`/`toolChoice` — including the `inputSchema` copy — runs
**before** the `AbortSignal` check, not after: a malformed request is malformed
regardless of whether it was also cancelled, and reporting
`M3LOperationAbortedError` for a request that could never have been sent would
hide a caller bug behind a timing coincidence.

That ordering guarantee is deliberately scoped to the tool config. Validation
of **message content** — a `toolResult`'s `json` payload, or a request-side
`toolUse.input` — happens later, when the command for a given model attempt is
built, and therefore _after_ the first abort check. So a request that is both
cancelled and carries a non-serializable value inside `messages` reports the
cancellation, not the bad value. This is stated rather than smoothed over: the
tool config is validated once up front, while message mapping is part of
building each per-model attempt.

**Response side.** When the model asks for a tool, `stopReason` is
`"tool_use"` and the reply's `message.content` carries one or more
`toolUse` blocks; `invoke` now **keeps** them (V4 dropped every non-`text`
block) so `result.message.content` is the caller's input to the tool-use
loop. `toolUse.input` is handed back **exactly as the SDK decoded it**, typed
`unknown` and never re-parsed, re-shaped, or validated against the tool's own
`inputSchema` — validating model output against a caller-supplied JSON Schema
is a whole schema engine this library does not have, so narrowing is the
handler's job. See "Unrepresentable content blocks in a reply" below for the
drop-vs-refuse rule that governs malformed and server-executed blocks.

A `toolResult` block is **request-side only** in practice: it is how a caller
answers a `toolUse` on the next turn. It is part of `M3LBedrockContentBlock`
— and so mappable in either direction — but the service does not emit one in
an assistant reply.

### `M3LBedrockInvokeOptions`

```ts
interface M3LBedrockInvokeOptions {
  readonly signal?: AbortSignal;
}
```

Cooperative cancellation per ADR-0049: passed as `{ abortSignal: signal }` on
the underlying `client.send()` call.

### `M3LBedrockInvocationResult`

```ts
interface M3LBedrockInvocationResult {
  readonly message: M3LBedrockMessage;
  readonly stopReason: M3LBedrockStopReason;
  readonly usage: M3LBedrockTokenUsage;
  readonly modelId: string;
}
```

`modelId` is the model that actually served the request — the primary model
id unless fallback advanced past it.

### `M3LBedrockStreamEvent`

```ts
type M3LBedrockStreamEvent =
  | M3LBedrockStreamStartEvent
  | M3LBedrockStreamTextDeltaEvent
  | M3LBedrockStreamStopEvent;

interface M3LBedrockStreamStartEvent {
  readonly type: "message-start";
  readonly role: M3LBedrockRuntimeRole;
  readonly modelId: string;
}

interface M3LBedrockStreamTextDeltaEvent {
  readonly type: "text-delta";
  readonly text: string;
  readonly contentBlockIndex: number;
}

interface M3LBedrockStreamStopEvent {
  readonly type: "message-stop";
  readonly stopReason: M3LBedrockStopReason;
  readonly usage: M3LBedrockTokenUsage;
  readonly modelId: string;
}
```

`invokeStream` yields exactly one `message-start` (from the SDK's
`messageStart` event, before any text), zero or more `text-delta` (from
`contentBlockDelta` events carrying a text delta), and exactly one
`message-stop`, last. `type` is a library-owned kebab-case discriminant, not
the SDK's own camelCase event names — deliberate, since `message-stop` fuses
two distinct SDK events (`messageStop` for `stopReason`, `metadata` for
`usage`) and borrowing either name alone would mislead. The two are buffered
independently and fused into one event as soon as both have arrived,
regardless of which the SDK sends first (the SDK's ordering is not
type-guaranteed).

`usage` on `message-stop` is the **cumulative total for the whole stream**,
read directly from the SDK's single terminal `metadata` event — there is no
per-delta usage field anywhere in the union, so no client-side accumulation
is performed. Concatenating every `text-delta.text` in yield order
reconstructs the full reply text. `contentBlockIndex` defaults to `0` when
the SDK omits it (mirrors `mapRole`'s role-fallback convention below).

**No `content-block-start`/`content-block-stop` events, and no member for
non-text content.** The SDK's `ContentBlockStart` union has no text member at
all (only `toolUse`/`toolResult`/`image`/`$unknown`) — consistent with V4's
`M3LBedrockContentBlock` being text-only — so a `contentBlockStart`/
`contentBlockStop` event, and any `contentBlockDelta` whose delta is not a
text delta (`toolUse`, `toolResult`, `reasoningContent`, `citation`, `image`,
or an unknown member), is silently dropped rather than yielded or thrown on.
A model that emits reasoning content (a "thinking" delta) therefore streams
only its final answer text through this API — see "Notes and behavior"
below.

### `M3LBedrockRuntimeStreamError`

Thrown (as a rejection of `.next()`) for a streaming-lifecycle fault: either
a mid-stream fault after `invokeStream` has already yielded at least one
`M3LBedrockStreamEvent` to the caller (see "Fault handling and model
fallback" below — retry and fallback are both unsafe by that point), or a
stream that drains cleanly without ever delivering both a `messageStop` and
a `metadata` event, including a zero-event drain.

```ts
class M3LBedrockRuntimeStreamError extends M3LError {
  override readonly code: "ERR_BEDROCK_RUNTIME_STREAM";
  readonly modelId: string;
  readonly eventsEmitted: number;
  readonly retrySafe: boolean;
}
```

`retrySafe` is the type-visible, programmatically-checkable answer to the
question this class exists to make mechanical: "did the caller already
receive output that a retry would duplicate?" It is `true` only for the
zero-event clean-drain case (`eventsEmitted === 0` — nothing reached the
caller, so re-invoking is safe) and `false` for every mid-stream fault
(`eventsEmitted >= 1` there, by construction — see "`invokeStream`'s
two-phase fault handling" above). A caller should branch on `retrySafe`
rather than compare `eventsEmitted` itself, since the field exists precisely
so that comparison never has to be written at every call site.

`modelId`, `eventsEmitted`, and `retrySafe` are all own fields and mirrored
into `context`, for the same `toJSON()`/ADR-0035-diagnostics reason as
`M3LBedrockRuntimeModelError.modelId` above. `origin: external`,
`retryable: "situational"` — situational for the same reason `retrySafe`
exists: a blanket "retry" or "don't retry" classification would be wrong for
one of the two cases this class covers. `cause` is the standard `M3LError`
chain (`unknown`, never an own field) — absent for the zero-event clean-drain
case (there is no underlying SDK fault to chain), present for every
mid-stream fault case.

### Plain types

```ts
type M3LBedrockRuntimeRole = "user" | "assistant";

interface M3LBedrockTextBlock {
  readonly type: "text";
  readonly text: string;
}

type M3LBedrockToolResultStatus = "success" | "error";

interface M3LBedrockToolUseBlock {
  readonly type: "toolUse";
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown; // model-generated: narrow before use
}

interface M3LBedrockToolResultJsonBlock {
  readonly type: "json";
  readonly json: unknown;
}

type M3LBedrockToolResultContent =
  M3LBedrockTextBlock | M3LBedrockToolResultJsonBlock;

interface M3LBedrockToolResultBlock {
  readonly type: "toolResult";
  readonly toolUseId: string;
  readonly content: readonly M3LBedrockToolResultContent[];
  readonly status?: M3LBedrockToolResultStatus; // omitted means "success"
}

type M3LBedrockContentBlock =
  M3LBedrockTextBlock | M3LBedrockToolUseBlock | M3LBedrockToolResultBlock;

type M3LBedrockToolInputSchema = Readonly<Record<string, unknown>>;

interface M3LBedrockToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: M3LBedrockToolInputSchema;
}

type M3LBedrockToolChoice = "auto" | "any" | { readonly tool: string };

interface M3LBedrockMessage {
  readonly role: M3LBedrockRuntimeRole;
  readonly content: readonly M3LBedrockContentBlock[];
}

type M3LBedrockStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "guardrail_intervened"
  | "content_filtered"
  | "malformed_tool_use"
  | "malformed_model_output"
  | "model_context_window_exceeded";

interface M3LBedrockTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface M3LBedrockInferenceConfig {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
}

interface M3LBedrockRuntimeOptions {
  readonly models: readonly [string, ...(readonly string[])]; // models[0] is primary
}
```

`M3LBedrockStopReason`'s members mirror the SDK's `StopReason` enum verbatim
(verified against installed `dist-types`, 2026-08-28) — no library-side
renaming, since callers reasoning about "why did the model stop" benefit from
the same vocabulary AWS's own docs use.

**Why the tool discriminants are camelCase.** `"toolUse"` and `"toolResult"`
mirror the SDK's `ContentBlock` member keys exactly, the same rule that gives
`M3LBedrockTextBlock` its `"text"` tag. The kebab-case used by
`M3LBedrockStreamEvent` (`"message-start"`) is reserved for library-invented
_fusions_ — `"message-stop"` fuses two distinct SDK events, so borrowing
either name alone would mislead — which is not the case here: both tool
members are 1:1 with a single SDK member, and they land in the same union as
the already-mirrored `"text"`.

One consequence is worth stating rather than leaving to be tripped over:
after V5, `stopReason === "tool_use"` (snake_case) and
`block.type === "toolUse"` (camelCase) coexist. That is the correct result of
mirroring two _different_ SDK vocabularies verbatim, not an inconsistency;
harmonizing them into a library dialect would make both unpredictable.

**`input`, `json`, and `inputSchema` are `unknown`, not a JSON-value type.**
The library owns no `JsonValue` type (`core/json` exports only
format/detection types), JSON Schema is an open, versioned vocabulary that a
partial hand-rolled model would wrongly reject, and re-exporting the SDK's own
`__DocumentType` would leak an `@aws-sdk`/`@smithy` type straight through the
wrapper boundary this submodule exists to seal (ADR-0027). `unknown` forces
the caller to narrow, which is the correct obligation for a
**model-generated** value.

Because the SDK's document type is **mutable** (`@smithy/types`' `DocumentType`
declares its array arm as `DocumentType[]`, not `readonly`), a `readonly`
library value is not assignable to it. `inputSchema` and a `json` tool result
are therefore **recursively copied** into fresh mutable structures on the way
out, not spread or passed through — the same reason `inferenceConfig.stopSequences`
is already copied. That copy is bounded: nesting deeper than **32** levels
throws `M3LBedrockRuntimeOperationError` (`origin: caller`, `retryable: false`)
rather than letting an unbounded recursion over caller input escape the public
boundary as a bare `RangeError`. A value that cannot round-trip through JSON
at all is likewise a caller error, not a silent mis-serialization at send
time: a `bigint`, a function, a symbol, `undefined`, a cycle — and also any
**non-plain object**, such as a `Date`, a `Map`, or a class instance, since
those serialize to something the caller almost never intended.

The copy additionally **refuses the reserved keys** `__proto__`,
`constructor`, and `prototype` outright, and builds every copied object on a
null prototype. This is not decorative: `JSON.parse` produces `__proto__` as a
real own property, and the AWS SDK serializes a document with `for...in`,
which walks the prototype chain — so an unguarded copy would hoist such a
key's nested contents into the document Bedrock actually receives. The error
names the offending key and its JSON path; it never includes the value.

`M3LBedrockToolResultContent` is a deliberate 2-of-6 subset of the SDK's
`ToolResultContentBlock` union: `image`, `document`, `video`, and
`searchResult` members are out of scope, and a tool handler needing one
constructs a raw `ConverseCommand` directly.

### `M3LBedrockRuntimeOperationError`

Thrown immediately, with no fallback advance, for: `ValidationException`,
`AccessDeniedException`, `ResourceNotFoundException`,
`ServiceQuotaExceededException`, or any other non-classified `client.send()`
rejection. **Not** thrown for an exhausted `InternalServerException`/
`ThrottlingException` retry — exhaustion always advances fallback instead
(see "Fault handling and model fallback" below), so the terminal error on
full exhaustion is always `M3LBedrockRuntimeNoModelError`, never this class.

```ts
class M3LBedrockRuntimeOperationError extends M3LError {
  override readonly code: "ERR_BEDROCK_RUNTIME_OPERATION";
}
```

`origin`/`retryable` default to `external`/`true` from the error catalog, but
a `ValidationException`/`AccessDeniedException`/`ResourceNotFoundException`/
`ServiceQuotaExceededException` cause overrides them per-instance to
`caller`/`false` — those are request-shape or permission faults no retry or
model fallback can fix.

### `M3LBedrockRuntimeModelError`

Thrown for `ModelErrorException` (single-shot) or `ModelStreamErrorException`
(streaming) — the model itself faulted while processing this specific input.
Not retried and does **not** trigger fallback: a different model may or may
not do better on the same malformed/edge-case input, and ADR-0059 treats this
as the caller's decision (`origin: external`, `retryable: "situational"`).

```ts
class M3LBedrockRuntimeModelError extends M3LError {
  override readonly code: "ERR_BEDROCK_RUNTIME_MODEL";
  readonly modelId: string; // which model in the fallback list faulted
}
```

`modelId` is both an own field (`error.modelId`) and mirrored into
`context.modelId` — `context` is what `toJSON()` serializes and what ADR-0035
diagnostics tooling reads; an own field alone would be invisible to both.

### `M3LBedrockRuntimeNoModelError`

Thrown when `models` is empty at construction (`attemptedModels: []`, no
`cause`), or when every model in the fallback order has been exhausted by
availability faults (see below; `attemptedModels` lists every model id
tried, in order, and `cause` chains the **last** attempt's fault — the most
recent evidence of why the fallback list as a whole failed, not a synthetic
message). `origin: caller`, `retryable: false` — the caller's model list is
the fault, not AWS.

```ts
class M3LBedrockRuntimeNoModelError extends M3LError {
  override readonly code: "ERR_BEDROCK_RUNTIME_NO_MODEL";
  readonly attemptedModels: readonly string[];
}
```

`attemptedModels` is both an own field and mirrored into
`context.attemptedModels`, for the same `toJSON()`/diagnostics reason as
`M3LBedrockRuntimeModelError.modelId` above. `cause` is the standard
`M3LError` chain (not an own field) — without it, a caller whose every model
failed for a genuine, diagnosable AWS-side reason (a throttling storm, a
region misconfiguration surfacing as `ModelNotReadyException` everywhere)
would see only a bare `attemptedModels` list with no evidence of _why_.

## Fault handling and model fallback

Every SDK-thrown exception is classified into exactly one of three handling
tiers before the wrapper's own error is raised. This table covers `invoke`
(single-shot) and the **pre-first-yield** phase of `invokeStream`
(`hasYielded === false`, defined below); once `invokeStream` has yielded at
least one event, retry and fallback are both retired — see "`invokeStream`'s
two-phase fault handling" below for exactly which faults collapse to
`M3LBedrockRuntimeStreamError` at that point and which do not.

| SDK exception                                                                                                | Delivered as¹ | Tier                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ThrottlingException`, `InternalServerException`                                                             | thrown        | **Retry same model** (see classifier note below); exhausted → advance fallback                                       |
| `ModelNotReadyException`, `ModelTimeoutException`, `ServiceUnavailableException`                             | thrown        | **Advance fallback** immediately, no same-model retry                                                                |
| `ModelErrorException` / `ModelStreamErrorException`                                                          | thrown        | **Immediate throw**, `M3LBedrockRuntimeModelError` — no retry, no fallback                                           |
| `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException`, `ServiceQuotaExceededException` | thrown        | **Immediate throw**, `M3LBedrockRuntimeOperationError` with `caller`/`false` origin override — no retry, no fallback |
| any other rejection                                                                                          | thrown        | **Immediate throw**, `M3LBedrockRuntimeOperationError`, default `external`/`true`                                    |

**Retry classifier note (row 1 only).** The exception is classified by SDK
error **`name`** _before_ any retry runner is invoked — never by
`$metadata.httpStatusCode`. This matters because `M3LPollingPolicies.
awsThrottling()`'s generic classifier retries any transient 5xx status,
including 503, and `ServiceUnavailableException` is a 503 — reusing that
policy unmodified would retry `ServiceUnavailableException` on the same
model, contradicting row 2 ("advance fallback immediately, no same-model
retry"). `invoke` therefore classifies by exception `name` first: only
`"ThrottlingException"` and `"InternalServerException"` enter a
`M3LRetryRunner` (constructed fresh per call so `signal` can be threaded,
matching `aws/athena/client.ts`'s per-call runner pattern), configured with
the same backoff as `M3LPollingPolicies.awsThrottling()`
(`exponentialJittered(200ms, 5000ms)`) but a **name-scoped** classifier
(retryable exactly on those two names; anything else is `unknownDecision:
"fatal"`, rethrown unchanged) rather than that policy's broader status-code
classifier. Every other exception in the table skips the runner entirely.

¹ Verified against the **installed, shipped runtime** of
`@aws-sdk/client-bedrock-runtime@3.1115.0` (2026-08-28) — not just its
`dist-types`, but `@smithy/core`'s `EventStreamSerde` deserializer, which the
Bedrock client actually runs. For both `ConverseCommand` (single-shot) and
`ConverseStreamCommand` (streaming), every exception in the table above is
**thrown**, never yielded as iterable data: `ConverseStreamOutput`'s type
declares five exception-shaped union members
(`internalServerException`/`modelStreamErrorException`/`validationException`/
`throttlingException`/`serviceUnavailableException`), but
`getUnmarshalledStream.js`'s `else if (messageType === "exception")` branch
throws the deserialized exception rather than returning it as a stream value
— so those five arrive as a **rejection of the async iterator**, exactly like
a `send()`-time throw, using the same SDK exception class (with the same
`name`) either way. A prior version of this page stated the opposite (that
these arrive in-band as yielded data); that was based on the TypeScript
union's shape alone, not on reading the deserializer that actually runs it —
corrected 2026-08-28 (slice 2). Because the classification in this table is
already by exception **`name`**, not by delivery mechanism, `invokeStream`'s
name-based classifier is identical to `invoke`'s and needs no
delivery-path-specific branch for these five names.

`ServiceQuotaExceededException` and `ModelStreamErrorException` are never
thrown from `client.send()` for `ConverseStreamCommand` specifically (absent
from that command's own `@throws` list) — `ModelStreamErrorException` only
ever arrives from iteration; `ServiceQuotaExceededException` cannot occur on
the streaming path at all.

**Defence-in-depth:** despite the above, `invokeStream` still inspects each
yielded `ConverseStreamOutput` chunk for one of the five exception-shaped
union keys and routes it through the identical classifier used for a thrown
exception, so a caller-visible outcome is guaranteed identical regardless of
which SDK version or code path is actually in effect at runtime.

"Advance fallback" means: try the next `models[]` entry with a fresh
`ConverseCommand`/`ConverseStreamCommand`; if no entry remains, throw
`M3LBedrockRuntimeNoModelError` naming every attempted model id in
`attemptedModels`. This is the **only** way `M3LBedrockRuntimeNoModelError`
is thrown (besides the empty-`models` constructor guard) — every
fallback-exhaustion path, including an exhausted same-model retry, ends
here, never as `M3LBedrockRuntimeOperationError`. For `invokeStream`,
exhaustion can by construction only happen pre-first-yield (see below), so
this error can never carry any already-delivered partial output.

### `invokeStream`'s two-phase fault handling

Define **`hasYielded`** = "this `invokeStream` call has executed at least one
`yield`." The table above (retry, then fallback, then the three throw tiers)
applies **only while `hasYielded === false`**. The instant the first event is
yielded, retry and fallback are both retired for the remainder of that call —
falling back after the caller has already consumed output would silently
start a second, unrelated generation on a different model and append it to a
half-delivered reply; there is no way to resume a Bedrock stream from a byte
offset, so a same-model retry is equally impossible once bytes have been
delivered.

Because `client.send()` resolves at response headers — before any stream
chunk — every fault surfaced from `send()` is, by construction, always
pre-`hasYielded`. Only a fault surfaced from **iterating the stream itself**
can occur on either side of the boundary:

| Phase                  | Fault                                                                                                                      | Surfaces as…                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hasYielded === false` | any (see the table above)                                                                                                  | retry same model, advance fallback, or an immediate throw — identical to `invoke`'s rules                                                                   |
| `hasYielded === true`  | `ModelStreamErrorException`                                                                                                | **`M3LBedrockRuntimeModelError`** — unchanged from the pre-boundary tier; already no-retry/no-fallback, so crossing the boundary changes nothing            |
| `hasYielded === true`  | `ValidationException`                                                                                                      | **`M3LBedrockRuntimeOperationError`**, `caller`/`false` origin override — likewise already no-retry/no-fallback pre-boundary                                |
| `hasYielded === true`  | a structurally-invalid terminal value (bad `stopReason`, incomplete `usage`)                                               | **`M3LBedrockRuntimeOperationError`** — the malformed-response tier below applies regardless of `hasYielded`; it is a data-shape fault, not a lifecycle one |
| `hasYielded === true`  | `ThrottlingException`, `InternalServerException`, `ServiceUnavailableException`, or any other unclassified iteration fault | **`M3LBedrockRuntimeStreamError`**, `retrySafe: false`                                                                                                      |

Only the last row is new behavior introduced by crossing the boundary — it is
the set of exceptions that retried or fell back pre-boundary and can safely
do neither anymore. The other three rows keep exactly the error type they
already had pre-boundary; `M3LBedrockRuntimeStreamError` exists specifically
for the fault classes that lose a capability (retry or fallback) at the
boundary, not as a universal post-yield wrapper.

`M3LRetryRunner` wraps only the `client.send()` call for `invokeStream`, the
same narrow scope as `invoke` — see `library-src.md`'s narrow-`try` rule.

**A stream that ends cleanly without delivering both a `messageStop` and a
`metadata` event is also a `M3LBedrockRuntimeStreamError`**, including a
zero-event stream (`eventsEmitted: 0`, `retrySafe: true` — nothing reached
the caller, so a retry duplicates nothing) — a truncated stream is a
lifecycle fault, the same tier as any other post-first-byte failure, not the
malformed-response tier above (that tier is reserved for a
structurally-invalid value the SDK _did_ deliver in full). This check runs
regardless of `hasYielded`, so it is the one `M3LBedrockRuntimeStreamError`
case reachable with `retrySafe: true`.

## Usage

### From within a script

```ts
import type { M3LScript } from "@m3l-automation/m3l-common/core";
import { M3LBedrockRuntimeOperations } from "@m3l-automation/m3l-common/aws";

export async function run(script: M3LScript): Promise<void> {
  const ops = new M3LBedrockRuntimeOperations(
    script.aws.clients.bedrockRuntime,
    {
      models: ["anthropic.claude-opus-5", "anthropic.claude-sonnet-5"],
    },
  );
  const result = await ops.invoke({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Summarize this run." }],
      },
    ],
    inferenceConfig: { maxTokens: 512 },
  });
  script.logger.info("model replied", {
    stopReason: result.stopReason,
    usage: result.usage,
  });
}
```

### Streaming from within a script

```ts
import type { M3LScript } from "@m3l-automation/m3l-common/core";
import { M3LBedrockRuntimeOperations } from "@m3l-automation/m3l-common/aws";

export async function run(script: M3LScript): Promise<void> {
  const ops = new M3LBedrockRuntimeOperations(
    script.aws.clients.bedrockRuntime,
    {
      models: ["anthropic.claude-opus-5", "anthropic.claude-sonnet-5"],
    },
  );
  let reply = "";
  for await (const event of ops.invokeStream({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Summarize this run." }],
      },
    ],
    inferenceConfig: { maxTokens: 512 },
  })) {
    switch (event.type) {
      case "text-delta":
        reply += event.text;
        break;
      case "message-stop":
        script.logger.info("model finished streaming", {
          stopReason: event.stopReason,
          usage: event.usage,
        });
        break;
    }
  }
  // `reply` is model-generated text reconstructed from the caller's own
  // prompt — routinely the highest-sensitivity data in a run (see "Notes
  // and behavior" below). Do not log it wholesale; a length or hash is
  // usually enough for an audit trail.
  script.logger.info("streaming complete", { replyLength: reply.length });
}
```

A `break` out of `for await` (or `.return()`) ends iteration without
throwing, but only best-effort releases the underlying connection — see
"Notes and behavior" below. Prefer aborting the `AbortSignal` over an early
`break` when the connection must be guaranteed torn down.

### Standalone construction

```ts
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { M3LBedrockRuntimeOperations } from "@m3l-automation/m3l-common/aws";

const client = new BedrockRuntimeClient({ region: "us-east-1" });
const ops = new M3LBedrockRuntimeOperations(client, {
  models: ["anthropic.claude-opus-5", "anthropic.claude-sonnet-5"],
});
```

## Notes and behavior

- The wrapper never leaks an `@aws-sdk/client-bedrock-runtime` type through
  its public boundary — every request/response field is translated to a
  plain, library-owned type.
- **A caller's prompt content can round-trip out through a chained SDK
  exception's `.message`** — via `String(err.cause)`/`err.cause.toString()`
  directly (note: `err.toString()` on the wrapper itself does _not_ render
  `cause`; `Error.prototype.toString()` renders only the receiver's own
  `name`/`message`, and every bedrock-runtime wrapper message is
  library-constructed with no `cause` interpolation), `util.inspect`/
  `console.error(err)` (which does walk `cause`), or a text-rendering log
  sink.**
  `ValidationException` and similar faults from the Bedrock service can quote
  the offending request content in the SDK exception's own message; this
  wrapper chains that exception unchanged via `cause` (the standing
  library-wide `M3LError` contract — this module introduces no new leak).
  **Correction (2026-08-28, slice 2), superseded 2026-08-29:** an earlier
  version of this page claimed `toJSON()` serializes only `cause.name` and is
  therefore safe for structured/JSON sinks; that was verified false by
  execution and the root-cause fix was tracked separately as GitHub
  [#727](https://github.com/monte3l/m3l-automation/issues/727) (F31). **That
  fix has since landed**: `M3LError.toJSON()`
  (`core/errors/M3LError.ts`) now allowlists a foreign `cause` down to its
  type name only — `JSON.stringify(err.toJSON())` no longer renders
  `cause.message`, `$response`, or `$metadata` verbatim (see
  `docs/reference/core/errors.md`'s `toJSON()`'s `cause` allowlist section).
  **This does not close every channel**, though: `core/diagnostics`'s
  `formatErrorChain`/`serializeErrorChain` walk the live `cause` chain
  directly and never call `toJSON()`, so they still emit each level's own
  `message` (heuristically redacted, `key=value`-scoped — unkeyed prompt
  prose is not caught). Unlike most AWS wrappers, this submodule's request
  payload is routinely the highest-sensitivity data in a run — a caller
  logging a caught `M3LBedrockRuntimeOperationError`'s,
  `M3LBedrockRuntimeModelError`'s, `M3LBedrockRuntimeNoModelError`'s, **or
  `M3LBedrockRuntimeStreamError`'s** full chain via `util.inspect`/
  `console.error(error)`, a text-rendering log sink
  (`formatErrorChain`/`serializeErrorChain`), or `String(error.cause)`
  directly should still be aware `cause.message`
  may echo back what was sent — `JSON.stringify(err.toJSON())` is the one
  channel now closed (`M3LBedrockRuntimeNoModelError` chains the last
  fallback attempt's fault the same way, once every model is exhausted;
  `M3LBedrockRuntimeStreamError` chains whichever mid-stream fault triggered
  it).
- Model-generated text is untrusted input: any future consumer parsing
  `message.content` text follows the style guide's ReDoS-conscious parsing
  rules — this submodule itself does not parse model output (V5's loop
  primitives will).
- `M3LRetryRunner` wraps only the `client.send()` call, never response
  mapping — see `library-src.md`'s narrow-`try` rule.
- **Malformed-but-successful response.** `ConverseCommandOutput.output`,
  `.stopReason`, and `.usage` are each `T | undefined` in the SDK, and
  `output`'s `ConverseOutput` union has an `$UnknownMember` arm, but
  `M3LBedrockInvocationResult` declares every field required. A response
  missing any of `output.message`, `stopReason`, or `usage` — or an
  `output` matching `$UnknownMember` rather than the expected message
  member — throws `M3LBedrockRuntimeOperationError` (default
  `external`/`true`; this is a genuinely unexpected AWS response shape, not
  a caller mistake), same as table row 5 above. This is checked **after**
  the retry runner resolves successfully — it is a response-shape fault,
  not a transport fault, so it is never retried or fallen back from.
- **`stopReason` is validated against the closed `M3LBedrockStopReason`
  membership**, the same `ReadonlySet` membership-check idiom used to
  classify SDK exception names — not just checked for presence. AWS's
  Smithy enums are open at the wire level (a future SDK/service value is not
  a client-side type error), so a `stopReason` outside the 9 documented
  members throws `M3LBedrockRuntimeOperationError` (malformed-response path
  above) rather than silently admitting an unrecognized string into a type
  callers switch on exhaustively — `content_filtered`/`guardrail_intervened`
  are exactly the values a caller checks for a blocked generation, so a
  silently-wrong value here is a correctness risk, not just a type nicety.
- **Unrepresentable content blocks in a reply: drop when ignorable, refuse
  when unsafe.** The SDK's `ContentBlock` union has 15 arms; this wrapper
  represents three (`text`, `toolUse`, `toolResult`). The model's reply is
  _external_ data, not a caller mistake, so the default is tolerance: any
  block `invoke` cannot represent is **dropped** when building the result's
  `message.content`, rather than failing the whole call. A `toolUse` block
  whose `toolUseId` or `name` is missing, not a string, or the empty string is
  dropped on the same grounds — it is not a well-formed request for anything.
  (Emptiness counts because the V5 loop keys one `toolResult` per `toolUse` by
  `toolUseId` and rejects duplicates within a turn; an empty id would both fail
  the Converse round-trip and let two independently-empty ids collide.)
  **One exception to the drop rule is itself a throw.** If `stopReason` is
  `"tool_use"` and at least one `toolUse`-shaped block was present but _every_
  one of them was malformed, `invoke` throws
  `M3LBedrockRuntimeOperationError` rather than returning
  `stopReason: "tool_use"` with empty content. Dropping all of them would hand
  the caller a reply that says "I want to call a tool" with nothing to call and
  nothing to catch — a silent failure rather than a tolerated one. The error
  carries only a count, never block payloads. The deliberate exception is a `toolUse`
  block carrying the SDK marker
  `type: "server_tool_use"`, which means **Bedrock already executed that tool
  server-side**. That one throws `M3LBedrockRuntimeOperationError`. Dropping
  it would be merely lossy, but _mapping_ it like an ordinary tool request is
  actively unsafe: the V5 tool-use loop would hand it to a caller handler and
  execute the side effect a **second** time. The governing rule is therefore
  "drop when a block is ignorable; refuse when acting on it would be unsafe" —
  the same instinct that already makes an unrecognized `stopReason` throw
  rather than pass through. This is unreachable by construction — a
  `server_tool_use` block can only appear if the request opted in via a
  `systemTool` entry in `toolConfig.tools`, and this wrapper only ever emits
  `toolSpec` entries — and is refused anyway, because "unreachable" is
  exactly the reasoning that quietly stops being true after an SDK upgrade.
- **`invokeStream`'s reasoning-content deltas are silently dropped.** A
  reasoning-capable model can emit `contentBlockDelta` events whose delta is
  `reasoningContent` rather than text. `M3LBedrockStreamEvent` has no member
  for this — consistent with `invokeStream`'s **text-only scope boundary**,
  which V5 did not change — so a caller streaming such a model sees only the
  model's final answer text, with its reasoning trace silently omitted. Note
  this is a property of the _stream event_ union specifically, not of
  `M3LBedrockContentBlock`, which V5 widened to three members: `invoke` is
  tool-aware, `invokeStream` is not, and richer streaming content members
  remain out of scope.
- **`invokeStream`'s underlying connection release on early exit is
  best-effort, not guaranteed.** The AWS SDK's event-stream deserializer
  wraps the raw HTTP response in an `AsyncIterable` whose own `.return()`
  does not forward to (and therefore does not close) the inner
  socket-reading iterator (verified against `@smithy/core`'s `dist-es`,
  2026-08-28). `invokeStream`'s `finally` block calls `.return()` on that
  inner iterator itself, best-effort, but a caller that needs the underlying
  connection torn down deterministically (rather than left to Node's normal
  socket/keep-alive lifecycle) should abort the `AbortSignal` passed via
  `options.signal` rather than relying on breaking out of a `for await` loop.

## Landing plan

Two independently-landable PRs (ADR-0072):

1. **Slice 1 — core wrapper.** `invoke()` single-shot Converse call, the model
   registry/fallback state machine, token usage capture, the three error
   classes, and the `AWSClientProvider.bedrockRuntime` getter (no
   `AWSServiceProvider` convenience getter — see the constructor note above).
   Tests: `packages/m3l-common/tests/bedrock-runtime.test.ts`, importing only
   this slice's symbols. **Shipped** — PR #725, merged into `main`.
2. **Slice 2 — streaming.** `invokeStream()` over `ConverseStreamCommand`, the
   `M3LBedrockStreamEvent` tagged union, and the two-phase (pre-/post-first-
   yield) fault-handling state machine, including `M3LBedrockRuntimeStreamError`.
   Tests: `packages/m3l-common/tests/bedrock-runtime-streaming.test.ts`,
   importing only the streaming symbols so `perFile` v8 coverage binds within
   the slice. **Shipped** — PR #728, merged into `main`.
3. **Slice 3 — tool vocabulary (V5).** The `toolUse`/`toolResult` content
   blocks, the tool definition/choice/schema types, `M3LBedrockToolInvokeRequest`,
   the request- and response-side mapping, and `invokeStream`'s
   tool-config rejection guard. `stream.ts` is untouched.
   Tests: `packages/m3l-common/tests/bedrock-runtime-tools.test.ts`.
4. **Slice 4 — conversation state and the tool-use loop (V5).** The immutable
   conversation value and its pure helpers, the bounded and cancellable
   invoke → `tool_use` → execute → `tool_result` state machine, the outcome
   ledger with cumulative token usage and optional cost, and
   `M3LBedrockToolLoopError`.
   Tests: `packages/m3l-common/tests/bedrock-runtime-loop.test.ts`.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider` / `AWSServiceProvider`.
- [ADR-0059](../../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md) —
  the governing decision, including its 2026-08-28 Update correcting the
  "first `AsyncIterable` contract" premise.
- [ADR-0049](../../adr/0049-cooperative-cancellation-contract.md) — the
  `AbortSignal` convention `invoke`/`invokeStream` follow.
- [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) — the
  fault-origin classification `M3LBedrockRuntime*Error` codes register into.
