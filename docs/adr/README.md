# Architecture Decision Records

This directory records the architecturally significant decisions for
`@m3l-automation/m3l-common` and the surrounding monorepo. Each ADR captures one
decision: its context, the choice made, and the consequences.

We use a lightweight [MADR](https://adr.github.io/madr/)-style format. Start from
[`template.md`](./template.md).

## Conventions

- One decision per file, named `NNNN-short-title.md` (zero-padded sequence),
  e.g. `0001-esm-only-output.md`.
- Status is one of: `Proposed`, `Accepted`, `Rejected`, `Deprecated`,
  `Superseded by ADR-NNNN`, `Re-affirmed by ADR-NNNN`.
- ADRs are immutable once `Accepted`. To change a decision, add a new ADR that
  supersedes the old one and update the old one's status. To _revisit_ a still-
  in-force decision on new grounds without changing it, add a new ADR and mark
  the old one `Re-affirmed by ADR-NNNN` — it remains accepted; the annotation
  just points to the newer rationale (e.g. ADR-0012 → ADR-0023).
- Decisions with semver impact (e.g. changes to the `exports` map) should be
  backed by an ADR.

## When to write an ADR

Write a new ADR when:

- A decision affects the **public contract** — adding, removing, or renaming an
  entry in the `exports` map; changing the minimum Node.js version; changing the
  ESM/CJS output strategy.
- A **new runtime dependency** is introduced (or a major one removed) and the
  reasoning should be recorded for future maintainers.
- A **foundational design choice** is made — error model, result type, module
  topology — that will be hard to reverse without a major semver bump.
- There is genuine **disagreement or uncertainty** among deciders: record what was
  decided and why, so it is not relitigated.
- A decision is **superseded**: the new ADR records the change; the old ADR's
  status is updated to `Superseded by ADR-NNNN`.

You do **not** need an ADR for implementation details that stay behind the module
boundary (internal helpers, test utilities, refactors that do not touch the public
surface).

## Index

| ADR  | Title                                                                                                                                                     | Status                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0001 | [Development toolchain choices](./0001-toolchain-choices.md)                                                                                              | Accepted                                              |
| 0002 | [ESM-only output](./0002-esm-only-output.md)                                                                                                              | Accepted                                              |
| 0003 | [Node 24 as the minimum runtime floor](./0003-node-24-floor.md)                                                                                           | Accepted                                              |
| 0004 | [Three-entry exports map as the public contract](./0004-exports-map-contract.md)                                                                          | Accepted                                              |
| 0005 | [M3LError and M3LResult as the error model](./0005-error-hierarchy.md)                                                                                    | Accepted                                              |
| 0006 | [Apache 2.0 license adoption](./0006-license-choice.md)                                                                                                   | Accepted                                              |
| 0007 | [Automated dependency monitoring and security gating](./0007-dependency-management-strategy.md)                                                           | Accepted                                              |
| 0008 | [Replace @commitlint/cli with a thin wrapper around @commitlint/lint](./0008-commitlint-cli-replacement.md)                                               | Accepted                                              |
| 0009 | [Dependency-direction guard: import-x/no-restricted-paths vs dependency-cruiser](./0009-dependency-direction-guard.md)                                    | Accepted                                              |
| 0010 | [Enforce formatting and Markdown linting in CI, with rumdl as the Markdown linter](./0010-markdown-lint-and-format-ci-gates.md)                           | Accepted                                              |
| 0011 | [Release and publishing workflow](./0011-release-and-publishing-workflow.md)                                                                              | Superseded by ADR-0020                                |
| 0012 | [Defer external code-index MCP; use native LSP + generated catalog](./0012-defer-external-code-index-mcp.md)                                              | Re-affirmed by ADR-0023                               |
| 0013 | [Git worktrees for task isolation and parallelization](./0013-git-worktrees-for-task-isolation.md)                                                        | Accepted                                              |
| 0014 | [Symmetric worktree tooling and corrected prune semantics](./0014-symmetric-worktree-tooling.md)                                                          | Accepted                                              |
| 0015 | [Code-scanning tooling evaluation and supply-chain hardening](./0015-code-scanning-tooling-evaluation.md)                                                 | Accepted                                              |
| 0016 | [Signed-commit enforcement and the pre-work decision gate](./0016-signed-commits-and-decision-gate.md)                                                    | Accepted                                              |
| 0017 | [Dependency loading, declaration, and pinning standard](./0017-dependency-loading-standard.md)                                                            | Accepted                                              |
| 0018 | [Ratify a single shared `M3LScriptOptions` bag for CLI and Lambda](./0018-shared-script-options-bag.md)                                                   | Accepted                                              |
| 0019 | [Remove the `scripts/` example-automation workspace](./0019-remove-scripts-workspace.md)                                                                  | Superseded by ADR-0022                                |
| 0020 | [Drop release automation](./0020-drop-release-automation.md)                                                                                              | Partially superseded by ADR-0057                      |
| 0021 | [Post-1.0.0 direction: deepen the library first, then build consumers](./0021-post-1.0-deepen-first-strategy.md)                                          | Superseded by ADR-0037                                |
| 0022 | [Re-introduce the `scripts/` workspace for real consumers](./0022-reintroduce-scripts-workspace.md)                                                       | Accepted                                              |
| 0023 | [Re-affirm the external code-index MCP deferral on new grounds](./0023-reaffirm-code-index-mcp-deferral.md)                                               | Accepted                                              |
| 0024 | [Deterministic prevention of derived-artifact merge conflicts](./0024-deterministic-derived-artifact-merges.md)                                           | Accepted                                              |
| 0025 | [Selective adoption of dynamic workflows for subagent orchestration](./0025-dynamic-workflows-assessment.md)                                              | Accepted                                              |
| 0026 | [Typed SQS operations wrapper over the raw SDK client](./0026-sqs-operations-wrapper.md)                                                                  | Accepted                                              |
| 0027 | [Scripts never import `@aws-sdk/*`; the library grows typed AWS operation wrappers per consumer need](./0027-aws-sdk-boundary-typed-wrappers.md)          | Accepted; amended by ADR-0029                         |
| 0028 | [AWS-scoped scripts and submodules are named with full official AWS service names](./0028-aws-service-naming-convention.md)                               | Accepted                                              |
| 0029 | [Consumer scripts depend only on @m3l-automation/m3l-common](./0029-script-dependency-boundary.md)                                                        | Accepted                                              |
| 0030 | [Targeted workflow tooling and MCP adoption](./0030-targeted-workflow-tooling-and-mcp.md)                                                                 | Accepted                                              |
| 0031 | [Relational and document data-engine access for the consumer fleet](./0031-relational-and-document-data-engine-access.md)                                 | Accepted                                              |
| 0032 | [Centralized project-state and roadmap visibility hub](./0032-project-management-visibility-hub.md)                                                       | Partially superseded by ADR-0051; amended by ADR-0079 |
| 0033 | [Typed S3 operations wrapper over the raw SDK client](./0033-aws-s3-operations-wrapper.md)                                                                | Accepted                                              |
| 0034 | [Sonar/Act-Podman re-assessment: OSS complexity/duplication gates, Act/Podman declined](./0034-sonar-act-podman-reassessment.md)                          | Accepted                                              |
| 0035 | [Failure reporting and diagnostics architecture](./0035-failure-reporting-and-diagnostics.md)                                                             | Accepted                                              |
| 0036 | [Inbound dependency license policy](./0036-dependency-license-policy.md)                                                                                  | Accepted                                              |
| 0037 | [Re-read deepen-first against real consumer pull; priority order for the capability-deepening wave](./0037-deepen-first-re-read-against-consumer-pull.md) | Accepted                                              |
| 0038 | [Widen the SQS wrapper for DLQ redrive; add an `AWSServiceProvider` services tier](./0038-sqs-dlq-redrive-and-aws-services-tier.md)                       | Partially superseded by ADR-0044                      |
| 0039 | [LLM/Bedrock inference integration is out of scope for `m3l-common`](./0039-llm-integration-out-of-scope.md)                                              | Accepted                                              |
| 0040 | [Widen the `aws/**` ESLint zone to admit `core/utils/M3LSingleFlight`](./0040-single-flight-zone-widening.md)                                             | Accepted                                              |
| 0041 | [Widen the `aws/**` ESLint zone to admit `core/logging`'s handler port](./0041-logger-seam-zone-widening.md)                                              | Accepted                                              |
| 0042 | [Defer the script-facing `packages/m3l-cli` package](./0042-script-cli-package-deferred.md)                                                               | Accepted                                              |
| 0043 | [Defer a step-pipeline engine; close out the remaining reference capabilities](./0043-step-pipeline-engine-deferred.md)                                   | Accepted                                              |
| 0044 | [Remove three deprecated `AWSClientProvider` wrapper getters](./0044-remove-deprecated-client-wrapper-getters.md)                                         | Accepted                                              |
| 0045 | [Byte-offset streaming resume for list exporters](./0045-streaming-safe-resume-contract.md)                                                               | Accepted                                              |
| 0046 | [Adopt a codified-procedure engine (`core/procedure`)](./0046-codified-procedure-engine.md)                                                               | Accepted                                              |
| 0047 | [Cross-script orchestration belongs to `m3l-cli`, and is deferred](./0047-cross-script-orchestration-deferred.md)                                         | Accepted                                              |
| 0048 | [Grade the destructive confirmation by target, not only by action](./0048-target-graded-destructive-confirmation.md)                                      | Accepted                                              |
| 0049 | [A cooperative cancellation contract for long-running operations](./0049-cooperative-cancellation-contract.md)                                            | Accepted                                              |
| 0050 | [GitHub platform-feature stance](./0050-github-platform-feature-stance.md)                                                                                | Partially superseded by ADR-0052                      |
| 0051 | [Semantic priority vocabulary for labels, milestones, and tracker cells](./0051-semantic-priority-vocabulary.md)                                          | Accepted; amended by ADR-0073                         |
| 0052 | [Hub board identity and field taxonomy](./0052-hub-board-identity-and-field-taxonomy.md)                                                                  | Partially superseded by ADR-0073                      |
| 0053 | [CLI-first evolution programme: from launcher to product](./0053-cli-first-evolution-programme.md)                                                        | Accepted                                              |
| 0054 | [Typed command-module contract and hybrid execution](./0054-command-module-contract-and-hybrid-execution.md)                                              | Accepted                                              |
| 0055 | [Declarative, enumerable operations in script config](./0055-declarative-operation-introspection.md)                                                      | Accepted                                              |
| 0056 | [Cross-script orchestration engine in `m3l-cli` (`m3l flow`)](./0056-cross-script-orchestration-engine.md)                                                | Accepted                                              |
| 0057 | [Distribute the CLI and its fleet via a private GitHub Packages registry](./0057-private-registry-distribution.md)                                        | Accepted                                              |
| 0058 | [Agent-operator programme: staged AI-agent operation of the m3l fleet](./0058-agent-operator-programme.md)                                                | Accepted                                              |
| 0059 | [`aws/bedrock-runtime` typed wrapper and tool-use loop primitives](./0059-bedrock-runtime-wrapper-and-loop-primitives.md)                                 | Accepted                                              |
| 0060 | [Agent policy layer: graded autonomy as a real authorization control](./0060-agent-policy-layer.md)                                                       | Accepted                                              |
| 0061 | [Agent decision log: an append-only audit artifact class](./0061-agent-decision-log.md)                                                                   | Accepted                                              |
| 0062 | [Runtime MCP surface: `packages/m3l-mcp`](./0062-runtime-mcp-surface.md)                                                                                  | Accepted                                              |
| 0063 | [CLI structured run results: completing the machine surface](./0063-cli-structured-run-results.md)                                                        | Accepted                                              |
| 0064 | [m3l console programme: a full-stack operations console](./0064-m3l-console-programme.md)                                                                 | Accepted                                              |
| 0065 | [Console server architecture and execution integration](./0065-console-server-architecture.md)                                                            | Accepted                                              |
| 0066 | [Console API contract: REST commands, SSE live streams](./0066-console-api-rest-sse.md)                                                                   | Accepted                                              |
| 0067 | [Console frontend stack and the scoped bundler exception](./0067-console-frontend-stack.md)                                                               | Accepted                                              |
| 0068 | [Workbench sessions and the addressable-artifact convention](./0068-workbench-sessions.md)                                                                | Accepted                                              |
| 0069 | [Console embedded persistence: `node:sqlite` behind a repository seam](./0069-console-embedded-persistence.md)                                            | Accepted                                              |
| 0070 | [Console audit, self-observability, and the display-vs-persist rule](./0070-console-audit-and-observability.md)                                           | Accepted                                              |
| 0071 | [Console containerization and local-first deployment](./0071-console-containerization-deployment.md)                                                      | Accepted                                              |
| 0072 | [Reviewable-slice discipline for PRs and submodule landings](./0072-reviewable-slice-discipline.md)                                                       | Accepted                                              |
| 0073 | [Hub board classification, hierarchy, and a single authoritative view](./0073-hub-board-classification-and-hierarchy.md)                                  | Accepted; amended by ADR-0074, ADR-0075, ADR-0081     |
| 0074 | [Retitle the `major` milestone to `Breaking`](./0074-milestone-major-tier-title.md)                                                                       | Accepted                                              |
| 0075 | [The board's Type column is invisible to GraphQL; view columns become assert-only](./0075-issue-type-invisible-columns-assert-only.md)                    | Accepted                                              |
| 0076 | [A codified analysis spine with preset-driven known cases](./0076-codified-runbook-analysis-presets.md)                                                   | Accepted                                              |
| 0077 | [Codified dead-letter-queue triage: one preset per queue, predicates as the matcher](./0077-dead-letter-queue-triage-procedure.md)                        | Accepted                                              |
| 0078 | [Hub session context management: honest budgets and durable-artifact compaction](./0078-session-context-management.md)                                    | Accepted                                              |
| 0079 | [Demote the live-GitHub-state drift gates to a non-blocking alarm](./0079-hub-drift-non-blocking-alarm.md)                                                | Accepted                                              |
| 0080 | [Host resource budgeting for concurrent Claude Code sessions](./0080-host-resource-budgeting.md)                                                          | Accepted; amends ADR-0013                             |
| 0081 | [Defer ADR-0073's `Programme` board field behind an explicit revival gate](./0081-deferring-the-programme-board-field.md)                                 | Accepted; amends ADR-0073                             |
