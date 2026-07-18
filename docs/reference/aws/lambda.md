# Lambda Operations

`M3LLambdaOperations` is a typed wrapper over a raw `LambdaClient`, so callers
never import `@aws-sdk/client-lambda` command classes directly. Surfaced by
`scripts/lambda-ops` (roadmap W3) needing to avoid importing the SDK directly
(ADR-0029 — scripts depend only on `@m3l-automation/m3l-common`).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `AWSClientProvider.lambda` returns
the raw `LambdaClient`; `M3LLambdaOperations` wraps it with bespoke, typed
methods, translating SDK request/response shapes into plain, library-owned
types so a caller never touches an `@aws-sdk/client-lambda` type.

Scoped to **control-plane CRUD + invoke only** — no deployment-package
build/zip tooling and no event-source-mapping management (out of scope for
`lambda-ops`; see `docs/reference/scripts/lambda-ops.md`).

- `M3LLambdaOperations` — the wrapper class, constructed from a raw `LambdaClient`.
- `M3LLambdaOperationError` — thrown on a request-level Lambda failure.
- Plain types: `M3LLambdaFunctionSummary`, `M3LLambdaFunctionConfiguration`,
  `M3LLambdaListFunctionsResult`, `M3LLambdaInvokeResult`,
  `M3LLambdaCreateFunctionInput`, `M3LLambdaUpdateFunctionCodeInput`,
  `M3LLambdaUpdateFunctionConfigurationInput`.

## Public API

### `M3LLambdaOperations`

**Constructor** — `new M3LLambdaOperations(client)`, where `client` is a raw
`LambdaClient` (e.g. `script.aws.clients.lambda`).

| Method                                   | Returns                                   | Throws                    |
| ---------------------------------------- | ----------------------------------------- | ------------------------- |
| `listFunctions(options?)`                | `Promise<M3LLambdaListFunctionsResult>`   | `M3LLambdaOperationError` |
| `getFunction(functionName)`              | `Promise<M3LLambdaFunctionConfiguration>` | `M3LLambdaOperationError` |
| `invokeFunction(functionName, payload?)` | `Promise<M3LLambdaInvokeResult>`          | `M3LLambdaOperationError` |
| `createFunction(input)`                  | `Promise<M3LLambdaFunctionConfiguration>` | `M3LLambdaOperationError` |
| `updateFunctionCode(input)`              | `Promise<M3LLambdaFunctionConfiguration>` | `M3LLambdaOperationError` |
| `updateFunctionConfiguration(input)`     | `Promise<M3LLambdaFunctionConfiguration>` | `M3LLambdaOperationError` |
| `deleteFunction(functionName)`           | `Promise<void>`                           | `M3LLambdaOperationError` |

`listFunctions` pages via `marker`/`nextMarker` (mirrors the SDK's own
`Marker`/`NextMarker` pagination — one page per call, no auto-pagination);
`nextMarker` is present only when another page exists.

`invokeFunction` always performs a synchronous (`RequestResponse`) invocation,
requesting the tail of the execution log (`LogType: "Tail"`) so `logResult` is
populated whenever the SDK returns one, and decodes the response `Payload` as
a UTF-8 string. `statusCode` defaults to `0` if the SDK response omits it.

**Function-level errors are not thrown.** A handler that throws or times out
still returns a _successful_ `InvokeCommand` response (`StatusCode: 200`,
`FunctionError` set, the error serialized into `Payload`) — this resolves
`invokeFunction`'s promise with `functionError` populated; the caller inspects
it. Only a `.send()`-level rejection (throttling, `ResourceNotFoundException`,
network failure) throws `M3LLambdaOperationError`.

No retry/backoff wrapping (contrast `M3LSQSOperations`'s batch-send retry):
Lambda invocation is generally non-idempotent, and no method here has a
transient-fault profile that justifies an automatic retry. A caller wanting
resilience composes its own `M3LRetryRunner` around a call.

### Plain types (field-by-field)

- `M3LLambdaFunctionSummary` / `M3LLambdaFunctionConfiguration` — `functionName`,
  `functionArn`, `lastModified` are always present (defaulted to `""` if the
  SDK omits them); every other field (`runtime`, `state`, `description`,
  `handler`, `timeout`, `memorySize`, `role`, `environment`) is present only
  when the SDK response includes it.
- `M3LLambdaListFunctionsResult` — `functions` is always an array (`[]` when
  the SDK omits `Functions`); `nextMarker` is present only when the SDK
  returns `NextMarker`.
- `M3LLambdaInvokeResult` — `statusCode` always present (`?? 0`); `payload`,
  `functionError`, `logResult` each present only when the SDK response
  includes the corresponding field.
- `M3LLambdaCreateFunctionInput` — `zipFile` maps to the SDK's
  `Code.ZipFile` (nested). `M3LLambdaUpdateFunctionCodeInput.zipFile` maps to
  the SDK's top-level `ZipFile` — the two are **not** symmetric; this is an
  SDK asymmetry (`CreateFunctionCommand` nests code under `Code`,
  `UpdateFunctionCodeCommand` does not), not a design choice.
- `environment` (create/update-configuration input) nests under the SDK's
  `Environment: { Variables }`; the response side reads back from
  `Environment?.Variables`.

There are no pre-flight validation guards in this module (contrast
`M3LSQSOperations`'s batch-size/duplicate-id guards) — every method's only
failure mode is a rejected `.send()` call.

### `M3LLambdaOperationError`

`code: "ERR_LAMBDA_OPERATION"`. Thrown when the underlying SDK `.send()`
rejects, chaining the SDK rejection as `cause`.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider.lambda`, the raw client
  getter this wrapper is constructed from.
- [SQS Operations](./sqs.md) — the closest sibling wrapper (ADR-0026),
  followed here for shape/error-handling consistency.
- [`scripts/lambda-ops` contract](../scripts/lambda-ops.md) — the consumer
  this submodule unblocks.
