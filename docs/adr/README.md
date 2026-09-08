# Architecture Decision Records

This directory records the architecturally significant decisions for
`@m3l-automation/m3l-common` and the surrounding monorepo. Each ADR captures one
decision: its context, the choice made, and the consequences.

We use a lightweight [MADR](https://adr.github.io/madr/)-style format. Start from
[`template.md`](./template.md).

## Conventions

- One decision per file, named `NNNN-short-title.md` (zero-padded sequence),
  e.g. `0001-esm-only-output.md`.
- **Status schema (ADR-0094).** The status block's machine-readable lines are
  `Status:` and, optionally, `Relations:` and `Review by:` (`Date:` and
  `Deciders:` are prose, not parsed):

  ```markdown
  - **Status:** Accepted
  - **Relations:** partially-superseded-by: 0057 (clauses: the publish pipeline; §Decision 2)
  - **Review by:** 2027-01-11
  ```

  `Status:` is exactly one of `Proposed`, `Accepted`, `Rejected`, `Deprecated`,
  `Superseded`, `Partially-superseded` — it states only the ADR's own current
  standing, never a cross-reference. `Relations:` is optional and holds
  comma-separated `<verb>: <NNNN>` entries; verb is one of `supersedes`,
  `superseded-by`, `partially-supersedes`, `partially-superseded-by`, `amends`,
  `amended-by`, `re-affirmed-by`, `fires-trigger-of`, `trigger-fired-by`. Omit
  the `Relations:` line entirely when an ADR has none.

- **`Review by:` (optional, `docs/decision-notes/0001-deferral-review-by-dates.md`).**
  A `YYYY-MM-DD` date for a deferral ADR whose revisit trigger has not fired
  yet, so it isn't forgotten indefinitely. `pnpm check:adr-index` warns (never
  blocks) once the date has passed — a prompt for a fresh look, not an
  automatic re-open. Applied where it's actually useful, not to every
  "…deferred"-titled ADR: an unfired trigger with no other schedule pressing
  on it is the case this exists for.

- **Partial supersession must name its clauses, on both sides.** A
  `partially-supersedes` / `partially-superseded-by` entry carries a
  `(clauses: …)` qualifier — on the superseding ADR, what it replaces; on the
  superseded ADR, what survives. A bare `Partially-superseded` status with no
  clause list forces the reader to cross-reference the other ADR to learn what
  still applies, which is exactly the ambiguity this convention exists to
  prevent.
- **Every `Relations:` entry must be reciprocal.** If ADR A declares
  `superseded-by: B`, ADR B must declare `supersedes: A` (and likewise for
  every other verb pair). `pnpm check:adr-index` enforces this as a blocking
  check.
