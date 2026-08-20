# 0039. LLM/Bedrock inference integration is out of scope for `m3l-common`

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

An internal capability audit considered whether
`@m3l-automation/m3l-common` should grow a narrow, prompt-template-driven
LLM invocation wrapper (e.g. over AWS Bedrock's Converse API) as a Core or
AWS submodule.

The audit found **zero references to Bedrock, LLM inference, or prompt
invocation anywhere in this repo** (`grep -ri bedrock` across `packages/`,
`bin/`, `scripts/`, `docs/`, `.claude/` returns no hits), and no ADR among
0001–0036 records any position on the question. That is a genuine gap in
the decision record, independent of whether the answer turns out to be
"build it" or "don't" — a recurring audit should not have to re-derive
this stance from silence every time.

This ADR records the stance so it stops resurfacing as an open question.

## Decision drivers

- **Minimal runtime dependencies** (project-wide non-negotiable, restated in
  every ADR that adds one) — an LLM client pulls in an AWS Bedrock Runtime
  SDK client plus, under a YAML-driven prompt-template design, a YAML
  prompt-template loading path that duplicates work `core/config`'s
  `M3LYAMLConfigProvider` already does for a different purpose.
- **Solo consumer, gated broadening** (ADR-0021, carried forward by
  ADR-0037) — new submodules stay gated on a named consumer call-site; there
  is no automation script today that needs LLM inference.
- **The library's stated purpose** (`CLAUDE.md`): "configuration management,
  logging, error handling, data import/export, asynchronous polling/retry
  mechanisms, and cross-cutting concerns" for **automation scripts** — an LLM
  invocation client is a different kind of capability (a managed-service SDK
  wrapper for a generative task) than anything else in scope, closer to a
  standalone integration than a cross-cutting utility.
- **Internal-only, unpublished** (ADR-0020) — there is no external-adoption
  pressure pushing toward a broader capability surface.

## Considered options

1. **Build a Bedrock-invoker submodule now, speculatively** — an enum of
   named task profiles, an externalized prompt registry, defensive
   ReDoS-safe output parsing. Rejected: no consumer script needs it; this is
   exactly the "broadening... gated on a named consumer call-site" pattern
   ADR-0021/ADR-0037 already declined to do speculatively for other
   submodules (e.g. an SSM config provider, a Lambda invoke wrapper).
2. **Record an explicit out-of-scope stance now, revisit only when a real
   consumer script needs LLM inference.** Costs nothing today, closes the
   audit gap, and gives a future "should we add Bedrock support" question an
   immediate, correct default answer instead of an unrecorded silence.
3. **Say nothing and let it stay undecided.** Free today, but the exact
   status quo the audit flagged as a gap — the question would resurface
   identically in the next audit.

## Decision

We chose **option 2**.

`@m3l-automation/m3l-common` will **not** grow an LLM/Bedrock invocation
submodule speculatively. If a future consumer script genuinely needs LLM
inference, the ADR-0021/ADR-0037 intake gate applies exactly as it does for
any other new capability: build it against that named call-site, not ahead
of one.

One portable idea from the audit is **not** gated the same way, because it is
general-purpose and not LLM-specific: **ReDoS-conscious string-only parsing
for untrusted/model-generated text** (avoiding regex on attacker- or
model-controllable input where a linear string-slice approach suffices) is
already practiced once in this repo (`internal/prompt/sanitize.ts`'s
control-character escaping via `codePointAt`, with no regex) but is not named
as a rule anywhere. Naming it is in scope for the style guide independent of
this ADR's LLM decision — tracked as a documentation follow-up, not code.

## Consequences

- **Positive:** closes the decision-record gap the audit found; a future "add
  Bedrock support" ask has an immediate, correct default (no, unless a named
  consumer needs it) instead of requiring a fresh audit to discover the gap
  again; costs nothing today.
- **Negative / trade-offs:** if a consumer script needs LLM inference before
  this is revisited, that script would either build it locally (a temporary
  ADR-0029 exception requiring its own decision record) or wait for the
  gated submodule — a minor process cost, not a technical one.
- **Semver impact:** none. This ADR records a non-decision to build; no code,
  export, or `exports`-map entry changes.

## Update 2026-08-20 — gate fired; Bedrock integration activated

The condition this ADR recorded has been met: a consumer script genuinely
needs LLM inference. The agent-operator programme
([ADR-0058](./0058-agent-operator-programme.md)) names
**`scripts/agent-operator`** — a policy-gated tool-use loop operating the
m3l fleet with Claude via AWS Bedrock — as the call-site, and
[ADR-0059](./0059-bedrock-runtime-wrapper-and-loop-primitives.md) is the
intake-gate decision built against it (the `aws/bedrock-runtime` typed
wrapper plus loop primitives), exactly as this ADR prescribed: against a
named consumer, not ahead of one. The Status stays Accepted — this update
activates the recorded stance's own revisit path rather than reversing it.

Worth noting: the ReDoS-conscious untrusted-text parsing rule this ADR
seeded into the style guide is now directly load-bearing — model-generated
tool output is exactly the untrusted input class it anticipated.

## Links

- Related: [ADR-0021 (post-1.0 deepen-first strategy — the broadening
  intake gate this decision applies)](./0021-post-1.0-deepen-first-strategy.md),
  [ADR-0037 (deepen-first re-read — carries the intake gate forward)](./0037-deepen-first-re-read-against-consumer-pull.md),
  [ADR-0020 (drop release automation, internal-only posture)](./0020-drop-release-automation.md).
- The ReDoS-conscious string-only-parsing practice this ADR flagged as a
  documentation follow-up is now named in
  [style guide § Parsing untrusted text](../contributing/style-guide.md#parsing-untrusted-text),
  citing `core/logging/redact.ts`'s bounded patterns and
  `internal/prompt/sanitize.ts`'s `escapeTerminalControls` as precedent (the
  latter uses a quantifier-free regex character class, not — as this ADR's
  original wording said — "no regex"). Closes issue #336.
