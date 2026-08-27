# Core / cli-contract

The typed seam a script exports so a host — the `m3l` CLI today, an agent
runtime later — can invoke it **in-process** instead of spawning
`scripts/<name>/dist/main.js` and reading an exit code off a dead child.

## Overview

Every execution path in `packages/m3l-cli` today re-serialises parsed
parameters back to `--name=value` argv and spawns the script as a child
process. That caps the product: progress cannot stream structured data back,
cancellation has to cross a process boundary, orchestration can branch only on
an integer, and nothing works at all when the workspace is absent — which is
what blocks distribution (ADR-0057).

ADR-0054 chose **hybrid execution with selective promotion of the contract
only**. A script opts in by exporting a `commandModule` descriptor; the host
may then run it in-process, and falls back to the spawn path for any script
that has not opted in. This submodule is that descriptor's typed home.

It lives in `m3l-common`, not in `m3l-cli`, because ADR-0029 fixes the
dependency direction: a consumer script depends on `@m3l-automation/m3l-common`
and nothing else. A descriptor type owned by the CLI would invert that.

### `cli-contract` is not a CLI framework

Only the seam is promoted. Argument parsing, command routing, help rendering,
did-you-mean suggestions, table layout, the discovery cache, and the concrete
`createOutput`/`resolveColorEnabled` implementation all stay private to
`packages/m3l-cli`. What crosses into the library is the _shape_ a script must
present and the _shape_ a host must supply — nothing that renders anything.

## Landing plan

ADR-0072 slice record.

| Slice                          | Scope                                                                                                                                    | Status |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| U3 — the contract              | The descriptor types, the outcome→exit-code mapper, and the output port. 5 exports.                                                      | Landed |
| U7a — the host seams (library) | The logger factory, the output-stream shape + default factory, the two descriptor/outcome guards, and `deriveCommandOutcome`. See below. | Landed |

Deliberately **not** in this slice, and why:

- **ADR-0055's operation declaration.** The declarative, enumerable operations
  field lands in `core/config` at U4; the descriptor is widened then, as a
  second additive minor. No placeholder type ships here.
