# Core / errors

Structured error handling for `@m3l-automation/m3l-common`: a typed error base class and a Rust-style `M3LResult<T, E>` for exception-free, chainable error propagation.

## Overview

The `errors` module provides two complementary tools:

- **`M3LError`** — an `Error` subclass that carries a stable `code`, an arbitrary `context` object, a properly-typed `cause`, a fault-origin classification (`origin`/`retryable`), and a `toJSON()` serializer.
- **`M3LResult<T, E>`** — a discriminated union modeled after Rust's `Result`, with a set of operators (`map`, `mapErr`, `andThen`, `unwrap`, `unwrapOr`, `fromPromise`, `tryCatch`, …) that let code propagate failures as values rather than throwing.

A set of `M3LErrorUtils` helper functions normalize `unknown` thrown values (as caught in `catch` blocks) into well-typed errors.

## Public API

Public surface (`errors/index.ts`):

- Types and classes: `M3LError`, `M3LErrorCode`, `M3LErrorOptions`, `M3LResult`, `M3LResultOk`, `M3LResultErr`
- `M3L_ERROR_CODES` — the runtime `as const` tuple of every built-in error code (the source of truth `M3LErrorCode` derives from)
- `M3LErrorUtils` functions: `getErrorMessage`, `toError`, `wrapError`, `getErrorStack`, `hasErrorName`, `errorMessageContains`
- Result operators: `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `map`, `mapErr`, `andThen`, `fromPromise`, `tryCatch`
- Fault-origin classification (ADR-0035 phase 1 — see
  [Error-code catalog](#error-code-catalog)): `M3LErrorOrigin`,
  `M3LErrorRetryable`, `M3LErrorClassification`, `M3L_ERROR_CATALOG`,
  `classifyErrorCode`, `isM3LErrorCode`

### `M3LError`

`M3LError` extends `Error` and adds:

- `code` — a stable string identifier for the failure mode.
- `context` — an arbitrary object carrying structured diagnostic data.
- `cause` — a properly-typed underlying error, set via `M3LErrorOptions`.
- `origin` / `retryable` — the fault-origin classification, defaulted from the
  [error-code catalog](#error-code-catalog) (see [Fault origin](#fault-origin)).
- `toJSON()` — serializes all fields, including the `stack`.

Subclass `M3LError` per failure mode rather than throwing bare strings.

### `M3L_ERROR_CODES` / `M3LErrorCode`

`M3LError.code` is typed `string` because a caller may construct an `M3LError`
with any code they choose. `M3L_ERROR_CODES` is an `as const` tuple listing
every **built-in** code the library itself emits — each `M3LError` subclass's
literal `code`, plus the codes attached by bare `M3LError` constructions and the
error utilities (e.g. `PROMISE_REJECTED`/`WRAPPED_ERROR`/`RESULT_UNWRAP_ON_ERR`).
`M3LErrorCode` is the derived union `(typeof M3L_ERROR_CODES)[number]`. Together
they give a consumer that catches a library error a named vocabulary to narrow
on (with autocomplete and typo-protection) plus a runtime list to validate an
unknown string against:

```ts
import type { M3LErrorCode } from "@m3l-automation/m3l-common/core";

