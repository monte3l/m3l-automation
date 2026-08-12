# 0041. Widen the `aws/**` ESLint zone to admit `core/logging`'s handler port

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Enrico Lionello

## Context and problem statement

The post-comparison hardening wave's §7 ("AWS depth") gives
`M3LAWSCredentialsManager` an injectable log handler: it already accepts an
injected `prompt` (`aws/credentials/manager.ts:191`, `M3LPrompt` from
`core/prompt`) but has no log seam, so the `aws sso login` subprocess's
lifecycle (start, success, failure, timeout) is observable only via
`stdio: "inherit"` — invisible to a caller building a structured log of a
script run.

The natural port to accept is `M3LLoggerHandler`
(`core/logging/M3LLogEvent.ts`), the same interface every built-in handler
(`M3LConsoleLoggerHandler`, `M3LFileLoggerHandler`, `M3LJsonLoggerHandler`)
implements and the one third parties are told to implement for a custom
handler. Building `M3LLogEvent` objects to hand it also needs
`M3LLogEventCategory` (`core/logging/M3LLogEventCategory.ts`).

Zone A of `eslint.config.js` (`import-x/no-restricted-paths`, ADR-0009)
allows `aws/**` to import only `core/errors`, `core/prompt`, `core/polling`,
and the single file `core/utils/M3LSingleFlight.ts` (ADR-0040). `core/logging`
is not in that list. Importing the full `core/logging` barrel
(`core/logging/index.ts`) would pull in `M3LLogger.ts` (which imports
`core/diagnostics/format-error.js`), `redact.ts`, `M3LTableFormatter.ts`, and
the three built-in handlers — exactly the kind of transitive-graph pull Zone A
exists to block, for a manager that only ever needs to _call_ a handler it is
given, never construct one.

## Decision drivers

- The whole point of this seam is accepting the same `M3LLoggerHandler` port
  every other handler implements — inventing a parallel, locally-declared
  structural type would fork the contract and break the
  `{@link M3LLoggerHandler}` TSDoc cross-reference third parties rely on.
- Zone A exists to keep `aws/**` a shallow, acyclic island; any widening must
  be justified by a genuinely minimal, acyclic edge — the same bar ADR-0026
  applied to `core/polling` and ADR-0040 applied to `M3LSingleFlight.ts`.
- `core/logging`'s implementation files (`M3LLogger.ts`, `redact.ts`,
  `M3LTableFormatter.ts`, the three handler classes) form the "mid" layer
  ADR-0009 already reserves for a different zone — widening to the whole
  submodule would let `aws/**` pull in that entire graph for what is, in this
  case, two interface/const-object declarations.
- No breaking change to the `exports` map or any existing exported signature.

## Considered options

1. **Widen Zone A's `except` list to the two files
   `logging/M3LLogEvent.ts` and `logging/M3LLogEventCategory.ts`**, not the
   whole `logging` directory. Verified by reading both files:
   `M3LLogEventCategory.ts` has zero imports of its own (a `const` object plus
   two derived types), and `M3LLogEvent.ts` imports only
   `M3LLogEventCategory.ts` (type-only) — a closed, two-file leaf subgraph,
   the same shape as ADR-0040's single-file exception.
2. **Declare a locally-scoped structural type in `aws/credentials/manager.ts`**
   matching `M3LLoggerHandler`'s shape (`handle`/`reset`) without importing
   it. Rejected: TypeScript's structural typing means a real
   `M3LLoggerHandler` would still be assignable, but the manager's own option
   type would no longer say `M3LLoggerHandler`, breaking discoverability and
   the `{@link M3LLoggerHandler}` TSDoc reference — a duplicate declaration of
   the exact kind ADR-0040 rejected for `M3LSingleFlight`.
3. **Widen Zone A to the whole `core/logging` directory**, matching the
   directory-name granularity of the `errors`/`prompt`/`polling` entries.
   Rejected: pulls in `M3LLogger.ts`'s own dependency on
   `core/diagnostics/format-error.js`, `redact.ts`, and three handler
   implementations `aws/**` has no need to construct — exactly the transitive
   pull Zone A is designed to prevent.
4. **Defer the logger seam entirely**, leaving SSO login observable only via
   `stdio: "inherit"`. Rejected: this is the concrete gap §7 exists to close,
   and the two-file exception below closes it with a provably minimal edge.

## Decision

We chose **option 1**: Zone A's exception list widens from
`except: ["errors", "prompt", "polling", "utils/M3LSingleFlight.ts"]` to
`except: ["errors", "prompt", "polling", "utils/M3LSingleFlight.ts", "logging/M3LLogEvent.ts", "logging/M3LLogEventCategory.ts"]`
(`eslint.config.js`, the `aws/**` zone block) — two files, not the directory.
`aws/credentials/manager.ts` accepts an optional `logger?: M3LLoggerHandler`
in `M3LAWSCredentialsManagerOptions`, defaulting to no-op (unset means no log
events are emitted — the existing `stdio: "inherit"` behavior is unchanged
either way), and calls `logger.handle(event)` at the SSO login lifecycle
points (start, success, failure, timeout) using `M3LLogEventCategory`
members to build each `M3LLogEvent`.

## Consequences

- **Positive:** the manager's log seam reuses the library's one handler
  contract instead of forking a parallel type; a caller can plug in
  `M3LConsoleLoggerHandler`/`M3LFileLoggerHandler`/`M3LJsonLoggerHandler` or
  their own implementation and observe the SSO subprocess lifecycle
  structurally, the same way every other loggable operation in the library
  already works.
- **Negative / trade-offs:** `aws/**` now has a sixth and seventh named
  exception instead of five; a future contributor adding a second
  `core/logging` consumer to `aws/**` must independently justify and add that
  file too, one line at a time — this is intentional friction, not an
  oversight. The manager still cannot _construct_ a default logger (unlike
  `M3LPrompt`, which lazily builds `new M3LPrompt()` when uninjected) without
  a further Zone A widening to the constructible handler classes — a
  deliberately narrower seam than the prompt one, and out of scope here.
- **Semver impact:** minor. `logger` is a new optional field on
  `M3LAWSCredentialsManagerOptions`; unset behavior is unchanged. No existing
  exported signature is retyped, no `exports`-map entry changes.

## Links

- Supersedes / superseded by: none. Amends ADR-0009's Zone A enforcement
  (`eslint.config.js`), the same way ADR-0026 and ADR-0040 did before it.
- Related: [ADR-0009 (dependency-direction guard)](./0009-dependency-direction-guard.md),
  [ADR-0026 (SQS operations wrapper — the first Zone A widening precedent)](./0026-sqs-operations-wrapper.md),
  [ADR-0040 (`M3LSingleFlight` zone widening — the immediate precedent this
  ADR mirrors)](./0040-single-flight-zone-widening.md),
  `packages/m3l-common/src/core/logging/M3LLogEvent.ts`,
  `packages/m3l-common/src/core/logging/M3LLogEventCategory.ts`,
  `packages/m3l-common/src/aws/credentials/manager.ts`.
