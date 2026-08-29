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

The module is pure: it performs no I/O, reads no clock, opens no file, and
holds no module-level state. A caller feeds it the parsed contents of a JSON or
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

| Slice                          | Scope                                                                                                                            | Status  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V6 slice 1 — verdicts          | The action/policy/verdict vocabulary, the declaration validator, and the evaluator's allowlist + autonomy-tier arms. 20 exports. | Landed  |
| V6 slice 2 — budgets + dry-run | Per-run/per-day budgets and ceilings, the run ledger, named exhaustion outcomes, and the dry-run-first discipline.               | Pending |

Deliberately **not** in this slice, and why:

- **The agent decision log.** [ADR-0061](../../adr/0061-agent-decision-log.md)
  is V7 and co-lands in this same submodule later. Slice 1 makes the log
  possible — every verdict names the rule that produced it, and carries the
  library's own frozen projection of the action rather than the caller's
  object — but writes nothing anywhere.
- **ADR-0055's richer operation vocabulary.** A grant allowlists operation
  **names**, plain strings. `core/config`'s `M3LOperationDeclaration` is a soft
  dependency and stays soft; a caller derives the names it allowlists and hands
  them over as data. No type from `core/config` is imported.
- **The A2 target-grading retrofit.** It is a soft prerequisite, neutralised by
  the fail-closed default in
  [Why an ungraded target is sensitive](#why-an-ungraded-target-is-sensitive).
  Nothing here waits on it.

This slice takes Core from 24 to 25 submodules (fleet total 44 → 45).

## Public API

```typescript
import { Core } from "@m3l-automation/m3l-common";
// or: import { ... } from "@m3l-automation/m3l-common/core";
```

Exported symbols — twenty in slice 1.

**The action under judgement** — what a caller describes:

- `M3LAgentActionKind` — `"read-only" | "mutating"`, the caller's declared tier.
- `M3LAgentAction` — the intended action a caller submits.
- `M3LAgentActionRecord` — the library's frozen projection of that action,
  carried on every verdict.
- `M3L_AGENT_MAX_PARAMETER_NAMES` — `256`, the ceiling on
  `M3LAgentAction.parameterNames`.

**The declared authority** — what a deployment writes down:

- `M3LAgentScriptGrant` — one script's grant.
- `M3LAgentPolicyDeclaration` — the plain-JSON, preset-storable declaration.
- `M3LAgentPolicy` — a validated, deep-frozen, **branded** policy. Only
  `validateAgentPolicy` can produce one.
- `validateAgentPolicy` — the boundary parser/validator.
- `M3L_AGENT_MAX_SCRIPT_GRANTS` (`128`) /
  `M3L_AGENT_MAX_OPERATIONS_PER_GRANT` (`128`) /
  `M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES` (`256`) — the declared structural
  ceilings. Every one is a **reject-above** bound: `length > MAX` throws,
  `length === MAX` is accepted.

**The verdict** — what the evaluator returns:

- `M3LAgentVerdict` — `"auto-approved" | "escalate" | "denied"`. Closed.
- `M3LAgentPolicyRuleId` — names the rule that produced a verdict. A closed
  literal union today that **grows in later minors**.
- `M3LAgentDecision` — the discriminated verdict.
- `isAgentPolicyRuleId` — type predicate over the ids **this build** knows.
- `isAgentActionAutoApproved` — the one correct approval gate.

**The evaluator** — the entry point itself:

- `M3LAgentEvaluationOptions` — the options bag.
- `evaluateAgentAction` — the evaluator.

**Errors** — both thrown, never returned:

- `M3LAgentPolicyDeclarationError` (`ERR_AGENT_POLICY_DECLARATION`).
- `M3LAgentActionValidationError` (`ERR_AGENT_INVALID_ACTION`).

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
`M3LAgentActionRecordTarget` is not surfaced through the barrel (slice 1's
public surface is fixed at twenty exports); name it as
`NonNullable<M3LAgentActionRecord["target"]>`.

The two `sensitivity` predicates — the declared spec's and the caller's
`additionalSensitiveTargets` — still receive a genuine `M3LDestructiveTarget`,
with an undeclared scalar **omitted** rather than present-and-`undefined`. That
is what ADR-0048's predicate contract promises, and a grading list is always a
non-empty list of non-blank strings, so an omitted scalar and an `undefined`
one grade identically.

The required-holding-`undefined` form is deliberate and follows the reasoning
already written for `M3LCommandContext.signal` in `core/cli-contract`: this is
a **library-built** record handed to callee code — the ADR-0061 writer — so the
stricter form applies. `dryRun` is required here now, so slice 2 adds no
required field to a type test fakes construct.

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

Step 0 validates the evaluator's whole options bag before any rule runs. Every
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
    bag is allowlisted to `action`, `policy`, and
    `additionalSensitiveTargets`, exactly as `action` is allowlisted by ACT-8.
    Two reasons. A typo'd `additionalSensitiveTarget` — one `s` short — is
    caught by TypeScript only for a fresh call-site object literal, never for
    a bag built as a variable, and silently evaluates with **no** extra
    sensitivity predicate at all. And it is deliberate for slice 2: a caller
    passing slice 2's per-run state to an older library must fail loud, not
    silently lose its budget ceilings.
12. **ACT-12** `options.policy` is a policy `validateAgentPolicy` itself
    produced — see [The trust boundary](#the-trust-boundary). Absent, `undefined`,
    and forged all reject identically.

Field presence is read with `Object.hasOwn`, never `field !== undefined`, so a
non-own `"__proto__"` resolves as absent.

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
Slice 2 adds an optional declared cross-check (`readOnlyOperations` on a grant)
for deployments that want the policy to hold the second opinion.

## The policy declaration

```typescript
interface M3LAgentScriptGrant {
  readonly script: string;
  readonly operations?: readonly string[];
  readonly allOperations?: boolean;
}

interface M3LAgentPolicyDeclaration {
  readonly version: 1;
  readonly scripts: readonly M3LAgentScriptGrant[];
  readonly sensitiveTargets?: M3LSensitiveTargetSpec;
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
11. **any unknown key**, at the top level, on a grant, **or on the
    `sensitiveTargets` object**. An unrecognised key in an authorization
    declaration is overwhelmingly a typo'd `operations` or `sensitiveTargets` —
    an accidental widening. Reject, never ignore. The grading spec is included
    deliberately: `{ profiles: ["prod"], regionz: ["eu-west-1"] }` satisfies
    rules 9 and 10 and silently drops every region grading, which is rule 9's
    own fail-open one level down;
12. any key rejected by `isDangerousKey` (defence in depth beyond 11).

Field reads use `Object.hasOwn(record, field)` rather than
`record[field] !== undefined`, because the input is a parsed JSON document and
a non-own `"__proto__"` must resolve as absent.

The traversal is **one pass**: validate and project into a fresh, deep-frozen
structure in the same walk, then brand. Nothing downstream re-reads the
caller's object.

## The tier decision table

The evaluation order below is normative. Each numbered arm is terminal.

```text
evaluateAgentAction({ action, policy, additionalSensitiveTargets }):

  Step 0 — boundary validation + single-traversal projection
      record := the frozen M3LAgentActionRecord projected from `action`
      A malformed options bag THROWS M3LAgentActionValidationError, per the
      twelve ACT rules. `kind` outside the two literals throws HERE, not at
      step 4. Every step below reads `record`, never `action`; every
      decision below carries `record`.

  Step 1 — script allowlist
      grant := the grant whose `script` equals record.script
      if none          -> denied     "script-not-allowlisted"

  Step 2 — operation allowlist
      if grant.allOperations !== true:            (strict true: opt-in)
          if record.operation is absent           -> denied "operation-not-allowlisted"
          if not grant.operations.includes(...)   -> denied "operation-not-allowlisted"

  Step 3 — budgets and ceilings                             [slice 2]
      if a declared budget is exhausted -> escalate "budget.<kind>"

  Step 4 — autonomy tier
      if record.kind === "read-only"    -> auto-approved "read-only-auto-approved"
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

  Step 6 — dry-run-first                                    [slice 2]
      if the shape has not been dry-run in this run
                                        -> escalate "dry-run-first"

  Step 7 — graded, non-sensitive mutation inside the allowlist
                                        -> auto-approved "graded-mutation-auto-approved"
```

Steps 3 and 6 are slice-2 arms, shown here so the full order is stated once.
Slice 1 evaluates 0, 1, 2, 4, 5, 7 and nothing else.

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

`additionalSensitiveTargets === undefined` resolves to `false` through an
explicit ternary rather than `pred?.(t) ?? false`, so "absent, contributes
nothing" stays visually distinct from "present and returned falsy".

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
  | "unclassifiable-escalated";
```

Slice 2 adds `"budget.invocations-per-run"`, `"budget.invocations-per-day"`,
`"budget.tokens-per-run"`, `"budget.cost-per-run"`,
`"budget.loop-iterations"`, and `"dry-run-first"`; V7 adds its own.

Growing it is **additive, not breaking**, because the type appears only in
**return** position: no caller constructs an `M3LAgentDecision`, so a new
member cannot invalidate a caller's value. What a new member _can_ break is an
exhaustive `switch`, so consumers must **not** write one. Treat an unrecognised
id as an opaque label — log it, render it, branch on `verdict` instead.

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
table rather than an array, so adding a ninth id is a compile error here
instead of a silently drifting runtime set.

Slice 1's eight ids:

| Rule id                         | Verdict         | Produced when                                          |
| ------------------------------- | --------------- | ------------------------------------------------------ |
| `script-not-allowlisted`        | `denied`        | No grant names the script.                             |
| `operation-not-allowlisted`     | `denied`        | Operation-scoped grant, operation absent or unlisted.  |
| `read-only-auto-approved`       | `auto-approved` | Allowlisted read-only action.                          |
| `target-ungraded-escalated`     | `escalate`      | Mutation carrying no ADR-0048 target.                  |
| `policy-ungraded-escalated`     | `escalate`      | Mutation, but the policy declares no grading.          |
| `sensitive-target-escalated`    | `escalate`      | The target graded sensitive.                           |
| `graded-mutation-auto-approved` | `auto-approved` | Allowlisted mutation on a graded non-sensitive target. |
| `unclassifiable-escalated`      | `escalate`      | Reserved: a future `kind` no rule handles.             |

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
`kind`, and the target's `profile` / `region` / `accountId`. It never embeds a
parameter value. It is not run through `escapeTerminalControls`: it is a data
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
}

function evaluateAgentAction(
  options: M3LAgentEvaluationOptions,
): M3LAgentDecision;
```

A single options bag rather than positional parameters, chosen so slice 2 is
additive: its per-run state becomes a new **optional** field on a bag callers
already construct. A required field there would be source-breaking for every
test fake.

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
options bag (the twelve ACT rules). It never throws to signal a verdict. It can
still propagate a throw raised inside a caller-supplied
`additionalSensitiveTargets`, unchanged — that exception is the caller's, not
this module's.

## Budgets and exhaustion

_Slice 2 — not yet landed._ Per-run and per-day invocation counts, token and
Bedrock cost ceilings, and a loop-iteration ceiling, declared additively on
`M3LAgentPolicyDeclaration`. Exhaustion is an `escalate` carrying a named
exhaustion outcome (which budget, its ceiling, the observed value), evaluated
at step 3 — above the read-only arm, per the decision recorded above.

The Bedrock cost ceiling is a plain number. No type from `aws/*` crosses into
this module: an ADR-0009 zone forbids it, and the policy layer has no business
knowing how a token was priced.

Per-day windows are driven by a **caller-supplied timestamp**, not an ambient
clock read. There is no injected-clock precedent anywhere in `core/`, and a
callable a library reads more than once can return a different value on each
read; one sampled number, read once, keeps the evaluator pure and
deterministic under test.

## Dry-run-first

_Slice 2 — not yet landed._ The first execution of a mutating script and
parameter shape in a run must be a dry run whose outcome the agent inspects
before the real run becomes eligible for `auto-approved`. The shape key is
computed with the **existing** `canonicalJsonHash` from `core/json`, over a
validated projection of the parameters rather than over the caller's object.

The verdict for an unsatisfied dry-run-first requirement is `escalate`, not
`denied`. Denial is a statement about **authority** — the agent may not do this
at all, and no runtime event changes that. Dry-run-first is a statement about
**sequence** — the agent may do it, just not yet, and there is a legitimate
in-run path to `auto-approved`.

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

## Out of scope

- Writing anything. The decision log is ADR-0061 / V7 and co-lands here later.
- Reading a policy file. The module takes a parsed value; a caller owns the
  I/O, exactly as every other pure Core module does.
- Enforcing the verdict. This layer decides; a caller that ignores the decision
  is not bounded by it.
- Detecting whether an action mutates. See
  [The trust boundary](#the-trust-boundary).

## See also

- [ADR-0060 — Agent policy layer](../../adr/0060-agent-policy-layer.md)
- [ADR-0048 — Target-graded destructive confirmation](../../adr/0048-target-graded-destructive-confirmation.md)
- [ADR-0061 — Agent decision log](../../adr/0061-agent-decision-log.md)
- [ADR-0009 — Dependency-direction guard](../../adr/0009-dependency-direction-guard.md)
- [`core/prompt`](./prompt.md) — the grading vocabulary this module rides.
- [`core/json`](./json.md) — `canonicalJsonHash`, used by slice 2's shape key.
