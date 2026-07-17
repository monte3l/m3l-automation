# AWS SDK boundary: `aws/logs-insights` library submodule + enforcement

**Status: shipped** (PR #120 submodule, PR #129 script)

## Context

While implementing the `logs-insights` W2 consumer script, designing its
CloudWatch Logs Insights `StartQuery`/`GetQueryResults` step hit an
architectural gap: the shipped `AWSClientProvider` (`script.aws.cloudWatchLogs`)
only exposes a **raw** `CloudWatchLogsClient`, so using it would have
required the _script_ to import `@aws-sdk/client-cloudwatch-logs` directly.
The user's directive was firm: consumer scripts must never import any
`@aws-sdk/*` package directly — all AWS SDK usage is mediated through
`@m3l-automation/m3l-common`. A 5-agent parallel audit confirmed no existing
ADR justified raw-client exposure, the library had zero operation-level AWS
wrappers (only the trivial `dynamoDBDocument` getter), roughly 76 distinct
AWS SDK commands existed across the planned W2–W4 fleet, and nothing
today blocked a script from importing `@aws-sdk/*` directly.

## Approach / Decisions

- Resolved via a **purpose-built library submodule per consumer need**
  (rejecting both a blanket upfront wrapper framework for all ~76 commands
  and a script-local raw-SDK dependency), recorded in a new ADR and backed
  by an ESLint rule — decided directly by the user, then detailed by a Plan
  agent and independently re-verified against live source.
- **New ADR-0027** records: scripts never import `@aws-sdk/*` (value or
  type); the library grows a typed wrapper per consumer need (the ADR-0021
  F-series gate), starting with `aws/logs-insights`; enforcement is a new
  `eslint.config.js` override banning `@aws-sdk/*` under `scripts/*/src/**`
  only. It also widens ADR-0009's Zone A (`aws/**` allowed core deps) from
  `{errors, prompt}` to `{errors, prompt, polling}` — the same acyclic edge
  ADR-0026 (`aws/sqs`) had just opened, reused here for the same
  `M3LPoller`/`M3LRetryRunner` need.
- **New submodule `aws/logs-insights`** — one class, `M3LLogsInsightsClient`,
  wrapping an _injected_ `CloudWatchLogsClient` (never self-constructing from
  profile/region, since the script already holds the resolved client).
  `startQuery()` wraps `StartQueryCommand` with throttling retry;
  `awaitResults()` is standalone-usable (the resume/re-attach primitive) and
  polls `GetQueryResultsCommand` via `M3LPoller` +
  `M3LPollingPolicies.cloudWatchLogsQuery()`, throwing
  `M3LLogsInsightsQueryFailedError` on any non-`Complete` terminal status;
  `runQuery()` composes both for the common case. Row normalization
  (`ResultField[][]` → `Record<string,string>[]`) is the submodule's job,
  absorbing what the script's original contract had scoped as a separate
  `normalize-rows.ts` step.
- Sequencing diverged from the F8/F6 two-PR precedent: the submodule and the
  script landed as **two separate PRs** rather than one PR, because
  `logs-insights`'s contract page was dropped from the submodule PR
  (`claude-pr-review` correctly flagged it as referencing a package not yet
  in that diff) and had to be re-drafted from scratch in the script's own PR.
- Landed via `scaffolding-submodules` → `implementing-submodules` (contract →
  RED → GREEN → review fan-out: `code-reviewer`, `security-reviewer`,
  `silent-failure-hunter`, `type-design-analyzer`), then the script resumed
  through `implementing-scripts` against the revised contract.

## Outcome

The submodule merged as PR #120 (`aws/logs-insights`, `M3LLogsInsightsClient`,
its two new error codes, and the Zone A widening); the consuming
`scripts/logs-insights` script merged separately as PR #129 (10 config
parameters, 5 step modules, 66 tests, contract page recreated from the
ground up after the earlier draft was dropped as an orphan doc). Both PRs
landed on 2026-07-13.

Both units were **later renamed** as part of the ADR-0028 naming-convention
follow-up: `aws/logs-insights` → `aws/cloudwatch-logs-insights` and
`logs-insights` → `cloudwatch-logs-insights` (PRs #136/#137), since the
capability is specifically CloudWatch Logs Insights, not a generic
"logs-insights" concept.

Full narrative for the script implementation (contract drifts caught before
RED, the resume-design pivot forced by the exporters' lack of an append
mode, and other divergences/lessons) is recorded in
[`docs/logs/2026-07-13-scripts-logs-insights.md`](../../logs/2026-07-13-scripts-logs-insights.md).
The design decision is recorded in
[`docs/adr/0027-aws-sdk-boundary-typed-wrappers.md`](../../adr/0027-aws-sdk-boundary-typed-wrappers.md).
