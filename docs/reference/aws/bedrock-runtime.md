# Bedrock Runtime Operations

`M3LBedrockRuntimeOperations` is a typed wrapper over a raw
`BedrockRuntimeClient`'s Converse API, so callers never import
`@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
types directly. See [ADR-0059](../../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md)
for why this module exists and its scope boundary against V5 (tool-use loop
primitives, a separate future change).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LBedrockRuntimeOperations` wraps
one of those raw clients (`bedrockRuntime`), translating the Converse API's
request/response shapes into plain, library-owned types so a caller never
touches an `@aws-sdk/client-bedrock-runtime` type. Built on `Converse` /
`ConverseStream` (not the lower-level `InvokeModel` API) — the unified,
model-agnostic Messages surface, so the wrapper never hand-rolls or parses a
per-model JSON request/response body.

**Scope boundary (V4 vs. V5):** this submodule's V4 slice covers **text-only**
single-shot and streaming invocation, the model-id fallback registry, and
token usage capture. `M3LBedrockContentBlock` is deliberately a
single-member tagged union (`{ type: "text"; text: string }`) even though the
underlying `ConverseCommandInput`/`Output` already support tool-use content —
V5 (a separate future change, ADR-0059) widens it to include
`toolUse`/`toolResult` members and adds the `tools`/`toolConfig` request
surface. The `type` discriminant exists from V4 onward specifically so that
widening is additive (a new union member), not a breaking change to an
existing shape.

- `M3LBedrockRuntimeOperations` — the wrapper class, constructed from a raw
  `BedrockRuntimeClient` and an ordered model-id fallback list.
- `M3LBedrockRuntimeOperationError`, `M3LBedrockRuntimeModelError`,
  `M3LBedrockRuntimeNoModelError` — thrown on, respectively, a
  transport/API-call failure, a model-side inference fault, and fallback-order
  exhaustion.
- Plain types: `M3LBedrockMessage`, `M3LBedrockTextBlock`,
  `M3LBedrockContentBlock`, `M3LBedrockRuntimeRole`, `M3LBedrockStopReason`,
  `M3LBedrockTokenUsage`, `M3LBedrockInferenceConfig`,
  `M3LBedrockInvokeRequest`, `M3LBedrockInvokeOptions`,
  `M3LBedrockInvocationResult`, `M3LBedrockRuntimeOptions`.

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

| Method                      | Retried? | Returns                               | Throws                                                                                                                        |
| --------------------------- | -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `invoke(request, options?)` | Yes¹     | `Promise<M3LBedrockInvocationResult>` | `M3LBedrockRuntimeOperationError`, `M3LBedrockRuntimeModelError`, `M3LBedrockRuntimeNoModelError`, `M3LOperationAbortedError` |

¹ `ThrottlingException`/`InternalServerException` retry on the **same** model
via `M3LRetryRunner` before any fallback is attempted; see "Fault handling and
model fallback" below for the retry classifier's exact scope.

**`invokeStream` does not exist on the class in slice 1.** It is added whole
in slice 2, once `M3LBedrockStreamEvent` and the streaming contract are
settled — a class gaining a method later is additive, not breaking, so
nothing here needs a stub. Do not declare, export, or test `invokeStream` (or
`M3LBedrockStreamEvent`) as part of this slice.

**`AbortSignal` cancellation.** `options?.signal` is checked against a
module-private `isAborted(signal)` helper (the ADR-0049 named-function
convention — see `aws/athena/client.ts`; a bare `signal?.aborted` re-check
after an `await` produces a TS2367 false alarm) **before** any exception
classification, at every point an abort could have occurred: before the
initial `send()`, after each retry-runner exhaustion, and before advancing
fallback to the next model. An abort mid-fallback stops the walk entirely —
it never advances to the next model — and throws `M3LOperationAbortedError`
(`ERR_OPERATION_ABORTED`, `origin: caller`, `retryable: false`) unchanged,
never wrapped as one of this module's own error classes.

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

### Plain types

```ts
type M3LBedrockRuntimeRole = "user" | "assistant";

interface M3LBedrockTextBlock {
  readonly type: "text";
  readonly text: string;
}

type M3LBedrockContentBlock = M3LBedrockTextBlock; // widened in V5

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

Every SDK-thrown or in-band exception is classified into exactly one of three
handling tiers before the wrapper's own error is raised:

| SDK exception                                                                                                | Delivered as¹               | Tier                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ThrottlingException`, `InternalServerException`                                                             | thrown / in-band            | **Retry same model** (see classifier note below); exhausted → advance fallback                                       |
| `ModelNotReadyException`, `ModelTimeoutException`, `ServiceUnavailableException`                             | thrown / in-band            | **Advance fallback** immediately, no same-model retry                                                                |
| `ModelErrorException` / `ModelStreamErrorException`                                                          | thrown / in-band            | **Immediate throw**, `M3LBedrockRuntimeModelError` — no retry, no fallback                                           |
| `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException`, `ServiceQuotaExceededException` | thrown only (never in-band) | **Immediate throw**, `M3LBedrockRuntimeOperationError` with `caller`/`false` origin override — no retry, no fallback |
| any other rejection                                                                                          | thrown                      | **Immediate throw**, `M3LBedrockRuntimeOperationError`, default `external`/`true`                                    |

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

