# CloudFormation Operations

`M3LCloudFormationOperations` is a typed wrapper over a raw
`CloudFormationClient`, so callers never import `@aws-sdk/client-cloudformation`
command classes directly. Surfaced by `scripts/cloudformation-stacks` (roadmap
W3) needing to avoid importing the SDK directly (ADR-0029 — scripts depend
only on `@m3l-automation/m3l-common`).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `AWSClientProvider.cloudFormation`
returns the raw `CloudFormationClient`; `M3LCloudFormationOperations` wraps it
with bespoke, typed methods, translating SDK request/response shapes into
plain, library-owned types so a caller never touches an
`@aws-sdk/client-cloudformation` type.

Scoped to the CloudFormation **stack** resource — list/describe/create/
update/delete, stack-event streaming, and the three stack-lifecycle waiters.
**Deliberately out of scope for this v1**: change sets, stack sets/StackSets
instances, drift detection, stack refactor, template validation/estimation,
and stack-policy management.

- `M3LCloudFormationOperations` — the wrapper class, constructed from a raw
  `CloudFormationClient`.
- `M3LCloudFormationOperationError` — thrown on a request-level CloudFormation
  failure.
- Plain types: `M3LCloudFormationListStacksResult`, `M3LCloudFormationStack`,
  `M3LCloudFormationStackSummary`, `M3LCloudFormationCreateStackInput`,
  `M3LCloudFormationCreateStackResult`, `M3LCloudFormationUpdateStackInput`,
  `M3LCloudFormationUpdateStackResult`, `M3LCloudFormationDeleteStackOptions`,
  `M3LCloudFormationDescribeStackEventsResult`, `M3LCloudFormationStackEvent`,
  `M3LCloudFormationWaiterResult`, `M3LCloudFormationWaitOptions`,
  `M3LCloudFormationKeyValue`, `M3LCloudFormationOutput`,
  `M3LCloudFormationCapability`.
- Options types (declared alongside the methods that take them, not
  constructed by callers otherwise): `M3LCloudFormationListStacksOptions`,
  `M3LCloudFormationDescribeStackEventsOptions`.

## Public API

### `M3LCloudFormationOperations`

**Constructor** — `new M3LCloudFormationOperations(client)`, where `client` is
a raw `CloudFormationClient` (e.g. `script.aws.clients.cloudFormation`).

| Method                                              | Returns                                               | Throws                            |
| --------------------------------------------------- | ----------------------------------------------------- | --------------------------------- |
| `listStacks(options?)`                              | `Promise<M3LCloudFormationListStacksResult>`          | `M3LCloudFormationOperationError` |
| `describeStack(stackName)`                          | `Promise<M3LCloudFormationStack \| undefined>`        | `M3LCloudFormationOperationError` |
| `createStack(input)`                                | `Promise<M3LCloudFormationCreateStackResult>`         | `M3LCloudFormationOperationError` |
| `updateStack(input)`                                | `Promise<M3LCloudFormationUpdateStackResult>`         | `M3LCloudFormationOperationError` |
| `deleteStack(stackName, options?)`                  | `Promise<void>`                                       | `M3LCloudFormationOperationError` |
| `describeStackEvents(stackName, options?)`          | `Promise<M3LCloudFormationDescribeStackEventsResult>` | `M3LCloudFormationOperationError` |
| `waitUntilStackCreateComplete(stackName, options?)` | `Promise<M3LCloudFormationWaiterResult>`              | `M3LCloudFormationOperationError` |
| `waitUntilStackUpdateComplete(stackName, options?)` | `Promise<M3LCloudFormationWaiterResult>`              | `M3LCloudFormationOperationError` |
| `waitUntilStackDeleteComplete(stackName, options?)` | `Promise<M3LCloudFormationWaiterResult>`              | `M3LCloudFormationOperationError` |

`listStacks` pages via `nextToken` (mirrors the SDK's own `NextToken`
pagination — one page per call, no auto-pagination); `nextToken` is present
only when another page exists. By default the SDK's `ListStacks` returns
stacks in every status **including** `DELETED`-family terminal states unless
`options.stackStatusFilter` narrows it — this wrapper passes the filter
straight through with no default narrowing of its own, so a caller wanting
only "live" stacks must supply the filter explicitly.

`describeStackEvents` also pages via `nextToken` (same one-page-per-call
contract). Events are returned in reverse chronological order (mirroring the
SDK), most recent first.