function isRetryable(code: M3LErrorCode): boolean {
  // `code === "ERR_TYPO"` here is a compile error — only real codes are members.
  return code === "ERR_POLL_EXHAUSTED" || code === "ERR_HTTP_REQUEST";
}
```

`M3LErrorCode` does **not** narrow `M3LError.code` itself (that stays `string`
for caller-supplied codes); it is additive vocabulary for the library's own
codes, surfaced through the `core` barrel. A **source-scan completeness test**
asserts `M3L_ERROR_CODES` equals the set of codes actually emitted across
`src/` — so a newly introduced built-in code that is not added here fails the
test, guarding the vocabulary against drift regardless of how the code is
emitted (subclass field or bare `M3LError`).

### Fault origin

`M3LErrorOptions` carries two optional, additive fields, defaulted from the
[error-code catalog](#error-code-catalog) below and `undefined` for any code the
catalog does not classify (unclassified — no existing construction changes
meaning):

- `origin: "caller" | "library" | "external"` — who must act to fix the
  failure. `caller`: the script/config author (bad config, invalid argument,
  API misuse). `external`: an external system (AWS, HTTP, remote job state,
  unreadable input data). `library`: an internal invariant violation — a bug
  in `@m3l-automation/m3l-common` itself.
- `retryable: boolean | "situational"` — whether re-running without changes
  can plausibly succeed. `"situational"` means it depends on the terminal
  status or context carried by the specific instance.

`origin` drives the [exit-code registry](./diagnostics.md#exit-code-registry--m3l_exit_codes--maperrortoexitcode)
and the triage table in the
[troubleshooting guide](../../guides/troubleshooting.md#1-triage-whose-failure-is-it):
`caller` → exit 2, `external` → exit 3, `library` → exit 4. The source-scan
completeness test that guards `M3L_ERROR_CODES` also asserts that every
built-in code has a catalog classification below.

**How the default is resolved.** `M3LError`'s constructor performs a single
catalog lookup on its own `code`: an explicit `origin`/`retryable` option always
wins, otherwise the catalog classification applies, otherwise both stay
`undefined`. Subclasses therefore inherit their classification without
declaring it — there is no per-subclass literal that could drift from the
catalog the exit-code registry reads. The trade-off is that `error.origin` types
as `M3LErrorOrigin | undefined` at a catch site rather than narrowing to a
literal the way a subclass's pinned `code` does.

### Error-code catalog

All **64** built-in codes, with their normative classification (the
implementation defaults for `origin`/`retryable` under ADR-0035). No built-in
code is classified `library` today — the built-in surface is strictly
caller/external; `library` is reserved for internal invariant violations,
which have no stable dedicated codes by definition.

The table below is mirrored in code as `M3L_ERROR_CATALOG`, shipped by
ADR-0035 phase 1:

```typescript
type M3LErrorOrigin = "caller" | "library" | "external";
type M3LErrorRetryable = boolean | "situational";

interface M3LErrorClassification {
  readonly origin: M3LErrorOrigin;
  readonly retryable: M3LErrorRetryable;
}

const M3L_ERROR_CATALOG: Readonly<Record<M3LErrorCode, M3LErrorClassification>>;

