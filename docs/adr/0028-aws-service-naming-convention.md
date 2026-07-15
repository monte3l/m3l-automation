# 0028. AWS-scoped scripts and submodules are named with full official AWS service names

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Enrico Lionello

## Context and problem statement

The 2026-07-15 fleet-governance audit (14-agent, two-wave review of the work
shipped since 2026-07-13) found that the convention "AWS-scoped scripts and
submodules are named after an AWS service" exists only as a de facto pattern:
it is documented nowhere and enforced nowhere. The only naming rule any gate
checks is the kebab-case regex in `bin/lib/script-scaffold.mjs`. The result is
drift already on disk and more scheduled in the roadmap:

- The shipped script `dynamo-crud` abbreviates the service name (the service
  is DynamoDB; the library submodule `aws/dynamodb` is correctly named).
- The shipped script `logs-insights` and submodule `aws/logs-insights` name a
  capability without its service family (the AWS capability is CloudWatch
  Logs Insights).
- `docs/ROADMAP.md` planned future scripts as `cfn-stacks`, `apigw-client`,
  and `data-query` — two abbreviations and one name with no service in it.

Left unwritten, every scaffold re-derives the convention from examples, and
the examples themselves disagree.

## Decision drivers

- One greppable name per AWS service across the whole monorepo: the submodule,
  the script, its reference page, and its ROADMAP row should all agree.
- A rule the scaffold generator can eventually machine-enforce (follow-up T5
  in `docs/ROADMAP.md`) has to be strict enough to check mechanically.
- Abbreviations (`cfn`, `apigw`, `dynamo`) read fine to whoever wrote them and
  ambiguously to everyone else — single-maintainer projects live on
  greppability, not tribal memory.

## Considered options

1. **Leave the convention de facto** — keep naming by example, no written
   rule.
2. **Strict full official names** — every AWS-scoped unit is named with the
   full official service name (or fully-qualified capability name),
   kebab-case, pattern `<service>[-<purpose>]`; abbreviations banned.
3. **Official names with recognized short forms** — full names required, but
   AWS-recognized capability short names (e.g. `logs-insights`) stay valid;
   only invented abbreviations (`cfn`, `apigw`) are banned.

## Decision

We chose **option 2: strict full official service names.**

An AWS-scoped script or submodule is named with the full official AWS service
name — or, for a service capability, the fully-qualified capability name —
in kebab-case, following the pattern `<service>[-<purpose>]`. Examples:
`dynamodb-crud`, `cloudwatch-logs-insights`, `cloudformation-stacks`,
`api-gateway-client`, `athena-query`. Abbreviations are banned: `cfn`,
`apigw`, and `dynamo` are not names; `sqs`, `s3`, `ecs`, and `eks` are —
they are the official service names, not abbreviations of longer ones.

**Scope definition.** A unit is "AWS-scoped" when its primary purpose is
operating one AWS service. Exempt: non-AWS scripts (`json-etl`) and
infrastructural submodules named for their function rather than a service
(`aws/clients`, `aws/credentials`, `aws/models`). The rule governs
service-operation units only.

**Noncompliance ledger.** Three shipped units predate this ADR and violate
it. Renames are scheduled as tracked follow-ups (see the Governance
follow-ups section of `docs/ROADMAP.md`), each its own PR:

| Unit      | Current             | Target                         | Blast radius                                                                                                                                                                                                                       |
| --------- | ------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| script    | `dynamo-crud`       | `dynamodb-crud`                | ~85 live refs: 42 in `scripts/dynamo-crud/` (pkg name `@m3l-automation/dynamo-crud`; `src/steps/run-dynamo-crud.ts` alone has 19), root `tsconfig.json` project ref, `docs/reference/scripts/dynamo-crud.md` filename, ROADMAP row |
| script    | `logs-insights`     | `cloudwatch-logs-insights`     | same shape: pkg name, directory, reference-page filename, ROADMAP row                                                                                                                                                              |
| submodule | `aws/logs-insights` | `aws/cloudwatch-logs-insights` | internal directory + barrel line in `src/aws/index.ts`, reference page + provenance sidecar filenames, `gen:index` catalog/symbol-map regen                                                                                        |

**Semver note.** The submodule rename changes no public subpath — the
`exports` map stays `.` / `./core` / `./aws` (ADR-0004) and the barrel
re-export path is internal. Renaming _exported symbols_
(`M3LLogsInsightsClient` etc.) WOULD be breaking per the exports contract;
the rename PR decides symbol treatment explicitly, and keeping the
`M3LLogsInsights*` symbol names (they name the capability, not the module
path) is the safe default.

**History note.** `docs/logs/` and `docs/plans/archive/` filenames are
immutable history and are never renamed by these follow-ups.

## Consequences

- **Positive:** one name per service everywhere; scaffold naming becomes
  mechanically checkable (follow-up T5); ROADMAP, reference pages, and
  directories stop disagreeing about what a unit is called.
- **Negative / trade-offs:** three rename PRs of real churn (~85 references
  for `dynamo-crud` alone); until they land, the ledger above is the honest
  record that the rule and the tree disagree.
- **Semver impact:** none from this ADR itself (documentation). The scheduled
  submodule rename is internal (no subpath change); only a symbol rename —
  explicitly not defaulted to — would be major.

## Links

- Related: [ADR-0022](./0022-reintroduce-scripts-workspace.md) (script
  workspace shape and package naming); [ADR-0029](./0029-script-dependency-boundary.md)
  (companion governance decision from the same audit);
  `docs/ROADMAP.md` Governance follow-ups T1–T3 and T5 (the scheduled
  renames and the scaffold naming check); `.claude/rules/scripts.md`
  (agent-facing extract of this rule).
- Supersedes / superseded by: none.
