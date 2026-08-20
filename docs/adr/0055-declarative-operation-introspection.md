# 0055. Declarative, enumerable operations in script config

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

Multi-operation scripts (`dynamodb-crud`, `s3-objects`, `ecs-ops`, and their
peers) encode their real capabilities — get/put/update/delete/query/scan and
so on — as a plain STRING parameter named `operation`, validated only by a
`Core.M3LConfigValidators.oneOf(...)` closure at run time. The audit
confirmed the consequence end-to-end: no CLI code path can read the allowed
value set, so `m3l inspect`, the dynamic `--help`, and the wizard all render
`operation` as an opaque string. A user must open `src/config.ts` to learn
what a script can do — the exact introspection gap ADR-0042 was created to
close, resurfaced one level down.

The gap also blocks two U-series consumers: shell completion cannot complete
operation values it cannot enumerate, and per-operation parameter surfacing
(which parameters `delete` requires vs `get`) has no declarative source.

## Decision drivers

- **Introspection is the CLI's founding purpose** (ADR-0042): what a script
  declares, every surface should be able to render.
- **Make illegal states unrepresentable:** an enumerated capability modelled
  as a free string with a runtime closure is the weakest possible encoding.
- **Fleet practice must stay expressible:** scripts guard per-operation
  requirements two documented ways (config-load-time `configValidators`, or
  run-start guards via `M3LOperationPipeline.requiredFields`) — the model
  must serve both, not force a migration of run semantics.
- **Additive only:** no breaking change outside a major (ADR-0020 context).

## Considered options

1. **Status quo** — operations stay opaque strings. Rejected: forecloses
   completion, operation-aware help, and wizard flows.
2. **Parse the `oneOf` closure** (reflection/AST tricks to recover the value
   set). Rejected: fragile, unserialisable through the CLI's JSON discovery
   cache, and still yields values without descriptions or parameter scoping.
3. **A declarative operation model in `core/config`** — operations become
   first-class, enumerable schema data. Chosen.

## Decision

We chose **option 3**. `core/config` grows an **additive** declarative
operation surface (exact API shaped at implementation, U4):

- A script may declare its operation set as data: each operation carries a
  name, a description, and optionally the parameter names it requires — the
  same information today split between `oneOf` closures, `requiredFields`
  options, and prose.
- The declaration is **serialisable** (it must survive `m3l-cli`'s JSON
  discovery cache, the same constraint that shaped
  `M3LCliParameterDescriptor.secret` — see ADR-0042's 2026-08-14 update).
- Validation derives from the declaration (declaring operations implies the
  membership check today's `oneOf` closure performs), so a script declares
  once and both the runtime guard and every introspection surface read the
  same source. Existing validator-based scripts keep working unchanged —
  adoption is per-script (U5 retrofit).
- Surfacing (U8): `m3l inspect` renders the operation table; the dynamic
  `--help` and the wizard scope prompts by operation; completion (U12)
  completes operation values.

## Consequences

- **Positive:** every introspection surface — inspect, help, wizard,
  completion, and ADR-0056's flow definitions — reads one declared source of
  truth; the runtime guard and the documentation can no longer drift apart.
- **Negative / trade-offs:** one more concept in the config vocabulary; the
  fleet retrofit (U5) is a per-script pass across all multi-operation
  scripts; scripts with genuinely dynamic operation sets (none today) would
  not fit the declarative model and would stay on validators.
- **Semver impact:** none from this ADR (docs only). Implementation is an
  **additive minor** on `m3l-common` (`core/config` additions; existing
  declarations unaffected).

## Links

- Programme: [ADR-0053](./0053-cli-first-evolution-programme.md). Command
  contract that carries the declarations in-process:
  [ADR-0054](./0054-command-module-contract-and-hybrid-execution.md).
- Related: [ADR-0042 (introspection purpose + serialisable-descriptor
  precedent)](./0042-script-cli-package-deferred.md),
  [ADR-0018 (the options bag)](./0018-shared-script-options-bag.md).