- **The `M3LScript`/`runScript` composition.** See
  [Compatibility with `core/script`](#compatibility-with-corescript) — an
  ADR-0009 layering zone puts it out of reach, so it lands in the adopting
  script (U6) and the CLI's in-process host (U7).
- **The CLI's own in-process execution path.** U7a lands the library seams a
  host needs; `packages/m3l-cli`'s consumption of them — locating and
  dynamically importing a script's `dist/command.js`, building the context,
  wiring `--in-process` — is U7's second slice and is not in this diff.

This slice takes Core from 23 to 24 submodules (fleet total 42 → 43). ADR-0054,
`docs/ROADMAP.md`, and `docs/plans/IMPLEMENTATION.md` all originally recorded
"22 → 23"; that was authored on 2026-08-20, one day before `core/procedure`
landed and consumed 22 → 23. The tracker rows are corrected in the same PR.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols — fourteen. The original five from U3, grouped by ADR-0054's
three bullets, plus nine U7a additions (the host seams a program running a
script in-process needs — see their own sections below):

- `M3LCommandModule<TParameters>` — the descriptor a script exports.
- `M3LCommandContext` — the port bag a host supplies to `execute`.
- `M3LCommandOutcome` — the discriminated result `execute` resolves to.
- `mapCommandOutcomeToExitCode` — outcome → process exit code.
- `M3LCommandOutput` — the operator-facing writer port.
- `M3LCommandOutputStream` / `M3LCommandOutputOptions` / `createCommandOutput`
  — the writable-stream shape a default output port writes through, and the
  factory that builds one (§ [The output port](#the-output-port)).
- `M3LCommandLoggerOptions` / `createCommandLogger` — builds the logger a host
  hands a hosted command, carrying the resolved log-level floor and the
  command's own derived secrets (§ [Building the host's
  logger](#building-the-hosts-logger)).
- `isM3LCommandModule` / `isM3LCommandOutcome` — runtime guards over the two
  values that cross a genuinely hostile boundary: a foreign `dist/`'s export,
  and whatever its `execute` resolved to (§ [Validating a foreign
  descriptor](#validating-a-foreign-descriptor)).
- `M3LCommandRunState` / `deriveCommandOutcome` — derives the outcome a hosted
  command reports from a finished run's observable end state (§ [Deriving an
  outcome](#deriving-an-outcome)).

**Reused, not re-exported.** `M3LExitCode`, `M3L_EXIT_CODES`, and
`mapErrorToExitCode` stay singly owned by `core/diagnostics`;
`M3LConfigParameter` by `core/config`; `M3LLogger` and `M3LLoggerHandler` by
`core/logging`. All six are already reachable as `Core.*`. Re-exporting any of
them here would not merely duplicate — it would **break the barrel**:
`src/core/index.ts` reaches every submodule with
`export * from "./<mod>/index.js"`, and the same name arriving from two star
exports is TS2308 at compile time and a _silently dropped_ export under ES
module semantics.

## The command-module descriptor

```typescript
interface M3LCommandModule<TParameters extends object = Record<string, never>> {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly configParameters: readonly M3LConfigParameter[];
  execute(
    parameters: TParameters,
    context: M3LCommandContext,
  ): Promise<M3LCommandOutcome>;
}
```

`name` and `version` are flat rather than nested under an `identity` object so
that an `M3LCommandModule` **is** structurally an `M3LScriptMetadata` — the
adopting script passes the descriptor straight into `new M3LScript({ metadata })`
with no adapter and no second source of truth for its own name.

`configParameters` is the existing seam, unchanged: `templates/script/src/config.ts.tmpl`
already exports `readonly Core.M3LConfigParameter[]`, and the CLI already reads
that array off a script's built `dist/` to render help and validate input.
Because `M3LConfigParameter` carries private fields it is _nominal_ in
TypeScript — a hand-rolled `{ name: "x", type: "int" }` literal is rejected, so
only a value that went through the constructor (with its eager `defaultValue`
validation) can appear here.

`execute` **resolves an outcome**. It does not throw to signal failure and it
never calls `process.exit` — in-process, either would take the host down with
it. `Promise<void>` is not assignable, so a command cannot finish without
declaring what happened.

A host holding an _arbitrary_ descriptor must name it `M3LCommandModule<object>`.
The bare `M3LCommandModule` cannot serve as the "any module" type: it defaults
`TParameters` to `Record<string, never>`, and a concrete interface is not
assignable to that (TS2375 — no index signature). `execute` is declared with
method syntax and is therefore bivariant, so `M3LCommandModule<object>` does
accept a descriptor with a concrete parameter shape — which also means the
generic is erased at the host boundary, not merely unenforced against the
author's own schema.

`TParameters` is _not_ derived from `configParameters`. `M3LConfigParameter` is
a runtime class, not a const-generic declaration, so its names and coerced
types are not liftable into a mapped type; a command whose `execute` disagrees
with its own declared schema still compiles. ADR-0055/U4 is where that seam
could become expressible.

## The execution context

```typescript
interface M3LCommandContext {
  readonly output: M3LCommandOutput;
  readonly logger: M3LLogger;
  readonly signal: AbortSignal | undefined;
  readonly dryRun: boolean;
}
```

**Cancellation (ADR-0049).** `signal` is a _required_ property holding
`AbortSignal | undefined`, not an optional one — the `M3LProcedureContext.signal`
convention. Under `exactOptionalPropertyTypes` an optional key lets a
host-side helper forget the field exists; a required `AbortSignal | undefined`
forces the narrow. Note this differs from `M3LPollerOptions.signal?` and
`M3LRetryRunnerOptions.signal?`, which are _caller-built options bags_ where
omission legitimately means "no cancellation". A context is host-built and
handed to callee code, so the stricter form applies.

**Dry run.** `dryRun` is likewise required, mirroring
`M3LScriptHookContext.dryRun`: `false` is meaningful information (this
invocation performs real work), not an absence of it, and a command branches on
it directly without a `?? false` at every call site.

**Logging.** `logger` is `core/logging`'s existing `M3LLogger`, assignable
straight into `M3LScriptOptions.logger`. A host routes command output into its
own stream by implementing `core/logging`'s existing `M3LLoggerHandler` port.
No logging symbols are promoted here.

## Outcomes

```typescript
type M3LCommandOutcome =
  | { readonly status: "success" }
  | { readonly status: "dry-run" }
  | { readonly status: "interrupted" }
  | { readonly status: "partial"; readonly recovered: number }
  | { readonly status: "failure"; readonly error: unknown };
```

The `status` vocabulary is deliberately identical to `core/diagnostics`'
`M3LRunOutcome`, so an in-process run and a run report describe the same event
with the same word.

A discriminated union rather than a flat bag: `error` is reachable only after
narrowing to `"failure"`, `recovered` only after `"partial"`. A
`{ status: "success", error }` does not compile. Contrast what this replaces —
a bare integer exit code that carries no evidence of what produced it.

One state stays representable and is **not** typed away:
`{ status: "partial", recovered: 0 }` is a lie (a partial run absorbed no
failures). Making it unrepresentable would need a branded positive integer and
a runtime smart constructor — new public surface for a case that degrades
gracefully, since the exit code keys off `status` alone. Such an outcome is
_mislabelled_, never _miscoded_.

## Exit-code mapping

```typescript
function mapCommandOutcomeToExitCode(outcome: M3LCommandOutcome): M3LExitCode;
```

Maps an in-process outcome to the code the child process would have exited
with, so the two execution paths are indistinguishable to a scheduler:

| Outcome         | Exit code                                                |
| --------------- | -------------------------------------------------------- |
| `"success"`     | `M3L_EXIT_CODES.SUCCESS` (0)                             |
| `"dry-run"`     | `M3L_EXIT_CODES.SUCCESS` (0)                             |
| `"interrupted"` | `M3L_EXIT_CODES.INTERRUPTED` (5)                         |
| `"partial"`     | `M3L_EXIT_CODES.PARTIAL` (6)                             |
| `"failure"`     | delegated to `mapErrorToExitCode(error)` → 1, 2, 3, or 4 |

**No new codes are minted.** The return type is `M3LExitCode`, not `number`, so
that clause of ADR-0054 is enforced by the compiler rather than by review. The
`"failure"` arm calls the real `core/diagnostics` mapper — there is no second
classification table here.

**Never throws.** Every read off the caller-supplied outcome — `status`, and
`error` on the failure arm — happens once inside a single guard, _before_ any
dispatch. This is load-bearing rather than defensive: argument evaluation
happens in this function's frame, so `mapErrorToExitCode(outcome.error)` would
evaluate `outcome.error` _outside_ that callee's own guard. A hostile getter, a
revoked `Proxy`, or a non-object forced past the type system therefore yields
`UNCLASSIFIED` (1) rather than propagating. The failure arm then hands the
already-read value to `mapErrorToExitCode`, whose own never-throws guarantee
covers it from there.

This mirrors `core/diagnostics`' `safeResolveExitCode`, the wrapper that makes
`M3LRunReporter.build`'s identical guarantee hold.

Adding a sixth outcome arm without mapping it is a compile error, via the
`const _exhaustive: never` idiom this module shares with
`core/diagnostics/run-report.ts`.

## Deriving an outcome

```typescript
interface M3LCommandRunState {
  readonly recovery: readonly M3LRunRecoveryEntry[];
  readonly recoveryTotal: number;
}

function deriveCommandOutcome(
  run: M3LCommandRunState,
  failures: readonly unknown[],
  dryRun: boolean,
): M3LCommandOutcome;
```

Promoted out of three byte-identical private `toOutcome` functions the U6
pilot scripts each carried. `M3LCommandRunState` is the two-property slice of
a finished run this function reads — structural, never `Pick<M3LScript, ...>`,
because the ADR-0009 layering zone forbids this module from naming
`core/script` at all. A real `M3LScript` satisfies the shape through its
existing `recovery`/`recoveryTotal` getters.

The precedence — a captured failure first, then partial recovery, then
dry-run, then success — mirrors `core/script/run-script.ts` literally rather
than being re-derived, because the property that matters is **parity**: for
every state a finished run can be in,
`mapCommandOutcomeToExitCode(deriveCommandOutcome(...))` must equal the exit
code the spawn path already assigned to `process.exitCode`. Only the first
captured failure is reported (the run's proximate cause); `recovered` reports
the honest `recoveryTotal`, not `recovery.length`, since the recovery buffer
is a truncated ring.

**Never throws**, matching every sibling in this module. `failures` holds
arbitrary caller-thrown values, so the cooperative-cancellation classification
(by `code`, per ADR-0049) reads the one caller-controlled property once inside
a `try` and falls back to `{ status: "failure" }` on a throwing read — a
hostile value costs the caller a classification, never the outcome itself.

## The output port

```typescript
interface M3LCommandOutput {
  readonly colorEnabled: boolean;
  info(text: string): void;
  error(text: string): void;
  heading(text: string): void;
}
```

`colorEnabled` describes the **stdout** channel — the one `info` and `heading`
write to. The shape this promotes resolves colour per stream, so a host whose
stdout is a TTY and stderr is not will style `info`/`heading` while leaving
`error` unstyled; a command that reads `colorEnabled` to decide what to emit on
the error channel would get the stdout answer. Per-channel resolution is not
exposed, deliberately — a command should not be branching on it.

`M3LCommandOutput` is the promoted shape of the CLI's own `M3LCliOutput`. At
U7's second slice (`packages/m3l-cli`'s in-process host) the CLI aliases its
`M3LCliOutput`/`M3LCliOutputStream` to these types rather than keeping a
second declaration, closing the drift risk this page used to flag.

**What stays CLI-private.** The rendering half — `createOutput`,
`resolveColorEnabled`, `sanitizeTerminalText`, and the options bag — remains in
`packages/m3l-cli`, per ADR-0054's "output rendering stays CLI-private".

### A default output port — `M3LCommandOutputStream` / `createCommandOutput`

```typescript
interface M3LCommandOutputStream {
  write(text: string): unknown;
  readonly isTTY?: boolean | undefined;
}

interface M3LCommandOutputOptions {
  readonly stdout?: M3LCommandOutputStream;
  readonly stderr?: M3LCommandOutputStream;
  readonly colorEnabled?: boolean;
}

function createCommandOutput(
  options?: M3LCommandOutputOptions,
): M3LCommandOutput;
```

A command needs _some_ writer when nothing hosted it — a direct
`node dist/command.js` invocation, or a test — and this replaces the
byte-identical private `consoleOutput` const the three U6 pilot scripts each
carried. `createCommandOutput()` with no argument writes to
`process.stdout`/`process.stderr`; `M3LCommandOutputStream` is a deliberately
minimal two-member structural port (not `NodeJS.WriteStream`) so a host can
bind an in-memory collector or a socket just as readily as a process stream.
It renders nothing — no styling, no terminal-escape sanitisation — same rule
as `M3LCommandOutput` itself; `error` always lands on the stderr sink
regardless of `colorEnabled`.

This ships one slice ahead of its second intended consumer:
`packages/m3l-cli`'s in-process host (U7's next slice) is written _against_
this shape rather than the shape being extracted from it afterwards — not yet
a satisfied two-consumer bar, a deliberate ordering risk stated plainly rather
than glossed over.

## Building the host's logger

```typescript
interface M3LCommandLoggerOptions {
  readonly handlers: readonly M3LLoggerHandler[];
  readonly configParameters: readonly M3LConfigParameter[];
  readonly correlationId?: string;
}

function createCommandLogger(options: M3LCommandLoggerOptions): M3LLogger;
```

This closes the gap U6 left open (see [What U7
shipped](#what-u7-shipped)): a host cannot correctly build
`M3LCommandContext.logger` by hand.
`new M3LLogger([handler])` carries neither the resolved
`--log-level`/`M3L_LOG_LEVEL` floor (`resolveLogLevelFloor` is `internal/` and
unreachable from outside the library) nor the command's own schema-derived
secrets — so a declared secret parameter's value would stop being redacted
the moment a run went hosted rather than spawned. `createCommandLogger`
applies the exact policy `M3LScript`'s own default logger applies, over
caller-supplied handlers instead of a hardcoded console handler.

`handlers` and `configParameters` are both **required**: a host that forgot
`configParameters` would silently build a logger with no derived secrets,
which is the exact regression this factory exists to prevent. Each declared
parameter is duck-type-checked (callable `getName`/`getAliases`/`isSecret`)
before it reaches `M3LConfigSchema`, so a malformed element from a foreign
`dist/` build throws a named `M3LError` (`ERR_INVALID_ARGUMENT`, naming the
offending index) rather than a raw `TypeError` three frames down —
`isM3LCommandModule` deliberately does not validate `configParameters`
elements (see below), so this factory is the first place they are used.

The layering is legal in both directions: `core/cli-contract` may import
`core/logging`, `core/config`, and `internal/**` freely — the ADR-0009 zone
bans only `core/**` → `core/script`.

## Validating a foreign descriptor

```typescript
function isM3LCommandModule(value: unknown): value is M3LCommandModule<object>;
function isM3LCommandOutcome(value: unknown): value is M3LCommandOutcome;
```

A host reads two values it did not compile: the export a foreign
`dist/command.js` resolves to, and whatever that descriptor's `execute`
resolves to. Both sit on a genuinely hostile boundary — a `Proxy`, a throwing
getter, a revoked handle, or a plain `undefined` from a missing `await` are
all reachable — so **neither guard ever throws**, and each reads every
caller-controlled property **at most once**, mirroring the fix
`mapCommandOutcomeToExitCode` already carries.

`isM3LCommandModule` is structural, never nominal: a descriptor loaded from a
foreign `dist/` build carries `M3LConfigParameter` instances constructed by a
_different copy_ of this library, so an `instanceof` element check would
reject exactly the case the guard exists for — `configParameters` is checked
with `Array.isArray` only, its elements not inspected (see
`createCommandLogger` above for where that trust boundary is actually
enforced). It narrows to `M3LCommandModule<object>`, never the bare
`M3LCommandModule` (which defaults `TParameters` to `Record<string, never>`
and cannot serve as the "any module" type — TS2375).

`isM3LCommandOutcome` accepts **what the type accepts**, not a stricter
runtime rule the type disclaims: since `M3LCommandOutcome`'s own
documentation already declines to make an odd `recovered` value
unrepresentable, the guard only requires `typeof recovered === "number"` —
`NaN` and `Infinity` included. On the `"failure"` arm only the _presence_ of
`error` is checked (`Object.hasOwn`), never its value, so a hostile `error`
getter is never invoked by a guard that never needed the answer.

## Compatibility with `core/script`

### Why this module cannot import `core/script`

`eslint.config.js` defines an ADR-0009 layering zone forbidding any `core/**`
module from importing `core/script` — it is the composition root. The rule is
`import-x/no-restricted-paths`, which is **not** type-aware, so even
`import type` is blocked, and `bin/check-eslint-zones.mjs` asserts the zone
exists. `cli-contract` therefore defines its types structurally and imports
nothing from `core/script`.

### Where ADR-0054's parity guarantee is actually enforced

ADR-0054 says the descriptor's `execute` composes `M3LScript`/`runScript` so an
in-process run behaves identically to a spawned one. That composition **cannot
live here** — this module cannot even name `M3LScript`. It lives in the
adopting script's entry file (U6) and the CLI's in-process host (U7), both of
which sit outside the zone and may import `core/script` freely.

To be plain about what the types do and do not carry: **nothing in this module
proves that a given `execute` composed `M3LScript`.** The parity guarantee is a
convention, enforced by `templates/script/`'s shape at U6, by
`check:script-scaffold`, and by the structural type tests in
`tests/cli-contract.test.ts` — which prove the _seams_ line up
(`M3LCommandModule` satisfies `M3LScriptMetadata`; `M3LCommandContext["logger"]`
is exactly what `M3LScriptOptions.logger` accepts) even though nothing can
prove the _composition_ happened.

### What U7 shipped

U6 landed the adopting-script half. A script that has adopted the seam carries
an **additive second entry point**, `src/command.ts`, exporting
`commandModule: Core.M3LCommandModule` whose `execute` constructs `M3LScript`
and calls `Core.runScript` itself. `check:script-scaffold` verifies an
adopted `src/command.ts` optionally-but-strictly (absent passes; present must
export the annotated descriptor, compose `Core.runScript`, source its schema
from `config.ts`, and never call `process.exit`); the manifest tier is
`OPTIONAL_EXACT_FILES` in `bin/lib/script-scaffold.mjs`.

Three consequences were deliberate at U6. U7 closes all three for the three
adopted pilots (`json-etl`, `sqs-etl`, `dynamodb-crud`) and the scaffold
template; the remaining thirteen-script fleet retrofit is a separate,
not-yet-started tracker item that inherits the same shape:

1. **`main.ts` now delegates to `execute`, retiring the second composition
   site.** Each pilot's `main.ts` builds an `M3LCommandContext` (via
   `createCommandOutput()` and `createCommandLogger` — both below) and calls
   `await commandModule.execute({}, context)`, then assigns
   `process.exitCode` from `mapCommandOutcomeToExitCode(outcome)` — a mapping
   that is redundant with, and confirms, the assignment `Core.runScript`
   already made inside `execute`. This was blocked at U6 because a
   caller-supplied logger forwarded into `M3LScriptOptions.logger` skipped
   `resolveLogLevelFloor()` (internal, unexported) and the script's own
   derived `secrets`; `createCommandLogger` (below) closes that gap by
   applying the same policy over host-supplied handlers, so `execute` passing
   `logger: context.logger` into `M3LScriptOptions.logger` is now safe. The
   per-script `tests/command.test.ts` remains the anti-drift guard.
2. **`context.logger` and `context.signal` are now forwarded** by all three
   pilots: `execute` passes `context.logger` straight into `M3LScript`'s
   `logger` option, and `context.signal` into the new
   `M3LScriptOptions.host.signal` seam (below) — conditionally, via
   `...(context.signal !== undefined ? { host: { signal: context.signal } } : {})`,
   so a caller with no signal to offer (every pilot's own `main.ts`, which
   has no in-process host yet) leaves `host` unset entirely rather than
   suppressing the script's own shutdown handlers for nothing.
   `context.output` is accepted by every pilot's `execute` but not forwarded
   anywhere — there is no `M3LScriptOptions.output` seam, and none of the
   three pilots render anything through `context.output` in their own run
   body. A future command that wants to report progress through the host's
   writer would call `context.output.info(...)` etc. directly; nothing here
   wires it into `M3LScript`.
3. **`TParameters` stays the default `Record<string, never>`, and no pilot
   binds parameters through the new seam yet.** `M3LScriptOptions.host.parameterValues`
   (below) exists and lets a caller bind already-resolved values at
   precedence level 1, replacing rather than layering over the ambient
   `process.argv` read — but the three pilots' `execute` still ignores its
   `_parameters` argument and lets configuration resolve ambiently, exactly
   as the spawn path does. Direct parameter binding is the CLI's in-process
   host's job (U7's next slice, not yet built) — once it exists, an adopting
   pilot widens its own `M3LCommandModule<TParameters>` generic and threads
   `parameters` into `host.parameterValues` individually.

### The host seam — `M3LScriptOptions.host`

Not part of `core/cli-contract` (an ADR-0009 zone forbids this module from
naming anything in `core/script`) — it lives on `M3LScriptOptions` itself,
documented here because it is the other half of what a hosted `execute` wires
up:

```typescript
interface M3LScriptOptions {
  // ...
  readonly host?: {
    readonly parameterValues?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  };
}
```

(The inner shape, `M3LScriptHostOptions`, is module-private — supplied inline,
like this file's existing `M3LScriptConfigDeclaration`.)

Supplying `host` at all — **even `{}`** — changes two behaviours
simultaneously:

1. **Signal ownership.** The script installs no `SIGTERM`/`SIGINT`/`SIGQUIT`
   listeners of its own; a hosted script that installed its own would tear
   down the host's _other_ work on the first Ctrl-C. When `host.signal` is
   supplied, an abort on it aborts the script's own `signal` (abort before
   cleanup, same order as the non-hosted shutdown path) instead.
2. **Parameter binding**, when `parameterValues` is present: bound at
   precedence level 1, _replacing_ the command-line provider rather than
   layering above it — the host's own `process.argv` must not leak into a
   hosted run's configuration. A value that came through this seam reports
   `config.sourceOf(name) === "cli"`, the same label the spawn path's
   command-line provider reports, so `run-report.json` cannot tell the two
   paths apart from provenance alone. `parameterValues` still passes through
   the same prototype-pollution screening every other config source does
   (`M3LUnsafeConfigKeyError` on a `__proto__`/`constructor`/`prototype` key).

`runScript`'s own `installProcessGuards`/`pushForcedSignalExitCode`
(`core/script/run-script.ts`) are untouched by `host` and stay inert for a
hosted script — they only affect the shutdown handlers `host` already
suppresses.

### A prerequisite for fleet-wide adoption — discharged

The three pilots used to each carry their own copy of the same four helpers —
`consoleOutput`, the abort predicate, the `onError` capture, and the outcome
mapper — because a `scripts/*` package may not import from a sibling script
(an ESLint path zone forbids it) and the library exported none of them.
Measured cost before this slice: `check:dup` at **3.23%** duplicated
TypeScript lines against a **4%** threshold, with thirteen more scripts
adopting the same shape projected to exceed it.

**U7a promotes all four** — `createCommandOutput` (output above),
`deriveCommandOutcome` (above; the abort predicate stays private, folded in),
and `captureRunFailures` (in `core/script`, documented on that page, since it
names `M3LScriptLifecycleHooks`, which this module cannot). The three pilots
and `templates/script/src/command.ts.tmpl` now consume the library versions
instead of their own copies, in the same PR. This unblocks — but does not
itself perform — the remaining thirteen-script fleet retrofit, which is its
own tracker item.

One further clause of ADR-0054 is worth stating plainly: `process.exit` is
forbidden in the command-module path, and the ban (`no-restricted-properties`
over every `scripts/*/src/**/*.ts`, plus a companion `no-restricted-imports`
entry for `import { exit } from "node:process"`) covers **script** code only.
It does not reach `runScript`'s own transitive behaviour:
`installProcessGuards` + `pushForcedSignalExitCode` install a signal handler
that calls `process.exit` on a second SIGINT/SIGTERM
(`internal/script/signalHandlers.ts`) — but only when the script is
**not** hosted (`M3LScriptOptions.host` is absent). A hosted command supplying
`host` therefore no longer installs that handler at all; the host owns what
happens on a second signal.

## Example

```typescript
import { Core } from "@m3l-automation/m3l-common";

interface ExportParameters {
  readonly bucket: string;
  readonly limit: number;
}

export const commandModule: Core.M3LCommandModule<ExportParameters> = {
  name: "s3-export",
  version: "1.0.0",
  description: "Exports a bucket listing to CSV.",
  configParameters,
  async execute(parameters, context) {
    if (context.dryRun) {
      context.output.info(`Would export ${parameters.bucket}.`);
      return { status: "dry-run" };
    }
    try {
      const { recovered } = await exportBucket(parameters, {
        signal: context.signal,
        logger: context.logger,
      });
      return recovered > 0
        ? { status: "partial", recovered }
        : { status: "success" };
    } catch (error: unknown) {
      return { status: "failure", error };
    }
  },
};
```

A host then runs it and exits with the same code the spawn path would have
produced:

```typescript
const outcome = await commandModule.execute(parameters, context);
process.exitCode = Core.mapCommandOutcomeToExitCode(outcome);
```

## Out of scope

- **The operation declaration (ADR-0055).** Lands in `core/config` at U4; the
  descriptor is widened then.
- **Name validation.** `name` is a bare `string`; reserved-name and slug rules
  live in `packages/m3l-cli` and importing them would invert ADR-0029.
- **The remaining thirteen-script fleet retrofit.** Unblocked by this slice's
  `check:dup` reduction (see [A prerequisite for fleet-wide
  adoption](#a-prerequisite-for-fleet-wide-adoption--discharged)), but not
  performed here — it is its own tracker item.

`packages/m3l-cli` now does call all of this: locating a script's
`dist/command.js`, dynamically importing it, building the context, and
wiring a `--in-process` flag are shipped — see `docs/reference/cli.md`
§ Design invariants ("Dependency-graph discovery, filesystem fallback") and
`#### m3l <script> [--param value ...] [-- args...]`.

## See also

- ADR-0054 — the typed command-module contract and hybrid execution.
- ADR-0029 — consumer scripts depend only on `@m3l-automation/m3l-common`.
- ADR-0049 — the cooperative cancellation contract.
- ADR-0035 — the exit-code registry this module reuses.
- `docs/reference/core/diagnostics.md` — `M3L_EXIT_CODES`, `mapErrorToExitCode`.
- `docs/reference/core/script.md` — `M3LScript`, `M3LScriptMetadata`.
- `docs/reference/core/config.md` — `M3LConfigParameter`.