function classifyErrorCode(code: string): M3LErrorClassification | undefined;
function isM3LErrorCode(code: string): code is M3LErrorCode;
```

`M3L_ERROR_CATALOG` carries an explicit `Record<M3LErrorCode, …>` annotation
rather than `as const`, which makes catalog drift a **compile** error in both
directions: a code added to `M3L_ERROR_CODES` without a classification fails
the exhaustive key requirement, and a stale entry for a removed code fails the
excess-property check. That is stronger than the source-scan test alone.

`classifyErrorCode` is prototype-pollution safe — `classifyErrorCode("toString")`
and `("constructor")` return `undefined`, not an inherited `Object.prototype`
member.

> **`"situational"` is truthy.** Do not write `if (classification.retryable)` —
> that retries every situational code, including `ERR_ATHENA_QUERY_FAILED` on a
> terminal `FAILED` status, which is explicitly _not_ retryable. Test
> `retryable === true` and handle `"situational"` by inspecting the specific
> instance's terminal status or context. The union keeps the shape ADR-0035
> §2.1 ratified; the footgun is a documented caveat, not an accident.

`mapErrorToExitCode` (see
[diagnostics](./diagnostics.md#exit-code-registry--m3l_exit_codes--maperrortoexitcode))
consults this catalog as its second resolution step, after reading an error's
own `origin` field. Both branches are live: a built-in error carries the
`origin` its code classifies to, so the structural read resolves it, and the
catalog lookup remains the fallback for a plain object or a foreign error that
carries a recognised `code` but no `origin`.

| Code                              | Module (thrower)                                    | Meaning                                                                  | Origin   | Retryable   |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ | -------- | ----------- |
| `ERR_ANALYSIS_INVALID_RULE`       | `core/analysis` (`M3LThresholdRuleValidationError`) | Threshold rule has an unknown operator/aggregation/missing field         | caller   | false       |
| `ERR_ATHENA_QUERY_FAILED`         | `aws/athena` (`M3LAthenaQueryFailedError`)          | Query reached terminal FAILED/CANCELLED, or status/result call failed    | external | situational |
| `ERR_ATHENA_START_QUERY`          | `aws/athena` (`M3LAthenaStartQueryError`)           | `StartQueryExecution` yielded no execution id after retries              | external | true        |
| `ERR_AWS_CLIENT`                  | `aws/clients` (`M3LAWSClientError`)                 | SDK client construction / credential resolution failed                   | external | true        |
| `ERR_AWS_CREDENTIALS`             | `aws/credentials` (`M3LAWSCredentialsError`)        | Credentials unrecoverable by re-auth, login declined, or SDK load failed | external | false       |
| `ERR_AWS_INVALID_PROFILE`         | `aws/models` (`parseAWSProfile`)                    | Configured AWS profile name is not a valid identifier                    | caller   | false       |
| `ERR_AWS_INVALID_REGION`          | `aws/models` (`parseAWSRegion`)                     | Configured AWS region is not a valid identifier                          | caller   | false       |
| `ERR_AWS_PROVISIONING`            | `internal/script` (bare `M3LError`)                 | Dynamic `aws/clients` facade load or provider construction failed        | external | false       |
| `ERR_BINARY_FILE_EXPORT`          | `core/exporters`                                    | Binary file write failed (I/O)                                           | external | false       |
| `ERR_CONFIG_COERCION`             | `core/config` (`M3LConfigCoercionError`)            | Raw value cannot be coerced to the declared parameter type               | caller   | false       |
| `ERR_CONFIG_MISSING`              | `core/config` (`M3LConfigMissingError`)             | Required parameter resolved to no value through the whole chain          | caller   | false       |
| `ERR_CONFIG_PARSE`                | `core/config` (`M3LConfigParseError`)               | Config file readable but malformed JSON/YAML                             | caller   | false       |
| `ERR_CONFIG_UNSAFE_KEY`           | `core/config` (`M3LUnsafeConfigKeyError`)           | Prototype-pollution vector key in a config source                        | external | false       |
| `ERR_CONFIG_VALIDATION`           | `core/config` (`M3LConfigValidationError`)          | Coerced value fails its declared `validate` constraint                   | caller   | false       |
| `ERR_CSV_EXPORT`                  | `core/exporters` (`M3LCSVListExporter`)             | CSV export formatting or write failed                                    | external | false       |
| `ERR_DYNAMODB_OPERATION`          | `aws/dynamodb` (`M3LDynamoDBOperationError`)        | DynamoDB SDK command rejected                                            | external | true        |
| `ERR_ENVIRONMENT_DETECTION`       | `core/environment` (`M3LEnvironmentDetectionError`) | Unrecoverable filesystem error during monorepo walk-up                   | external | false       |
| `ERR_EVENTBRIDGE_OPERATION`       | `aws/eventbridge` (`M3LEventBridgeOperationError`)  | EventBridge request rejected or pre-flight validation failed             | external | true        |
| `ERR_FILE_COPY`                   | `core/files` (`M3LFileCopyError`)                   | Copier options invalid, or batch-fatal I/O (dir/write/manifest)          | external | false       |
| `ERR_FILE_EXPORT`                 | `core/exporters` (`M3LFileExporter`)                | Generic file export failed                                               | external | false       |
| `ERR_FILE_LIST_EXPORT`            | `core/exporters`                                    | File-list export failed                                                  | external | false       |
| `ERR_FTS_CORRUPT_METADATA`        | `core/storage` (`M3LFtsIndexError`)                 | FTS side-table metadata missing or unparseable                           | external | false       |
| `ERR_FTS_INVALID_DOCUMENT`        | `core/storage` (`M3LFtsIndexError`)                 | Document has an empty id                                                 | caller   | false       |
| `ERR_FTS_INVALID_IDENTIFIER`      | `core/storage` (`M3LFtsIndexError`)                 | Table/column name is not a bare SQL identifier                           | caller   | false       |
| `ERR_FTS_INVALID_LIMIT`           | `core/storage` (`M3LFtsIndexError`)                 | `options.limit` is not a positive integer                                | caller   | false       |
| `ERR_FTS_INVALID_MODE`            | `core/storage` (`M3LFtsIndexError`)                 | `options.mode` is not `full-text`/`literal`                              | caller   | false       |
| `ERR_FTS_INVALID_TOKENIZER`       | `core/storage` (`M3LFtsIndexError`)                 | Tokenizer directive malformed                                            | caller   | false       |
| `ERR_FTS_UNKNOWN_FILTER_COLUMN`   | `core/storage` (`M3LFtsIndexError`)                 | Filter key is not a declared metadata column                             | caller   | false       |
| `ERR_HTML_LIST_EXPORT`            | `core/exporters`                                    | HTML list render/write failed                                            | external | false       |
| `ERR_HTTP_REQUEST`                | `core/network` (`M3LHttpClientError`)               | HTTP failure; `reason` discriminates status/network/timeout/abort        | external | true        |
| `ERR_IMPORT_PARSE`                | `core/importers`                                    | Import source content malformed/unparseable                              | external | false       |
| `ERR_IMPORT_SOURCE`               | `core/importers`                                    | Import source missing/unreadable                                         | external | false       |
| `ERR_IMPORT_VALIDATION`           | `core/importers`                                    | Import validation escalated to a throw (reserved)                        | external | false       |
| `ERR_INVALID_ARGUMENT`            | `core/utils` (`M3LConcurrencyPool`)                 | Constructor argument validation failed                                   | caller   | false       |
| `ERR_JSON_DETECT_DEPTH`           | `core/json` (`M3LJSONFormatDetector`)               | Nesting exceeds the detection depth threshold                            | external | false       |
| `ERR_JSON_DETECT_READ`            | `core/json` (`M3LJSONFormatDetectionError`)         | Detection file read failed                                               | external | false       |
| `ERR_JSON_FILE_EXPORT`            | `core/exporters` (`M3LJSONFileExporter`)            | JSON file write failed                                                   | external | false       |
| `ERR_JSON_INVALID_CONFIDENCE`     | `core/json` (`M3LJSONFormatDetector`)               | Detection confidence below threshold                                     | external | false       |
| `ERR_JSON_LIST_EXPORT`            | `core/exporters` (`M3LJSONListExporter`)            | JSON list export failed                                                  | external | false       |
| `ERR_LAMBDA_OPERATION`            | `aws/lambda` (`M3LLambdaOperationError`)            | Lambda SDK command rejected                                              | external | true        |
| `ERR_LOG_TABLE_ALIGN`             | `core/logging` (`M3LTableFormatter`)                | Table alignment constraint violated                                      | caller   | false       |
| `ERR_LOG_TABLE_BORDER`            | `core/logging` (`M3LTableFormatter`)                | Table border/frame constraint violated                                   | caller   | false       |
| `ERR_LOGS_INSIGHTS_QUERY_FAILED`  | `aws/cloudwatch-logs-insights`                      | Query reached terminal Failed/Cancelled/Timeout/Unknown                  | external | situational |
| `ERR_LOGS_INSIGHTS_START_QUERY`   | `aws/cloudwatch-logs-insights`                      | `StartQuery` yielded no query id after retries                           | external | true        |
| `ERR_PATH_RESOLUTION`             | `core/utils` (`M3LPathResolutionError`)             | Directory path resolution failed                                         | external | false       |
| `ERR_POLL_EXHAUSTED`              | `internal/polling` (`M3LPollExhaustedError`)        | Poller used all attempts while the check kept returning `continue`       | external | true        |
| `ERR_POLL_FAILURE`                | `internal/polling` (`M3LPollFailureError`)          | Poller check returned a terminal `failure` decision                      | external | false       |
| `ERR_POLLING_INVALID_OPTION`      | `internal/polling`                                  | Polling numeric option non-finite or out of range                        | caller   | false       |
| `ERR_PRESET_CYCLE`                | `core/script` (`M3LPresetCycleError`)               | Preset `extends` chain cycles or exceeds depth 16                        | caller   | false       |
| `ERR_PRESET_LOAD`                 | `core/script`                                       | Preset file missing/unreadable/not a plain object                        | caller   | false       |
| `ERR_PRESET_TOO_DEEP`             | `core/script`                                       | Preset structure nesting exceeds depth 64                                | caller   | false       |
| `ERR_PRESET_UNKNOWN_KEYS`         | `core/script` (`M3LPresetUnknownKeysError`)         | Preset keys not declared in the config schema                            | caller   | false       |
| `ERR_PROMPT_VALIDATION`           | `core/prompt` (`M3LPromptValidationError`)          | Prompt input/bounds validation failed                                    | caller   | false       |
| `ERR_S3_OPERATION`                | `aws/s3` (`M3LS3OperationError`)                    | S3 SDK command rejected                                                  | external | true        |
| `ERR_SIGNING_FAILURE`             | `aws/signing` (`M3LSigningError`)                   | SigV4 signing failed (bad URL or credential resolution)                  | external | false       |
| `ERR_SQS_OPERATION`               | `aws/sqs` (`M3LSQSOperationError`)                  | SQS batch rejected after retries or pre-flight validation failed         | external | true        |
| `ERR_TEXT_EXTRACTION`             | `core/text` (`M3LTextExtractionError`)              | Extraction failed (unreadable/corrupt source, backing lib error)         | external | false       |
| `ERR_TEXT_EXTRACTION_MISSING_DEP` | `core/text` (`M3LTextExtractionError`)              | Optional peer dependency for the format could not load                   | external | false       |
| `ERR_TEXT_EXTRACTION_UNSUPPORTED` | `core/text` (`M3LTextExtractionError`)              | No extractor registered for the MIME type/extension                      | caller   | false       |
| `M3L_MESSAGING_NO_READER`         | `core/messaging` (`M3LMessenger`)                   | `read()` iterated with no reader configured                              | caller   | false       |
| `M3L_MESSAGING_NO_TARGET`         | `core/messaging` (`M3LMessenger`)                   | Send with no explicit target and no `defaultTarget`                      | caller   | false       |
| `PROMISE_REJECTED`                | `core/errors` (`fromPromise`)                       | Wraps a promise rejection into an `err(...)` result                      | external | true        |
| `RESULT_UNWRAP_ON_ERR`            | `core/errors` (`unwrap`)                            | `unwrap()` called on an `Err` result                                     | caller   | false       |
| `WRAPPED_ERROR`                   | `core/errors` (`wrapError`)                         | Default code for a generically wrapped underlying failure                | external | situational |

Classification notes:

- `retryable: true` marks transient-by-nature failures (throttling, network,
  poll exhaustion against slow remote state); `situational` means inspect the
  instance (e.g. an Athena `FAILED` status is not retryable, a transient
  status-poll error is). `caller` codes are never retryable — re-running
  without a fix cannot succeed.
- `ERR_CONFIG_UNSAFE_KEY` is `external` because the guarded key may arrive
  from any config source, including ones populated from external input; treat
  it as potentially adversarial data, not a typo.
- `WRAPPED_ERROR` and `PROMISE_REJECTED` inherit the true classification of
  their `cause` — walk the chain to the root before triaging.

### `M3LResult<T, E>`

`M3LResult<T, E>` is a discriminated union of `M3LResultOk<T>` and `M3LResultErr<E>`. The `andThen`, `map`, `fromPromise`, and `tryCatch` operators enable chainable, exception-free error handling. `unwrap()` converts a result back into a thrown exception at a boundary where that is appropriate.

## Usage examples

### Typed errors with `code`, `context`, and `cause`

```typescript
import { Core } from "@m3l-automation/m3l-common";