`deleteStack` is **destructive**. This wrapper performs no confirmation gate
of its own — the caller (`scripts/cloudformation-stacks`) is responsible for
its own destructive-operation confirmation, matching every other AWS-consumer
script's convention (§1.5 of the fleet's shared conventions, promoted to
`Core.confirmDestructive`).

#### `describeStack` and the "does not exist" `ValidationError`

`DescribeStacksCommand` declares **no modeled exception classes** — only the
base `CloudFormationServiceException`. A stack CloudFormation cannot resolve
by the given identifier rejects with an **unmodeled** error whose `name` is
`"ValidationError"` and whose `message` contains the substring
`"does not exist"` (verified against AWS's documented error text: `Stack with
id <identifier> does not exist`). `describeStack`'s classifier predicate is
exactly `error instanceof Error && error.name === "ValidationError" &&
error.message.includes("does not exist")` — case-sensitive substring match,
`.name`-based (not `instanceof` against a modeled exception class, since none
exists) — and on a match it **resolves `undefined`** instead of throwing;
every other rejection (including any other `ValidationError` — a malformed
parameter, say — and a bare `Error` with no matching text) throws
`M3LCloudFormationOperationError` chaining the cause.

A successful `DescribeStacks` call whose `Stacks` array is empty or absent
(the SDK types `DescribeStacksOutput.Stacks` as optional, and the type
technically allows a filtered call to return zero matches without erroring)
is treated identically to the does-not-exist `ValidationError` case above —
`describeStack` resolves `undefined`. In practice CloudFormation raises the
`ValidationError` instead of returning an empty array for a `StackName`-filtered
call, so this branch is a defensive fallback for the type's stated
possibility, not an observed behavior. When `Stacks` has one or more entries,
`describeStack` maps the **first** element only and ignores the response's
own `NextToken` (a `StackName`-filtered `DescribeStacks` call resolves to at
most one matching stack in practice).

**This is message-text matching, not a modeled SDK exception** — AWS does not
publish this string as a stable contract, only as documented behavior, so a
future wording change could silently stop matching (the classifier would then
throw instead of resolving `undefined`, which is the safe failure direction:
callers see a loud error rather than a silently-wrong "not found"). Narrower
than "any `ValidationError` is not-found": an unmatched `ValidationError` — a
malformed parameter, say — throws, per the same "an unclassifiable
non-success is treated as a fault, not guessed at" principle
`M3LECSOperations.waitUntilServicesStable` documents.

`describeStack` resolving by **stack name** on a stack that has reached
`DELETE_COMPLETE` raises this same does-not-exist `ValidationError` (deleted
stacks are not resolvable by name); resolving by **stack ID** (ARN) instead
still returns the record for a limited retention window, since CloudFormation
keeps deleted-stack records addressable by ID longer than by name. So a
`describeStack` result of `undefined` means "not resolvable by the identifier
given," not "this identifier never existed."

#### `updateStack` and the "no updates" `ValidationError`

`UpdateStack` rejects with the same unmodeled shape when the submitted
template/parameters are identical to the stack's current state: `name ===
"ValidationError"` with `message` containing the substring `"No updates are
to be performed"` (verified against AWS's documented error text).
`updateStack`'s classifier predicate is exactly `error instanceof Error &&
error.name === "ValidationError" && error.message.includes("No updates are
to be performed")` — the same `.name`-based, case-sensitive substring shape as
`describeStack`'s, not a bare message match with no `name` check. On a match
it **resolves** `{ changed: false }` instead of throwing; every other
successful call resolves `{ changed: true, stackId }`. Every other rejection
(including any other `ValidationError`) throws
`M3LCloudFormationOperationError`. Same caveat as `describeStack`: this is
message-text matching, documented as best-effort per
`.claude/rules/library-src.md`'s under-claim guidance, not a guaranteed
mechanism.

CloudFormation does not consider a change to `Parameters` values alone (with
an unchanged template) as an update in every case — this can also surface the
same "no updates" `ValidationError`; the wrapper does not attempt to
distinguish that nuance from a genuinely-identical template, it only reports
`{ changed: false }` either way.

`createStack`/`updateStack` return **only** `{ stackId }` /
`{ changed, stackId }` on success — the SDK's `CreateStack`/`UpdateStack`
responses carry no stack description, unlike `M3LECSOperations.createService`.
Neither the created/updated `stackId` nor the `waitUntilStack*Complete`
waiters (see below) resolve a stack record either — a `waitUntilStack*Complete`
waiter internally polls `DescribeStacksCommand` to evaluate its own acceptor
conditions, and on a **resolved** outcome (`SUCCESS`/`TIMEOUT`/`ABORTED`) that
internal poll is never surfaced to the caller; its result type is
`M3LCloudFormationWaiterResult` (`{ state, reason? }`) only. This does **not**
hold on the SDK's `FAILURE` terminal state: the SDK's own waiter machinery
embeds the entire last `DescribeStacksCommand` response (verbatim, including
`Parameters`/`Outputs` values) into the plain `Error` it throws in that case,
and this wrapper chains that error as `cause` on the resulting
`M3LCloudFormationOperationError` like any other rejection — so a `FAILURE`
outcome's `cause` **can** carry stack parameter/output values the caller
supplied, and this is not covered by the library's `redactSensitiveLogText`
denylist (CloudFormation's own `NoEcho` parameter masking is a separate,
service-side mechanism and still applies). This mirrors
`M3LECSOperations.waitUntilServicesStable`'s identical shape, which carries
the same caveat. A caller wanting the full stack record on the resolve path
calls `describeStack` separately, after a `createStack`/`updateStack`/successful
wait. `stackId` is typed required on
`M3LCloudFormationCreateStackResult`/on the `changed: true` arm of
`M3LCloudFormationUpdateStackResult`: the SDK types `StackId` as optional, but
its absence on an otherwise-successful `CreateStack`/`UpdateStack` response is
a genuine API/SDK anomaly (mirrors `M3LECSOperations.createService`'s
treatment of an absent `.service`), so this wrapper throws
`M3LCloudFormationOperationError` rather than silently omitting the field.

`deleteStack` on a stack that no longer exists is a CloudFormation **no-op
success**, not an error — the SDK's `DeleteStack` call resolves normally in
that case, and this wrapper passes that resolution straight through as
`void`.

### Waiters

All three waiters wrap the SDK's own (current, non-deprecated)
`waitUntilStackCreateComplete`/`waitUntilStackUpdateComplete`/
`waitUntilStackDeleteComplete` functions (not `Command`s — CloudFormation
waiters, like ECS's, are standalone exports from
`@aws-sdk/client-cloudformation`), each inside a `try`/`catch`: the waiter
itself throws on a non-`SUCCESS` terminal state (via the SDK's own
`checkExceptions` helper) rather than resolving with one, so each method's
whole contract is translating that catch back into a resolved value where it
can — mirroring `M3LECSOperations.waitUntilServicesStable` exactly.

`options?.maxWaitTime` defaults to **3600 seconds (60 minutes)** when the
caller omits it. Unlike ECS, the installed SDK's waiter framework
(`@smithy/core`'s `createWaiter`) sets **no default `maxWaitTime` of its
own** — it is a required field that a caller must supply, validated `> 0` and
`> minDelay` at call time (CloudFormation's generated waiters set
`minDelay: 30`/`maxDelay: 120`, so the real floor is `maxWaitTime > 30`, not
the framework's generic `> 0`/`> minDelay` check alone). This wrapper's 3600s
default instead matches the published AWS CLI/botocore waiter configuration
for all three CloudFormation stack waiters (`waiters-2.json`: `Delay: 30`,
`MaxAttempts: 120` — the same nominal 30s × 120 = 3600s budget for
`StackCreateComplete`, `StackUpdateComplete`, and `StackDeleteComplete`
alike), matching the precedent `M3LECSOperations.waitUntilServicesStable` set
(deriving its 600s default from the AWS CLI's own ECS wait budget rather than
an SDK-side default). Because the JS SDK's waiter backs off exponentially
between `minDelay`/`maxDelay` rather than polling at a fixed 30s cadence like
the CLI's waiter, a 3600s `maxWaitTime` yields **fewer** than 120 actual SDK
polls — the CLI's `Delay × MaxAttempts` figures are the source of the 3600s
figure, not a claim that this wrapper reproduces the CLI's exact poll count.
There is no pre-flight bounds-check on `options.maxWaitTime` in this wrapper
(consistent with "no pre-flight validation guards" below): an out-of-range
value (`<= 0`, or `<= 30` against CloudFormation's `minDelay`) is passed
straight to the SDK waiter, which throws a plain, unnamed `Error` at
construction — indistinguishable by identity from any other unclassified
waiter rejection, so it surfaces as `M3LCloudFormationOperationError` like
any other misconfiguration, not a dedicated validation error.

**A caught error named `"TimeoutError"` resolves `{ state: "TIMEOUT", reason }`**,
where `reason` is a fresh, static, library-constructed string naming the stack
that was waited on. (The method name reaches the thrown
`M3LCloudFormationOperationError` on the fault path, but not the resolved
`reason`.) It is deliberately **not** the SDK error's own
`message`: `@smithy/core`'s `checkExceptions` builds that message by serializing
the whole waiter result, which can embed the last observed `DescribeStacks`
response — including caller-supplied parameter and output values. This mirrors
the treatment `aws/eks`'s waiters already apply for the same reason.

**A caller-signal abort rejects rather than resolving.** All three methods accept
`options.signal` and forward it to the SDK waiter's `abortSignal`, so a
cancellation stops the in-flight request. When the signal aborts, the method
rejects with
[`M3LOperationAbortedError`](../core/errors.md#m3loperationabortederror)
(`ERR_OPERATION_ABORTED`, `origin: "caller"`, `retryable: false`) — not with a
resolved `{ state: "ABORTED" }`. Rejecting is what lets `runScript()` recognise
the run as `interrupted` rather than reporting it as a success or a failure
([ADR-0049](../../adr/0049-cooperative-cancellation-contract.md)).

The `"ABORTED"` member of `M3LCloudFormationWaiterResult` is therefore reachable only when an `AbortError` arrives with no _aborted_ caller signal —
a signal that was supplied but has not fired still takes the resolving path.
Before this change it was unreachable outright, because no method accepted a
signal. The member is retained rather than removed because narrowing an exported
union is a breaking change; removal is deferred to the next major. A caller that
passes a signal should handle cancellation via `catch`, never via `state`.

Every other rejection — including the SDK's `FAILURE` terminal waiter state (e.g. a stack
that rolled back) — throws `M3LCloudFormationOperationError` chaining the
cause. This is narrower than "any non-success outcome resolves": like ECS's
`checkExceptions`, a `FAILURE` terminal state surfaces as a plain, unnamed
`Error` — indistinguishable by identity from a genuine `DescribeStacks` call
failure (credentials, throttling exhausted, network) — so there is no
reliable way to resolve one without also silently swallowing the other.

**`waitUntilStackDeleteComplete` has a broader acceptor than the
create/update waiters**: the SDK's generated delete waiter matches on
`exception.name === "ValidationError"` **alone** (no message-text check) and
treats any such rejection as **`SUCCESS`** (deletion is confirmed by the
stack becoming unresolvable) — so `waitUntilStackDeleteComplete` on an
already-deleted stack resolves `{ state: "SUCCESS" }` rather than throwing,
and so does any other `ValidationError` (e.g. a malformed stack identifier)
raised while it polls. This is broader than `describeStack`'s own
does-not-exist classifier, which additionally requires the message-text
match. The create/update waiters carry the **opposite**, explicit acceptor
for the identical `ValidationError` name: their generated code matches
`exception.name === "ValidationError"` and classifies it as a `FAILURE`
terminal state (not a `SUCCESS` one) — so a does-not-exist `ValidationError`
raised while `waitUntilStackCreateComplete`/`UpdateComplete` polls throws
`M3LCloudFormationOperationError` like any other `FAILURE`, rather than
resolving.

No retry/backoff wrapping beyond what the waiters already perform internally
(contrast `M3LSQSOperations`'s batch-send retry) — none of the other methods
here has a transient-fault profile that justifies an automatic retry. A
caller wanting resilience composes its own `M3LRetryRunner` around a call.

### Plain types (field-by-field)

**Optionality convention used throughout this section**: the installed SDK
types several fields as a _required key whose value itself is nullable_
(e.g. `StackName: string | undefined`) rather than an _optional key_ (e.g.
`StackId?: string`) — a modeling distinction that matters for
`exactOptionalPropertyTypes`-safe input construction but looks identical from
the consuming side (`.StackName` is `string | undefined` either way). This
wrapper defaults a required-nullable **string** field to `""` when the SDK
omits it (mirrors `M3LECSOperations`'s `service.serviceArn ?? ""`
convention) rather than throwing, since these fields (`stackName`,
`stackStatus`, and the `StackEvent` identity fields) are functionally always
populated by the service in practice. A genuinely **optional key**
(`StackId?` on both `Stack` and `StackSummary`) is typed optional here too,
not defaulted — an empty-string stack ID would be actively misleading for an
identifying field a caller looks values up by (deliberately asymmetric with
`StackEvent.stackId`, which the SDK models as required-nullable rather than
optional-key, so it stays in the defaulted-`""`-string bucket like
`stackName`/`stackStatus`). A `Date`-typed field is mapped to an **ISO-8601
string** (`someDate.toISOString()`, mirrors `M3LECSOperations`'s `createdAt`
convention) and has no safe string placeholder for "absent," so every `Date`
field here (`creationTime`, `timestamp`, `lastUpdatedTime`, `deletionTime`)
is typed **optional**, present only when the SDK response includes a value —
this applies even to `StackEvent.Timestamp` and `Stack`/`StackSummary`'s
`CreationTime`, which the SDK models as required-nullable rather than
optional-key; there is no contradiction in calling a required-nullable field
"optional" here, since the wrapper's optionality describes what a caller
receives, not the SDK's input-construction key requirement.

- `M3LCloudFormationListStacksResult` — `stackSummaries` is always an array
  (`[]` when the SDK omits `StackSummaries`); `nextToken` is present only when
  the SDK returns one.
- `M3LCloudFormationStackSummary` — `stackName`, `stackStatus` always present
  (defaulted to `""` per the convention above); `stackId` (genuinely optional
  key), `creationTime`, `lastUpdatedTime`, `deletionTime`, `stackStatusReason`
  present only when the SDK response includes them.
- `M3LCloudFormationStack` — `stackName`, `stackStatus` always present
  (defaulted to `""` per the convention above); `stackId`, `creationTime`,
  `description`, `lastUpdatedTime`, `stackStatusReason`, `parameters`,
  `outputs`, `tags`, `roleArn`, `disableRollback`,
  `enableTerminationProtection` present only when the SDK response includes
  them. `parameters`/`outputs`/`tags` are each mapped to a plain
  `{ key, value }`-shaped array (dropping the SDK's `ParameterKey`/
  `ParameterValue`/`UsePreviousValue`/`ResolvedValue` and `OutputKey`/
  `OutputValue`/`Description`/`ExportName` nesting down to `key`/`value`,
  each defaulted to `""` when the SDK omits either half, with `outputs`
  additionally carrying an optional `description`/`exportName` when the SDK
  supplies them).
- `M3LCloudFormationCreateStackInput` — `stackName` is required.
  `templateBody`/`templateUrl` are both optional and **not mutually
  enforced** by this wrapper — CloudFormation itself requires exactly one,
  but supplying zero, both, or the wrong one for a given `TemplateURL`
  constraint is passed straight through with no local guard (see "no
  pre-flight validation guards" below); the resulting `ValidationError`
  surfaces as `M3LCloudFormationOperationError` like any other rejection.
  `parameters` (plain `{ key, value }[]`), `capabilities` (typed
  `M3LCloudFormationCapability[]` — the closed 3-value set CloudFormation
  itself accepts, not an open `string[]`, so a typo is a compile error rather
  than a runtime `ValidationError`), `roleArn`, `tags`, `timeoutInMinutes`,
  `disableRollback`, `enableTerminationProtection` are optional (each
  included in the SDK command only when the caller supplies it —
  `exactOptionalPropertyTypes`-safe).
- `M3LCloudFormationCreateStackResult` — `stackId` always present (see the
  anomaly-throw note above).
- `M3LCloudFormationUpdateStackInput` — `stackName` required. Like
  `createStack`, `templateBody`/`templateUrl`/`usePreviousTemplate` are all
  optional and not mutually enforced — CloudFormation requires exactly one of
  `templateBody`/`templateUrl` unless `usePreviousTemplate` is set, and this
  wrapper does not validate the combination locally. `parameters`,
  `capabilities`, `roleArn`, `tags` all optional.
- `M3LCloudFormationUpdateStackResult` — a discriminated union:
  `{ changed: true, stackId: string }` on a genuine update, or
  `{ changed: false }` on the "no updates" `ValidationError` (see above).
- `M3LCloudFormationDeleteStackOptions` — `retainResources` (string array),
  `roleArn` both optional.
- `M3LCloudFormationDescribeStackEventsResult` — `stackEvents` always an
  array (`[]` when the SDK omits `StackEvents`); `nextToken` present only when
  the SDK returns one.
- `M3LCloudFormationStackEvent` — `stackId`, `eventId`, `stackName` always
  present (defaulted to `""` per the convention above); `timestamp` present
  only when the SDK response includes one (see the `Date`-field rule above);
  `logicalResourceId`, `physicalResourceId`, `resourceType`, `resourceStatus`,
  `resourceStatusReason` present only when the SDK response includes them.
- `M3LCloudFormationWaitOptions` — `maxWaitTime` (seconds) optional, defaults
  to 3600 when omitted (see the Waiters section above); `signal?: AbortSignal`
  optional, forwarded to the SDK waiter's `abortSignal` for cooperative
  cancellation.
- `M3LCloudFormationWaiterResult` — `state` is one of `"SUCCESS" | "ABORTED" |
"TIMEOUT"`; `reason` is present only when the waiter supplies one, and is
  always a fresh, static, library-constructed string — never the raw SDK
  waiter error's own `message` (see the Waiters section).
- `M3LCloudFormationKeyValue` — the plain `{ key, value }` shape used for
  stack parameters and tags; both fields default to `""` when the SDK omits
  either half (see the convention paragraph above).
- `M3LCloudFormationOutput` — `key`/`value` default to `""` per the same
  convention; `description`/`exportName` present only when the SDK response
  includes them.
- `M3LCloudFormationCapability` — a 3-value string-literal union
  (`"CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM" | "CAPABILITY_AUTO_EXPAND"`),
  mirroring the SDK's own `Capability` enum, used by
  `M3LCloudFormationCreateStackInput`/`UpdateStackInput`'s `capabilities`
  field.

There are no pre-flight validation guards in this module (contrast
`M3LSQSOperations`'s batch-size/duplicate-id guards) — every method's only
failure mode is a rejected `.send()`/waiter call, or the two named
`ValidationError` classifications above. This includes the
`templateBody`/`templateUrl` mutual-requirement noted above and the waiter
`maxWaitTime` bounds noted in the Waiters section.

### `M3LCloudFormationOperationError`

`code: "ERR_CLOUDFORMATION_OPERATION"`. Thrown when the underlying SDK
`.send()` call or a `waitUntilStack*Complete` waiter's polling call rejects
with anything other than the two named data-classified `ValidationError`
cases (`describeStack`'s does-not-exist, `updateStack`'s no-updates) or the
two named waiter terminal error names (`TimeoutError`, `AbortError`), chaining
the rejection as `cause`.

## Out of scope (v1)

Recorded here rather than left implicit, so a future revision has a named
starting point instead of rediscovering the boundary:

- **Change sets** — `CreateChangeSet`/`DescribeChangeSet`/`ExecuteChangeSet`/
  `DeleteChangeSet` and the `waitUntilChangeSetCreateComplete` waiter.
  CloudFormation's safe-update idiom (preview a diff before applying) is a
  materially larger surface than direct `createStack`/`updateStack`; deferred
  until a consumer needs preview-before-apply.
- **Stack sets** — `CreateStackSet`/`DescribeStackSet`/`ListStackInstances`/
  and related StackSets/StackInstances operations. Out of scope because
  `scripts/cloudformation-stacks` (per the roadmap) operates on single
  stacks, not multi-account/multi-region StackSets.
- **Drift detection** — `DetectStackDrift`/`DescribeStackDriftDetectionStatus`/
  `DescribeStackResourceDrifts`.
- **Stack refactor** — `CreateStackRefactor`/`ExecuteStackRefactor` and
  related operations (a newer CloudFormation capability for moving resources
  between stacks without replacement).
- **Template validation/estimation** — `ValidateTemplate`/
  `EstimateTemplateCost`.
- **Stack-policy management** — `SetStackPolicy`/`GetStackPolicy`.

## See also

- [AWS Clients](./clients.md) — `AWSClientProvider.cloudFormation`, the raw
  client getter this wrapper is constructed from; also reachable as
  `AWSServiceProvider.cloudFormation` (`script.aws.services.cloudFormation`).
- [ECS Operations](./ecs.md) — the closest sibling wrapper in shape (a
  standalone-waiter, name-classified terminal-state pattern) and the direct
  precedent for this module's waiter contract.
- [Athena](./athena.md) — precedent for a poll method resolving a
  terminal non-success state rather than throwing
  (`M3LAthenaClient.awaitResults`).
