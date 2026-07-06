# Core / errors

Structured error handling for `@m3l-automation/m3l-common`: a typed error base class and a Rust-style `M3LResult<T, E>` for exception-free, chainable error propagation.

## Overview

The `errors` module provides two complementary tools:

- **`M3LError`** — an `Error` subclass that carries a stable `code`, an arbitrary `context` object, a properly-typed `cause`, and a `toJSON()` serializer.
- **`M3LResult<T, E>`** — a discriminated union modeled after Rust's `Result`, with a set of operators (`map`, `mapErr`, `andThen`, `unwrap`, `unwrapOr`, `fromPromise`, `tryCatch`, …) that let code propagate failures as values rather than throwing.

A set of `M3LErrorUtils` helper functions normalize `unknown` thrown values (as caught in `catch` blocks) into well-typed errors.

## Public API

Public surface (`errors/index.ts`):

- Types and classes: `M3LError`, `M3LErrorCode`, `M3LErrorOptions`, `M3LResult`, `M3LResultOk`, `M3LResultErr`
- `M3L_ERROR_CODES` — the runtime `as const` tuple of every built-in error code (the source of truth `M3LErrorCode` derives from)
- `M3LErrorUtils` functions: `getErrorMessage`, `toError`, `wrapError`, `getErrorStack`, `hasErrorName`, `errorMessageContains`
- Result operators: `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `map`, `mapErr`, `andThen`, `fromPromise`, `tryCatch`

### `M3LError`

`M3LError` extends `Error` and adds:

- `code` — a stable string identifier for the failure mode.
- `context` — an arbitrary object carrying structured diagnostic data.
- `cause` — a properly-typed underlying error, set via `M3LErrorOptions`.
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
