# Core: `orchestration`

Address a prior step's output from a later step: a parser, formatter and resolver for step-output references, plus typed value bindings.

## Overview

The `orchestration` module owns the convention a multi-step run uses to refer to an earlier step's result. A reference is a short string — `step-2.output.records[0].id` — that parses into a typed `M3LStepReference`, formats back to the same string, and resolves against a supplied value to yield whatever it addresses. `M3LStepBinding` pairs a reference with the value shape a consumer expects, and `validateBindingValue` checks a resolved value against that expectation.

The module is deliberately host-agnostic: it performs no I/O, knows nothing about queues, sessions, flows or processes, and never decides what a step's output _is_ — the caller supplies that. Two consumers use it today. `m3l-console-server`'s workbench sessions resolve references against a stored step result (ADR-0068, which defines this convention). The `m3l` CLI's flow engine resolves them against a step's structured run envelope (ADR-0056). Both walk the same grammar with the same guard.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- `M3LStepReference`
- `M3LStepReferenceSegment`
- `parseStepReference`
- `formatStepReference`
- `resolveStepReference`
- `M3LStepReferenceError`
- `M3LBindingExpectedType`
- `M3LStepBinding`
- `validateBindingValue`

## The reference grammar

```text
step-<ordinal>.output( .<ident> | [<index>] | ["<quoted>"] )*
```

- **`<ordinal>`** is **1-based** and matches `[1-9][0-9]*` — `step-1` is the first step. A leading zero is rejected.
- **`.output`** is mandatory and is the only addressable root. A step's output is the one thing a later step may read.
- **`.<ident>`** selects a property. An identifier matches `[A-Za-z_$][A-Za-z0-9_$]*` and may not start with a digit.
- **`[<index>]`** selects an array element and is **0-based**. A leading zero is rejected except for a bare `0`.
- **`["<quoted>"]`** selects a property whose name is not a legal identifier. Inside the quotes, `\"` and `\\` are the only legal escapes; any other backslash sequence is rejected, as is an unterminated quote.

Both digit runs — the ordinal and any index — are capped at 15 characters, so a reference cannot smuggle in a value that loses integer precision.

Parsing is all-or-nothing. Trailing garbage after an otherwise valid reference is rejected outright rather than silently truncated, so a typo cannot resolve to a shorter reference than the author wrote.

```typescript
import { Core } from "@m3l-automation/m3l-common";

const reference = Core.parseStepReference(
  'step-2.output.rows[0]["total count"]',
);

Core.formatStepReference(reference); // 'step-2.output.rows[0]["total count"]'

Core.resolveStepReference(reference, {
  rows: [{ "total count": 42 }],
}); // 42
```

`formatStepReference` **canonicalizes**: it is stable, not byte-preserving. A parsed reference always formats to text the parser accepts and re-parses to an equal reference — `parse(format(parse(s)))` equals `parse(s)` for every `s` the parser accepts — but the emitted text is the canonical spelling, which is not always the input spelling. A bracket-quoted key that happens to be a legal identifier comes back in dot form:

```typescript
Core.formatStepReference(Core.parseStepReference('step-1.output["messages"]'));
// "step-1.output.messages"      — canonical dot form

Core.formatStepReference(
  Core.parseStepReference('step-1.output["total count"]'),
);
// 'step-1.output["total count"]' — unchanged; the name is not a legal identifier
```

Both directions enforce the _same_ rules — the formatter applies the parser's dangerous-name screen, digit-run cap and safe-integer check, so it cannot produce text the parser would reject. A reference therefore survives storage without ever drifting in meaning, but compare references by parsing them rather than by comparing their text.

## Typed bindings

A binding records what a consumer expects to find at a reference, so a resolved value can be checked before it is used:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const binding: Core.M3LStepBinding = {
  reference: Core.parseStepReference("step-1.output.queueUrl"),
  expectedType: "string",
  multiSelect: false,
};

const value = Core.resolveStepReference(binding.reference, stepOutput);

if (!Core.validateBindingValue(value, binding)) {
  // the step produced something other than the single string expected
}
```

`M3LBindingExpectedType` is `"string" | "number" | "boolean" | "object"`. When `multiSelect` is `true`, the binding expects an array in which **every** element satisfies `expectedType`; when it is `false`, it expects a single value of that type. `validateBindingValue` returns a boolean and never throws — it is a predicate, not a guard.

## The prototype-pollution guard

Property names are screened with [`isDangerousKey`](./security.md) — `__proto__`, `constructor` and `prototype` are rejected — and the screen runs at **two** independent levels:

1. **At parse time**, so a dangerous reference cannot be constructed from a string at all.
2. **At walk time**, inside `resolveStepReference`, immediately before any property access — so a reference assembled programmatically rather than parsed is screened too.

A third screen runs in `formatStepReference`, so the formatter cannot emit text its own parser would reject.

The extra checks are not redundant. `M3LStepReference` is a plain data shape, so a caller can build one by hand or deserialize one from storage without ever passing through the parser; without the walk-time screen, that path would reach a property access unguarded.

Two subtleties the screens exist to close, both of which are only reachable from an in-process object rather than from JSON:

- **The segment name is read once, into a local, and the guard applies to that local.** Reading `segment.name` separately for the guard and for the access would let a getter return a safe name to the guard and a dangerous one to the access.
- **An index segment must be an actual safe non-negative integer before it is used.** JavaScript coerces a property key with `toString`, not `valueOf`, so an object index that reports `0` to a bounds check can still key the array by name and reach `Array.prototype`.

All three levels fail closed by throwing.

## Errors

`parseStepReference`, `formatStepReference` and `resolveStepReference` throw `M3LStepReferenceError` — an `M3LError` subclass whose `code` is pinned to `"ERR_STEP_REFERENCE_INVALID"` — for a malformed reference, a rejected property name, a resolution that does not match the supplied value's shape, or an argument of the wrong type. All three narrow their arguments, so a wrong-typed argument raises this typed error rather than a bare `TypeError`; a host that maps this code to a client error keeps doing so instead of reporting a server fault.

`validateBindingValue` never throws, and always returns a `boolean`. An `expectedType` outside the documented union — reachable from a JavaScript caller or a deserialized definition, where the compile-time union cannot help — returns `false` rather than accepting the value.

## Notes and behavior

- Pure and synchronous: no I/O, no clock, no environment reads.
- `resolveStepReference` treats a shape mismatch as an error, not as `undefined`: reading a property off a non-object, or an index off a non-array, throws rather than resolving to nothing. A silent `undefined` here would let a later step consume a value that was never produced.
- `validateBindingValue` rejects a sparse array under `multiSelect`. `Array.prototype.every` skips holes, so a hole would otherwise satisfy any expected type vacuously.
- A property getter that throws is surfaced with its cause chained, never swallowed.
- Ordinals are 1-based and array indices are 0-based. This is deliberate — the ordinal is a human-facing step number, the index is an ordinary array offset — and it is the single most common authoring mistake.
- The module does not resolve a step ordinal to a step. Mapping `step-2` onto an actual step's output is the caller's job, because only the caller knows what a step is.

## See also

- [security](./security.md) — the shared prototype-pollution guard
- [json](./json.md) — dot-notation field paths over arbitrary JSON
- [cli-contract](./cli-contract.md) — the host/script seam a flow step runs through
- [errors](./errors.md) — the `M3LError` hierarchy and code vocabulary
- [Architecture overview](../../m3l-common-architecture.md)
