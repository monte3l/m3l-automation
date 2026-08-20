# 0059. `aws/bedrock-runtime` typed wrapper and tool-use loop primitives

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

[ADR-0039](./0039-llm-integration-out-of-scope.md) declined a speculative
Bedrock invoker and recorded the activation condition: "if a future consumer
script genuinely needs LLM inference, build it against that named
call-site." That condition is now met — the agent-operator programme
(ADR-0058) names **`scripts/agent-operator`** as the consumer: a
policy-gated tool-use loop that drives m3l CLI operations with Claude via
AWS Bedrock. This ADR is the intake-gate decision ADR-0021/0037 require,
built against that call-site.

The audit confirmed the library has **zero precedent** for five things an
agent loop needs: streaming responses (every wrapper method is
`Promise`-returning, never `AsyncIterable`), conversation/message state
(wrappers are stateless), token/cost accounting (run reports track timing,
never spend), model selection/fallback, and the tool-use loop state machine
(invoke → `tool_use` blocks → execute tools → feed `tool_result` → repeat).
On current Bedrock, Claude sits behind the standard Messages API with
**client-side tools only** — the loop is necessarily the caller's (research
snapshot, S21/S27).

## Decision drivers

- **ADR-0027/0028 pattern fit**: scripts never import `@aws-sdk/*`; the
  library grows a typed wrapper per consumer need, named by the full
  official AWS service name.
- **Gated broadening**: one consumer, one provider — build the narrow thing
  the named call-site needs, not a provider-abstraction layer.
- **ADR-0009 dependency direction**: `core/*` must not import `aws/*`, so a
  provider-agnostic core loop module would force an injected-port design
  and duplicate Bedrock's message vocabulary with no second provider to pay
  for it.
- **Minimal runtime dependencies**: exactly one new SDK client package.

## Considered options

1. **Wrapper only; the script hand-rolls the loop.** Rejected: the loop
   state machine, conversation accounting, and token tracking are exactly
   the promotable, testable machinery ADR-0029 wants in the library — and
   the MCP surface (ADR-0062) and future workloads would each re-implement
   them.
2. **Wrapper in `aws/`, loop primitives as a provider-agnostic `core/`
   module.** Rejected for now: ADR-0009 forbids `core → aws` imports, so
   the core module would need injected ports mirroring Bedrock's message
   shapes — an abstraction with one implementation. Revisit trigger: a
   **second named model provider**.
3. **One `aws/bedrock-runtime` submodule carrying both the typed wrapper
   and the loop primitives.** Chosen.

## Decision

We chose **option 3**. `m3l-common` gains **`aws/bedrock-runtime`**
(ADR-0028 naming: the inference service's SDK is
`@aws-sdk/client-bedrock-runtime`, service name "Amazon Bedrock Runtime";
the control-plane `@aws-sdk/client-bedrock` is out of scope), surfaced
through the AWS namespace barrel (AWS submodule count 19 → 20 via
`gen:counts` when it ships — never hand-edited). Scope, shaped at
implementation (V4/V5) within these bounds:

- **Typed invocation wrapper** over the Bedrock Messages API: single-shot
  and streaming (the library's first `AsyncIterable` surface — its shape is
  part of this submodule's contract, not a general library-wide streaming
  framework), model-id registry with explicit fallback order, and
  per-invocation token usage capture. Client provisioning via a new lazy
  `AWSClientProvider` getter; credentials/regions flow through the existing
  SSO chain unchanged.
- **Tool-use loop primitives**: typed tool definitions (name, description,
  JSON-schema input — the shape official guidance says matters most),
  conversation state as an explicit immutable value the caller holds (no
  hidden client state), the loop state machine honouring cooperative
  cancellation (ADR-0049's `AbortSignal`), an iteration ceiling, and
  cumulative token/cost accounting surfaced on the loop outcome.
- **Model-generated text is untrusted input**: every parse of model output
  follows the style guide's ReDoS-conscious parsing rules — the practice
  ADR-0039 itself seeded, now load-bearing.

Semantic inference failures (`ModelErrorException` and kin) map to named
`M3LError` codes with ADR-0035 origin classification; transient transport
faults reuse `M3LRetryRunner` conventions.

## Consequences

- **Positive:** the loop machinery every agent consumer needs (script now,
  MCP surface next) is library-owned, typed, and tested once; ADR-0039's
  gate closes with the exact paperwork it prescribed; the wrapper slots
  into every existing AWS pattern (getter, SSO, naming, barrel).
- **Negative / trade-offs:** the loop is Bedrock-coupled until a second
  provider is named (recorded revisit trigger); one new runtime dependency
  (`@aws-sdk/client-bedrock-runtime`); streaming introduces an
  `AsyncIterable` contract the test suite must learn to cover.
- **Semver impact:** none from this ADR (docs only). Implementation is an
  **additive minor** on `m3l-common` (new barrel submodule; AWS 19 → 20;
  no new `exports` subpath — `check:api` unaffected).

## Links

- Fires the gate of: [ADR-0039](./0039-llm-integration-out-of-scope.md)
  (its 2026-08-20 Update block records the firing).
- Programme: [ADR-0058](./0058-agent-operator-programme.md). Consumer
  policy/audit: [ADR-0060](./0060-agent-policy-layer.md),
  [ADR-0061](./0061-agent-decision-log.md).
- Patterns: [ADR-0027](./0027-aws-sdk-boundary-typed-wrappers.md),
  [ADR-0028](./0028-aws-service-naming-convention.md),
  [ADR-0026](./0026-sqs-operations-wrapper.md) /
  [ADR-0033](./0033-aws-s3-operations-wrapper.md) (wrapper precedents),
  [ADR-0009](./0009-dependency-direction-guard.md) (why the loop is not a
  core module), [ADR-0049](./0049-cooperative-cancellation-contract.md).
- Research: [`docs/research/agent-cli-integration.md`](../research/agent-cli-integration.md).
