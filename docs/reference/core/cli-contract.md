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

ADR-0072 slice record. One slice; no further slicing was needed.

| Slice             | Scope                                                                               | Status |
| ----------------- | ----------------------------------------------------------------------------------- | ------ |
| U3 — the contract | The descriptor types, the outcome→exit-code mapper, and the output port. 5 exports. | Landed |

Deliberately **not** in this slice, and why:

- **ADR-0055's operation declaration.** The declarative, enumerable operations
  field lands in `core/config` at U4; the descriptor is widened then, as a
  second additive minor. No placeholder type ships here.
- **The `M3LScript`/`runScript` composition.** See
  [Compatibility with `core/script`](#compatibility-with-corescript) — an
  ADR-0009 layering zone puts it out of reach, so it lands in the adopting
  script (U6) and the CLI's in-process host (U7).
- **Fleet adoption** (U6) and **the CLI's in-process execution path** (U7).

This slice takes Core from 23 to 24 submodules (fleet total 42 → 43). ADR-0054,
`docs/ROADMAP.md`, and `docs/plans/IMPLEMENTATION.md` all originally recorded
"22 → 23"; that was authored on 2026-08-20, one day before `core/procedure`
landed and consumed 22 → 23. The tracker rows are corrected in the same PR.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols — five, grouped by ADR-0054's three bullets:

- `M3LCommandModule<TParameters>` — the descriptor a script exports.
- `M3LCommandContext` — the port bag a host supplies to `execute`.
- `M3LCommandOutcome` — the discriminated result `execute` resolves to.
- `mapCommandOutcomeToExitCode` — outcome → process exit code.
- `M3LCommandOutput` — the operator-facing writer port.

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

`M3LCommandOutput` is the promoted shape of the CLI's own `M3LCliOutput`: a
hosted command renders operator-facing text through it, so output routes via
the host's TTY / `NO_COLOR` / redaction handling rather than raw
`process.stdout`.

The two shapes agree today by construction, but nothing yet _enforces_ that
they stay in agreement — `m3l-cli` keeps its own private copy. At U7 the CLI
should alias this type rather than keep a second declaration; if U7 slips, the
drift lock belongs in `packages/m3l-cli/tests` (the CLI may import
`m3l-common`, and the reverse would invert ADR-0029).

**What stays CLI-private.** The rendering half — `createOutput`,
`resolveColorEnabled`, `sanitizeTerminalText`, and the options bag — remains in
`packages/m3l-cli`, per ADR-0054's "output rendering stays CLI-private".

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

### What U6 shipped, and what it deliberately did not

U6 landed the adopting-script half. A script that has adopted the seam carries
an **additive second entry point**, `src/command.ts`, exporting
`commandModule: Core.M3LCommandModule` whose `execute` constructs `M3LScript`
and calls `Core.runScript` itself. `src/main.ts` is left exactly as it was, so
the spawn path has zero behaviour change. `check:script-scaffold` verifies an
adopted `src/command.ts` optionally-but-strictly (absent passes; present must
export the annotated descriptor, compose `Core.runScript`, source its schema
from `config.ts`, and never call `process.exit`); the manifest tier is
`OPTIONAL_EXACT_FILES` in `bin/lib/script-scaffold.mjs`.

Three consequences are deliberate at U6 and are U7's inheritance. They are
recorded here rather than in ADR-0054, which is `Accepted` and therefore
immutable:

1. **`main.ts` does not delegate to `execute`, so two composition sites exist.**
   Delegating would force `main.ts` to build an `M3LCommandContext`, and
   `execute` to forward `context.logger` into `M3LScriptOptions.logger`. That
   option documents a caller-supplied logger as skipping
   `resolveLogLevelFloor()` — which lives in `internal/logging/` and is not
   exported, so a script cannot replicate it, and `--log-level` /
   `M3L_LOG_LEVEL` would silently stop working — and as never receiving the
   script's derived `secrets`, so declared secret parameters would stop being
   redacted. That is a behavioural **and** security regression on the spawn
   path, which is why the two sites stand until U7 unifies them behind a
   library seam. The per-script `tests/command.test.ts` is the anti-drift
   guard in the meantime.
2. **`context.output`, `context.logger` and `context.signal` are accepted and
   not forwarded.** `execute` consumes only `context.dryRun`. A U7 host must
   build its logger with the script's derived `secrets` and the resolved
   log-level floor, and must expect that aborting its own signal has no effect
   on a U6-era command (a script that threads cancellation does so from its own
   `script.signal`).
3. **`TParameters` stays the default `Record<string, never>`.**
   `M3LScriptOptions` has no seam to inject host-bound values — precedence
   level 1 is built from `process.argv` inside the loader, and only
   `preset`/`configFiles`/Lambda-event providers are injectable — so
   configuration still resolves ambiently through the library's own precedence
   chain on both paths. Real parameter binding needs an additive `m3l-common`
   minor.

### A prerequisite for fleet-wide adoption

The three pilots each carry their own copy of the same four helpers —
`consoleOutput`, the abort predicate, the `onError` capture, and the
outcome mapper — because a `scripts/*` package may not import from a sibling
script (an ESLint path zone forbids it) and the library exports none of them.
Measured cost: `check:dup` moved from **2.80%** to **3.23%** duplicated
TypeScript lines against a **4%** threshold, so three pilots consumed roughly
a third of the headroom. Thirteen more scripts adopting the same shape would
exceed the threshold.

So the remaining fleet retrofit is **gated on promoting those helpers into
`core/cli-contract`** (an additive minor: an outcome-deriving seam plus a
default `M3LCommandOutput`), not merely on repeating the pilots' diff. This
is the same reasoning `.claude/rules/scripts.md` applies to any capability the
library lacks — it becomes a typed library wrapper first (the ADR-0027
pattern), never sixteen hand-rolled copies.

One further clause of ADR-0054 is worth stating plainly, because U6 is where
its ESLint ban lands: `process.exit` is forbidden in the command-module path,
and the ban (`no-restricted-properties` over every `scripts/*/src/**/*.ts`,
plus a companion `no-restricted-imports` entry for
`import { exit } from "node:process"`) covers **script** code only. It does not
reach `runScript`'s own transitive behaviour: `installProcessGuards` +
`pushForcedSignalExitCode` install a signal handler that calls `process.exit`
on a second SIGINT/SIGTERM (`internal/script/signalHandlers.ts`). A hosted
command therefore still terminates its host on a double signal. Closing that is
a U7 host obligation, not something a script can do.

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
- **Re-narrowing the awaited outcome.** A host that dynamically imports a
  foreign `dist/` cannot trust that `execute` resolved to a real
  `M3LCommandOutcome` — no structural check over a returned promise can prove
  it. The host must narrow at the call site (a U7 obligation); if it does not,
  the failure mode is a bare `TypeError` crossing the public boundary.
- **The output stream shape.** No `M3LCommandOutputStream` ships here. Its only
  consumer is U7's stream binder, and one speculative consumer is the same
  argument that defers the descriptor guard below. It lands with that binder,
  as a second additive minor.
- **Descriptor validation.** No `isM3LCommandModule` guard ships here. U7's
  loader is its first real consumer, and it lands then rather than being
  promoted speculatively.
- **Name validation.** `name` is a bare `string`; reserved-name and slug rules
  live in `packages/m3l-cli` and importing them would invert ADR-0029.
- **Fleet adoption** (U6) and **the in-process execution path** (U7).

## See also

- ADR-0054 — the typed command-module contract and hybrid execution.
- ADR-0029 — consumer scripts depend only on `@m3l-automation/m3l-common`.
- ADR-0049 — the cooperative cancellation contract.
- ADR-0035 — the exit-code registry this module reuses.
- `docs/reference/core/diagnostics.md` — `M3L_EXIT_CODES`, `mapErrorToExitCode`.
- `docs/reference/core/script.md` — `M3LScript`, `M3LScriptMetadata`.
- `docs/reference/core/config.md` — `M3LConfigParameter`.