class RecordNotFoundError extends Core.M3LError {}

function loadRecord(id: string): Record<string, unknown> {
  const row = lookup(id);
  if (row === undefined) {
    throw new RecordNotFoundError(`record ${id} not found`, {
      code: "RECORD_NOT_FOUND",
      context: { id },
    });
  }
  return row;
}

try {
  loadRecord("abc");
} catch (error: unknown) {
  // Normalize the unknown caught value into a real Error.
  const e = Core.toError(error);
  console.error(Core.getErrorMessage(e));
}
```

### Wrapping an underlying failure

```typescript
import { Core } from "@m3l-automation/m3l-common";

try {
  await writeOutput(data);
} catch (cause: unknown) {
  // wrapError chains the underlying failure via the `cause` option.
  throw Core.wrapError(cause, "failed to write output", {
    code: "OUTPUT_WRITE_FAILED",
  });
}
```

### Chainable, exception-free results

```typescript
import { Core } from "@m3l-automation/m3l-common";
import type { M3LResult } from "@m3l-automation/m3l-common";

function parsePort(raw: string): M3LResult<number, M3LError> {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0
    ? Core.ok(n)
    : Core.err(new Core.M3LError(`invalid port: ${raw}`, { code: "BAD_PORT" }));
}

const result = Core.map(parsePort("8080"), (port) => port + 1);

