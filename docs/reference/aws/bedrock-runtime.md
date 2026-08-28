# Bedrock Runtime Operations

`M3LBedrockRuntimeOperations` is a typed wrapper over a raw
`BedrockRuntimeClient`'s Converse API, so callers never import
`@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
types directly. See [ADR-0059](../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md)
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
`client` is a raw `BedrockRuntimeClient` (e.g.
`script.aws.clients.bedrockRuntime`, or the cached
`script.aws.services.bedrockRuntimeOperations` getter which constructs one for
you, sharing the underlying `bedrockRuntime` client's lifecycle) and `options`
is `M3LBedrockRuntimeOptions` — `{ models: readonly string[] }`, an ordered,
non-empty fallback list (`models[0]` is the primary model id; later entries
are tried only on a model-availability fault). Throws
`M3LBedrockRuntimeNoModelError` at construction if `models` is empty — this is
a caller/config error, not deferred to the first `invoke` call.

| Method                            | Retried? | Returns                                 | Throws                                                                                                                                      |
| --------------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke(request, options?)`       | Yes¹     | `Promise<M3LBedrockInvocationResult>`   | `M3LBedrockRuntimeOperationError`, `M3LBedrockRuntimeModelError`, `M3LBedrockRuntimeNoModelError`                                           |
| `invokeStream(request, options?)` | Yes¹     | `AsyncGenerator<M3LBedrockStreamEvent>` | same three, from the generator's `next()` (Landing plan slice 2 — not yet implemented; throws `M3LBedrockRuntimeOperationError` in slice 1) |

¹ `ThrottlingException`/`InternalServerException` retry on the **same** model
via `M3LRetryRunner` (`M3LPollingPolicies.awsThrottling()`) before any
fallback is attempted; see "Fault handling and model fallback" below.

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
  readonly models: readonly string[]; // non-empty; models[0] is primary
}
```

`M3LBedrockStopReason`'s members mirror the SDK's `StopReason` enum verbatim
(verified against installed `dist-types`, 2026-08-28) — no library-side
renaming, since callers reasoning about "why did the model stop" benefit from
the same vocabulary AWS's own docs use.

### `M3LBedrockRuntimeOperationError`

Thrown for a transport/API-call failure that is not one of the model-specific
faults below: `ValidationException`, `AccessDeniedException`,
`ResourceNotFoundException`, `ServiceQuotaExceededException`, an exhausted
`InternalServerException`/`ThrottlingException` retry, or any other
non-classified `client.send()` rejection.

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

### `M3LBedrockRuntimeNoModelError`

Thrown when `models` is empty at construction, or when every model in the
fallback order has been exhausted by availability faults (see below).
`origin: caller`, `retryable: false` — the caller's model list is the fault,
not AWS.

```ts
class M3LBedrockRuntimeNoModelError extends M3LError {
  override readonly code: "ERR_BEDROCK_RUNTIME_NO_MODEL";
  readonly attemptedModels: readonly string[];
}
```

## Fault handling and model fallback

Every SDK-thrown or in-band exception is classified into exactly one of three
handling tiers before the wrapper's own error is raised:

| SDK exception                                                                                                | Delivered as¹               | Tier                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ThrottlingException`, `InternalServerException`                                                             | thrown / in-band            | **Retry same model** via `M3LRetryRunner(M3LPollingPolicies.awsThrottling())`; exhausted → advance fallback          |
| `ModelNotReadyException`, `ModelTimeoutException`, `ServiceUnavailableException`                             | thrown / in-band            | **Advance fallback** immediately, no same-model retry                                                                |
| `ModelErrorException` / `ModelStreamErrorException`                                                          | thrown / in-band            | **Immediate throw**, `M3LBedrockRuntimeModelError` — no retry, no fallback                                           |
| `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException`, `ServiceQuotaExceededException` | thrown only (never in-band) | **Immediate throw**, `M3LBedrockRuntimeOperationError` with `caller`/`false` origin override — no retry, no fallback |
| any other rejection                                                                                          | thrown                      | **Immediate throw**, `M3LBedrockRuntimeOperationError`, default `external`/`true`                                    |

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
naming every attempted model id in `attemptedModels`.

## Usage

### From within a script

```ts
import type { M3LScript } from "@m3l-automation/m3l-common/core";

export async function run(script: M3LScript): Promise<void> {
  const ops = script.aws.services.bedrockRuntimeOperations;
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
- Model-generated text is untrusted input: any future consumer parsing
  `message.content` text follows the style guide's ReDoS-conscious parsing
  rules — this submodule itself does not parse model output (V5's loop
  primitives will).
- `M3LRetryRunner` wraps only the `client.send()` call, never response
  mapping — see `library-src.md`'s narrow-`try` rule.

## Landing plan

Two independently-landable PRs (ADR-0072):

1. **Slice 1 — core wrapper.** `invoke()` single-shot Converse call, the model
   registry/fallback state machine, token usage capture, the three error
   classes, `AWSClientProvider.bedrockRuntime` getter,
   `AWSServiceProvider.bedrockRuntimeOperations` getter. Tests:
   `packages/m3l-common/tests/bedrock-runtime.test.ts`, importing only this
   slice's symbols.
2. **Slice 2 — streaming.** `invokeStream()` over `ConverseStreamCommand`, the
   `M3LBedrockStreamEvent` tagged union, in-band exception discrimination.
   Tests: `packages/m3l-common/tests/bedrock-runtime-streaming.test.ts`,
   importing only the streaming symbols so `perFile` v8 coverage binds within
   the slice.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider` / `AWSServiceProvider`.
- [ADR-0059](../adr/0059-bedrock-runtime-wrapper-and-loop-primitives.md) —
  the governing decision, including its 2026-08-28 Update correcting the
  "first `AsyncIterable` contract" premise.
- [ADR-0049](../adr/0049-cooperative-cancellation-contract.md) — the
  `AbortSignal` convention `invoke`/`invokeStream` follow.
- [ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) — the
  fault-origin classification `M3LBedrockRuntime*Error` codes register into.
