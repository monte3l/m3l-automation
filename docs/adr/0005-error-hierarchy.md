# 0005. M3LError and M3LResult as the error model

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

`@m3l-automation/m3l-common` is a library for automation scripts that handle failures at every layer: network calls, file I/O, configuration loading, AWS API errors. The team needed an error model that lets callers discriminate failure modes precisely, supports chainable, exception-free pipelines for complex async workflows, and introduces no additional runtime dependencies.

## Decision drivers

- Callers must distinguish failure modes at runtime (e.g., config parse error vs. network timeout); bare `Error` throws do not carry a machine-readable code.
- Async automation pipelines benefit from chainable, value-based error propagation that avoids deeply nested try/catch.
- `unknown` thrown from `catch` blocks must normalize to a well-typed error without unsafe casts.
- Zero new runtime dependencies — the model must be built entirely on native `Error`.

## Considered options

1. **Bare `Error` throws only** — subclass `Error` with a `code` field; all callers use try/catch. Simple but offers no ergonomic path for chaining and forces every async step to wrap in try/catch.
2. **`M3LResult<T, E>` only (no thrown errors)** — all functions return a Result discriminated union; no throws anywhere. Consistent but forces consumer code to always destructure even for trivially infallible operations; unusual for Node library conventions.
3. **`M3LError` + `M3LResult<T, E>` complementary** (chosen) — thrown errors for synchronous failure modes and Result for async pipelines where callers want to chain operations without try/catch.

## Decision

1. **`M3LError` is the root of the typed error hierarchy.** It extends the native `Error` and adds a `code` (string, machine-readable), `context` (arbitrary object for structured diagnostics), and typed `cause` for chaining underlying failures. Subclasses represent distinct failure modes. Callers `catch (e) { if (e instanceof SomeM3LError) … }` to discriminate. `toJSON()` serializes all fields including the stack for structured logging.

2. **`M3LResult<T, E>` is a discriminated union of `M3LResultOk<T>` and `M3LResultErr<E>`.** Operators — `map`, `mapErr`, `andThen`, `unwrap`, `unwrapOr`, `fromPromise`, `tryCatch` — enable chainable, exception-free pipelines modelled after Rust's `Result`. Helper utilities normalize `unknown` values from `catch` blocks into `M3LError` instances without unsafe casts.

3. **The two tools are complementary, not competing.** Synchronous invariant violations and configuration errors are thrown (exceptional); async pipeline steps return `M3LResult` so that operation chains compose without nested try/catch. `fromPromise` and `tryCatch` bridge promise-based or throwing code into the Result world.

## Consequences

- **Positive:** callers can discriminate failures by type and code; async pipelines compose without nested try/catch; `unknown` from catch blocks is safely normalized; structured `toJSON()` output integrates with the library's logging layer.
- **Negative / trade-offs:** two error-handling idioms require documentation discipline to avoid confusion. The dual model is explicitly documented with worked examples for each pattern.
- **Semver impact:** once published, changing `M3LError`'s public fields or `M3LResult`'s operator signatures is a breaking change (major).

## Links

- Related: `docs/reference/core/errors.md` (full spec with code examples), `docs/m3l-common-architecture.md`, `docs/contributing/coding-standards.md`.
