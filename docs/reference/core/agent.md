# Core / agent

The authorization layer for an autonomous operator: it evaluates every
intended agent action **before** the action is attempted and returns a typed
verdict — `auto-approved`, `escalate`, or `denied`.

## Overview

[ADR-0048](../../adr/0048-target-graded-destructive-confirmation.md) is
explicit about what the destructive gate is not: "an operator-safety prompt,
not an authorization control". Anyone who can pass `--yes` / `--yes-sensitive`
bypasses it, and no downstream decision may treat a passed gate as proof of
entitlement. For a human at a terminal that is the right trade. For an
autonomous operator it means there is no safety layer at all — only a disabled
prompt.

[ADR-0060](../../adr/0060-agent-policy-layer.md) answers that. This submodule
is the authorization control ADR-0048 deliberately declines to be. An agent's
authority is **declared, tested, repo-owned data** — a plain structured object
a deployment stores next to its config and a reviewer reads in one place — not
harness configuration and not the absence of a prompt.

The **evaluator** is pure: `evaluateAgentAction` performs no I/O, reads no
clock, opens no file, and holds no module-level state. That claim covered the
whole module until V7 slice 2, which adds the decision-log **writer** — the one
deliberately impure thing here, and the reason the claim is now scoped rather
than dropped. Everything the evaluator touches is still a total function; see
[Writing the decision log](#writing-the-decision-log). A caller feeds it the parsed contents of a JSON or
YAML policy preset; the module validates that value at its own boundary and
returns a branded, frozen policy. Everything after that is a total function
from `(policy, action)` to a verdict.

### What this module is not

It is not a sandbox, a permission system for the harness, or a replacement for
ADR-0048's prompt. It cannot stop a caller who never asks it. It **rides**
ADR-0048's target grades rather than reinterpreting them: `sensitiveTargets`
from `core/prompt` is the classifier, imported and called, never
re-implemented. And it never emits the `yesSensitive` bypass on its own
authority — a sensitive mutation always reaches a human.

It also does not detect mutation. `M3LAgentAction.kind` is **caller-declared**,
and that is the layer's one trust boundary: the authorization guarantee holds
only when `kind` is derived from the script's own contract, never from model
output. See [The trust boundary](#the-trust-boundary).

## Landing plan

ADR-0072 slice record.

| Slice                           | Scope                                                                                                                            | Status |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V6 slice 1 — verdicts           | The action/policy/verdict vocabulary, the declaration validator, and the evaluator's allowlist + autonomy-tier arms. 20 exports. | Landed |
| V6 slice 2 — budgets + dry-run  | Per-run/per-day budgets and ceilings, the run ledger, named exhaustion outcomes, and the dry-run-first discipline. 4 exports.    | Landed |
| V7 slice 1 — decision-log entry | The decision-log entry schema, the pure projector from a decision, and the JSONL serializer. No I/O. 7 exports.                  | Landed |
| V7 slice 2 — the writer         | The append-only segmented writer, its rotation ceilings, the loud write error, and the log-unavailable escalation. 5 exports.    | Landed |

Deliberately **not** in either slice, and why:

- **Writing the agent decision log.**
  [ADR-0061](../../adr/0061-agent-decision-log.md) is V7 and co-lands in this
  same submodule. Its V6 slices made the log possible — every verdict names the
  rule that produced it, and carries the library's own frozen projection of the
  action rather than the caller's object. **V7 slice 1 adds the entry itself**
  (schema, projector, serializer) and still writes nothing; the appender, its
  rotation, and the loud write failure are V7 slice 2. See
  [The decision-log entry](#the-decision-log-entry).
- **ADR-0055's richer operation vocabulary.** A grant allowlists operation
  **names**, plain strings. `core/config`'s `M3LOperationDeclaration` is a soft
  dependency and stays soft; a caller derives the names it allowlists and hands
  them over as data. No type from `core/config` is imported.
- **The A2 target-grading retrofit.** It is a soft prerequisite, neutralised by
  the fail-closed default in
  [Why an ungraded target is sensitive](#why-an-ungraded-target-is-sensitive).
  Nothing here waits on it.

Slice 1 took Core from 24 to 25 submodules (fleet total 44 → 45). Slice 2 adds
no submodule: four exports join the same barrel, taking the module from twenty
to twenty-four, and one field joins `M3LAgentActionRecord`.

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols — twenty from V6 slice 1, four more from V6 slice 2, seven
more from V7 slice 1, and five more from V7 slice 2.

**The action under judgement** — what a caller describes:

- `M3LAgentActionKind` — `"read-only" | "mutating"`, the caller's declared tier.
- `M3LAgentAction` — the intended action a caller submits.
- `M3LAgentActionRecord` — the library's frozen projection of that action,
  carried on every verdict.
- `M3L_AGENT_MAX_PARAMETER_NAMES` — `256`, the ceiling on
  `M3LAgentAction.parameterNames`.
- `agentActionShapeKey` — the dry-run shape key for an action, so a caller can
  seed a ledger without first producing a decision.

**The declared authority** — what a deployment writes down:

- `M3LAgentScriptGrant` — one script's grant.
- `M3LAgentPolicyDeclaration` — the plain-JSON, preset-storable declaration.
- `M3LAgentBudgets` — the declared per-run and per-day ceilings.
- `M3LAgentPolicy` — a validated, deep-frozen, **branded** policy. Only
  `validateAgentPolicy` can produce one.
- `validateAgentPolicy` — the boundary parser/validator.
- `M3L_AGENT_MAX_SCRIPT_GRANTS` (`128`) /
  `M3L_AGENT_MAX_OPERATIONS_PER_GRANT` (`128`) /
  `M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES` (`256`) — the declared structural
  ceilings. Every one is a **reject-above** bound: `length > MAX` throws,
  `length === MAX` is accepted.

**The run ledger** — what a caller observes and hands back:

- `M3LAgentRunLedger` — the observed state of the current run: counts, spend,
  loop depth, the completed dry-run shapes, and the one sampled timestamp.
- `M3L_AGENT_MAX_DRY_RUN_SHAPES` — `256`, the ceiling on
  `M3LAgentRunLedger.dryRunCompletedShapes`. Reject-above, like every other
  structural ceiling.

**The verdict** — what the evaluator returns:

- `M3LAgentVerdict` — `"auto-approved" | "escalate" | "denied"`. Closed.
- `M3LAgentPolicyRuleId` — names the rule that produced a verdict. A closed
  literal union today that **grows in later minors**.
- `M3LAgentDecision` — the discriminated verdict.
- `isAgentPolicyRuleId` — type predicate over the ids **this build** knows.
- `isAgentActionAutoApproved` — the one correct approval gate.

**The decision log** — what a caller records (V7 slice 1, no I/O):

- `M3LAgentIdentity` — the caller-supplied identity of the acting agent: a
  required logical `name`, and an optional `modelId` / `awsPrincipal`. The
  library resolves none of it.
- `M3LAgentDecisionOutcome` — what happened after an approved action ran.
  Absent when nothing ran, which is most of what the log is for.
- `M3LAgentDecisionLogEntry` — one audit record: the decision, the identity,
  and the outcome, flat and plain-JSON.
- `M3LAgentDecisionLogEntryOptions` — the projector's options bag.
- `agentDecisionLogEntry` — the pure projector from a decision to an entry.
- `serializeAgentDecisionLogEntry` — an entry to one JSONL line, no trailing
  newline.
- `M3L_AGENT_MAX_LOG_ENTRY_BYTES` — `65536`, the ceiling on that line's UTF-8
  byte length. Exported here, **enforced by slice 2's writer**.

**The evaluator** — the entry point itself:

- `M3LAgentEvaluationOptions` — the options bag.
- `evaluateAgentAction` — the evaluator.

**Writing the log** — the one impure surface (V7 slice 2):

- `M3LAgentDecisionLog` — the append-only segmented writer.
- `M3LAgentDecisionLogOptions` — its options bag: the directory override and
  both rotation ceilings.
- `M3L_AGENT_LOG_MAX_SEGMENT_BYTES` (8 MiB) /
  `M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS` (24 h) — the default rotation ceilings,
  both caller-overridable.

**Errors** — all thrown, never returned:

- `M3LAgentPolicyDeclarationError` (`ERR_AGENT_POLICY_DECLARATION`).
- `M3LAgentActionValidationError` (`ERR_AGENT_INVALID_ACTION`).
- `M3LAgentDecisionLogWriteError` (`ERR_AGENT_DECISION_LOG_WRITE`).

Both take the repo's standard error-subclass shape, and both narrow `code` to
their own literal:

```typescript
constructor(
  message: string,
  options?: { context?: Record<string, unknown>; cause?: unknown },
);
```

The options interface is **not** exported — callers catch these, they never
construct them. The "`context` names the field and the violation kind, never a
value" discipline applies to **both** classes, not just the declaration error.

**Reused, not re-exported.** `M3LDestructiveTarget`,
`M3LDestructiveTargetPredicate`, `M3LSensitiveTargetSpec`, and
`sensitiveTargets` stay singly owned by `core/prompt` and are already reachable
as `Core.*`. Re-exporting any of them here would not merely duplicate — the
Core barrel is `export * from "./<mod>/index.js"` per submodule, so the same
name arriving from two star exports is TS2308 at compile time and a silently
dropped export under ES module semantics.

## The action under judgement

```typescript
type M3LAgentActionKind = "read-only" | "mutating";

interface M3LAgentAction {
  readonly script: string;
  readonly operation?: string;
  readonly kind: M3LAgentActionKind;
  readonly target?: M3LDestructiveTarget;
  readonly parameterNames?: readonly string[];
  readonly dryRun?: boolean;
}
```

- `script` is matched **verbatim** against a grant's `script`. It is a plain
  name, never an `M3LScript`: an ADR-0009 layering zone forbids any `core/**`
  module from importing `core/script`, and `import-x/no-restricted-paths` is
  not type-aware, so even `import type` is blocked.
- `operation` is a declared operation name (ADR-0055's vocabulary, carried as a
  string). Absent when the script has no operation vocabulary.
- `target` is ADR-0048's own `M3LDestructiveTarget`, imported. This module
  declares no target shape of its own.
- `parameterNames` carries parameter **names**, never values. Slice 1 records
  it and does not judge it; it is here from day one because ADR-0061's log
  entry schema requires it and slice 2's dry-run-first keys on the parameter
  shape, so slice 2 adds no field to a type callers construct.
- `dryRun` is read as a strict opt-in — when present it must be a **boolean**.
  `false` is accepted and recorded as `false`; a non-boolean is rejected by
  rule ACT-7 below rather than coerced. Slice 1 records it; slice 2 judges it.

`M3LAgentActionRecord` is the same information as required fields holding
`undefined` rather than optional keys, with `parameterNames` defaulted to `[]`
and `dryRun` defaulted to `false`:

```typescript
interface M3LAgentActionRecordTarget {
  readonly profile: string;
  readonly region: string | undefined;
  readonly accountId: string | undefined;
}

interface M3LAgentActionRecord {
  readonly script: string;
  readonly operation: string | undefined;
  readonly kind: M3LAgentActionKind;
  readonly target: M3LAgentActionRecordTarget | undefined;
  readonly parameterNames: readonly string[];
  readonly dryRun: boolean;
  readonly shapeKey: string;
}
```

`target` is **not** `M3LDestructiveTarget`. That type declares `region` and
`accountId` as optional, which under `exactOptionalPropertyTypes` means
"absent, or a string — never `undefined`", while the projection emits both as
own keys holding `undefined`. Naming it `M3LDestructiveTarget` was a lie the
compiler believed: `if ("region" in target)` narrowed `target.region` to
`string`, compiled, and read `undefined` at runtime. The type moved to match
the runtime, not the other way round — see
[Why absent keys are materialised](#why-absent-keys-are-materialised).
`M3LAgentActionRecordTarget` is not surfaced through the barrel — it is the
type of one field on a record the library builds, not a symbol a caller names;
write `NonNullable<M3LAgentActionRecord["target"]>` instead.

The two `sensitivity` predicates — the declared spec's and the caller's
`additionalSensitiveTargets` — still receive a genuine `M3LDestructiveTarget`,
with an undeclared scalar **omitted** rather than present-and-`undefined`. That
is what ADR-0048's predicate contract promises, and a grading list is always a
non-empty list of non-blank strings, so an omitted scalar and an `undefined`
one grade identically.

`shapeKey` is slice 2's addition and is the only field the record gained after
slice 1 shipped. It is the dry-run shape key described under
[Dry-run-first](#dry-run-first), computed during the same step-0 traversal that
builds the rest of the record — so the key a decision carries is provably the
key the evaluator judged, not a recomputation that could drift. It is on the
**record** rather than the decision because ADR-0061's log entry is written
from the record.

The required-holding-`undefined` form is deliberate and follows the reasoning
already written for `M3LCommandContext.signal` in `core/cli-contract`: this is
a **library-built** record handed to callee code — the ADR-0061 writer — so the
stricter form applies.

An earlier draft of this section claimed slice 2 would add no required field to
this type. That was wrong — `shapeKey` is one — and it is recorded here rather
than quietly deleted, because the claim is what made the field look free. Two
shipped tests construct an `M3LAgentActionRecord` literal or assert on the
whole record with `toEqual`, and both had to be updated in the slice-2 commit.
For a consumer the same migration applies: a hand-built record needs the field,
and a whole-record `toEqual` needs to expect it. The field is required anyway,
because an optional `shapeKey` would defeat the guarantee in the paragraph
above — a decision could then carry no key at all, and the caller would be back
to recomputing one.

The record exists to satisfy a rule this module cannot afford to break:
validate once, then never let anything re-read the caller's object.
`evaluateAgentAction` traverses `M3LAgentAction` exactly once, projects into a
frozen record, decides from the projection, and puts **the projection** on the
decision. A caller mutating their action object afterwards therefore cannot
make the decision log and the verdict disagree.

**The projection is a deep copy, not a reference copy.** `parameterNames`
becomes a frozen copy of the caller's array, and `target` becomes a fresh
frozen object carrying only the three scalars ADR-0048 declares
(`profile` / `region` / `accountId`), with `region` and `accountId` present as
own properties holding `undefined` when absent. Copying the `target`
**reference** instead would leave `action.target.profile = "prod"` after the
call able to rewrite `decision.action.target.profile` — which is precisely the
guarantee the previous paragraph makes.

### Validating the action

Step 0 validates the evaluator's whole options bag before any rule runs — the
twelve rules slice 1 shipped, plus slice 2's three for the run ledger.

Ahead of all fifteen, and not numbered among them, the bag itself must be an
object: otherwise the walk throws with `field: "options"` and violation
`not-an-object`. That check is deliberately weaker than ACT-1's
`isPlainObject` — an array or a class instance passes it and is caught by the
key sweep instead — because the bag is a call-site literal rather than parsed
JSON, so the prototype-shadowing hazard ACT-1 exists to stop does not apply to
it. Every
violation throws `M3LAgentActionValidationError` (`ERR_AGENT_INVALID_ACTION`),
whose `context` names the offending field and the violation kind and — exactly
as for the declaration error — **never a value**. Each check is an allowlist:
prove the shape valid, never try to recognise it as invalid.

1. **ACT-1** `action` is a plain object (`isPlainObject`). `null`, an array, a
   string, a `Date`, and a class instance all throw.
2. **ACT-2** `script` is present and is a **non-blank** string — non-empty
   after trimming. A whitespace-only script name is a caller mistake, not a
   name.
3. **ACT-3** `kind` is present and is exactly `"read-only"` or `"mutating"`.
   Anything else throws — see
   [Why an unrecognised `kind` throws](#why-an-unrecognised-kind-throws).
4. **ACT-4** `operation`, when present, is a non-blank string.
5. **ACT-5** `target`, when present, is a plain object whose `profile` is a
   non-blank string, and whose `region` and `accountId` — when present — are
   non-blank strings. Any other own key on `target` throws.
6. **ACT-6** `parameterNames`, when present, is an array of non-blank strings
   no longer than `M3L_AGENT_MAX_PARAMETER_NAMES`. It is never truncated: an
   over-long list throws, because silently dropping names would silently
   change the parameter shape slice 2 keys its dry-run discipline on.
7. **ACT-7** `dryRun`, when present, is a boolean. `"yes"`, `1`, and `null`
   throw rather than resolving to `false`; present-but-valueless is malformed
   input, not "absent".
8. **ACT-8** **Any unknown own key** on `action` throws, for the same reason
   rule 11 rejects one on a grant: in an authorization input an unrecognised
   key is overwhelmingly a typo'd known one.
9. **ACT-9** Any key rejected by `isDangerousKey` throws — defence in depth
   beyond ACT-8.
10. **ACT-10** `options.additionalSensitiveTargets`, when present, is a
    function. A non-function must surface as this module's typed error, not as
    a bare `TypeError` from the call site.
11. **ACT-11** **Any unknown own key on the options bag itself** throws — the
    bag is allowlisted to `action`, `policy`, `additionalSensitiveTargets`,
    and — since slice 2 — `run`, exactly as `action` is allowlisted by ACT-8.
    Two reasons. A typo'd `additionalSensitiveTarget` — one `s` short — is
    caught by TypeScript only for a fresh call-site object literal, never for
    a bag built as a variable, and silently evaluates with **no** extra
    sensitivity predicate at all. And it is deliberate for slice 2: a caller
    passing slice 2's per-run state to an older library must fail loud, not
    silently lose its budget ceilings.
12. **ACT-12** `options.policy` is a policy `validateAgentPolicy` itself
    produced — see [The trust boundary](#the-trust-boundary). Absent, `undefined`,
    and forged all reject identically.
13. **ACT-13** `options.run`, when present, is a plain object, and **any**
    unknown own key on it throws. The ledger is the one input whose fields are
    all individually optional, which makes a typo'd `invocationsThisRun`
    indistinguishable from an honest omission on a plain read — and an
    omission is what turns a declared budget into an escalation. Rejecting the
    unknown key is what keeps that distinction observable.
14. **ACT-14** every present numeric ledger field is a **finite** number and
    is not negative. `invocationsThisRun`, `invocationsToday`,
    `loopIterations`, `tokensThisRun`, `todayCountedAt`, and `now` must be
    safe **integers**; `costThisRun` may be fractional. `NaN`, `Infinity`,
    `-1`, and a numeric string all throw. `NaN` matters most: every
    exhaustion comparison below is a `>=`, and `NaN >= ceiling` is `false`, so
    a `NaN` that validated would silently disable the budget it was measuring.
15. **ACT-15** `dryRunCompletedShapes`, when present, is an array of non-blank
    strings no longer than `M3L_AGENT_MAX_DRY_RUN_SHAPES`, with no duplicates.
    It is never truncated, for the reason ACT-6 gives. Its length is read
    **once into a local**, and both the bound check and the walk are driven
    from that one value, by index rather than through the array's own
    iterator. Both halves are load-bearing and an earlier draft of this page
    claimed only the second: the indexed walk alone stops a hostile
    `Symbol.iterator`, but `Array.isArray` is `true` for a `Proxy` wrapping an
    array, so a `length` trap answering `1` and then the real length walked
    5,000 entries past a 256 bound while the check itself passed. Reading
    `length` twice is the bug; reading it once is the fix. Note the
    deliberate asymmetry with ACT-6: `parameterNames` **preserves** duplicates
    and `dryRunCompletedShapes` **rejects** them. Both run through the same
    list helper with different rules, so the difference looks like an oversight
    and is not. A repeated parameter name is data — it changes the shape being
    hashed. A repeated shape key is a set membership written twice, which in a
    hand-advanced ledger is a bug worth surfacing. Do not harmonise them.

Field presence is read with `Object.hasOwn`, never `field !== undefined`, so a
non-own `"__proto__"` resolves as absent. One consequence is worth stating
because it is easy to under- or over-constrain in a test: an own key holding an
explicit `undefined` is **present**, so `{ action, policy, run: undefined }`
throws rather than reading as "no ledger". That matches how
`additionalSensitiveTargets` already behaves. At the _declaration_ boundary the
answer differs and legitimately so — an explicit `undefined` cannot survive
`JSON.parse`, so it can only come from a hand-built object.

The ACT rules are numbered for reading, not for evaluation. Their **evaluation
order** is fixed separately and is observable whenever two are violated at once:
the options bag's own key sweep first, then `policy`, then `action`, then
`additionalSensitiveTargets`, then `run`. So `{ policy: forged, run: { typo: 1 } }`
reports the forged policy, every time.

The ledger is validated **unconditionally**, not only when the policy consults
it. A malformed `run` throws even against a slice-1 declaration that declares no
`budgets` and no `dryRunFirst` — step 0 runs before any policy field is read.
That is the one new way slice 2 can throw where slice 1 did not, and it is
reachable only by a caller that opts into the new field.

A throwing accessor or a `Proxy` trap can make even an allowlist walk fail:
`{ get script() { throw } }` and a `Proxy` whose `ownKeys` throws both raise a
raw error from inside a guard that reads as total. The whole step-0 traversal
is therefore wrapped: a non-`M3LError` throw becomes
`M3LAgentActionValidationError` with violation `traversal-threw`, and an
already-typed error is re-thrown unchanged rather than double-wrapped. The
declaration walk behind `validateAgentPolicy` is wrapped the same way, with
`M3LAgentPolicyDeclarationError` and the same violation kind. The original
throw is carried as `cause`: since the `M3LError.toJSON()` cause allowlist
landed, a foreign cause collapses to `{ "name": "RangeError" }` in a
serialised record — no message, stack, or own fields — so chaining it leaks
nothing while keeping the live `.cause` available for hand debugging.

#### Why absent keys are materialised

The projection emits `region` and `accountId` as own keys holding `undefined`
rather than omitting them, and that is a **security** property, not a style
choice: an own key cannot be shadowed by a polluted `Object.prototype`, while
an omitted one resolves up the prototype chain on a plain dot read.

The other half of the same rule applies where materialising is not available.
`M3LAgentScriptGrant` and `M3LAgentPolicyDeclaration` are the deployment's own
preset-storable shapes, where an optional key genuinely means absent, so their
projections keep omitting the undeclared key — and every read of one, in the
decision arms, goes through `Object.hasOwn` instead. Both halves close the
same hole: with `Object.prototype.allOperations = true`, a plain
`grant.allOperations` read a named-operation grant as a whole-script grant and
skipped the operation allowlist entirely; with
`Object.prototype.sensitiveTargets = {}`, a plain `policy.sensitiveTargets`
read made the most cautious deployment of all — the one that declared no
grading precisely so every mutation would escalate — auto-approve a production
mutation instead.

#### Why an unrecognised `kind` throws

`kind` is validated at step 0 rather than falling through to step 4's
`unclassifiable-escalated` arm. Consistency is the reason: every other step-0
field fails loud on a malformed value, and a typo'd `kind: "readonly"` that
merely escalated would hide a caller bug behind a verdict that looks like
policy working correctly.

`unclassifiable-escalated` remains as the fail-closed path for the moment
`M3LAgentActionKind` gains a third member. It is **unreachable at runtime
today**, and unavoidably so: ACT-3 is a runtime allowlist, and a TypeScript cast
is erased at compile time, so neither a caller nor a test can drive a third
value into step 4. An earlier draft of this page claimed the arm was "tested
through a cast" — that was wrong, and it is recorded here so the next reader
does not spend a round trying.

A guard no test can reach is a guard that guards nothing, so the untestable
runtime guard is replaced by a **stronger compile-time** one: the arm assigns
`record.kind` to a `never`-typed local. Adding a third member to
`M3LAgentActionKind` is therefore a **compile error at that exact line** rather
than a runtime escalation nobody observes until production. The line carries a
scoped `v8 ignore` annotation naming that reason — the one case where such an
annotation is honest, because the line is provably unreachable rather than
merely un-exercised.

### The trust boundary

**The policy brand is enforced at runtime.** `M3LAgentPolicy`'s `unique symbol`
brand is erased at compile time, so on its own it stops nothing: a parsed
document asserted to the branded type compiles, and so does a spread of a real
policy with rewritten grants — which needs no assertion at all, because a
spread carries the brand type across. Both put an unvalidated declaration in
front of the evaluator, which is the one thing "the validator is the only
door" rules out. `validateAgentPolicy` therefore records the exact object it
returns in a module-private `WeakSet`, and ACT-12 rejects any non-member with
`M3LAgentActionValidationError` (`ERR_AGENT_INVALID_ACTION`), field
`options.policy`. A spread produces a **new** object, so the hole closes
completely; a `WeakSet` is used rather than a non-enumerable own symbol
because a symbol survives a spread of own symbol keys.

The evaluator reads `options.policy` exactly once, **inside step 0**, and the
decision arms take the policy step 0 returned. Nothing re-reads any field of
the caller's bag after validation.

`kind` is asserted by the caller, not detected by the library. A script that
declares `kind: "read-only"` for something that mutates has defeated the tier
rule, and no amount of validation here can notice. The guarantee this module
offers is precisely: _given a truthful `kind`, these are the bounds._ Callers
must derive `kind` from the script's own contract — its `M3LCommandModule`
descriptor or its ADR-0055 operation declaration — and never from model output.
Slice 2 delivers the declared cross-check this paragraph promised —
`readOnlyOperations` on a grant — for deployments that want the policy to hold
the second opinion. See
[The declared cross-check on `kind`](#the-declared-cross-check-on-kind).

## The policy declaration

```typescript
interface M3LAgentScriptGrant {
  readonly script: string;
  readonly operations?: readonly string[];
  readonly allOperations?: boolean;
  readonly readOnlyOperations?: readonly string[];
}

interface M3LAgentPolicyDeclaration {
  readonly version: 1;
  readonly scripts: readonly M3LAgentScriptGrant[];
  readonly sensitiveTargets?: M3LSensitiveTargetSpec;
  readonly budgets?: M3LAgentBudgets;
  readonly dryRunFirst?: boolean;
}

interface M3LAgentBudgets {
  readonly invocationsPerRun?: number;
  readonly invocationsPerDay?: number;
  readonly tokensPerRun?: number;
  readonly costPerRun?: number;
  readonly loopIterations?: number;
}
```

The declaration round-trips `JSON.parse(JSON.stringify(x))` byte-identically,
which is what makes it storable in a preset and reviewable in a diff.

Exactly one of `operations` (non-empty) or `allOperations === true` must be
present on each grant. Neither and both are declaration errors. **Omission
never means "everything"** — a whole-script grant has to be written down, so a
typo'd key can never silently widen authority.

`sensitiveTargets` is ADR-0048's own `M3LSensitiveTargetSpec`, imported. Its
**presence** is the grading opt-in. A deployment therefore writes one
sensitivity policy and both the destructive gate and this authorization layer
read it.

`budgets` and `dryRunFirst` are slice 2's two additions, and both are
**opt-ins**: a declaration written against slice 1 carries neither, so steps 3
and 6 are skipped and its `verdict`, `rule`, and `reason` are exactly what slice
1 produced. The **decision object** is not byte-identical — `decision.action`
gained `shapeKey`, so `JSON.stringify(decision)` changed for every caller. The
verdict is what a policy layer promises; the serialisation is not.

That second break is the quieter one and deserves naming separately. The typed
break — a hand-built `M3LAgentActionRecord` missing the field — is a compile
error that names the missing property, which is the best kind. But a consumer
holding a **snapshot or golden-file assertion** over a serialised decision, or
over an ADR-0061 log line, breaks at _test_ time instead, with a diff rather
than a message. Given this module's sibling ADR writes a decision log, that is
the more likely encounter, and it belongs in a release note rather than only
here.
That is the whole reason dry-run-first is a declared key rather than an
unconditional rule — an unconditional step 6 would have turned every existing
caller's `graded-mutation-auto-approved` into an escalation inside a minor.

`dryRunFirst` takes the **strict-`true`** polarity `allOperations` takes, and
for the mirror-image reason. `allOperations` is strict because a truthy
non-`true` must never _widen_ authority; `dryRunFirst` is strict because a
deployment that writes down a discipline should get it or get an error, never a
silent downgrade to no discipline at all. `false` is accepted and means the
same as absent — a deployment is allowed to write the default down.

The Bedrock cost ceiling in `costPerRun` is a plain number of the deployment's
own unit. No type from `aws/*` crosses into this module: an ADR-0009 zone
forbids it, and the policy layer has no business knowing how a token was
priced.

### `validateAgentPolicy`

```typescript
function validateAgentPolicy(declaration: unknown): M3LAgentPolicy;
```

The parameter is `unknown`, not `M3LAgentPolicyDeclaration`, because the real
input is a parsed JSON document and typing it as the declaration would be a lie
that skips the entire point.

`M3LAgentPolicy` is branded:

```typescript
type M3LAgentPolicy = M3LAgentPolicyDeclaration & {
  readonly __m3lAgentPolicyBrand: unique symbol;
};
```

`evaluateAgentAction` accepts **only** `M3LAgentPolicy`. The brand alone stops
nothing at runtime, though — it is erased at compile time, so both a parsed
document asserted to the branded type and an object spread of a real policy
compile fine. What actually closes the door is a **runtime registry**:
`validateAgentPolicy` records the exact frozen object it returns in a
module-private `WeakSet`, and ACT-12 rejects any policy object that is not a
member. A spread produces a **new** object and a `JSON.parse(...) as
M3LAgentPolicy` was never registered, so both are rejected at runtime rather
than merely discouraged. The validator is not advisory — it is the only door.
See [The trust boundary](#the-trust-boundary) for the full mechanism.

Every check is an **allowlist**: prove the shape valid, never try to recognise
it as invalid. Each violation throws `M3LAgentPolicyDeclarationError`
(`ERR_AGENT_POLICY_DECLARATION`) whose `context` names the offending grant
index or key and the violation kind, **never a value**. The rejected cases:

1. not a plain object;
2. `version` is not the literal `1` — an unknown version is never "best effort";
3. `scripts` absent, not an array, empty, or longer than
   `M3L_AGENT_MAX_SCRIPT_GRANTS`;
4. a grant that is not a plain object, or whose `script` is not a **non-blank**
   string — non-empty after trimming. "Non-blank" is used uniformly for every
   string in the declaration; `"   "` is a declaration mistake, not a name;
5. a duplicate `script` across grants — no last-wins merge in an authorization
   declaration;
6. a grant with **neither** `operations` nor `allOperations`, or with **both**;
7. `operations` present but empty, longer than
   `M3L_AGENT_MAX_OPERATIONS_PER_GRANT`, containing a non-string or blank
   string, or containing duplicates;
8. `allOperations` present and not the boolean `true`;
9. `sensitiveTargets` present but not a plain object, or present with **all
   three** of `profiles` / `regions` / `accountIds` omitted. This is the single
   most important rule in the validator: `sensitiveTargets({})` builds a
   predicate that matches nothing, which would silently grade every target as
   non-sensitive and auto-approve every mutation;
10. a `sensitiveTargets` list that is present and is not a non-empty array of
    non-blank strings, that contains duplicates, or whose entries **summed
    across all three lists** exceed `M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES`.
    The bound is a total, not a per-list bound, because the cost the ceiling
    exists to bound is the whole spec's size. Duplicates are rejected for the
    same reason rule 7 rejects them in `operations`: in a hand-written
    authorization declaration a repeat is a mistake worth surfacing, and OR
    semantics make it inert rather than harmful, which is exactly why it would
    otherwise never be noticed;
11. **any unknown key**, at the top level, on a grant, on the
    `sensitiveTargets` object, **or on `budgets`**. An unrecognised key in an authorization
    declaration is overwhelmingly a typo'd `operations` or `sensitiveTargets` —
    an accidental widening. Reject, never ignore. The grading spec is included
    deliberately: `{ profiles: ["prod"], regionz: ["eu-west-1"] }` satisfies
    rules 9 and 10 and silently drops every region grading, which is rule 9's
    own fail-open one level down;
12. any key rejected by `isDangerousKey` (defence in depth beyond 11);
13. `budgets` present but not a plain object, or present with **all five**
    ceilings omitted. This is rule 9's shape one module over: an empty
    `budgets` object reads as "this deployment governs spend" in a diff while
    enforcing nothing at all, so it is rejected rather than treated as absent.
    An unknown key on it is rejected by rule 11;
14. a budget ceiling that is present and is not a **positive finite** number —
    `invocationsPerRun`, `invocationsPerDay`, `tokensPerRun`, and
    `loopIterations` must be safe **integers**, `costPerRun` may be
    fractional. Zero is rejected along with negatives and `NaN`: a ceiling of
    `0` is exhausted before the run begins, which is a way of spelling "deny
    this script" that the `scripts` allowlist already spells properly, and
    accepting it would make a mistyped ceiling look like a working one;
15. `readOnlyOperations` present but not a non-empty array of non-blank,
    non-duplicate strings within `M3L_AGENT_MAX_OPERATIONS_PER_GRANT`, or —
    on an operation-scoped grant — containing an entry that is not also in
    `operations`. An unreachable entry is always a typo: step 2 denies the
    operation before step 4 could consult the list. On an `allOperations`
    grant there is no list to cross-check against and only the shape rules
    apply;
16. `dryRunFirst` present and not a boolean. Unlike `allOperations` — where
    only `true` is accepted, because the key exists solely to widen — `false`
    is accepted here and means the same as absent, so a deployment can write
    the default down. A non-boolean throws rather than coercing.

Field reads use `Object.hasOwn(record, field)` rather than
`record[field] !== undefined`, because the input is a parsed JSON document and
a non-own `"__proto__"` must resolve as absent.

The traversal is **one pass**: validate and project into a fresh, deep-frozen
structure in the same walk, then brand. Nothing downstream re-reads the
caller's object.

### The declared cross-check on `kind`

`kind` is asserted by the caller and cannot be verified by the library — that
is [the trust boundary](#the-trust-boundary), and it is the one place where a
wrong answer skips grading entirely, because step 4's read-only arm returns
before step 5 ever runs.

`readOnlyOperations` lets the declaration hold a second opinion. It names the
operations this grant considers read-only; when it is declared, a `read-only`
claim is only honoured for an operation on that list:

```json
{
  "script": "dynamodb-crud",
  "operations": ["get-item", "put-item", "delete-item"],
  "readOnlyOperations": ["get-item"]
}
```

An action claiming `kind: "read-only"` for `delete-item` under that grant
escalates with `kind-cross-check-escalated` instead of auto-approving. The
declaration and the action disagree about what the operation does, and a
disagreement is exactly the unclassifiable state the fail-closed table sends to
a human.

The check is **one-directional on purpose**: it doubts a `read-only` claim and
never a `mutating` one. Only a false `read-only` claim is dangerous, because
only it skips grading; an action that over-declares itself mutating merely
takes the long route through step 5 and arrives at the same or a stricter
verdict. Doubting that direction too would add a failure mode and close no
hole.

The cross-check applies to an `allOperations: true` grant too, and the effect
is worth stating because it looks surprising: a whole-script grant that also
declares `readOnlyOperations` escalates a `read-only` claim for any operation
outside that list. That is the key doing its job, not a hidden narrowing — it
never blocks a mutation, it only refuses to believe a _read-only_ claim the
declaration does not corroborate. A deployment that wants the whole script
auto-approvable for reads simply omits the key.

This is also the only route by which the pseudocode's "`record.operation` is
absent" clause is reachable: on an operation-scoped grant step 2 has already
denied an absent operation, so only a whole-script grant can arrive at step 4
with no operation to cross-check. An unnamed operation cannot be corroborated,
so it escalates.

It stays **optional** for the same reason `sensitiveTargets` is: a deployment
that has not enumerated its read-only operations should not be forced to
guess, and a wrong list is worse than no list. Absent means the trust boundary
stands exactly where slice 1 left it, and this page says plainly that it does.
`validateAgentPolicy` rule 15 rejects a `readOnlyOperations` entry that is not
also in `operations` on an operation-scoped grant — such an entry can never be
reached, since step 2 denies the operation first, so it is always a typo.

## The tier decision table

The evaluation order below is normative. Each numbered arm is terminal.

```text
evaluateAgentAction({ action, policy, additionalSensitiveTargets, run }):

  Step 0 — boundary validation + single-traversal projection
      record := the frozen M3LAgentActionRecord projected from `action`
      A malformed options bag THROWS M3LAgentActionValidationError, per the
      fifteen ACT rules. `kind` outside the two literals throws HERE, not at
      step 4. Every step below reads `record`, never `action`; every
      decision below carries `record`.

  Step 1 — script allowlist
      grant := the grant whose `script` equals record.script
      if none          -> denied     "script-not-allowlisted"

  Step 2 — operation allowlist
      if grant.allOperations !== true:            (strict true: opt-in)
          if record.operation is absent           -> denied "operation-not-allowlisted"
          if not grant.operations.includes(...)   -> denied "operation-not-allowlisted"

  Step 3 — budgets and ceilings
      if policy.budgets is absent       -> skip this step
      for each declared ceiling, IN THIS FIXED ORDER:
          invocationsPerRun, invocationsPerDay, tokensPerRun,
          costPerRun, loopIterations
        if its observation is absent    -> escalate "budget.<kind>.unobservable"
        if observed >= ceiling          -> escalate "budget.<kind>"
      (`invocationsPerDay` also needs `todayCountedAt` and `now`; when the two
       fall in different UTC days the observed count is read as 0.)
      (a declared ceiling that is not a finite number escalates on that
       ceiling's `.unobservable` id too — it is the same "cannot evaluate this
       budget" state. Unreachable behind validator rule 14, and kept as the
       same second line of defence `allOperations !== true` is.)

  Step 4 — autonomy tier
      if record.kind === "read-only":
          if grant.readOnlyOperations is declared, and record.operation
             is absent or not on it     -> escalate "kind-cross-check-escalated"
          otherwise                     -> auto-approved "read-only-auto-approved"
      if record.kind === "mutating"     -> continue
      otherwise                         -> escalate "unclassifiable-escalated"
      (the `otherwise` arm is unreachable at RUNTIME — ACT-3 rejects any
       other `kind` at step 0, and a cast cannot bypass a runtime check.
       It is a `never`-typed exhaustiveness assertion, so a future third
       M3LAgentActionKind member is a COMPILE error here.)

  Step 5 — ADR-0048 grading, ridden not reinterpreted
      if record.target is absent        -> escalate "target-ungraded-escalated"
      if policy.sensitiveTargets absent -> escalate "policy-ungraded-escalated"
      if sensitiveTargets(spec)(target) is truthy
         OR additionalSensitiveTargets(target) is truthy
                                        -> escalate "sensitive-target-escalated"

  Step 6 — dry-run-first
      if policy.dryRunFirst !== true    -> skip this step  (strict true: opt-in)
      if record.dryRun === true         -> skip this step  (this IS the dry run)
      if record.shapeKey is in run.dryRunCompletedShapes -> skip this step
      otherwise                         -> escalate "dry-run-first"

  Step 7 — graded, non-sensitive mutation inside the allowlist
                                        -> auto-approved "graded-mutation-auto-approved"
```

Both slice-2 arms are **skipped entirely** when the declaration opts out, which
is what makes slice 2 additive: a slice-1 declaration reaches exactly the arms
slice 1 evaluated, in the same order, and gets the same verdict.

**Budgets gate read-only actions too** (step 3 sits above step 4). ADR-0060's
tier sentence reads "read-only/introspection actions: `auto-approved`"
unconditionally, and this page departs from that reading deliberately: ADR-0025
records that the repo has "no token/cost governance of any kind", and an agent
burning tokens on read-only Bedrock introspection is squarely inside that gap.
An unconditional read-only arm above the budget arm would leave an unbounded
spend path open. Maintainer decision, recorded here rather than left as an
implementation detail.

### Fail-closed defaults, enumerated

Every unclassifiable state resolves to `escalate` or to a loud throw. None
resolves to `auto-approved`.

| Unclassifiable state                                                     | Resolution                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------- |
| Action is structurally malformed                                         | **throws** `ERR_AGENT_INVALID_ACTION`           |
| Options bag carries an unknown own key (ACT-11)                          | **throws** `ERR_AGENT_INVALID_ACTION`           |
| `policy` absent, `undefined`, or not validator-produced (ACT-12)         | **throws** `ERR_AGENT_INVALID_ACTION`           |
| A throwing accessor or `Proxy` trap breaks a traversal                   | **throws** the walk's own typed error           |
| Declaration is structurally malformed, incl. an all-omitted grading spec | **throws** `ERR_AGENT_POLICY_DECLARATION`       |
| An `M3LAgentActionKind` member no rule handles (compile error today)     | `escalate` / `unclassifiable-escalated`         |
| Mutation with no ADR-0048 target                                         | `escalate` / `target-ungraded-escalated`        |
| Mutation, target present, policy declares no grading                     | `escalate` / `policy-ungraded-escalated`        |
| A sensitivity predicate returns a truthy non-boolean                     | `escalate` / `sensitive-target-escalated`       |
| A sensitivity predicate throws                                           | propagates; no verdict exists, nothing proceeds |
| Script or operation not positively proven present                        | `denied`                                        |
| A declared budget whose observation the ledger does not carry            | `escalate` / `budget.<kind>.unobservable`       |
| A declared budget the ledger reports as reached                          | `escalate` / `budget.<kind>`                    |
| A `read-only` claim the grant's `readOnlyOperations` contradicts         | `escalate` / `kind-cross-check-escalated`       |
| `dryRunFirst` declared, shape not yet dry-run in this run                | `escalate` / `dry-run-first`                    |

The line between the throwing rows and the escalating rows is the one sentence
worth memorising: **a malformed input is a bug to surface loudly; a well-formed
input the current rule set cannot classify is a condition to escalate.**

### Guard polarity

Two checks sit in the same call path with deliberately opposite polarity. The
asymmetry is load-bearing and must not be "harmonised".

- `grant.allOperations !== true` is an **opt-in**, so it demands strict `true`.
  It widens a grant from a named operation set to the entire script; a truthy
  non-`true` value must never widen authority. (`validateAgentPolicy` already
  rejects a non-boolean; this is the second line of defence, not a redundancy.)
- `declaredSensitive || extraSensitive` is a **verdict**, so it escalates on
  truthiness. `additionalSensitiveTargets` is caller-supplied, so a JavaScript
  caller can return `1` or `"yes"` — those must escalate, never fall through to
  auto-approve. `=== true` here would be a fail-open hole in the one place with
  the widest blast radius.

Slice 2 adds a third check on the opt-in side. `policy.dryRunFirst !== true`
skips step 6, so it demands strict `true` for the same reason `allOperations`
does — a truthy non-`true` must never decide an authorization question. Note
that the two opt-ins move authority in opposite directions (`allOperations`
widens it, `dryRunFirst` narrows it) and still take the same polarity: strict
`true` is not about which way the key leans, it is about a declaration meaning
what it says.

`additionalSensitiveTargets === undefined` resolves to `false` through an
explicit ternary rather than `pred?.(t) ?? false`, so "absent, contributes
nothing" stays visually distinct from "present and returned falsy". The budget
comparisons keep the same discipline: an absent observation takes its own
explicit escalate arm rather than defaulting to `0`, because defaulting would
make "I have spent nothing" and "I did not tell you what I spent"
indistinguishable — and only one of those is safe to auto-approve.

## Why an ungraded target is sensitive

ADR-0060's conservative default: until a script has adopted ADR-0048 target
grading, any mutation through it is treated as **sensitive**. Grading opts a
target _down_ to auto-approvable; its absence never opts one up.

That default is what makes the A2 retrofit a soft prerequisite instead of a
blocker, and it has two distinct arms here because two distinct things can be
missing:

- `target-ungraded-escalated` — the **action** carries no target. The script
  has not adopted grading.
- `policy-ungraded-escalated` — the action carries a target but the
  **declaration** has no `sensitiveTargets` spec. There is nothing that could
  grade it down.

Neither is reachable for a read-only action: step 4 has already returned.

## Verdicts and rule ids

```typescript
type M3LAgentVerdict = "auto-approved" | "escalate" | "denied";

type M3LAgentDecision =
  | {
      readonly verdict: "auto-approved";
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
      readonly action: M3LAgentActionRecord;
    }
  | {
      readonly verdict: "escalate";
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
      readonly action: M3LAgentActionRecord;
    }
  | {
      readonly verdict: "denied";
      readonly rule: M3LAgentPolicyRuleId;
      readonly reason: string;
      readonly action: M3LAgentActionRecord;
    };
```

The block above spells `M3LAgentVerdict` out for readability; the source derives
it as `M3LAgentDecision["verdict"]`, which is the same type and cannot drift
from the union it names.

**`M3LAgentVerdict` is closed and will never gain a member.** ADR-0060 fixes it
at three words. Budget exhaustion is an `escalate` carrying a new rule id — "a
named outcome, never a silent stop" — not a fourth verdict.

**`M3LAgentPolicyRuleId` is a closed literal union that grows in later
minors.**

```typescript
type M3LAgentPolicyRuleId =
  | "script-not-allowlisted"
  | "operation-not-allowlisted"
  | "read-only-auto-approved"
  | "target-ungraded-escalated"
  | "policy-ungraded-escalated"
  | "sensitive-target-escalated"
  | "graded-mutation-auto-approved"
  | "unclassifiable-escalated"
  | "budget.invocations-per-run"
  | "budget.invocations-per-day"
  | "budget.tokens-per-run"
  | "budget.cost-per-run"
  | "budget.loop-iterations"
  | "dry-run-first"
  | "kind-cross-check-escalated"
  | "budget.invocations-per-run.unobservable"
  | "budget.invocations-per-day.unobservable"
  | "budget.tokens-per-run.unobservable"
  | "budget.cost-per-run.unobservable"
  | "budget.loop-iterations.unobservable";
```

Slice 2 added the last twelve. V7 adds its own.

Two naming inconsistencies in that list are deliberate and now permanent, since
these strings are ADR-0061's wire format. The ten budget ids use a `.`
namespace separator no other id uses, because they are one family with a shared
cause and an operator filtering a log wants `budget.` as a prefix — and the
second segment lets `budget.*.unobservable` be filtered on its own, which is
the whole point of splitting them. And
`dry-run-first` is the only `escalate` id without an `-escalated` suffix,
because it names a **precondition** rather than a judgement — the others say
what the evaluator concluded, this one says what has not happened yet. Both
spellings were fixed by slice 1's page before either was implemented; renaming
them now would break a log format for a consistency no reader of a log would
benefit from. Growing the union is exactly the
additive change the paragraph below describes, and slice 2 is the first proof
of it: a slice-1 consumer that logged `decision.rule` as an opaque label keeps
compiling and keeps working; one that wrote the exhaustive `switch` this page
told it not to write does not.

Growing it is **additive, not breaking**, because the type appears only in
**return** position: no caller constructs an `M3LAgentDecision`, so a new
member cannot invalidate a caller's value. What a new member _can_ break is an
exhaustive `switch`, so consumers must **not** write one — nor a
`Record<M3LAgentPolicyRuleId, T>`, which is the same hazard in the shape a
consumer reaches for more often. A rule-id-keyed lookup table for log rendering
looks harmless and stops compiling on every added id, for exactly the reason
this module uses one internally in `guards.ts` to force that break on itself.
Treat an unrecognised id as an opaque label — log it, render it, branch on
`verdict` instead.

A closed union is chosen over a `string`-assignable open type because it is the
only form that gives autocomplete on the known ids and lets
`isAgentPolicyRuleId` narrow to something meaningful; the `string & {}` idiom
that would give both appears nowhere else in this repo.

### `isAgentPolicyRuleId`

```typescript
function isAgentPolicyRuleId(value: unknown): value is M3LAgentPolicyRuleId;
```

It answers one question: _is this one of the rule ids **this build** knows?_ It
takes `unknown` because its input is a value read back out of an ADR-0061 log
line, which is parsed JSON.

The honest limitation, stated rather than implied: because the vocabulary grows
across minors, an older library reading a log written by a newer one returns
`false` for an id that is perfectly valid. That is a version-skew answer, not a
validity answer, and a caller must not treat `false` as "corrupt log". It is
backed at runtime by a module-private `Record<M3LAgentPolicyRuleId, true>`
table rather than an array, so adding a twenty-first id is a compile error here
instead of a silently drifting runtime set. The same sentence is written in
`guards.ts` and moves with the count.

The twenty ids, slice 1's eight first:

| Rule id                                   | Verdict         | Produced when                                             |
| ----------------------------------------- | --------------- | --------------------------------------------------------- |
| `script-not-allowlisted`                  | `denied`        | No grant names the script.                                |
| `operation-not-allowlisted`               | `denied`        | Operation-scoped grant, operation absent or unlisted.     |
| `read-only-auto-approved`                 | `auto-approved` | Allowlisted read-only action.                             |
| `target-ungraded-escalated`               | `escalate`      | Mutation carrying no ADR-0048 target.                     |
| `policy-ungraded-escalated`               | `escalate`      | Mutation, but the policy declares no grading.             |
| `sensitive-target-escalated`              | `escalate`      | The target graded sensitive.                              |
| `graded-mutation-auto-approved`           | `auto-approved` | Allowlisted mutation on a graded non-sensitive target.    |
| `unclassifiable-escalated`                | `escalate`      | Reserved: a future `kind` no rule handles.                |
| `budget.invocations-per-run`              | `escalate`      | Per-run invocation ceiling reached (observed >= ceiling). |
| `budget.invocations-per-day`              | `escalate`      | Per-day invocation ceiling reached (observed >= ceiling). |
| `budget.tokens-per-run`                   | `escalate`      | Per-run token ceiling reached (observed >= ceiling).      |
| `budget.cost-per-run`                     | `escalate`      | Per-run cost ceiling reached (observed >= ceiling).       |
| `budget.loop-iterations`                  | `escalate`      | Loop-iteration ceiling reached (observed >= ceiling).     |
| `dry-run-first`                           | `escalate`      | The shape has not been dry-run in this run.               |
| `kind-cross-check-escalated`              | `escalate`      | A `read-only` claim `readOnlyOperations` contradicts.     |
| `budget.invocations-per-run.unobservable` | `escalate`      | Per-run invocation ceiling declared, not observable.      |
| `budget.invocations-per-day.unobservable` | `escalate`      | Per-day invocation ceiling declared, not observable.      |
| `budget.tokens-per-run.unobservable`      | `escalate`      | Token ceiling declared, not observable.                   |
| `budget.cost-per-run.unobservable`        | `escalate`      | Cost ceiling declared, not observable.                    |
| `budget.loop-iterations.unobservable`     | `escalate`      | Loop-iteration ceiling declared, not observable.          |

`rule` is typed as the whole union on every arm, so
`{ verdict: "denied", rule: "read-only-auto-approved" }` is representable and
is a lie the type system will not catch. The pairing is locked by a test, not
by the type.

The reason is **not** that per-arm rule aliases would be less additive — they
would be equally additive, since they too appear only in return position, and
adding a member to one of them could not invalidate a caller's value either.
The real cost is arm **reassignment**: with per-arm unions, moving an existing
id from `escalate` to `denied` — a policy change, not a vocabulary change, and
one this module should stay free to make — becomes a breaking type change for
anyone who wrote `Extract<M3LAgentDecision, { verdict: "escalate" }>["rule"]`.
The flat union keeps reassignment a runtime-behaviour change with a test to
prove it, which is where it belongs.

`reason` is library-authored prose composed only from `script`, `operation`,
`kind`, the target's `profile` / `region` / `accountId`, and — for the budget
arms — the budget's own key, its declared ceiling, and the observed value. It
never embeds a parameter value. The budget numbers are admitted deliberately:
every one is either a ceiling the deployment declared or a count the caller
itself reported, so none is data read out of the action under judgement, and an
escalation that cannot say _which_ budget and _by how much_ is an escalation an
operator cannot act on. It is not run through `escapeTerminalControls`: it is a data
value flowing to a log sink, not a display channel, and `core/logging`'s
redaction operates on unmodified text.

### `isAgentActionAutoApproved`

```typescript
function isAgentActionAutoApproved(decision: M3LAgentDecision): boolean;
```

It returns `decision.verdict === "auto-approved"` and nothing else. It ships as
a named export because the obvious hand-written alternative —
`if (decision.verdict !== "denied")` — **runs every escalation**. Shipping the
one correct gate is cheaper than relying on every consumer to pick the right
polarity.

## The evaluator

```typescript
interface M3LAgentEvaluationOptions {
  readonly action: M3LAgentAction;
  readonly policy: M3LAgentPolicy;
  readonly additionalSensitiveTargets?: M3LDestructiveTargetPredicate;
  readonly run?: M3LAgentRunLedger;
}

function evaluateAgentAction(
  options: M3LAgentEvaluationOptions,
): M3LAgentDecision;
```

A single options bag rather than positional parameters, chosen so slice 2 could
be additive — and it was: `run` arrived as a new **optional** field on a bag
callers already construct, and no slice-1 call site changed. A required field
there would have been source-breaking for every test fake.

`additionalSensitiveTargets` is OR-ed with the declared spec, so it can only
add sensitivity and can never remove it. A deployment that classifies
sensitivity programmatically — account tags, an STS lookup already performed —
can escalate more, and cannot de-escalate what the declaration marked
sensitive. A throw from it propagates unchanged: no verdict is produced, so the
action cannot proceed.

Whether it is invoked at all when the declared spec has already matched is
**unspecified** — `||` short-circuits, and no consumer may depend on a call
count either way. It is likewise never invoked when step 5's first two arms
have already returned, since those arms are terminal.

`evaluateAgentAction` throws **on its own authority** only for a malformed
options bag (the fifteen ACT rules). It never throws to signal a verdict. It can
still propagate a throw raised inside a caller-supplied
`additionalSensitiveTargets`, unchanged — that exception is the caller's, not
this module's.

## Budgets and exhaustion

ADR-0025 records that this repo has "no token/cost governance of any kind".
Step 3 is where that gap closes for an autonomous operator: a deployment
declares ceilings, the caller reports what it has observed, and the evaluator
compares the two. It performs no counting itself.

```typescript
interface M3LAgentRunLedger {
  readonly invocationsThisRun?: number;
  readonly invocationsToday?: number;
  readonly todayCountedAt?: number;
  readonly now?: number;
  readonly tokensThisRun?: number;
  readonly costThisRun?: number;
  readonly loopIterations?: number;
  readonly dryRunCompletedShapes?: readonly string[];
}
```

The ledger is **caller-owned and immutable**. `evaluateAgentAction` reads it,
never writes it, and holds nothing between calls — the function is documented
pure, and a library that quietly accumulated per-run state would be a different
function on its second call than on its first. Advancing the ledger after an
approved action is the caller's job, and passing a fresh object each time is
what keeps two concurrent runs from sharing a budget.

**The ledger is projected at step 0, exactly like the action, and steps 3 and 6
decide from the projection alone.** This is not symmetry for its own sake. The
rule this module cannot afford to break is _validate once, then never re-read
the caller's object_, and the ledger is the input where breaking it would be
easiest to miss: `dryRunCompletedShapes` is validated at step 0 but consulted at
step 6, and a live re-read across that gap is a time-of-check/time-of-use hole
of precisely the shape `projectStringList` was already hardened against — a
hostile `Symbol.iterator` or a getter that answers differently on its second
call would let a shape pass step 6 that never passed ACT-15. So step 0 emits a
frozen internal projection with every numeric field materialised as an own key
holding `undefined` when absent, and nothing downstream touches `options.run`
again.

An earlier draft of this section said only that the evaluator "reads it, never
writes it". That was true and insufficient — _when_ it reads it is the part that
matters.

### The exhaustion comparison

A budget is exhausted when `observed >= ceiling`.

That is a **reject-at** bound, and it is deliberately the opposite polarity to
every structural ceiling on this page, all of which are reject-above. The two
measure different things. `M3L_AGENT_MAX_SCRIPT_GRANTS` bounds a declaration
that already exists, so a declaration _of_ exactly 128 grants is within it. A
budget bounds a run that is still going: `invocationsThisRun` counts what has
already happened, and the action under judgement would be the next one. With
a ceiling of 10 and 10 already spent, approving would make 11.

`NaN` is why ACT-14 rejects it rather than treating it as absent: `NaN >= 10`
is `false`, so a `NaN` observation that reached this comparison would report
every budget as unexhausted — a fail-open hole in the arm whose entire job is
to stop a runaway.

Zero points in two directions here, and both are deliberate:

| Value                             | Legal | Why                                                                                                                                                        |
| --------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A **ceiling** of `0`              | no    | Exhausted before the run starts. The `scripts` allowlist already spells "deny this script" properly, and a mistyped ceiling would look like a working one. |
| An **observation** of `0`         | yes   | "I have spent nothing" is the normal state at the start of a run.                                                                                          |
| A negative ceiling or observation | no    | Neither a bound nor a count can run backwards.                                                                                                             |
| `todayCountedAt` / `now` of `0`   | yes   | The epoch is a real instant; only negatives are rejected.                                                                                                  |

### Which ceilings count as declared

A ceiling is declared when `Object.hasOwn(budgets, key)` says so — never
`budgets.key !== undefined`. The whole module reads presence that way, and this
is the arm where a dot read would be worst: with
`Object.prototype.tokensPerRun = 1`, a validated policy that declared no token
ceiling would grow one, and every action under it would escalate for a budget
nobody wrote down. `budgets` itself is read the same way, so a polluted
`Object.prototype.budgets` cannot make step 3 run at all for a policy that
declared none.

### Evaluation order, and why it is fixed

The five ceilings are checked in a fixed order — `invocationsPerRun`,
`invocationsPerDay`, `tokensPerRun`, `costPerRun`, `loopIterations` — not in
declaration order. Two budgets can be exhausted at once, and the rule id on the
verdict is what an ADR-0061 log entry records; if the order came from the
declaration, the same run against two declarations that differ only in key
order would produce different log entries. The order is a property of the
library, and it is tested.

### An absent observation escalates, on its own id

A declared ceiling whose observation the ledger does not carry escalates with
that ceiling's **`.unobservable`** id — `budget.tokens-per-run.unobservable`,
not `budget.tokens-per-run`. So does a policy that declares `budgets` while the
caller passes no `run` at all: the first declared ceiling in the fixed order
above names the verdict, with the `.unobservable` suffix.

**The two states are opposite and must not share a label.** "You have spent
your budget" is the control working exactly as the deployment intended;
"I cannot see your ledger" is a wiring mistake in the caller. An operator
should page on the second and not on the first, and a rule id is what an
ADR-0061 log line carries — `reason` is library-authored prose this page
explicitly declines to make a contract, so collapsing the distinction into it
would leave a caller regex-matching English to tell a working budget from a
broken integration.

An earlier draft of this page did collapse them, and named the cost honestly
("a stream of escalations is easy to stop reading") without fixing it. Splitting
the ids is the fix: it is a return-position vocabulary addition, so it costs
nothing in semver, and it makes the wiring mistake machine-detectable at the
only place a consumer is allowed to branch.

This is the module's standing posture applied once more: the evaluator cannot
prove the budget unexhausted, and an unprovable state escalates rather than
auto-approving. The alternatives were both worse. Throwing would crash a
running agent over a caller's wiring mistake, when degrading to human review is
available and strictly safer. Skipping the budget silently would mean a
declared ceiling could be disabled by omitting an argument — which is the exact
shape of all four fail-open defects slice 1 shipped with and had to fix.

A caller that wires the ledger up wrongly still gets a stream of escalations
rather than one loud error, and a stream of escalations is easy to stop
reading — but every one of them now carries a `.unobservable` rule id, so the
stream is machine-distinguishable from a budget doing its job. ACT-13's
unknown-key rejection is the other half: it converts the most likely wiring
mistake, a typo'd field name, from a silent omission into a throw.

### The per-day window

`invocationsPerDay` needs to know when the window rolled, and the evaluator may
not read a clock. So the caller supplies both halves: `invocationsToday`, and
`todayCountedAt` — the epoch-millisecond instant those invocations were counted
in — plus `now`, sampled **once** by the caller for this evaluation.

If `now` and `todayCountedAt` fall in different **UTC** days, the library reads
`invocationsToday` as `0`: the window has rolled and yesterday's count does not
constrain today. "Different day" is a same-day test, not an ordering test — a
`now` that runs _backwards_ into a previous day rolls the window just as a
forward one does, because a caller whose clock jumped is a caller whose count is
not trustworthy either way.

All three fields are required together whenever `invocationsPerDay` is declared,
and **presence is checked before the window is**: any one of the three absent
escalates, even when the two timestamps that _are_ present would have rolled the
window and made the count irrelevant. Absence is a statement about the caller's
wiring, and answering it with a window calculation would hide the wiring bug
behind a pass.

Two things this deliberately does not do. It does not read `Date.now()` — a
value a library reads more than once can differ between reads, and one sampled
number keeps the evaluator deterministic under test, which is what lets the
window-roll rule be tested at all rather than only observed. And it takes no
timezone: UTC is the only day boundary that needs no input and cannot drift
between a caller and the library. A deployment that needs local midnight rolls
its own counter and leaves `invocationsPerDay` undeclared.

## Dry-run-first

The first execution of a mutating script and parameter shape in a run must be
a dry run whose outcome the agent inspects, before the real run becomes
eligible for `auto-approved`.

```typescript
function agentActionShapeKey(action: M3LAgentAction): string;
```

The shape key is `canonicalJsonHash` from `core/json` — the existing one, not a
new hash — over exactly this value, built from the library's own validated
projection and from nothing else:

```typescript
canonicalJsonHash({
  script: record.script,
  operation: record.operation, // dropped from the digest when undefined
  kind: record.kind,
  parameterNames: [...record.parameterNames].sort(compareByCodePoint),
});
```

Every part of that literal is normative, because **the key is a stored value**.
This page endorses seeding a ledger from a durable store, which means a key
written by one version must equal the key computed by the next. Changing the
field set, the key names, the nesting, or the comparator is therefore a
**breaking change** needing a major, not an implementation detail.

Three specifics the literal fixes:

- `operation` is passed as `undefined` when absent, and `canonicalJsonStringify`
  drops keys that serialise to `undefined` — so an action with no operation
  hashes as if the key were never written. Harmless, since a present
  `operation` is always non-blank, but it is the observable behaviour and a
  reimplementation must match it.
- The names are sorted with **the same code-point comparator `core/json` already
  uses for object keys**, not a bare `.sort()`. Default `Array.prototype.sort`
  orders by UTF-16 code unit, which disagrees with code-point order above the
  BMP; `core/json` chose the code-point comparator for exactly that reason and
  the two must not diverge inside one hash.
- The array is **copied** before sorting. `record.parameterNames` is frozen, so
  an in-place sort would throw — and sorting the record itself would change what
  the decision log reports the caller asked for.

Hashing the caller's object instead of the projection would key on property
order and on fields the projection deliberately drops.

**The hash itself had to be hardened for this to hold.** `canonicalJsonHash`
defers to a value's `toJSON()` before deciding its shape, matching
`JSON.stringify` — and that lookup walks the prototype chain, which is the one
read in this whole path that is not an `Object.hasOwn` presence check. With
`Object.prototype.toJSON = () => 0` every value hashed identically, so every
shape key collapsed to one digest and a completed dry run of `get-item`
auto-approved a `delete-table` on the same script. `core/json` now ignores a
`toJSON` whose owning prototype is `Object.prototype` or `Array.prototype` —
neither natively defines one, so a `toJSON` found there is a pollution gadget by
construction — while `Date` and any custom `toJSON`, own or inherited, keep
working unchanged. Hardening the module and then routing its authorization
token through an unhardened primitive is the mistake this records.

Sorting the names makes the key a property of the parameter **set**: an agent
that reorders its arguments between the dry run and the real run has not
changed what it is about to do. Duplicates are preserved rather than collapsed,
because ACT-6 records the list verbatim and a list with a repeat is a different
list.

`target` is **not** in the key. That looks like the fail-open choice and is
not, because step 5 grades the target on **every** evaluation and returns
before step 6 is ever reached — a dry run against a sandbox profile cannot
smuggle a production one past, since the production target escalates at step 5
regardless of what the ledger says. Including the target would multiply the
dry runs a deployment owes by every profile and region it touches, and buy no
authorization property that step 5 does not already hold.

`agentActionShapeKey` and `M3LAgentActionRecord.shapeKey` are two doors to one
computation, and both exist because the caller needs the key at two different
moments. After an escalation the key is already on the decision
(`decision.action.shapeKey`) and recomputing it would be a second code path
that has to agree with the first forever. Before any evaluation — seeding a
ledger from a previous run, or from a durable store — there is no decision to
read it from, and the exported function is the only way. It validates its
argument by **ACT-1 through ACT-9** — every rule that is about the action itself
— plus the same `traversal-threw` wrapper, throwing
`M3LAgentActionValidationError`. It cannot apply ACT-10 through ACT-15: those
judge the options bag, its policy, its predicate, and its ledger, and this
function receives none of them. So it cannot produce a key for an action the
evaluator would reject, and it demands nothing the evaluator would not.

Its `context.field` reads `"action"` for **every** failure, not only a
top-level one: a nested violation like `action.target.profile` still reports
`"action"`, because the whole argument is the action and there is no outer bag
to distinguish it from. That is deliberately unlike the evaluator's wrapper,
which reports `"options"`. There is no options bag here, and
naming one would send a reader looking for a parameter that does not exist.

### Seeding a ledger from a durable store

`M3L_AGENT_MAX_DRY_RUN_SHAPES` is reject-above and never truncates, and a
long-lived deployment's store will eventually hold more than 256 distinct
shapes. At that point a naive seed throws `M3LAgentActionValidationError` rather
than silently dropping entries — which is the correct half of the behaviour,
since a silently dropped shape would demand a dry run the agent already
performed.

The half this module does **not** decide is _which_ shapes to carry when the
store outgrows the bound. That is a deployment policy, not a library one: most
recent, most frequent, or scoped to the current run all defend themselves, and
the library has no basis to choose. A caller seeding from a store must therefore
bound its own selection to 256, and should expect to, rather than discovering
the throw in production.

### Why `escalate` and not `denied`

Denial is a statement about **authority**: the agent may not do this at all,
and no runtime event changes that. Dry-run-first is a statement about
**sequence**: the agent may do it, just not yet, and there is a legitimate
in-run path to `auto-approved` that the agent can take by itself.

That difference is the one an operator acts on. `denied` means stop and change
the declaration; `escalate` means a human looks, or the agent performs the dry
run and asks again.

### What the discipline can and cannot move

Step 6 sits below step 5 and above step 7, so it can only move a verdict from
`auto-approved` to `escalate` — never the reverse. A sensitive target still
escalates at step 5 whether or not it has been dry-run, and a non-allowlisted
script is still `denied` at step 1. Dry-run-first adds a requirement; it
removes none.

An action that declares `dryRun: true` **is** the dry run and skips step 6.
It does not skip step 5: dry-running against a production target is still an
escalation, because a dry run is a real call to a real account and ADR-0048
grades the target, not the intent.

## The decision-log entry

[ADR-0061](../../adr/0061-agent-decision-log.md) is V7, and it lands in this
submodule in two slices. **This slice adds the entry only** — a schema, a pure
projector from a decision to one record, and a serializer to one JSONL line. It
writes nothing. The appender, its segment rotation, and the loud write failure
are slice 2, and they are what will qualify the purity claim in
[Overview](#overview); after this slice that claim still holds unqualified.

### Why a log at all

ADR-0060 decides and records nothing. Without a durable trail the programme's
autonomy claim is unreviewable: the CLI history is a 100-entry
overwrite-on-cap ring buffer, and `run-report.json` is classified by ADR-0035
as a **sensitive** crash-dump artifact that only exists when a run happened. So
the two verdicts an auditor most needs — `denied` and `escalate`, where by
construction nothing ran — leave no trace anywhere today.

ADR-0035's 2026-08-20 Update already registers the third artifact class this
fills: append-only, non-sensitive **by construction**, retained rather than
pruned.

### Names, never values — structurally

The projector never sees the caller's action object. Its input is
`M3LAgentDecision.action`, which is already this library's own frozen
`M3LAgentActionRecord`: `parameterNames` is a copy of the **names**, and no
parameter value was ever admitted into it in the first place.

That is worth stating precisely, because it is a stronger guarantee than the
usual one. This is not a redaction pass that has to be complete to be correct —
ADR-0035 records how badly that class of argument converges. There is simply
nothing in the projector's reach to redact.

`tokens` and `cost` are plain structural numbers, exactly as
`M3LAgentRunLedger.tokensThisRun` and `.costThisRun` already are. This module
cannot import `aws/bedrock-runtime`'s token-usage type — ADR-0009's zone 3b
forbids `core/**` from reaching `aws/**`, and `bin/check-eslint-zones.mjs`
enforces it — and should not want to: the log has to stay readable in a
deployment that never invokes Bedrock at all.

### Every verdict is recorded

`agentDecisionLogEntry` takes **any** `M3LAgentDecision` and filters nothing.
Recording only what ran would reproduce exactly the gap that motivates the log.

### The clock stays outside the module

`now` is caller-sampled, the same discipline `M3LAgentRunLedger.now` already
imposes. `timestamp` is the ISO-8601 UTC rendering of that instant, derived
purely — the same `now` always yields the same string — because an audit line
an operator greps should be readable without a converter.

`now` must be a finite safe integer within the range `Date` can represent.
Anything else throws rather than emitting a record stamped `Invalid Date`: an
audit entry that cannot be placed in time is worse than a loud failure.

### Identity is caller-supplied

`M3LAgentIdentity` carries a required logical `name` and an optional `modelId`
and `awsPrincipal`. The library resolves **none** of it, and could not: no
principal resolver exists in `core/`, and `aws/` is unreachable from here.

Its optional fields are typed `?: string` — the plain narrow spelling, not
the `?: T | undefined` widening and not the "required, holding `undefined`" form
`M3LAgentActionRecord` uses. The record uses that third form because it is
built by the library and handed to callee code; `M3LAgentIdentity` is written
by a caller, so it follows `M3LAgentAction`'s precedent instead.

The narrow spelling works in both directions because the projector emits
**omitted** keys rather than `undefined`-holding ones, so a returned identity
re-passes cleanly. It is also the stricter choice, and deliberately so: the
validator reads presence with `Object.hasOwn`, so a key present holding
`undefined` is malformed input rather than an absent field. The narrow type
makes `{ name: "bot", modelId: undefined }` a **compile** error instead of a
runtime throw. The same applies to `M3LAgentDecisionOutcome`'s and
`M3LAgentDecisionLogEntryOptions`' optionals.

### What an entry carries

`M3LAgentDecisionLogEntry` is a flat, frozen, plain-JSON record:

- `timestamp` — ISO-8601 UTC, derived from the caller's `now`.
- `identity` — a frozen copy of the supplied `M3LAgentIdentity`.
- `script` / `operation` / `kind` / `target` / `parameterNames` / `shapeKey` —
  copied from the decision's frozen `M3LAgentActionRecord`.
- `verdict` / `rule` / `reason` — the decision itself.
- `outcome` — an `M3LAgentDecisionOutcome`, present only when something ran.
  An `auto-approved` action runs, and so does an `escalate` a human then
  approves, so both can carry one. A `denied` action never runs, so in practice
  it never should — but the type does not forbid the pairing, deliberately: an
  audit log that cannot represent a thing that should not have happened cannot
  record one either.
- `tokens` / `cost` — plain numbers, present only when the caller reported
  them.

`kind` and `reason` are recorded deliberately. `kind` is the module's one trust
boundary (see [The trust boundary](#the-trust-boundary)) — a log that omits
whether an action was declared read-only or mutating omits the single claim an
auditor most needs to check. `reason` is library-authored prose that ADR-0060
already documents as safe for a log sink: it is composed only from the script,
operation, kind, target coordinates, and a budget's own declared ceiling and
observed count, and it never embeds a parameter value.

`target` carries only `profile` / `region` / `accountId` — the coordinates the
verdict `reason` already names in prose. Recording them as fields as well is
what makes a log queryable rather than merely readable.

### What an outcome carries

`M3LAgentDecisionOutcome` is the "and then what happened" half of an entry, and
its fields reach the audit schema verbatim:

- `dryRun` — **required** `boolean`. Whether the run that happened was a dry
  run. Required rather than optional because "we did not record whether this
  was a rehearsal" is not a state an audit trail should be able to express.
- `exitCode` — optional integer, the process exit code where there was one.
- `registryName` — optional non-blank string, the name the run was recorded
  under in the caller's own registry, so a log line can be joined back to it.

The whole outcome is optional on the entry, because most entries record a
decision that never ran.

### `M3L_AGENT_MAX_LOG_ENTRY_BYTES`

`65536` — the ceiling on one serialized line's UTF-8 byte length.

It is exported in this slice but **enforced in slice 2**, by the writer, where
it belongs: the reason for a ceiling is that a single oversized `write()` is
where a line-delimited append can tear, and only the writer performs one.
`serializeAgentDecisionLogEntry` deliberately does not enforce it — a caller
that wants to check can measure the string it just received.

It is a bloat and tear-risk bound, not a proof of atomicity; slice 2 records
the durability stance in full.

### `agentDecisionLogEntry`

```typescript
function agentDecisionLogEntry(
  options: M3LAgentDecisionLogEntryOptions,
): M3LAgentDecisionLogEntry;
```

An options bag rather than positional parameters, for the reason
`M3LAgentEvaluationOptions` already records: slice 2 needs to add fields, and
on a bag that is additive.

- `decision` — the `M3LAgentDecision` to record. Required.
- `identity` — the acting agent. Required.
- `now` — the caller-sampled instant, epoch milliseconds. Required.
- `outcome` / `tokens` / `cost` — optional; omitted fields are omitted from the
  entry rather than written as `null`.

The returned entry is deep-frozen and shares no object by reference with
either argument, so a caller mutating its identity afterwards cannot make two
entries disagree — the same rule step 0 already applies to the action.

**Throws `M3LAgentActionValidationError`** when the bag is structurally
malformed. The full set:

- `options` itself is not a plain object, or carries an unknown or **dangerous**
  key.
- `identity` is missing or not a plain object; `identity.name` is blank or not a
  string; `identity.modelId` or `identity.awsPrincipal` is present but blank or
  not a string.
- `now` is missing, is not a number, is not an integer, is `NaN` or `±Infinity`,
  or falls outside the range `Date` can represent.
- `tokens` or `cost` is negative or non-finite.
- `outcome` is present but not a plain object; `outcome.dryRun` is missing or
  not a boolean; `outcome.exitCode` is not an integer; `outcome.registryName` is
  blank or not a string.
- `decision` is missing, is not a plain object, or is structurally malformed —
  a non-object `decision.action`; a blank `decision.action.script` or
  `.shapeKey`; a malformed `.parameterNames` or `.dryRun`; a blank
  `decision.reason`; a `decision.action.operation` that is present and neither
  `undefined` nor a non-blank string; a `decision.action.target` that is present but not a plain
  object, or whose `profile` / `region` / `accountId` is present-and-blank or
  non-string, or which carries an unknown key.
- `decision.verdict`, `decision.rule` or `decision.action.kind` holds a string
  that is **not a member of its union**. These get their own violation
  vocabulary — `not-a-known-verdict`, `not-a-known-rule-id`,
  `not-a-known-kind` — kept distinct from `blank-or-non-string` so "you sent
  nothing" and "you sent something we do not recognise" stay tellable apart.
  Membership matters because the projection **asserts** these types onto the
  entry: without the check, an entry could carry `verdict: "banana"` typed as
  `M3LAgentVerdict`.
- A throwing accessor or `Proxy` trap encountered while reading the bag, which
  surfaces as a wrapped failure with the underlying error chained as `cause`.

Its `context` names the offending field and the violation kind, **never a
value** — the same discipline both existing errors on this module follow.

**Every field the projector reads is proven** — `target` and `operation`
included. That last
one is not a footnote: `target` is read and copied field-by-field, so an
unvalidated `action.target = "prod"` produced `"target":{}` — an entry that
silently lost the account and region coordinates an auditor needs, while
looking entirely well-formed. An unvalidated `operation` was worse still: a
non-string one carried a **caller-supplied value** straight into the log,
breaking the names-never-values guarantee this module exists to provide.

That gap was found three times, on three different fields, before it was closed
as a class. The key allowlists are now derived from `Record<keyof T, true>`
proof objects mirroring `M3LAgentDecision`, `M3LAgentActionRecord` and
`M3LAgentActionRecordTarget`, so a field added to any of them without a
matching proof entry is a **compile error**, not a silent hole. That closes
allowlist drift; it cannot prove a validation _call_ exists per admitted key,
which is recorded in the source as a known limit rather than papered over.

`decision` is validated rather than trusted even though `evaluateAgentAction`
is the only thing that produces one. In a fully-typed call graph a malformed
decision cannot arise; the moment one crosses a process, queue, or
serialization boundary it can, and an unvalidated projection would answer with
a **frozen, plausible, throw-free entry silently missing `script`, `kind`,
`shapeKey` and `target`**. A false audit record is worse than no audit record,
so a malformed input is a bug to surface loudly; it is never folded into an
entry.

### `serializeAgentDecisionLogEntry`

```typescript
function serializeAgentDecisionLogEntry(
  entry: M3LAgentDecisionLogEntry,
): string;
```

One entry to one JSONL line, **without** a trailing newline — the writer owns
the separator, so a caller composing lines cannot end up with a blank record
between them. Absent optional fields are omitted from the JSON, not emitted as
`null`.

A parser must therefore treat `outcome`, `tokens` and `cost` as possibly-absent
keys — and `operation` and `target` too. Those two are "required, holding
`undefined`" on the entry, inherited from `M3LAgentActionRecord`, and
`JSON.stringify` drops an `undefined`-valued key just the same. An action with
no operation and no target produces a line with neither key present.

JSONL rather than a JSON array was chosen for the reason slice 2 depends on: a
line-delimited format is the one shape that survives two processes appending
concurrently.

## Writing the decision log

V7 slice 2. This is the slice that makes the module impure, and the
[Overview](#overview) purity claim is rescoped accordingly: **the evaluator**
is pure — `evaluateAgentAction` still performs no I/O, reads no clock, and
holds no module-level state. The writer is not, by design.

### The writer

`M3LAgentDecisionLog` appends serialized entries to a segmented, append-only
JSONL stream under `data/agent-log/`. It creates the directory itself.

The default directory is `new M3LPaths().getDataDir()` + `"agent-log"`, and is
overridable through the options bag. That override, plus the `M3L_DATA_DIR`
environment override `M3LPaths` already honours, is what keeps a test out of
the real `data/`.

### Durability and concurrency, stated rather than assumed

The active segment is opened with `O_APPEND` (`flag: "a"`) and each call writes
one `JSON.stringify(entry) + "\n"`.

`O_APPEND` makes the seek-to-end and the write a **single atomic step** against
other writers on a local filesystem, so two concurrent agent processes
interleave whole lines rather than corrupting one. That is exactly the
guarantee a line-delimited format needs, and it is why JSONL was chosen over a
JSON array — an array would need every writer to rewrite the closing bracket.

Two limits are recorded rather than papered over:

- The guarantee does **not** hold across NFS.
- A single `write()` larger than the pipe buffer is not guaranteed atomic. The
  writer therefore enforces `M3L_AGENT_MAX_LOG_ENTRY_BYTES` and throws rather
  than emitting a line that might tear.

ADR-0061 already records that "append-only" here is **filesystem-honest, not
cryptographically tamper-evident**. Anyone who can write the file can rewrite
it; the property being bought is that the library itself never rewrites or
truncates, so an operator's own audit trail is not silently edited by the tool
it is auditing.

### Cold-start segment discovery

On first write the writer lists `data/agent-log/`, picks the highest-numbered
segment for the current date prefix, and `stat`s it to decide seal-vs-append
against both ceilings.

There is **no index file and no in-memory state carried across processes** —
the directory listing is the state. A freshly spawned process and a long-lived
one therefore agree about which segment is active, which is the only way the
concurrency stance above survives a restart.

### Rotation

- `M3L_AGENT_LOG_MAX_SEGMENT_BYTES` — 8 MiB.
- `M3L_AGENT_LOG_MAX_SEGMENT_AGE_MS` — 24 hours.

Both are exported and both are caller-overridable through the options bag.
Crossing either ceiling seals the active segment and opens a new one.

**Segments are retained, never pruned and never truncated in place.** A
retention policy is a deployment decision, and a library that silently deletes
an audit trail is worse than one that grows.

### Write failure is loud

A failed append throws `M3LAgentDecisionLogWriteError`
(`ERR_AGENT_DECISION_LOG_WRITE`). It is never swallowed and never downgraded to
a warning.

The reasoning is the whole point of the slice: an action that cannot be audited
must not run unaudited. A silent write failure would produce exactly the
condition ADR-0061 exists to prevent — an autonomous operator acting with no
record — and would produce it precisely when something is already wrong with
the host.

Like both existing errors on this module, its `context` names the offending
field and the failure kind and **never carries caller data**.

## Escalating when the log is unavailable

The evaluator stays **pure and synchronous**. It does not probe the filesystem,
because a pure function cannot, and because a probe would be a
time-of-check-to-time-of-use lie anyway.

Instead this follows the budgets and dry-run-first idiom exactly: the caller
observes, and hands the observation back.

1. **Policy-declared opt-in.** `M3LAgentPolicyDeclaration.requireDecisionLog`
   takes the same **strict-`true`** polarity as `dryRunFirst` — `false` means
   the same as absent.
2. **Caller-observed health.** `M3LAgentRunLedger.decisionLogAvailable`
   reports what the caller found.
3. **Two new rule ids**, taking the union from 20 to 22:
   - `decision-log-unavailable` — declared, and observed `false`.
   - `decision-log-unavailable.unobservable` — declared, but the caller
     supplied no observation at all.

The declared-vs-unobservable split is the one the five `budget.*.unobservable`
ids already use, and for the same reason: "you asked for a discipline and gave
me nothing to check it with" is a different operational fault from "the thing
you asked me to check is broken", and an operator needs to tell them apart.

### Why the opt-in is not optional

Without the policy gate, this rule would escalate actions for every existing
caller that never passes the new ledger field — a behavioural break shipped as
an additive minor.

Gated on `requireDecisionLog`, a policy that does not declare it reaches
exactly the arms it reaches today, in the same order, with the same verdict.
That is a property the existing test suite proves, not a claim.

### Where it sits: step 3b

Immediately **after** budgets (step 3) and **before** the autonomy tier
(step 4).

- **Above step 4** for the reason step 3's own comment already argues for
  budgets: an unauditable _read-only_ action is unauditable too. Placing it
  here covers both auto-approval arms — `read-only-auto-approved` at step 4 and
  `graded-mutation-auto-approved` at step 7 — in one place rather than two.
- **After step 3**, so an action that is already budget-exhausted keeps
  reporting its budget rule. The first fault an operator sees should be the one
  that was true first.
- **Below the two deny arms** (steps 1 and 2), so a denied action stays denied.
  A denial needs no audit record to be safe, because nothing runs.

## Compatibility with `core/prompt`

This module **rides** ADR-0048's grades. Three consequences worth stating
plainly:

1. Sensitivity is classified by `sensitiveTargets` from `core/prompt`, called
   with the declaration's own spec. This module contains no matching logic.
2. The policy layer never emits `yesSensitive` on its own authority. A
   sensitive mutation is always `escalate`, whatever any flag says.
3. A passed destructive gate is not evidence of entitlement, and this module
   never reads one. The two controls are independent: the gate asks a human
   _are you sure_, the policy asks _is this agent allowed at all_.

### Why this module cannot import `core/script`

`eslint.config.js`'s ADR-0009 Zone B forbids every `core/**` module except
`core/script` itself from importing `core/script`, and
`import-x/no-restricted-paths` is not type-aware, so `import type` is blocked
too. The allowlist therefore keys on a plain script **name** string. This is
the same wall that forced `core/cli-contract` to drop its `M3LScript`
composition.

## Example

```typescript
import { Core } from "@m3l-automation/m3l-common";

const policy = Core.validateAgentPolicy({
  version: 1,
  scripts: [
    { script: "s3-report", allOperations: true },
    { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
  ],
  sensitiveTargets: { profiles: ["prod"], regions: ["eu-west-1"] },
});

const decision = Core.evaluateAgentAction({
  policy,
  action: {
    script: "dynamodb-crud",
    operation: "put-item",
    kind: "mutating",
    target: { profile: "sandbox", region: "eu-central-1" },
    parameterNames: ["table", "item"],
  },
});

if (Core.isAgentActionAutoApproved(decision)) {
  // decision.rule === "graded-mutation-auto-approved"
} else {
  // decision.verdict is "escalate" or "denied"; decision.rule says which rule,
  // decision.action is the frozen projection to record in the decision log.
}
```

With slice 2's budgets and dry-run-first declared, the caller also hands over
what it has observed, and advances that ledger itself:

```typescript
const governed = Core.validateAgentPolicy({
  version: 1,
  scripts: [
    {
      script: "dynamodb-crud",
      operations: ["get-item", "put-item"],
      readOnlyOperations: ["get-item"],
    },
  ],
  sensitiveTargets: { profiles: ["prod"] },
  budgets: { invocationsPerRun: 50, costPerRun: 5 },
  dryRunFirst: true,
});

let run: Core.M3LAgentRunLedger = {
  invocationsThisRun: 12,
  costThisRun: 0.42,
  dryRunCompletedShapes: [],
  now: Date.now(), // sampled by the CALLER, once — the library reads no clock
};

const first = Core.evaluateAgentAction({ policy: governed, action, run });
// first.verdict === "escalate", first.rule === "dry-run-first"

// ... the agent performs the dry run and inspects it, then records the shape:
run = {
  ...run,
  dryRunCompletedShapes: [
    ...(run.dryRunCompletedShapes ?? []),
    first.action.shapeKey,
  ],
};

const second = Core.evaluateAgentAction({ policy: governed, action, run });
// second.verdict === "auto-approved"
```

## Out of scope

- **Retaining or pruning** the decision log. Segments are sealed and rotated,
  never deleted and never truncated in place: a retention policy is a
  deployment decision, and a library that silently drops an audit trail is
  worse than one that grows.
- **Probing** whether the log is writable, from the evaluator. It reports what
  the caller observed; a probe from a pure function is impossible and would be
  a time-of-check-to-time-of-use lie besides.
- Reading a policy file. The module takes a parsed value; a caller owns the
  I/O, exactly as every other pure Core module does.
- Enforcing the verdict. This layer decides; a caller that ignores the decision
  is not bounded by it.
- Detecting whether an action mutates. `readOnlyOperations` lets a
  declaration hold a second opinion, but it is still a declaration — see
  [The trust boundary](#the-trust-boundary).
- Counting anything. Budgets are compared, never accumulated: the caller owns
  the ledger and advances it, which is what keeps the evaluator pure and two
  concurrent runs from sharing a ceiling.
- Reading a clock. Per-day windows roll from a timestamp the caller sampled.

## See also

- [ADR-0060 — Agent policy layer](../../adr/0060-agent-policy-layer.md)
- [ADR-0048 — Target-graded destructive confirmation](../../adr/0048-target-graded-destructive-confirmation.md)
- [ADR-0061 — Agent decision log](../../adr/0061-agent-decision-log.md)
- [ADR-0009 — Dependency-direction guard](../../adr/0009-dependency-direction-guard.md)
- [`core/prompt`](./prompt.md) — the grading vocabulary this module rides.
- [`core/json`](./json.md) — `canonicalJsonHash`, used by slice 2's shape key.