¹ Verified against installed `@aws-sdk/client-bedrock-runtime@3.1115.0`
`dist-types` (2026-08-28). For `ConverseCommand` (single-shot), every
exception above is thrown from `client.send()`. For `ConverseStreamCommand`
(streaming), `ThrottlingException`, `InternalServerException`,
`ModelStreamErrorException`, and `ServiceUnavailableException` can additionally
arrive **in-band** as a `ConverseStreamOutput` union member (yielded by the
`AsyncIterable`, not thrown from iteration) — `ValidationException` can arrive
either from the initial `client.send()` (before the stream opens) or in-band;
`AccessDeniedException`/`ResourceNotFoundException`/`ServiceQuotaExceededException`
have no in-band member and can only be thrown from the initial `send()`.
`invokeStream`'s generator must discriminate each yielded event for an
exception-shaped member and translate it into a rejection of `next()` — the
SDK does not reject the iterator on these faults itself, it yields them as
data. This is settled at slice-1 contract time; slice 2 (implementing
`invokeStream`) re-verifies the exact `ConverseStreamOutput` member shapes
(`contentBlockStart`'s payload in particular) against `dist-types` before
writing the streaming test suite, per the standard aws/\* contract-settling
practice.

"Advance fallback" means: try the next `models[]` entry with a fresh
`ConverseCommand`; if no entry remains, throw `M3LBedrockRuntimeNoModelError`
naming every attempted model id in `attemptedModels`. This is the **only**
way `M3LBedrockRuntimeNoModelError` is thrown from `invoke` (besides the
empty-`models` constructor guard) — every fallback-exhaustion path,
including an exhausted same-model retry, ends here, never as
`M3LBedrockRuntimeOperationError`.

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
  exception's `.message`.** `ValidationException` and similar faults from
  the Bedrock service can quote the offending request content in the SDK
  exception's own message; this wrapper chains that exception unchanged via
  `cause` (the standing library-wide `M3LError` contract — this module
  introduces no new leak), and any log sink that renders a `cause` chain's
  `message` (e.g. `Core.format-error`'s default renderer) will surface it
  verbatim. Redaction in this library is key-name-scoped over structured
  `context`/`data`, not free text, so it does not catch this. Unlike most
  AWS wrappers, this submodule's request payload is routinely the
  highest-sensitivity data in a run — a caller logging a caught
  `M3LBedrockRuntimeOperationError`'s full chain should be aware the
  `cause.message` may echo back what was sent.
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
- **Non-text content blocks in a reply.** V4's `M3LBedrockContentBlock` is
  text-only, but the SDK's `ContentBlock` union on the reply side can in
  principle carry non-text members. Per the style guide's caller-vs-external
  distinction, the model's reply is _external_ data, not a caller mistake,
  so `invoke` tolerates rather than rejects it: any non-`text` content block
  in `output.message.content` is dropped when building the result's
  `message.content` array. In practice this is unreachable in V4 — the
  request never sends `toolConfig`, so the model has no tool to invoke — but
  the tolerance is documented so a future response shape doesn't throw an
  unexplained "malformed response" error for a legitimately-absent library
  feature.

## Landing plan

Two independently-landable PRs (ADR-0072):

1. **Slice 1 — core wrapper.** `invoke()` single-shot Converse call, the model
   registry/fallback state machine, token usage capture, the three error
   classes, and the `AWSClientProvider.bedrockRuntime` getter (no
   `AWSServiceProvider` convenience getter — see the constructor note above).
   Tests: `packages/m3l-common/tests/bedrock-runtime.test.ts`, importing only
   this slice's symbols.
2. **Slice 2 — streaming.** `invokeStream()` over `ConverseStreamCommand`, the
   `M3LBedrockStreamEvent` tagged union, in-band exception discrimination.
   Tests: `packages/m3l-common/tests/bedrock-runtime-streaming.test.ts`,
   importing only the streaming symbols so `perFile` v8 coverage binds within
   the slice.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider` / `AWSServiceProvider`.
- [ADR-0059](../../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md) —
  the governing decision, including its 2026-08-28 Update correcting the
  "first `AsyncIterable` contract" premise.
- [ADR-0049](../../adr/0049-cooperative-cancellation-contract.md) — the
  `AbortSignal` convention `invoke`/`invokeStream` follow.
- [ADR-0035](../../adr/0035-failure-reporting-and-diagnostics.md) — the
  fault-origin classification `M3LBedrockRuntime*Error` codes register into.
