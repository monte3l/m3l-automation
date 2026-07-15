# 0027. Scripts never import `@aws-sdk/*`; the library grows typed AWS operation wrappers per consumer need

- **Status:** Accepted — amended 2026-07-15: the context passage recording
  script-local, AWS-adjacent dependencies as "an accepted, ratified pattern"
  is superseded by [ADR-0029](./0029-script-dependency-boundary.md); the
  decision itself stands in full
- **Date:** 2026-07-12
- **Deciders:** Enrico Lionello

## Context and problem statement

The consumer-script fleet (ADR-0022) reaches AWS through `script.aws.<service>`
— a dynamic-provisioning seam over `AWSClientProvider`
(`packages/m3l-common/src/aws/clients/provider.ts`). That seam resolves
credentials and constructs a client, but every getter (`.s3`, `.lambda`,
`.cloudWatchLogs`, ...) hands back the **raw AWS SDK v3 client** — the caller
is expected to import AWS SDK command classes (e.g. `StartQueryCommand`)
directly and call `.send()`. `docs/reference/aws/clients.md` documents this
as the intentional shipped design.

Implementing the `logs-insights` W2 script's CloudWatch Logs Insights
`StartQuery`/`GetQueryResults` step surfaced the consequence: using
`script.aws.cloudWatchLogs` as shipped would require `scripts/logs-insights`
to depend on `@aws-sdk/client-cloudwatch-logs` directly, purely to build two
command objects. A 5-facet audit (design rationale, fleet AWS surface,
script-local dependency precedent, existing wrapper patterns, enforcement)
found:

- No ADR justifies exposing raw SDK clients over a wrapper; ADR-0022 §7's
  "not hand-constructed SDK clients" convention is unenforced today, and read
  narrowly, covers only credential/client construction — not SDK imports.
- The library has **zero** operation-level AWS wrappers. `dynamoDBDocument`
  is the sole non-trivial getter, and it is only the SDK's own
  `DynamoDBDocumentClient.from(...)`, not a bespoke abstraction.
- ~76 distinct AWS SDK commands exist across the full planned W2–W4 fleet
  (`dynamo-crud`, `s3-objects`, `lambda-ops`, `ecs-ops`, `cfn-stacks`,
  `codepipeline-ops`, `eventbridge-schedules`, `data-query`, `eks-ops`,
  `apigw-client`).
- Nothing today automatically blocks a script from declaring
  `@aws-sdk/client-*` as its own dependency and importing it — every gate
  (`check:script-scaffold`, `check:deps`, ESLint, knip) passes.
- Script-local, AWS-adjacent dependencies are already an accepted, ratified
  pattern (`eks-ops` → `@kubernetes/client-node`, `apigw-client` →
  `@smithy/signature-v4`, `data-query` → `pg`/`mongodb`), each gated by "own
  PR review" (`docs/ROADMAP.md`).

## Decision drivers

- Keep the AWS SDK surface entirely out of consumer scripts — one mediation
  point, uniform typed error taxonomy, trivially mockable step tests.
- `CLAUDE.md`'s non-negotiable constraint: minimal runtime dependencies, keep
  the import graph shallow — building wrappers for all ~76 fleet-wide
  commands upfront is disproportionate; a per-consumer-need gate (the
  ADR-0021 F-series "surfaced by consumer, becomes library friction"
  pattern) keeps the library's growth matched to actual demand.
- The frozen three-entry `exports` map (`.`, `./core`, `./aws`) — new
  capability must surface through an existing namespace barrel, not a new
  subpath.

## Considered options

1. **Status quo** — scripts import AWS SDK command classes directly
   (script-local dependency, following the `eks-ops`/`apigw-client`
   precedent); the library's role stays limited to credentials/client
   construction.
2. **Typed wrapper submodule per consumer need** — scripts never import
   `@aws-sdk/*`; the library grows a narrow, typed operation wrapper the
   first time a consumer needs one, rather than a speculative fleet-wide
   façade.
3. **Full AWS operation façade upfront** — design and build typed wrappers
   for the ~76 commands the whole W2–W4 fleet will eventually need, before
   continuing any AWS-touching script.

## Decision

We chose **option 2: a typed wrapper submodule per consumer need.**

Option 1 matches precedent and requires no new library work, but it means
every future AWS-touching script re-imports the SDK, and the AWS-shape
knowledge (command construction, response field mapping, terminal-status
handling) is duplicated per script rather than mediated once. Option 3 builds
~76 commands' worth of wrapper surface speculatively, in direct tension with
the minimal-dependencies/shallow-import-graph driver, and blocks the entire
fleet on a large upfront design.

Option 2's first concrete instance is `aws/logs-insights`
(`M3LLogsInsightsClient`, wrapping `StartQuery`/`GetQueryResults` with
`M3LPoller`-driven polling via the existing
`M3LPollingPolicies.cloudWatchLogsQuery()`), consumed by
`scripts/logs-insights`. It establishes the pattern for future AWS wrappers:
inject the already-provisioned SDK client (never self-construct from
profile/region — that stays behind the `aws.profile` seam), normalize AWS
response shapes at the library boundary, and reuse `core/polling` primitives
rather than re-implementing retry/poll logic per wrapper.

Enforcement: a new `eslint.config.js` override bans `@aws-sdk/*` imports
(value and type) under `scripts/*/src/**` only —
`packages/m3l-common/src/**` is explicitly uncovered, since the library
itself legitimately imports the SDK.

## Consequences

- **Positive:** one AWS mediation seam per operation family; uniform typed
  errors (`M3LError` subclasses with stable `code`s); scripts are fully
  SDK-free and their step tests mock a plain library call instead of an AWS
  SDK client; precedent set for the rest of the W2–W4 fleet.
- **Negative / trade-offs:** `aws/logs-insights` relies on the `aws/**` ESLint
  dependency-direction zone (ADR-0009) already having widened from
  `{errors, prompt}` to `{errors, prompt, polling}` — landed by ADR-0026
  (`aws/sqs`) for the same `M3LPoller`/`M3LRetryRunner`/`M3LPollingPolicies`
  reuse need, a verified-acyclic but real widening of that island's allowed
  surface. A new wrapper submodule is needed per new AWS operation a script
  needs going forward (accepted cost — matches the consumer-pull gate rather
  than speculative building).
- **Semver impact:** minor — additive symbols through the existing `./aws`
  barrel (`M3LLogsInsightsClient` and its error/type exports); the
  count-enforced submodule ledger moves 24→25 (AWS: 5→6).

## Links

- Related: [ADR-0022](./0022-reintroduce-scripts-workspace.md) §7 (the
  `aws.profile` seam convention this ADR hardens from documentation into a
  lint-enforced rule); [ADR-0017](./0017-dependency-loading-standard.md)
  (AWS SDK as a hard library dependency, sync client getters — unaffected,
  nothing moves to optional); [ADR-0009](./0009-dependency-direction-guard.md)
  (the `aws/**` → `core` zone this ADR extends by one module);
  [ADR-0021](./0021-post-1.0-deepen-first-strategy.md) (the F-series
  "surfaced by consumer, becomes library friction" gate this decision
  follows); `docs/reference/aws/logs-insights.md` (the new submodule's
  contract). The consuming `scripts/logs-insights` package and its own
  revised contract page land in a later PR, once its business logic is
  implemented.
- Supersedes / superseded by: superseded in part by
  [ADR-0029](./0029-script-dependency-boundary.md) (the script-local
  dependency passage in the context section; the wrapper decision and the
  `@aws-sdk/*` ban stand).