- **`## Update` sections are permitted on an `Accepted` ADR without changing
  its `Status:`**, on one condition: the Update must execute a revisit
  trigger or condition already stated in the ADR's own accepted Decision (a
  named consumer call-site, a named multi-script flow, and similar — see any
  ADR titled "…deferred"). Update section headings and dates are never
  renumbered or redated once written; other documents cite them by exact date
  (e.g. `docs/contributing/filing-work.md` cites "ADR-0032's 2026-08-19
  Update").
- **ADRs are immutable in every other respect once `Accepted`.** An Update
  that would change the decision itself — not merely execute a trigger the
  decision already declared — requires a new ADR with `superseded-by` or
  `partially-superseded-by`, and the old ADR's status is updated accordingly.
- **The `## Index` table below is generated, not hand-maintained.** Its
  `ADR | Title | Status` columns are derived from each file's own status block
  by `pnpm gen:adr-index`, inside the `<!-- BEGIN GENERATED ADR INDEX -->` …
  `<!-- END GENERATED ADR INDEX -->` markers; `pnpm check:adr-index` verifies
  the block matches a fresh re-derivation. Do not hand-edit inside the
  markers — regenerate instead.
- Decisions with semver impact (e.g. changes to the `exports` map) should be
  backed by an ADR.
- **A drafted-but-unpushed ADR number is provisional, not reserved.** A
  faster-merging sibling PR can claim the same number first. Re-check
  `ls docs/adr/*.md | tail -1` and `git fetch origin main` right before the
  final push, not just at drafting time; if collided, `git mv` to the next
  free number, fix the file's own `# NNNN.` header and every cross-reference
  (`grep -rl` the old `ADR-NNNN`/filename across the change), then rebase —
  a generated index table means this no longer produces a manual merge
  conflict in this README (ADR-0024's merge driver applies to the generated
  block), only in the file listing itself
  (`docs/logs/2026-09-02-session-naming-convention.md`).

## When to write an ADR

Write a new ADR when:

- A decision affects the **public contract** — adding, removing, or renaming an
  entry in the `exports` map; changing the minimum Node.js version; changing the
  ESM/CJS output strategy.
- A **new runtime dependency** is introduced (or a major one removed) and the
  reasoning should be recorded for future maintainers.
- A **foundational design choice** is made — error model, result type, module
  topology — that will be hard to reverse without a major semver bump.
- A **harness or agent-operating-model decision** changes how work gets done
  across the whole repo — a new spoke role, a subagent tool-grant policy, a
  session-naming or worktree convention, a cross-cutting hook or gate class.
  This cluster was the corpus's largest single theme as of ADR-0095's audit
  (~18 of the then-94 ADRs) and the criteria above never named it explicitly
  before that — naming it here is itself the fix for that gap. (Deliberately
  not re-citing the exact count here: it is a live-corpus fact that rots the
  moment another ADR lands, unlike ADR-0095's own point-in-time record of
  it.)
- There is genuine **disagreement or uncertainty** among deciders: record what was
  decided and why, so it is not relitigated.
- A decision is **superseded**: the new ADR records the change; the old ADR's
  `Status:` is updated to `Superseded` (or `Partially-superseded`, with a
  clause list) and its `Relations:` gains `superseded-by: NNNN`, reciprocated
  by `supersedes: NNNN` on the new ADR.

**The reversibility test.** Before writing a new ADR, ask: _would a different
choice here force a different choice somewhere else, or cost real effort to
reverse?_ If the honest answer is "we'd just change it and move on" — a label
rename, one ESLint zone widened by one module, a naming convention with no
downstream dependents — it does not need an ADR. This test exists because the
corpus accumulated exactly these low-blast-radius entries once ADR-writing
became habitual (ADR-0074 retitles a milestone label; ADR-0040/ADR-0041 each
widen one ESLint zone by a single module; ADR-0087/ADR-0088 are two ADRs for
one harness affordance) — diluting the signal for the ADRs that gate
something genuinely hard to reverse. Route a decision that fails this test to
a [decision note](../decision-notes/README.md) instead: a real record, sized
to the decision.

You do **not** need an ADR for implementation details that stay behind the module
boundary (internal helpers, test utilities, refactors that do not touch the public
surface).

## Index

<!-- BEGIN GENERATED ADR INDEX -->
<!-- Do not hand-edit this block — run `pnpm gen:adr-index` (bin/gen-adr-index.mjs)
     to regenerate it from each ADR's own status block. `pnpm check:adr-index`
     verifies it matches a fresh re-derivation. -->

| ADR  | Title                                                                                                                                                     | Status               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 0001 | [Development toolchain choices](./0001-toolchain-choices.md)                                                                                              | Accepted             |
| 0002 | [ESM-only output](./0002-esm-only-output.md)                                                                                                              | Accepted             |
| 0003 | [Node 24 as the minimum runtime floor](./0003-node-24-floor.md)                                                                                           | Accepted             |
| 0004 | [Exports map as the public contract](./0004-exports-map-contract.md)                                                                                      | Accepted             |
| 0005 | [M3LError and M3LResult as the error model](./0005-error-hierarchy.md)                                                                                    | Accepted             |
| 0006 | [Apache 2.0 license adoption](./0006-license-choice.md)                                                                                                   | Accepted             |
| 0007 | [Automated dependency monitoring and security gating](./0007-dependency-management-strategy.md)                                                           | Accepted             |
| 0008 | [Replace @commitlint/cli with a thin wrapper around @commitlint/lint](./0008-commitlint-cli-replacement.md)                                               | Accepted             |
| 0009 | [Dependency-direction guard: import-x/no-restricted-paths vs dependency-cruiser](./0009-dependency-direction-guard.md)                                    | Accepted             |
| 0010 | [Enforce formatting and Markdown linting in CI, with rumdl as the Markdown linter](./0010-markdown-lint-and-format-ci-gates.md)                           | Accepted             |
| 0011 | [Release and publishing workflow](./0011-release-and-publishing-workflow.md)                                                                              | Superseded           |
| 0012 | [Defer external code-index MCP server; use native LSP + generated catalog](./0012-defer-external-code-index-mcp.md)                                       | Accepted             |
| 0013 | [Git worktrees for task isolation and parallelization](./0013-git-worktrees-for-task-isolation.md)                                                        | Accepted             |
| 0014 | [Symmetric worktree tooling and corrected prune semantics](./0014-symmetric-worktree-tooling.md)                                                          | Accepted             |
| 0015 | [Code-scanning tooling evaluation and supply-chain hardening](./0015-code-scanning-tooling-evaluation.md)                                                 | Accepted             |
| 0016 | [Signed-commit enforcement and the pre-work decision gate](./0016-signed-commits-and-decision-gate.md)                                                    | Accepted             |
| 0017 | [Dependency loading, declaration, and pinning standard](./0017-dependency-loading-standard.md)                                                            | Accepted             |
| 0018 | [Ratify a single shared `M3LScriptOptions` bag for CLI and Lambda](./0018-shared-script-options-bag.md)                                                   | Accepted             |
| 0019 | [Remove the `scripts/` example-automation workspace](./0019-remove-scripts-workspace.md)                                                                  | Superseded           |
| 0020 | [Drop release automation](./0020-drop-release-automation.md)                                                                                              | Partially-superseded |
| 0021 | [Post-1.0.0 direction: deepen the library first, then build consumers](./0021-post-1.0-deepen-first-strategy.md)                                          | Superseded           |
| 0022 | [Re-introduce the `scripts/` workspace for real consumers](./0022-reintroduce-scripts-workspace.md)                                                       | Accepted             |
| 0023 | [Re-affirm the external code-index MCP deferral on new grounds](./0023-reaffirm-code-index-mcp-deferral.md)                                               | Accepted             |
| 0024 | [Deterministic prevention of derived-artifact merge conflicts](./0024-deterministic-derived-artifact-merges.md)                                           | Accepted             |
| 0025 | [Selective adoption of dynamic workflows for subagent orchestration](./0025-dynamic-workflows-assessment.md)                                              | Accepted             |
| 0026 | [Typed SQS operations wrapper over the raw SDK client](./0026-sqs-operations-wrapper.md)                                                                  | Accepted             |
| 0027 | [Scripts never import `@aws-sdk/*`; the library grows typed AWS operation wrappers per consumer need](./0027-aws-sdk-boundary-typed-wrappers.md)          | Partially-superseded |
| 0028 | [AWS-scoped scripts and submodules are named with full official AWS service names](./0028-aws-service-naming-convention.md)                               | Accepted             |
| 0029 | [Consumer scripts depend only on @m3l-automation/m3l-common](./0029-script-dependency-boundary.md)                                                        | Accepted             |
| 0030 | [Targeted workflow tooling and MCP adoption](./0030-targeted-workflow-tooling-and-mcp.md)                                                                 | Partially-superseded |
| 0031 | [Relational and document data-engine access for the consumer fleet](./0031-relational-and-document-data-engine-access.md)                                 | Accepted             |
| 0032 | [Centralized project-state and roadmap visibility hub](./0032-project-management-visibility-hub.md)                                                       | Partially-superseded |
| 0033 | [Typed S3 operations wrapper over the raw SDK client](./0033-aws-s3-operations-wrapper.md)                                                                | Accepted             |
| 0034 | [Sonar/Act-Podman re-assessment: OSS complexity/duplication gates, Act/Podman declined](./0034-sonar-act-podman-reassessment.md)                          | Accepted             |
| 0035 | [Failure reporting and diagnostics architecture](./0035-failure-reporting-and-diagnostics.md)                                                             | Accepted             |
| 0036 | [Inbound dependency license policy](./0036-dependency-license-policy.md)                                                                                  | Accepted             |
| 0037 | [Re-read deepen-first against real consumer pull; priority order for the capability-deepening wave](./0037-deepen-first-re-read-against-consumer-pull.md) | Accepted             |
| 0038 | [Widen the SQS wrapper for DLQ redrive; add an `AWSServiceProvider` services tier](./0038-sqs-dlq-redrive-and-aws-services-tier.md)                       | Partially-superseded |
| 0039 | [LLM/Bedrock inference integration is out of scope for `m3l-common`](./0039-llm-integration-out-of-scope.md)                                              | Accepted             |
| 0040 | [Widen the `aws/**` ESLint zone to admit `core/utils/M3LSingleFlight`](./0040-single-flight-zone-widening.md)                                             | Accepted             |
| 0041 | [Widen the `aws/**` ESLint zone to admit `core/logging`'s handler port](./0041-logger-seam-zone-widening.md)                                              | Accepted             |
| 0042 | [Defer the script-facing `packages/m3l-cli` package](./0042-script-cli-package-deferred.md)                                                               | Accepted             |
| 0043 | [Defer a step-pipeline engine; close out the remaining reference capabilities](./0043-step-pipeline-engine-deferred.md)                                   | Accepted             |
| 0044 | [Remove three deprecated `AWSClientProvider` wrapper getters](./0044-remove-deprecated-client-wrapper-getters.md)                                         | Accepted             |
| 0045 | [Byte-offset streaming resume for list exporters](./0045-streaming-safe-resume-contract.md)                                                               | Accepted             |
| 0046 | [Adopt a codified-procedure engine (`core/procedure`)](./0046-codified-procedure-engine.md)                                                               | Accepted             |
| 0047 | [Cross-script orchestration belongs to `m3l-cli`, and is deferred](./0047-cross-script-orchestration-deferred.md)                                         | Accepted             |
| 0048 | [Grade the destructive confirmation by target, not only by action](./0048-target-graded-destructive-confirmation.md)                                      | Accepted             |
| 0049 | [A cooperative cancellation contract for long-running operations](./0049-cooperative-cancellation-contract.md)                                            | Accepted             |
| 0050 | [GitHub platform-feature stance](./0050-github-platform-feature-stance.md)                                                                                | Partially-superseded |
| 0051 | [Semantic priority vocabulary for labels, milestones, and tracker cells](./0051-semantic-priority-vocabulary.md)                                          | Accepted             |
| 0052 | [Hub board identity and field taxonomy](./0052-hub-board-identity-and-field-taxonomy.md)                                                                  | Partially-superseded |
| 0053 | [CLI-first evolution programme: from launcher to product](./0053-cli-first-evolution-programme.md)                                                        | Accepted             |
| 0054 | [Typed command-module contract and hybrid execution](./0054-command-module-contract-and-hybrid-execution.md)                                              | Accepted             |
| 0055 | [Declarative, enumerable operations in script config](./0055-declarative-operation-introspection.md)                                                      | Accepted             |
| 0056 | [Cross-script orchestration engine in `m3l-cli` (`m3l flow`)](./0056-cross-script-orchestration-engine.md)                                                | Accepted             |
| 0057 | [Distribute the CLI and its fleet via a private GitHub Packages registry](./0057-private-registry-distribution.md)                                        | Accepted             |
| 0058 | [Agent-operator programme: staged AI-agent operation of the m3l fleet](./0058-agent-operator-programme.md)                                                | Accepted             |
| 0059 | [`aws/bedrock-runtime` typed wrapper and tool-use loop primitives](./0059-bedrock-runtime-wrapper-and-loop-primitives.md)                                 | Accepted             |
| 0060 | [Agent policy layer: graded autonomy as a real authorization control](./0060-agent-policy-layer.md)                                                       | Accepted             |
| 0061 | [Agent decision log: an append-only audit artifact class](./0061-agent-decision-log.md)                                                                   | Accepted             |
| 0062 | [Runtime MCP surface: `packages/m3l-mcp`](./0062-runtime-mcp-surface.md)                                                                                  | Accepted             |
| 0063 | [CLI structured run results: completing the machine surface](./0063-cli-structured-run-results.md)                                                        | Accepted             |
| 0064 | [m3l console programme: a full-stack operations console](./0064-m3l-console-programme.md)                                                                 | Accepted             |
| 0065 | [Console server architecture and execution integration](./0065-console-server-architecture.md)                                                            | Accepted             |
| 0066 | [Console API contract: REST commands, SSE live streams](./0066-console-api-rest-sse.md)                                                                   | Accepted             |
| 0067 | [Console frontend stack and the scoped bundler exception](./0067-console-frontend-stack.md)                                                               | Accepted             |
| 0068 | [Workbench sessions and the addressable-artifact convention](./0068-workbench-sessions.md)                                                                | Accepted             |
| 0069 | [Console embedded persistence: `node:sqlite` behind a repository seam](./0069-console-embedded-persistence.md)                                            | Accepted             |
| 0070 | [Console audit, self-observability, and the display-vs-persist rule](./0070-console-audit-and-observability.md)                                           | Accepted             |
| 0071 | [Console containerization and local-first deployment](./0071-console-containerization-deployment.md)                                                      | Partially-superseded |
| 0072 | [Reviewable-slice discipline for PRs and submodule landings](./0072-reviewable-slice-discipline.md)                                                       | Accepted             |
| 0073 | [Hub board classification, hierarchy, and a single authoritative view](./0073-hub-board-classification-and-hierarchy.md)                                  | Accepted             |
| 0074 | [Retitle the `major` milestone to `Breaking`](./0074-milestone-major-tier-title.md)                                                                       | Accepted             |
| 0075 | [The board's Type column is invisible to GraphQL; view columns become assert-only](./0075-issue-type-invisible-columns-assert-only.md)                    | Accepted             |
| 0076 | [A codified analysis spine with preset-driven known cases](./0076-codified-runbook-analysis-presets.md)                                                   | Accepted             |
| 0077 | [Codified dead-letter-queue triage: one preset per queue, predicates as the matcher](./0077-dead-letter-queue-triage-procedure.md)                        | Accepted             |
| 0078 | [Hub session context management: honest budgets and durable-artifact compaction](./0078-session-context-management.md)                                    | Accepted             |
| 0079 | [Demote the live-GitHub-state drift gates to a non-blocking alarm](./0079-hub-drift-non-blocking-alarm.md)                                                | Accepted             |
| 0080 | [Host resource budgeting for concurrent Claude Code sessions](./0080-host-resource-budgeting.md)                                                          | Accepted             |
| 0081 | [Defer ADR-0073's `Programme` board field behind an explicit revival gate](./0081-deferring-the-programme-board-field.md)                                 | Accepted             |
| 0082 | [Self-polling cadence for harness-vs-Anthropic freshness](./0082-harness-refresh-cadence.md)                                                              | Accepted             |
| 0083 | [Permissions hardening and the managed-settings scope for a single-maintainer repo](./0083-permissions-hardening-and-managed-settings-scope.md)           | Accepted             |
| 0084 | [Which improvement signals the retrospective loop consumes](./0084-retrospective-signal-sources.md)                                                       | Accepted             |
| 0085 | [CLI secret delivery via the spawn environment, not argv](./0085-cli-secret-delivery-via-spawn-env.md)                                                    | Accepted             |
| 0086 | [Per-attempt retry metadata leaves `core/polling` by a sibling detailed method](./0086-retry-attempt-metadata-seam.md)                                    | Accepted             |
| 0087 | [Claude Code session naming convention](./0087-claude-code-session-naming-convention.md)                                                                  | Accepted             |
| 0088 | [Automatic session naming via a launcher wrapper](./0088-automatic-session-naming-via-launcher.md)                                                        | Accepted             |
| 0089 | [Skill invocation stance, the listing-budget ceiling, and where routing guidance lives](./0089-skill-invocation-stance-and-listing-budget.md)             | Partially-superseded |
| 0090 | [Native `subagentStatusLine` supersedes the JSONL spoke-lifecycle tracker](./0090-subagent-statusline-supersedes-lifecycle-tracker.md)                    | Accepted             |
| 0091 | [Podman and Containerfiles replace Docker for the console's app containers](./0091-podman-replaces-docker.md)                                             | Accepted             |
| 0092 | [Out-of-band usage cache for the statusline's first network dependency](./0092-out-of-band-usage-cache.md)                                                | Accepted             |
| 0093 | [Documentation-lookup MCP (Context7): adoption stance and usage policy](./0093-documentation-lookup-mcp-context7.md)                                      | Accepted             |
| 0094 | [ADR governance: a structured status schema and a generated index](./0094-adr-governance-and-status-schema.md)                                            | Accepted             |
| 0095 | [ADR-worthiness routing and a lightweight decision-note tier](./0095-adr-worthiness-and-decision-note-tier.md)                                            | Accepted             |
| 0096 | [Replace the in-repo `m3l` MCP server's tool set with read-only query tools](./0096-m3l-mcp-server-replace-with-query-tools.md)                           | Accepted             |
| 0097 | [A Should-fix acknowledgment gate for claude-pr-review](./0097-should-fix-acknowledgment-gate.md)                                                         | Accepted             |
| 0098 | [Raise the skill-listing budget fraction from 1% to 2%](./0098-raise-skill-listing-budget-fraction.md)                                                    | Accepted             |

<!-- END GENERATED ADR INDEX -->
