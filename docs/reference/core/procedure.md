# Core: `procedure`

A codified-procedure engine: a multi-step procedure whose control flow and
conclusions are **data rather than hand-written branching**. A script declares
steps, a prioritised list of named cases with declarative conditions, and a
mandatory fallback; `M3LProcedure` executes the steps, decides which case the
gathered evidence matches, and reports _why_.

## Overview

A script that gathers evidence across several queries, decides what to do next
from what it found, and terminates with a named conclusion has to write all of
that as bespoke branching inside its `steps/` modules — where the conclusion is
not inspectable, not testable in isolation, and not reportable. This engine makes
the control flow and the conclusion into declared data: a step returns a flow
directive the **engine** interprets, and a conclusion is a case with an
operator-facing prose field and a serialisable condition.

The engine opens the gate recorded in
[ADR-0046](../../adr/0046-codified-procedure-engine.md): it is built against a
named consumer, the `cloudwatch-logs-analysis` script.

### `procedure` is not `pipeline`

[`core/pipeline`](./pipeline.md) and `core/procedure` address different shapes
and deliberately coexist. The vocabularies do not overlap and must not drift:

|                   | `core/pipeline`                                      | `core/procedure`                                              |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Unit of work      | **phase** — a fixed, engine-owned sequence of eleven | **step** — a caller-declared, ordered list of any length      |
| Selection         | **operation** — one handler per operation, keyed     | **case** — a prioritised list matched against evidence        |
| Control flow      | none; the phase order is fixed                       | a step returns a **flow directive** the engine interprets     |
| Accumulated state | none between phases beyond `prepare`'s context       | an immutable, copy-on-write **context**                       |
| Conclusion        | `{ operation, status, result }`                      | a discriminated **outcome** carrying the matched case and why |

Use `M3LOperationPipeline` for "one of N operations, always the same run
skeleton". Use `M3LProcedure` for "gather evidence, then conclude".

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- Shape: `M3LProcedureShape`, `M3LProcedureValue`, `M3LProcedureScalar`,
  `M3LProcedureValueMap`
- Engine: `M3LProcedure`, `M3LProcedureSummary`
- Builder: `createProcedureBuilder`, `M3LProcedureBuilder`,
  `M3LProcedureBuildOptions`
- Steps: `M3LProcedureStep`, `M3LProcedureStepKind`, `M3LProcedureStepResult`,
  `M3LProcedureStepRecord`, `M3LProcedureFlow`, `M3LProcedureLoop`
- Context: `M3LProcedureContext`
- Conditions: `M3LProcedureCondition`, `M3LProcedureConditionKind`,
  `M3LProcedureCompareOperator`, `M3LProcedurePath`, `M3LProcedureReference`,
  `M3LProcedureConditionScope`, `M3LProcedureConditionEvaluation`,
  `M3LProcedureResolvedReference`, `evaluateProcedureCondition`
- Cases: `M3LProcedureCase`, `M3LProcedureFallback`,
  `M3LProcedureCaseEvaluation`, `M3LProcedureCaseMatch`
- Run: `M3LProcedureRunOptions`, `M3LProcedureProgressOptions`,
  `M3LProcedureProgressWitness`
- Outcome: `M3LProcedureOutcome`, `M3LProcedureOutcomeBase`,
  `M3LProcedureTelemetry`
- Tracing: `M3LProcedureTraceOptions`, `M3LProcedureTraceSink`,
  `M3LProcedureTraceEntry`
- Validation: `M3LProcedureValidationProblem`, `M3LProcedureProblemCode`
- Limits: `M3L_PROCEDURE_MAX_ITERATIONS`,
  `M3L_PROCEDURE_CONDITION_MAX_DEPTH`, `M3L_PROCEDURE_MAX_PATTERN_LENGTH`,
  `M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH`