if (Core.isOk(result)) {
  console.log(Core.unwrap(result)); // 8081
} else {
  console.log(Core.unwrapOr(result, 0));
}
```

### Bridging promises and try/catch into results

```typescript
import { Core } from "@m3l-automation/m3l-common";

// fromPromise turns a rejecting promise into an err(...) result.
const fetched = await Core.fromPromise(loadRemoteConfig());

// tryCatch turns a throwing call into a result.
const parsed = Core.tryCatch(() => JSON.parse(rawText) as unknown);

// andThen chains result-producing steps; mapErr reshapes the error channel.
const port = Core.mapErr(
  Core.andThen(parsed, (value) => parsePort(String(value))),
  (e) => Core.toError(e),
);
```

## Notes and behavior

- Never throw bare strings and never swallow errors silently; subclass `M3LError` per failure mode and chain underlying failures through `cause`.
- `toError` and `getErrorMessage` are designed for `catch (error: unknown)` blocks — use them to narrow `unknown` instead of using `any`.
- `hasErrorName` and `errorMessageContains` are predicates useful for branching on error identity without instanceof chains; `getErrorStack` safely extracts a stack when present.
- `isOk` / `isErr` are type guards that narrow `M3LResult<T, E>` to `M3LResultOk<T>` / `M3LResultErr<E>`.
- `unwrap()` throws on an error result; prefer `unwrapOr` (or `isOk` narrowing) when you want to stay exception-free.

## See also

- [Core / events](./events.md)
- [Core / logging](./logging.md)
- [Core / polling](./polling.md) — `M3LRetryRunner` classifies thrown errors for retry decisions
- [Architecture overview](../../m3l-common-architecture.md)