No error class is exported: callers narrow on `instanceof M3LError` plus the
machine-readable `code`, never on a subclass identity — the same rule
[`core/pipeline`](./pipeline.md) follows. See
[Errors](#errors) for which code is thrown where.

## The procedure shape

Every type in this module is parameterised by **one** caller-declared interface.
Threading six positional generics through nine exported types would be
unusable; a single shape bundle keeps each signature to one type argument and
gives the compiler enough to reject a typo'd step id or value key outright.

```typescript
interface M3LProcedureShape {
  /** The injected dependency bag. The engine never reads a property of it. */
  readonly deps: unknown;
  /** The extracted-value map; its keys are what a `value` reference may name. */
  readonly values: M3LProcedureValueMap;
  /** The resolved parameters; its keys are what a `parameter` reference may name. */
  readonly parameters: M3LProcedureValueMap;
  /** What a case action and the fallback action produce. */
  readonly conclusion: unknown;
  /** The closed step-id union. */
  readonly stepId: string;
  /** The closed case-id union. */
  readonly caseId: string;
}
```

A consumer declares it once:

```typescript
interface LogAnalysis extends Core.M3LProcedureShape {
  deps: { readonly logs: M3LLogsInsightsClient; readonly prompt: M3LPrompt };
  values: { errorCount: number; topMessage: string };
  parameters: { logGroup: string; errorThreshold: number };
  conclusion: void;
  stepId: "count-errors" | "sample-traces" | "confirm";
  caseId: "error-spike" | "throttled" | "healthy";
}
```

`deps` is **opaque**: the engine passes it through and never reads a property.
That is what keeps this module prompt-agnostic — a `decide` step reaches
`Core.M3LPrompt` as `context.deps.prompt`, and `core/procedure` does not import
`core/prompt`.

## Values and references

Everything a condition can address is a **serialisable value**. That constraint
is what makes conditions traceable, statically checkable and explainable, and it
is why step outputs are constrained rather than generic:

```typescript
type M3LProcedureScalar = string | number | boolean | null;

type M3LProcedureValue =
  | M3LProcedureScalar
  | readonly M3LProcedureValue[]
  | { readonly [key: string]: M3LProcedureValue };

type M3LProcedureValueMap = Readonly<Record<string, M3LProcedureValue>>;
```

A non-serialisable handle — an SDK client, a logger, an `M3LPrompt` — is **not**
a step output. It belongs in `context.deps`, which is opaque to conditions and
never traced or hashed.

`M3LProcedureValue` admits `NaN` and `Infinity`, which TypeScript cannot
exclude but [`canonicalJsonHash`](./json.md) rejects with
`ERR_INVALID_ARGUMENT`. The engine therefore never hashes a step output — only
the **definition** and the **parameters** are hashed, and `parameters` are
validated for finiteness when `run()` is called, under
`ERR_PROCEDURE_INVALID_OPTION`. A non-finite number inside a step output is
carried, compared and reported without a problem; it simply never reaches a
digest.

A **reference** addresses one of the four things a condition may read. It is a
value object, not a parsed string: nothing is parsed at run time, a typo is a
compile error, and a dangling step reference is a build-time problem.

```typescript
/** A path into a nested value. Non-empty; array indices are decimal strings. */
type M3LProcedurePath = readonly [string, ...(readonly string[])];

type M3LProcedureReference<TShape extends M3LProcedureShape> =
  | {
      readonly source: "step";
      readonly step: TShape["stepId"];
      readonly path?: M3LProcedurePath;
    }
  | {
      readonly source: "value";
      readonly key: keyof TShape["values"] & string;
      readonly path?: M3LProcedurePath;
    }
  | {
      readonly source: "parameter";
      readonly key: keyof TShape["parameters"] & string;
      readonly path?: M3LProcedurePath;
    }
  | { readonly source: "literal"; readonly literal: M3LProcedureScalar };
```

Three things carry the type-safety weight: `source` is the discriminant, so the
arms are mutually exclusive by construction; `step: TShape["stepId"]` and
`key: keyof TShape["values"] & string` make a reference to something that does
not exist a **compile** error; and the `literal` arm makes `compare` symmetric —
both sides are references — so the evaluator resolves and reports both sides
uniformly, which is what makes the explanation readable.

`path` walks into an object or array (`["items", "0", "count"]`), and every
segment is bounded by exactly these rules:

- Only an **own enumerable** property resolves. A `__proto__`, `constructor` or
  `prototype` segment never resolves, and neither does an inherited property.
- An array resolves a segment only when it is a **canonical decimal index**
  (`"0"`, `"12"` — not `"01"`, `"-1"`, `"1.0"`) that is in range. `"length"`
  does **not** resolve: it is array metadata, not data.
- A **string** value resolves no segment at all. `["0"]` against `"abc"` is
  `undefined`, not `"a"` — a string is a scalar here, and indexing into one
  would make `exists` answer differently for a string than for a number.
- Walking stops at the first unresolved segment.

A path that does not resolve yields `undefined`, which is exactly what `exists`
tests and what makes `compare` against a missing value evaluate `false` rather
than throw. Path depth is bounded by `M3L_PROCEDURE_CONDITION_MAX_DEPTH`.

## Steps

```typescript
type M3LProcedureStepKind =
  | "gather" // acquires evidence from outside the procedure
  | "transform" // derives values from evidence already gathered
  | "check" // asserts something about the evidence
  | "decide" // chooses a path, possibly by asking the operator
  | "control"; // manipulates flow only

interface M3LProcedureLoop {
  /** Why this repetition is deliberate. Recorded in the definition digest. */
  readonly reason: string;
  /** Extra executions permitted beyond the first. Finite integer > 0. */
  readonly maxRevisits: number;
}

interface M3LProcedureStep<
  TShape extends M3LProcedureShape,
  TId extends TShape["stepId"],
  TJump extends TShape["stepId"] = never,
> {
  readonly id: TId;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  /**
   * Every step id this step's `execute` may return as a `{ goTo }` target.
   * Declared, not inferred: `goTo` is a value a function body returns, so the
   * jump graph is not statically knowable without this. It is load-bearing
   * twice — it is what makes build-time cycle detection possible at all, and
   * `TJump` is inferred from it, so `execute` cannot return a `goTo` this
   * array does not name.
   */
  readonly jumpsTo?: readonly TJump[];
  /**
   * Acknowledges that this step's jump edges are deliberate back edges. Edges
   * out of a step carrying `loop` are excluded from cycle detection; the
   * engine enforces `maxRevisits` at run time instead.
   */
  readonly loop?: M3LProcedureLoop;
  /** Absorb a throw from `execute` into a recovery entry and advance. */
  readonly continueOnFailure?: boolean;
  readonly execute: (
    context: M3LProcedureContext<TShape>,
  ) =>
    | M3LProcedureStepResult<TShape, TJump>
    | Promise<M3LProcedureStepResult<TShape, TJump>>;
  /**
   * Called **before** `execute`, with the context `execute` is about to
   * receive — so what reaches the trace is the *resolved* value the step
   * actually used (the final query, the evaluated window), not the
   * declaration it came from. Return type is pinned to the allowlisted
   * breadcrumb scalars and enforced again at run time.
   */
  readonly describeTrace?: (
    context: M3LProcedureContext<TShape>,
  ) => Readonly<Record<string, M3LBreadcrumbScalar>>;
}

/** The patch a step returns. A step never returns a context — see Context. */
interface M3LProcedureStepResult<
  TShape extends M3LProcedureShape,
  TJump extends TShape["stepId"] = never,
> {
  readonly flow: M3LProcedureFlow<TJump>;
  /** Recorded under this step's id; addressable by a `step` reference. */
  readonly output?: M3LProcedureValue;
  /** Merged into the next context's `values`. Absent keys are untouched. */
  readonly values?: Readonly<Partial<TShape["values"]>>;
  /** A short, non-secret operator note recorded on the step record. */
  readonly note?: string;
}
```

The `kind` is a declaration, not a capability grant: the engine does not treat
kinds differently. It exists so a trace and an operator report can say what a
step _was for_.

### Flow directives

```typescript
/**
 * @typeParam TJump - The step's own declared `jumpsTo` targets. Defaults to
 *   `never`, so a step that declares no jumps cannot construct a `goTo` arm at
 *   all: `{ readonly goTo: never }` is uninhabited.
 */
type M3LProcedureFlow<TJump extends string = never> =
  "continue" | "stop" | "resolve" | { readonly goTo: TJump };
```

The **engine**, never the step, interprets a directive:

- `"continue"` — run the next step in declaration order.
- `"stop"` — stop executing steps and go straight to case evaluation.
- `"resolve"` — _"there may be enough evidence now; check."_ The engine
  evaluates **every** case immediately. On a match the run terminates early and
  the remaining (typically expensive) steps never execute. On no match the run
  continues exactly as if `"continue"` had been returned. This is what keeps the
  matching condition written **once**, in the case, instead of duplicated as a
  step-level branch.
- `{ goTo }` — jump to that step. Existence is a compile error to get wrong and
  acyclicity is a build-time problem, so a jump cannot fail at run time from
  typed TypeScript. An untyped caller that returns a target outside `jumpsTo`
  gets `ERR_PROCEDURE_UNDECLARED_JUMP`.

## Context

The context is immutable and copy-on-write: a step receives one and the
**engine** derives the next from the step's returned patch.

```typescript
interface M3LProcedureContext<TShape extends M3LProcedureShape> {
  /** The injected dependency bag. The same reference for the whole run. */
  readonly deps: TShape["deps"];
  /** The latest record per step id. `Partial` — mid-run, most are absent. */
  readonly results: Readonly<
    Partial<Record<TShape["stepId"], M3LProcedureStepRecord>>
  >;
  readonly values: Readonly<Partial<TShape["values"]>>;
  readonly parameters: Readonly<TShape["parameters"]>;
  /** Failures absorbed by `continueOnFailure`, capped at `M3L_RECOVERY_LIMIT`. */
  readonly recovered: readonly M3LRunRecoveryEntry[];
  /** The true count of absorbed failures, even when `recovered` was capped. */
  readonly recoveredTotal: number;
  /**
   * The cooperative cancellation signal (ADR-0049), or `undefined`.
   * Deliberately a required property holding `undefined` rather than an
   * optional one: under `exactOptionalPropertyTypes` an optional key lets a
   * caller-side helper forget the field exists, while a required
   * `AbortSignal | undefined` forces the narrow.
   */
  readonly signal: AbortSignal | undefined;
  /** Count of step executions completed before this one. */
  readonly iteration: number;
}

interface M3LProcedureStepRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  readonly status: "succeeded" | "recovered";
  /** 1-based; increments when a `goTo` revisits this step. */
  readonly attempt: number;
  readonly output: M3LProcedureValue | undefined;
  readonly note: string | undefined;
  readonly durationMs: number;
}
```

**How copy-on-write is expressed, not merely documented.** A step returns a
_patch_, never a context. No constructor, factory or `with*` method for
`M3LProcedureContext` exists in the public surface; the only producers are
private, and both freeze their result. So a step cannot mutate the context
(every field `readonly`, the object frozen), and cannot forge or replay one
(it has no way to make one). The engine derives the next context at exactly one
call site.

The rejected alternative — `execute: (ctx) => { context, flow }` — is the shape
that _looks_ like copy-on-write and is not: a step could return a stale context
captured from an earlier call, silently rolling back the run's evidence, and the
type system could not see it.

On a **revisit** (via `{ goTo }`), the step's `results` entry is **overwritten**
and its `attempt` incremented; `values` keys the step patches are overwritten
while keys it omits are untouched. `telemetry.steps` keeps every execution, so
nothing about the earlier pass is lost — only `context.results` is
latest-wins, because a condition asking "what did `count-errors` find" means the
most recent answer.

## Conditions

Conditions are **serialisable value objects, not predicate functions**. That is
the point: a predicate cannot be traced, statically checked, or explained.

```typescript
type M3LProcedureCompareOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";

type M3LProcedureConditionKind =
  "compare" | "matches" | "contains" | "exists" | "and" | "or" | "not";

type M3LProcedureCondition<TShape extends M3LProcedureShape> =
  | {
      readonly kind: "compare";
      readonly left: M3LProcedureReference<TShape>;
      readonly operator: M3LProcedureCompareOperator;
      readonly right: M3LProcedureReference<TShape>;
    }
  | {
      readonly kind: "matches";
      readonly subject: M3LProcedureReference<TShape>;
      readonly pattern: string;
      readonly ignoreCase?: boolean;
    }
  | {
      readonly kind: "contains";
      readonly subject: M3LProcedureReference<TShape>;
      readonly item: M3LProcedureReference<TShape>;
    }
  | { readonly kind: "exists"; readonly subject: M3LProcedureReference<TShape> }
  | {
      readonly kind: "and";
      readonly operands: readonly [
        M3LProcedureCondition<TShape>,
        ...M3LProcedureCondition<TShape>[],
      ];
    }
  | {
      readonly kind: "or";
      readonly operands: readonly [
        M3LProcedureCondition<TShape>,
        ...M3LProcedureCondition<TShape>[],
      ];
    }
  | { readonly kind: "not"; readonly operand: M3LProcedureCondition<TShape> };
```

The non-empty tuple on `and`/`or` makes a **vacuous connective
unrepresentable**. `{ kind: "and", operands: [] }` would evaluate `true` and
silently match a case that checked nothing — the same class of defect
[`core/analysis`](./analysis.md)'s `M3LThresholdVerdict` `"no-rules"` arm exists
to close.

Arm semantics — every arm is **total**: it returns a boolean for any resolved
values and never throws, never coerces.

- **`compare`** — `==`/`!=` compare by deep structural equality (below).
  `>`/`>=`/`<`/`<=` require **both** sides to resolve to a `number`; any other
  pair is `false`. A `NaN` on either side is `false` for every operator
  including `==`, matching IEEE-754 rather than `Object.is`.
- **`matches`** — the subject must resolve to a `string`; anything else is
  `false`. See [Pattern safety](#pattern-safety).
- **`contains`** — an array subject tests membership by deep structural
  equality. A string subject tests substring containment, and the item must
  resolve to a string. Any other pair is `false`.
- **`exists`** — `true` when the reference resolves to anything other than
  `undefined`. `null` **exists**; a missing key does not.
- **`and` / `or` / `not`** — `and` is `true` when every operand is; `or` when
  any is.

### Deep structural equality

Used by `==`, `!=` and array `contains`. Two values are equal when, and only
when, one of the following holds:

- Both are the same scalar, compared with `Object.is` — **except** that `NaN`
  is never equal to anything (including another `NaN`), and `+0` and `-0` **are**
  equal. Both departures from `Object.is` are deliberate: `NaN` follows
  IEEE-754, which is what a numeric condition should mean, and `±0` follows
  `canonicalJsonStringify`, which renders both as `0`.
- Both are arrays of the same length whose elements are pairwise equal **in
  order** — array order **is** significant.
- Both are objects with the same set of own enumerable string keys whose values
  are pairwise equal — object key order is **not** significant. A key present
  with value `null` is **not** equal to an absent key.

Nothing else is equal — a scalar never equals a container, and an array never
equals an object. Comparison is depth-bounded by
`M3L_PROCEDURE_CONDITION_MAX_DEPTH`; beyond it the comparison yields `false`
rather than recursing. `M3LProcedureValue` is a recursive type, so a caller
_can_ build a self-referential value; that bound is what keeps it from
overflowing the stack.

### Pattern safety

`matches` is string-only over bounded input, per
[ADR-0039](../../adr/0039-llm-integration-out-of-scope.md) and the style guide's
_Parsing untrusted text_ rule. `pattern` is a pattern **source string**, never a
`RegExp`, so the condition stays canonical-JSON serialisable for the digest.
Four enforced properties:

1. The pattern is **authored code**, never assembled from evidence. Nothing the
   engine resolves ever enters a pattern source.
2. It is validated at **build time**, so a malformed pattern is never a run
   failure halfway through a set of real remote queries. A pattern longer than
   `M3L_PROCEDURE_MAX_PATTERN_LENGTH` (512), one `new RegExp` rejects, or one
   containing a **quantified group** — a `)` that closes a group and is followed
   by `+`, `*`, `?` or `{` — is a build-time problem under
   `ERR_PROCEDURE_INVALID_PATTERN`. An escaped `\)` and a `)` inside a character
   class are not group closers and are skipped by the scan.
3. That is a **blanket** structural rule, deliberately stricter than "no nested
   quantifier". It also rejects patterns that are individually safe, such as
   `(?:abc)+`. The trade-off is accepted because the precise rule — "no
   quantified group whose body can match the same text two ways" — cannot be
   checked reliably, and a rule that is implemented differently by two readers
   is not a guarantee. Every legitimate need has a rewrite: a character class
   (`[a-z]+` rather than `(?:[a-z])+`), or composition with `contains` and
   `and`/`or`.
4. The **subject** is untrusted and therefore bounded: a resolved string longer
   than `M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH` (8192) is **refused, not
   scanned** — the arm evaluates `false` and the resolved reference is marked
   `oversized`, so "no match" is never silently indistinguishable from "not
   checked". Patterns are compiled once at `build()`, never with the `g` or `y`
   flag, so no `lastIndex` state carries between cases or between runs.

### Explainability

The evaluator returns the resolved values alongside the boolean. This is what
lets a run report _why_ it concluded what it did, without re-running anything.

```typescript
interface M3LProcedureResolvedReference {
  /** Canonical rendering, e.g. `"step:count-errors.count"`, `"literal:5"`. */
  readonly reference: string;
  /** `false` when the reference addressed something absent. */
  readonly present: boolean;
  readonly resolved: M3LProcedureValue | undefined;
  /** Set when a string was refused for exceeding the `matches` input bound. */
  readonly oversized?: true;
}

/** A tree mirroring the condition tree, one node per node. */
interface M3LProcedureConditionEvaluation {
  readonly kind: M3LProcedureConditionKind;
  readonly satisfied: boolean;
  /** The leaf references this node resolved; empty for `and`/`or`/`not`. */
  readonly references: readonly M3LProcedureResolvedReference[];
  /** Child evaluations; empty for leaves. */
  readonly operands: readonly M3LProcedureConditionEvaluation[];
  /** A short rendered explanation, e.g. `"12 > 5"`. Length-capped. */
  readonly detail: string | undefined;
}

interface M3LProcedureConditionScope<TShape extends M3LProcedureShape> {
  readonly results: Readonly<
    Partial<Record<TShape["stepId"], M3LProcedureStepRecord>>
  >;
  readonly values: Readonly<Partial<TShape["values"]>>;
  readonly parameters: Readonly<TShape["parameters"]>;
}

function evaluateProcedureCondition<TShape extends M3LProcedureShape>(
  condition: M3LProcedureCondition<TShape>,
  scope: M3LProcedureConditionScope<TShape>,
): M3LProcedureConditionEvaluation;
```

`and` and `or` deliberately **do not short-circuit**. An unevaluated operand
would leave a hole in the explanation, and the whole justification for value-
object conditions is that the explanation is complete. A consequence worth
knowing: the evaluation tree is fully determined by the condition and the scope,
so a test can assert it exactly.

`evaluateProcedureCondition` is public because a consumer must be able to
unit-test its own case list without standing up a whole procedure. It is pure:
no `deps`, no signal, no I/O.

> **Safety classification.** An evaluation tree carries **resolved caller data
> verbatim** — that is the point of explainability — so it is _run-report grade_,
> not _breadcrumb grade_. It reaches the outcome and is **never** handed to a
> trace sink. The only thing `core/procedure` ever gives a sink is a
> `describeTrace` return, allowlist-projected. See [Tracing](#tracing).

## Cases and the mandatory fallback

```typescript
interface M3LProcedureCase<
  TShape extends M3LProcedureShape,
  TId extends TShape["caseId"],
> {
  readonly id: TId;
  /** What this case means, for a maintainer. */
  readonly description: string;
  /** Operator-facing prose — what a human reads when this case wins. */
  readonly prose: string;
  readonly condition: M3LProcedureCondition<TShape>;
  /** Unique across the procedure; higher wins. */
  readonly priority: number;
  readonly action: (
    context: M3LProcedureContext<TShape>,
    match: M3LProcedureCaseMatch<TShape>,
  ) => TShape["conclusion"] | Promise<TShape["conclusion"]>;
}

interface M3LProcedureFallback<TShape extends M3LProcedureShape> {
  readonly description: string;
  readonly prose: string;
  /** Receives every case evaluation, so "what was investigated" is data. */
  readonly action: (
    context: M3LProcedureContext<TShape>,
    investigated: readonly M3LProcedureCaseEvaluation<TShape>[],
  ) => TShape["conclusion"] | Promise<TShape["conclusion"]>;
}

interface M3LProcedureCaseEvaluation<TShape extends M3LProcedureShape> {
  readonly caseId: TShape["caseId"];
  readonly description: string;
  readonly prose: string;
  readonly priority: number;
  readonly evaluation: M3LProcedureConditionEvaluation;
}

/** A case evaluation that provably matched. */
type M3LProcedureCaseMatch<TShape extends M3LProcedureShape> = Omit<
  M3LProcedureCaseEvaluation<TShape>,
  "evaluation"
> & {
  readonly evaluation: M3LProcedureConditionEvaluation & {
    readonly satisfied: true;
  };
};
```

`boolean & true` collapses to `true`, so `match.evaluation.satisfied` is the
literal `true`: a case action can never be handed an unsatisfied evaluation, and
the compiler enforces that rather than a test asserting it.

**Priority uniqueness is load-bearing.** With a tie, which case matched would
depend on array order, so the same evidence could produce different conclusions
across a refactor that only reordered a list. A duplicate priority is a
build-time problem, not a convention.

**The fallback is mandatory.** A procedure cannot terminate without a defined
outcome; "no case matched" is a first-class structured result recording what was
investigated, never a silent gap. It is a **required positional argument** to
`build()`, so its absence is a compile error; the runtime
`ERR_PROCEDURE_MISSING_FALLBACK` problem covers the untyped path. (The same
belt-and-braces pairing `core/pipeline` applies to its non-empty `operations`
tuple.)

The fallback deliberately has **no** `id` and no `priority`. There is exactly
one per procedure, so `status === "unrecognized"` already identifies it, and
giving it an id would invite a second.

## Builder, definition, engine

```typescript
function createProcedureBuilder<TShape extends M3LProcedureShape>(
  /** Non-empty; part of the digest. An empty or non-string name is a
   *  build-time `ERR_PROCEDURE_INVALID_DECLARATION` problem. */
  name: string,
): M3LProcedureBuilder<TShape, TShape["stepId"], TShape["caseId"]>;

class M3LProcedureBuilder<
  TShape extends M3LProcedureShape,
  TPendingSteps extends TShape["stepId"],
  TPendingCases extends TShape["caseId"],
> {
  /**
   * Appends a step; execution order is call order.
   *
   * `TId extends TPendingSteps` is what makes a duplicate step id a **compile**
   * error: the returned builder's pending union excludes `TId`, so a second
   * `.step({ id: "gather" })` no longer satisfies the constraint.
   */
  step<
    const TId extends TPendingSteps,
    const TJump extends TShape["stepId"] = never,
  >(
    step: M3LProcedureStep<TShape, TId, TJump>,
  ): M3LProcedureBuilder<TShape, Exclude<TPendingSteps, TId>, TPendingCases>;

  /** Same `Exclude` discipline, so a duplicate case id is a compile error. */
  case<const TId extends TPendingCases>(
    entry: M3LProcedureCase<TShape, TId>,
  ): M3LProcedureBuilder<TShape, TPendingSteps, Exclude<TPendingCases, TId>>;

  /**
   * Declares the parameter names this procedure reads, **at run time**.
   *
   * `TShape["parameters"]` gives the compiler the names, but types are erased,
   * so without this call `build()` has no way to know a `parameter` reference
   * addresses something real, `describe()` has no `parameters` list to project
   * into the digest, and `run()` cannot reject an undeclared key. The element
   * type is constrained to the shape's own keys, so this cannot drift from the
   * type — it can only be incomplete.
   *
   * Omitting it declares **none**, which is a loud failure rather than a quiet
   * one: every `parameter` reference then fails `build()` under
   * `ERR_PROCEDURE_UNKNOWN_REFERENCE`, and every key passed to `run()` fails
   * under `ERR_PROCEDURE_INVALID_OPTION`. Both messages name this method as the
   * remedy.
   */
  parameters(names: readonly (keyof TShape["parameters"] & string)[]): this;

  /**
   * Validates and freezes. `fallback` is required, so a procedure without a
   * defined outcome cannot be constructed.
   *
   * @throws `M3LError` with code `ERR_PROCEDURE_INVALID_DEFINITION`, carrying
   *   **every** finding in `context.problems`, each under its own code.
   */
  build(
    fallback: M3LProcedureFallback<TShape>,
    options?: M3LProcedureBuildOptions,
  ): M3LProcedure<TShape>;
}

interface M3LProcedureBuildOptions {
  /**
   * Folded into the digest projection. The digest cannot see handler *bodies*
   * (functions are not canonical-JSON serialisable), so this is the author's
   * lever for "the declared shape is unchanged but the behaviour is not".
   */
  readonly revision?: string;
}

class M3LProcedure<TShape extends M3LProcedureShape> {
  /** Computed once at build; copied onto every outcome. */
  readonly digest: string;
  /** The exact serialisable projection `digest` hashes. */
  describe(): M3LProcedureSummary;
  run(
    options: M3LProcedureRunOptions<TShape>,
  ): Promise<M3LProcedureOutcome<TShape>>;
}
```

Run options:

```typescript
type M3LProcedureProgressWitness<TShape extends M3LProcedureShape> = (
  context: M3LProcedureContext<TShape>,
) => string | number | bigint | boolean;

interface M3LProcedureProgressOptions<TShape extends M3LProcedureShape> {
  /** Sampled once per continuing step. Must be cheap and side-effect-free. */
  readonly witness: M3LProcedureProgressWitness<TShape>;
  /** Consecutive unchanged samples after the baseline that trip the guard. */
  readonly maxStalledSteps: number;
}

interface M3LProcedureRunOptionsBase<TShape extends M3LProcedureShape> {
  readonly deps: TShape["deps"];
  readonly signal?: AbortSignal;
  /** Ceiling on step *executions*. Defaults to `M3L_PROCEDURE_MAX_ITERATIONS`. */
  readonly maxIterations?: number;
  /**
   * The no-progress guard. **Opt-in**, exactly as `M3LPollerOptions` and
   * `M3LRetryRunnerOptions` have it: absent, no guard runs and the engine
   * samples nothing. The iteration ceiling still bounds a runaway loop.
   */
  readonly progress?: M3LProcedureProgressOptions<TShape>;
  readonly trace?: M3LProcedureTraceOptions;
  /** Used only for guarded tracing warnings. Absent → the warning is dropped. */
  readonly logger?: M3LLogger;
  readonly initialValues?: Readonly<Partial<TShape["values"]>>;
}

/**
 * `parameters` is conditionally required — the mechanism
 * `M3LOperationPipelineOptions` uses for `prepare`.
 *
 * The predicate tests the map's **value** type, not its key type. Testing
 * `[keyof TShape["parameters"]] extends [never]` looks equivalent and is not:
 * `keyof Record<string, never>` is `string`, so the most natural way to write
 * "this procedure takes no parameters" would land on the *required* branch and
 * demand an empty object at every call site. Both `Record<string, never>` and
 * `Record<never, never>` make `parameters` optional under the value-type form,
 * and every populated map — including one whose only property is optional —
 * still makes it required.
 */
type M3LProcedureRunOptions<TShape extends M3LProcedureShape> =
  M3LProcedureRunOptionsBase<TShape> &
    ([TShape["parameters"][keyof TShape["parameters"]]] extends [never]
      ? { readonly parameters?: Readonly<TShape["parameters"]> }
      : { readonly parameters: Readonly<TShape["parameters"]> });

const M3L_PROCEDURE_MAX_ITERATIONS = 100;
const M3L_PROCEDURE_CONDITION_MAX_DEPTH = 16;
const M3L_PROCEDURE_MAX_PATTERN_LENGTH = 512;
const M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH = 8192;
```

### The compile-time guarantees cover a hand-written chain

`step()`'s and `case()`'s `Exclude`-based narrowing is **positional**: it makes a
duplicate id a compile error in a literal, hand-written fluent chain, which is
how a procedure is meant to be authored. It cannot cover a procedure assembled
dynamically — from a loop, or from a pre-built array — because there the ids are
not literals the compiler can track, and the pending union collapses.

That is not a gap; it is the division of labour. The eleven build-time problem
codes exist precisely because the dynamic path is reachable, and they check at
run time exactly what the fluent chain checks at compile time. State the
consequence plainly rather than discovering it: **a dynamically-assembled
procedure gets the same guarantees, just from `build()` instead of from `tsc`.**

There is deliberately **no public constructor and no public definition type**.
`build()` is the only way to obtain an `M3LProcedure`, so there is no path by
which a hand-assembled definition reaches the engine and skips validation —
every guarantee on this page holds for every instance that exists.

A procedure is inert and reusable: one `M3LProcedure` may be `run` repeatedly
**and concurrently**. Everything run-scoped — the context chain, visit counts,
step records, the trace buffer, the progress tracker — lives in the `run()` call
frame, never on the instance. Exactly two things are instance state, both
immutable after `build()` and therefore shared safely: the digest (a string) and
the compiled `matches` patterns (compiled once, never with the `g` or `y` flag,
so they carry no `lastIndex` between runs).

### Option validation

`run()` reads and validates its options **before** anything observable happens,
and throws `ERR_PROCEDURE_INVALID_OPTION` on any of:

- `maxIterations` that is not a finite integer in `[1, Number.MAX_SAFE_INTEGER]`.
  Exactly `maxIterations` step executions are permitted; the guard trips when the
  run is about to begin execution number `maxIterations + 1`.
- `progress.witness` that is not a function, or `progress.maxStalledSteps` that
  is not a finite integer greater than `0`.
- a `parameters` key the shape never declared, a `parameters` value containing a
  non-finite number or a `BigInt` (it would fail `parametersDigest`), or a
  dangerous parameter name (`__proto__`, `constructor`, `prototype`).

`parameters` and `initialValues` are read **exactly once**, each property into a
local, and copied into fresh frozen objects. A caller's object may be getter- or
`Proxy`-backed and free to return a different value on every access, so
validating one read and then storing a second, separate read would reproduce the
"two observations of a mutable caller graph" defect `captureProgressConfig` was
extracted to eliminate. Mutating the caller's object after `run()` is entered
cannot change the run.

### What "frozen" means here

`Object.freeze` is shallow, so the guarantee is stated exactly: the context
object **and** its `results`, `values`, `parameters` and `recovered` containers
are frozen. The values _inside_ those containers are **not** deep-frozen — a
caller that puts a mutable array into a step output can still mutate it, and
this page does not claim otherwise. `deps` is never frozen and never touched:
freezing a caller's SDK-client or logger bag would be a real breakage.

## The run contract

`run(options)` executes exactly three phases, in exactly this order.

### Phase 1 — steps

Starting at the first declared step, for each iteration:

1. **Cancellation** — if the signal is aborted, stop and return the `aborted`
   outcome. Checked at **every** step boundary and **before** any other guard,
   so a run started with an already-aborted signal executes zero steps.
2. **Iteration ceiling** — checked before the execution it would authorise, so
   the ceiling bounds _executions_, not distinct steps: a `goTo` loop counts
   every pass. Exceeding it ends the run with a `failed` outcome under
   `ERR_PROCEDURE_ITERATION_LIMIT`.
3. **Revisit ceiling** — a step carrying `loop` may execute at most
   `maxRevisits + 1` times; exceeding that is the same code with
   `context.limit === "revisits"`.
4. **`describeTrace`** — called **before** `execute`, with the context `execute`
   is about to receive. Its return is buffered and recorded at step **exit**, so
   `durationMs` is known and the engine's own keys are applied last. This is the
   ordering [`core/pipeline`](./pipeline.md#describe-runs-at-phase-entry)
   established.
5. **`execute`** — awaited. A throw ends the run with a `failed` outcome, unless
   the step declares `continueOnFailure`.
6. **Recovery** — with `continueOnFailure`, the failure is serialised **now**,
   while its context is still available, into an `M3LRunRecoveryEntry`
   (`{ item: <step id>, error: serializeErrorChain(error), recordedAt }` —
   [`core/diagnostics`](./diagnostics.md)'s shape and its redaction), appended
   under the `M3L_RECOVERY_LIMIT` ring buffer with the oldest evicted, and
   `recoveredTotal` incremented uncapped. The step's record is
   `status: "recovered"` with no output, and the run advances.
7. **Fold** — a **new** frozen context is derived.
8. **Directive** — as [Flow directives](#flow-directives) defines. A `"resolve"`
   runs phase 2 immediately; on a match the run concludes with the remaining
   steps unexecuted.
9. **No-progress guard** — when `progress` is configured, the witness is sampled
   **exactly once** per continuing step, after the context is derived (so the
   sample sees this step's contribution) and after the flow is applied. Tripping
   ends the run with a `failed` outcome under `ERR_PROCEDURE_NO_PROGRESS`.

Phase 1 also ends when the last declared step returns `"continue"`.

An abort **always wins**: over `continueOnFailure`, over a no-progress trip, and
over a step's own thrown error. A step that declares `continueOnFailure` and
throws an abort is **not** absorbed — absorbing it would continue past a
cancellation the operator asked for, and ADR-0049's whole posture is that a
cancelled operation is never retried.

The abort is recognised by `code === "ERR_OPERATION_ABORTED"`, not by
`instanceof` — the library rule is to discriminate on the machine-readable code.
A raw `AbortError` `DOMException` from an SDK maps to `failed`, not `aborted`:
the engine cannot tell it from an abort the caller never requested. A step that
throws `ERR_OPERATION_ABORTED` while `options.signal` is **not** aborted still
produces `aborted` — the step is reporting that something it owns was
cancelled, and the engine takes it at its word.

`abortedAt` is the id of the step at whose boundary the abort was observed: the
step about to run when a boundary check fired, or the step that threw. It is
`undefined` for an abort observed after phase 1 — at the phase-2 or phase-3
check.

### Phase 2 — cases

**Every** case is evaluated — no short-circuit across the case list — in
descending priority, which is safe to precompute precisely because `build()`
proved the priorities unique. The highest-priority match is the **primary**
case; the rest of the matches are recorded on the outcome as `alsoMatched`,
because evidence satisfying three cases is worth knowing about and suppressing
it is how a case list silently rots. On an early `"resolve"` this is the same
evaluation, run mid-procedure.

A procedure may therefore evaluate its case list several times — once per
`"resolve"` that did not match, plus once at the end. Only the **final** pass is
reported: `investigated` holds one entry per case, from the pass that concluded
the run, and `alsoMatched` comes from that same pass. `resolveChecks` counts how
many passes ran, so a run that checked four times is distinguishable from one
that checked once. `earlyResolved` is `true` **iff** the run concluded from a
`"resolve"`-triggered pass — including when the last declared step is the one
that returned `"resolve"`, because what the flag reports is _which pass
concluded_, not whether steps remained.

### Phase 3 — conclusion

The primary case's `action` runs, or the fallback's when nothing matched. Either
way the run produces an outcome; no path terminates without one.

A throw from a case action or from the fallback action **propagates unmodified**
— it is a caller bug in the conclusion, not a run conclusion, and folding it
into `unrecognized` would report the wrong thing. Same posture as the pipeline's
`recovery` callback.

## Outcome

`run()` **resolves** for all four arms. A failed, aborted or unrecognized run is
a structured result, because a procedure's whole purpose is to make its
conclusion inspectable — including the conclusion "this failed". Only a
**contract violation** throws: a `build()` problem, or a malformed `run` option.

Three properties keep "resolves rather than rejects" from becoming a swallowed
error:

1. **Nothing is discarded.** `error` on the `failed` arm is the thrown value
   **verbatim** — typed `unknown` because a step may throw anything, never
   wrapped and never re-coded, so its `cause` chain is intact. A guard failure
   carries the `M3LError` the guard constructed.
2. **The read does not compile without the narrow.** `conclusion` exists **only**
   on the `matched` and `unrecognized` arms, so a caller that never narrows on
   `status` cannot reach a conclusion value at all.
3. **`failed` and `aborted` are terminal.** The engine never continues past
   either; no further step, case or action runs.

The caller-side obligation is therefore to narrow, and to map a non-success arm
onto a non-zero exit — `M3LRunOutcome`'s `partial` / `failed` and their
`M3L_EXIT_CODES` entries are what [`core/diagnostics`](./diagnostics.md) provides
for that.

```typescript
interface M3LProcedureOutcomeBase<TShape extends M3LProcedureShape> {
  /** `canonicalJsonHash` over the built definition. Identical across runs. */
  readonly digest: string;
  /** `canonicalJsonHash` over this run's parameters. */
  readonly parametersDigest: string;
  /** The allowlisted per-step trace, in execution order. */
  readonly trace: readonly M3LProcedureTraceEntry[];
  readonly telemetry: M3LProcedureTelemetry<TShape>;
}

type M3LProcedureOutcome<TShape extends M3LProcedureShape> =
  M3LProcedureOutcomeBase<TShape> &
    (
      | {
          readonly status: "matched";
          readonly primary: M3LProcedureCaseMatch<TShape>;
          /** Every OTHER case that also matched, descending priority. */
          readonly alsoMatched: readonly M3LProcedureCaseMatch<TShape>[];
          readonly conclusion: TShape["conclusion"];
          readonly error?: undefined;
        }
      | {
          readonly status: "unrecognized";
          readonly primary?: undefined;
          readonly alsoMatched: readonly [];
          /** Every case checked, with its full evaluation tree. */
          readonly investigated: readonly M3LProcedureCaseEvaluation<TShape>[];
          readonly conclusion: TShape["conclusion"];
          readonly error?: undefined;
        }
      | {
          readonly status: "failed";
          readonly primary?: undefined;
          readonly alsoMatched: readonly [];
          /** The step that failed, or `undefined` for a guard failure. */
          readonly failedStep: TShape["stepId"] | undefined;
          readonly error: unknown;
        }
      | {
          readonly status: "aborted";
          readonly primary?: undefined;
          readonly alsoMatched: readonly [];
          /** The boundary the abort was observed at. */
          readonly abortedAt: TShape["stepId"] | undefined;
          readonly error: M3LOperationAbortedError;
        }
    );

interface M3LProcedureTelemetry<TShape extends M3LProcedureShape> {
  /** Every execution, in order — including revisits. */
  readonly steps: readonly M3LProcedureStepRecord[];
  readonly iterations: number;
  /** Declared steps that never executed, because of `stop`, a forward `goTo`,
   *  or an early `resolve`. */
  readonly stepsSkipped: number;
  /** How many times a `resolve` triggered an all-case check. */
  readonly resolveChecks: number;
  /** Directly assignable to `M3LRunReportInput["recovery"]`. */
  readonly recovered: readonly M3LRunRecoveryEntry[];
  /** The true, uncapped count — `M3LRunReportInput["recoveryTotal"]`. */
  readonly recoveredTotal: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly terminatedAt: TShape["stepId"] | undefined;
  readonly earlyResolved: boolean;
}
```

`alsoMatched: readonly []` appears on three arms rather than being omitted, so a
caller can read `outcome.alsoMatched.length` without narrowing — mirroring
`M3LOperationPipelineOutcomeBase`'s stated purpose.

## Errors

Every code below is registered in `M3L_ERROR_CODES` and `M3L_ERROR_CATALOG`
(see [`core/errors`](./errors.md)) with `{ origin: "caller", retryable: false }`.

### Thrown

| Code                               | Thrown by                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PROCEDURE_INVALID_DEFINITION` | `build()` — the one outer code; every finding in `context.problems`                                                          |
| `ERR_PROCEDURE_INVALID_OPTION`     | `run()` — a bad `maxIterations`, a non-finite `parameters` value, a non-function / throwing / non-primitive progress witness |

### Carried by a `failed` outcome's `error`

| Code                            | Fires when                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ERR_PROCEDURE_ITERATION_LIMIT` | the iteration ceiling, or a `loop` step's `maxRevisits`; `context.limit` is `"iterations"` or `"revisits"`                                                                                                                                 |
| `ERR_PROCEDURE_NO_PROGRESS`     | the stall guard tripped; `context` carries `stalledSteps` and `lastStepId`                                                                                                                                                                 |
| `ERR_PROCEDURE_INVALID_OPTION`  | the progress witness **threw**, or returned a non-primitive, mid-run. The option was only provably bad once sampled, so it surfaces as a `failed` outcome with the thrown value chained as `cause` rather than breaking "`run()` resolves" |
| `ERR_PROCEDURE_UNDECLARED_JUMP` | a `goTo` outside the step's `jumpsTo` — unreachable from typed TypeScript                                                                                                                                                                  |

`ERR_PROCEDURE_NO_PROGRESS` is deliberately **not**
[`core/polling`](./polling.md)'s `ERR_NO_PROGRESS`, which is
`{ origin: "external" }`. A polling stall means a remote system stopped
advancing; a procedure stall means the **graph loops without changing state** —
a definition fault. Different actor, so a different code and a different origin.
The mechanism (baseline sample, then `Object.is` against the previous sample,
tripping on the `maxStalledSteps`-th consecutive unchanged observation) is the
shared internal one A5 shipped, reused verbatim.

Cancellation mints nothing: `M3LOperationAbortedError`
(`ERR_OPERATION_ABORTED`) is surfaced as the `aborted` arm's `error`, unwrapped
and un-re-coded.

## Build-time validation

`build()` refuses to produce an invalid procedure and reports **every** problem
at once, each under its own machine-readable code. A step graph typically has
several faults, and fixing them one rejection at a time is the failure mode this
replaces.

One throw, code `ERR_PROCEDURE_INVALID_DEFINITION`, with `context.problems` an
array of `M3LProcedureValidationProblem`:

```typescript
/** The eleven per-problem codes, narrowed away from the full `M3LErrorCode`. */
type M3LProcedureProblemCode =
  | "ERR_PROCEDURE_EMPTY_STEPS"
  | "ERR_PROCEDURE_DUPLICATE_STEP_ID"
  | "ERR_PROCEDURE_INVALID_JUMP_TARGET"
  | "ERR_PROCEDURE_CYCLE_DETECTED"
  | "ERR_PROCEDURE_DUPLICATE_CASE_ID"
  | "ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY"
  | "ERR_PROCEDURE_MISSING_FALLBACK"
  | "ERR_PROCEDURE_INVALID_PATTERN"
  | "ERR_PROCEDURE_CONDITION_TOO_DEEP"
  | "ERR_PROCEDURE_UNKNOWN_REFERENCE"
  | "ERR_PROCEDURE_INVALID_DECLARATION";

interface M3LProcedureValidationProblem {
  readonly code: M3LProcedureProblemCode;
  readonly message: string;
  readonly stepId?: string;
  readonly caseId?: string;
  /** For `ERR_PROCEDURE_CYCLE_DETECTED`: the cycle, first node repeated last. */
  readonly path?: readonly string[];
}
```

| Per-problem code                        | Fires when                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PROCEDURE_EMPTY_STEPS`             | no step was declared                                                                                                                                                                                                                                                                                                                               |
| `ERR_PROCEDURE_DUPLICATE_STEP_ID`       | two steps share an `id` (reported once per duplicated id, however many repeats)                                                                                                                                                                                                                                                                    |
| `ERR_PROCEDURE_INVALID_JUMP_TARGET`     | a `jumpsTo` entry names no declared step                                                                                                                                                                                                                                                                                                           |
| `ERR_PROCEDURE_CYCLE_DETECTED`          | an unacknowledged cycle; carries `path`                                                                                                                                                                                                                                                                                                            |
| `ERR_PROCEDURE_DUPLICATE_CASE_ID`       | two cases share an `id`                                                                                                                                                                                                                                                                                                                            |
| `ERR_PROCEDURE_DUPLICATE_CASE_PRIORITY` | two cases share a `priority`; names both                                                                                                                                                                                                                                                                                                           |
| `ERR_PROCEDURE_MISSING_FALLBACK`        | the fallback is absent or malformed (untyped callers only)                                                                                                                                                                                                                                                                                         |
| `ERR_PROCEDURE_INVALID_PATTERN`         | a `matches` pattern is over-long, uncompilable, or contains a quantified group                                                                                                                                                                                                                                                                     |
| `ERR_PROCEDURE_CONDITION_TOO_DEEP`      | a condition nests past `M3L_PROCEDURE_CONDITION_MAX_DEPTH`                                                                                                                                                                                                                                                                                         |
| `ERR_PROCEDURE_UNKNOWN_REFERENCE`       | a condition references a step / value / parameter name that does not exist (untyped callers only)                                                                                                                                                                                                                                                  |
| `ERR_PROCEDURE_INVALID_DECLARATION`     | a malformed declaration: an empty or non-string `id` / `label` / parameter name; a dangerous parameter or `values` key (`__proto__`, `constructor`, `prototype`); a duplicate parameter name; a non-finite or non-number case `priority`; a `loop.maxRevisits` that is not a finite integer > 0; a condition `literal` that is a non-finite number |

`ERR_PROCEDURE_INVALID_DECLARATION` exists because `build()` calls
`canonicalJsonHash`, which rejects a non-finite number or a `BigInt` anywhere
in the tree with `ERR_INVALID_ARGUMENT`. A `priority: NaN` or a
`{ literal: Infinity }` would otherwise leak that code out of `build()` — a
code this contract does not name and a caller cannot act on. The declaration
check therefore runs **before** the digest is computed, so `build()` only ever
throws `ERR_PROCEDURE_INVALID_DEFINITION`. A `NaN` priority would also make
descending-priority ordering undefined, so rejecting it is not only about the
hash.

The problem list is **deterministic**: checks run in the table's order, and each
check reports in declaration order. A single problem renders inline; several
render as a numbered list — the shape
`internal/pipeline/validate.ts`'s `renderMessage` established.

### Cycle detection

Nodes are step ids. Edges are of two kinds:

- **implicit sequential** — step _i_ → step _i+1_, contributed unconditionally,
  because the engine advances on `"continue"` and no declaration proves a step
  never returns it. Every step except the last contributes one. These edges are
  strictly forward, so a linear procedure is trivially acyclic — and the direct
  consequence, worth stating because it is what an author trips over: **any
  `jumpsTo` entry naming the declaring step itself or an earlier one is a
  cycle**, so every backward jump and every self-jump requires `loop`. A
  forward-only `jumpsTo` never needs it.
- **explicit** — one edge per `jumpsTo` entry, **excluded** when the step carries
  `loop`. That exclusion is what keeps a deliberate re-gather expressible while
  an accidental cycle stays a build error — and it is what gives the iteration
  and no-progress guards something real to guard.

Detection is a depth-first search with three-colour marking: white
(undiscovered), grey (on the current stack), black (fully explored). A grey
re-entry is a back edge, hence a cycle. The walk is iterative with an explicit
stack, so a hand-generated ten-thousand-step graph cannot overflow. Successor
order is fixed — implicit next, then `jumpsTo` in declared order — so the same
definition always reports the same problems.

The reported problem carries the **cycle path**, first node repeated last, and
its message names the remedy:

```text
M3LProcedure: cycle detected in the step graph:
'check' -> 'gather' -> 'check' (annotate the jumping step with `loop` if this
repetition is deliberate)
```

"Cycle detected" without the path sends the author hunting through the graph,
which is the failure mode reporting-all-problems-at-once exists to remove. The
same cycle discovered from two different roots is reported once, deduplicated on
a canonical rotation of its node list.

## Definition digest

`build()` computes `canonicalJsonHash` ([`core/json`](./json.md)) over the
definition's **serialisable projection**, returned as-is by `describe()`: the
procedure name and `revision`; each step's id, label, kind,
`continueOnFailure`, `jumpsTo` and `loop`, in order; each case's id,
description, prose, priority and condition; the fallback's description and
prose; the declared parameter names.

```typescript
interface M3LProcedureSummary {
  readonly name: string;
  readonly revision: string | undefined;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: M3LProcedureStepKind;
    readonly continueOnFailure: boolean;
    readonly jumpsTo: readonly string[];
    readonly loop: M3LProcedureLoop | undefined;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly description: string;
    readonly prose: string;
    readonly priority: number;
    /** Shape-erased: `M3LProcedureShape`'s own `stepId`/`caseId` are `string`. */
    readonly condition: M3LProcedureCondition<M3LProcedureShape>;
  }[];
  readonly fallback: { readonly description: string; readonly prose: string };
  /** The names declared via the builder's `parameters()`, sorted. */
  readonly parameters: readonly string[];
}
```

Every field is a scalar, an array, or a condition value object — nothing in a
summary is a function, so `canonicalJsonHash` accepts it whole, and
`describe()` doubles as the human-readable answer to "what exactly does this
digest cover".

Two things are deliberately outside it:

- **Handler bodies.** Functions are not canonical-JSON serialisable, so two
  behaviourally different procedures with identical declared shapes share a
  digest. `M3LProcedureBuildOptions.revision` is the author's lever for that;
  the limit is stated here rather than left to be discovered.
- **Parameter values.** `digest` identifies the procedure; `parametersDigest`
  identifies the run's inputs. A preset retune therefore moves
  `parametersDigest` and leaves `digest` alone.

Both are surfaced on **every** outcome, including `failed` and `aborted`, so a
partial run still identifies exactly what it ran. A resumable consumer supplies
**both** to [`core/checkpoint`](./checkpoint.md) as its `definition`
fingerprint — `digest` alone would happily resume across an edited threshold,
which is the defect A4's fingerprint exists to prevent.

## Tracing

`options.trace` is opt-in and additive. Absent it, the engine touches no sink
and does no tracing work.

```typescript
interface M3LProcedureTraceSink {
  record(source: string, event: string, payload?: unknown): void;
}

interface M3LProcedureTraceOptions {
  readonly sink: M3LProcedureTraceSink;
  /** Overrides the default `"M3LProcedure"` source label. */
  readonly source?: string;
}

interface M3LProcedureTraceEntry {
  readonly stepId: string;
  readonly label: string;
  readonly kind: M3LProcedureStepKind;
  readonly attempt: number;
  readonly durationMs: number;
  readonly failed: boolean;
  /**
   * The flow directive, **projected to a scalar**: `"continue"`, `"stop"`,
   * `"resolve"`, or `"goTo:<targetId>"`. `undefined` when the step threw.
   *
   * `M3LProcedureFlow`'s `{ goTo }` arm is an object, and a breadcrumb sink
   * drops a non-scalar payload entry — so the structured form would silently
   * vanish from exactly the trace that is supposed to explain the jump.
   * `M3LProcedureStepRecord.flow` keeps the structured value.
   */
  readonly flow: string | undefined;
  readonly payload: Readonly<Record<string, M3LBreadcrumbScalar>>;
}
```

This is a **separate declaration** from `M3LPipelineTraceSink`, not a reuse.
Its TSDoc, its `@link` targets and its event names all say "step" where the
pipeline's say "phase"; sharing one type would force one engine's vocabulary
into the other's docs — the exact drift ADR-0046 § _Consequences_ names as the
cost of carrying two engines. The duplication costs a call site nothing: both
are structural, so one `M3LBreadcrumbTrail` satisfies both with no adapter and a
script can hand the same object to both engines.

Two events are recorded:

- **`procedure:step`** — one entry per step that actually executes, recorded
  against the source label `trace.source` (default `"M3LProcedure"`), carrying
  the engine's own `stepId`/`label`/`kind`/`attempt`/`durationMs`/`flow`/`failed`
  keys plus `describeTrace`'s allowlist-projected return. The engine's keys are
  applied **last**, so a `describeTrace` return cannot forge them: a return
  claiming `failed: true` on a clean step is overwritten, not left standing.
  `failed` is present as `false` on a clean step rather than omitted, so a
  payload-equality assertion has one shape to match. A step whose `execute`
  **threw** still records its entry, with `failed: true` and `flow: undefined`,
  before the run ends.
- **`procedure:outcome`** — engine-owned scalars only: `status`,
  `primaryCaseId`, `alsoMatchedCount`, `iterations`, `resolveChecks`,
  `earlyResolved`, `digest`. Case ids are author-written code, not caller data.

There is deliberately **no case-evaluation event**: an evaluation tree carries
resolved caller values and is report-grade, not breadcrumb-grade.

- **Payloads are allowlisted, never denylisted.** Each key of
  `describeTrace`'s return is dropped unless it is a safe own key and its value
  is an `M3LBreadcrumbScalar` (`string | number | boolean | null`). Non-scalars
  are dropped **individually** — a single bad entry does not discard the whole
  payload — and are never stored by reference, so a later caller-side mutation
  cannot change what a deferred sink serialises. ADR-0035's 2026-07-23 update is
  authoritative: four adversarial passes established that regex redaction over
  unbounded caller text does not converge, while allowlisting held every round.
- **Tracing is never load-bearing.** Payload assembly and `sink.record` share
  one guard; a throw from `describeTrace`, from a getter on its return, or from
  `sink.record` cannot change an outcome. The warning logged names the step and
  the error's `code` **only when that code is a member of `M3L_ERROR_CODES`** —
  never its `message`, `stack` or `name`, all of which can embed caller data.
  The `logger.warning` call is itself guarded.
- [`core/diagnostics`](./diagnostics.md) registers summarizers for both events,
  so a default `trail.attach()` timeline keeps the engine's scalar keys —
  including `null` — instead of dropping them through the generic fallback.

## Cancellation

`options.signal` is the
[ADR-0049](../../adr/0049-cooperative-cancellation-contract.md) cooperative
signal — the one `M3LScript` exposes as `script.signal`. It is checked at every
step boundary, before phase 2, and before phase 3, and it is threaded into
`context.signal` so a `gather` step can forward it to an SDK call. An aborted run
returns the `aborted` outcome; it does not throw.

## Import constraints

`core/procedure` must not import `aws/**` (steps are script-supplied handlers,
so the engine stays AWS-agnostic and the island zone is not inverted) and must
not import `core/script` (the composition root). Both are enforced by
`eslint.config.js`'s `import-x/no-restricted-paths` zones and asserted
structurally by `pnpm check:zones`; neither may be widened to make the engine
compile.

Note that the `aws/**` half of that constraint was **not** enforced when
ADR-0046 asserted it was: the aws island zone only constrains `aws → core`. The
missing `core → aws` zone was added alongside this module.

## Example — a log-analysis shape

```typescript
import { Core } from "@m3l-automation/m3l-common";

interface Triage extends Core.M3LProcedureShape {
  deps: { readonly logs: { query(q: string): Promise<number> } };
  values: { errorCount: number };
  parameters: { window: string; threshold: number };
  conclusion: { readonly verdict: string };
  stepId: "count-errors" | "sample-traces";
  caseId: "quiet" | "spiking";
}

const procedure = Core.createProcedureBuilder<Triage>("log-triage")
  .step({
    id: "count-errors",
    label: "Count ERROR lines in the window",
    kind: "gather",
    describeTrace: (ctx) => ({ window: ctx.parameters.window }),
    execute: async (ctx) => {
      const errorCount = await ctx.deps.logs.query("filter level = 'ERROR'");
      return { flow: "resolve", output: errorCount, values: { errorCount } };
    },
  })
  .step({
    id: "sample-traces",
    label: "Fetch sample stack traces (expensive)",
    kind: "gather",
    continueOnFailure: true,
    execute: async (ctx) => ({
      flow: "continue",
      output: await ctx.deps.logs.query("filter @message like /Exception/"),
    }),
  })
  .case({
    id: "quiet",
    description: "No errors in the window",
    priority: 100,
    condition: {
      kind: "compare",
      left: { source: "value", key: "errorCount" },
      operator: "==",
      right: { source: "literal", literal: 0 },
    },
    prose: "The window is clean. No action needed.",
    action: () => ({ verdict: "quiet" }),
  })
  .case({
    id: "spiking",
    description: "Error count past the alert threshold",
    priority: 200,
    condition: {
      kind: "compare",
      left: { source: "value", key: "errorCount" },
      operator: ">=",
      right: { source: "parameter", key: "threshold" },
    },
    prose: "Errors are past the threshold. Page on-call and attach the traces.",
    action: () => ({ verdict: "spiking" }),
  })
  .build({
    description: "Evidence matched no known case",
    prose: "Unrecognized pattern. Capture the trace and add a case for it.",
    action: () => ({ verdict: "unrecognized" }),
  });

const outcome = await procedure.run({
  deps: { logs },
  parameters: { window: "PT1H", threshold: 25 },
  signal: script.signal,
});

if (outcome.status === "matched") {
  logger.info(outcome.primary.prose, {
    case: outcome.primary.caseId,
    digest: outcome.digest,
  });
}
```

Because `count-errors` returns `"resolve"`, a clean window matches the `quiet`
case immediately and `sample-traces` — the expensive step — never runs.

## Out of scope

Recorded so the engine does not creep past its evidence
([ADR-0046](../../adr/0046-codified-procedure-engine.md) § _Deliberately out of
scope_):

- **Cross-script orchestration** — sequencing whole consumer scripts is
  [ADR-0047](../../adr/0047-cross-script-orchestration-deferred.md), not this
  engine.
- **Data-file definitions** (YAML/JSON validated at load) — declined: the
  library has no schema validator, compile-time exhaustiveness would be lost,
  and handlers must remain code regardless.
- **Unattended dispatch**, **replay and reconciliation** — no consumer.
- **Model-interpreted branching** — closed by
  [ADR-0039](../../adr/0039-llm-integration-out-of-scope.md). A procedure
  produces the same conclusion from the same evidence.
