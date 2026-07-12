---
name: triaging-scan-alerts
description: >-
  Triage GitHub code-scanning alerts on a PR or branch in this repo using the gh
  CLI: fetch the open alerts, group them by tool (CodeQL vs Scorecard) and
  severity, map each to its file:line and rule, gate on error-severity CodeQL
  alerts that block merge, and present remediation options — without editing any
  code. Use this skill whenever the user says /triaging-scan-alerts, "check the
  CodeQL alerts", "code scanning alerts", "security scanning alerts", "any CodeQL
  findings", "check the security tab", "what's in the security tab", "did CodeQL
  flag anything", "review the scanning alerts", or asks whether a PR is blocked
  by a required code-scanning check. Always uses gh CLI; never uses GitHub MCP
  (blocked by enterprise policy). Skip for: fixing claude-pr-review bot findings
  (use resolving-pr-comments), and diagnosing failed CI workflow steps (use
  triaging-ci).
---

Diagnose the GitHub **code-scanning alerts** on a PR or branch via `gh`, group
them by tool and severity, and report which ones block merge — then present
remediation options for the user to choose from. This skill does not edit code
or dismiss alerts; it ends with options, not actions.

CodeQL runs via GitHub "default setup" (repo settings, not a workflow file), and
its `Analyze (...)` check-runs are required to merge (see
`docs/contributing/branch-protection.md`). Scorecard uploads supply-chain alerts
to the same code-scanning surface.

## Steps

### 1 — Resolve the PR and repo

Confirm `gh` is authenticated, then find the PR for the current branch:

```bash
gh auth status
gh pr view --json number,headRefName,url,mergeable,mergeStateStatus
```

If no PR is open for the branch, the alerts still apply to the branch head —
continue and note that findings are reported against the branch, not a PR.

Resolve `{owner}/{repo}` for the API calls:

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

### 2 — Fetch open code-scanning alerts

Pull every open alert (`--paginate` so alerts beyond the first page are not
silently missed):

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts --paginate -f state=open
```

If the endpoint returns `403`/`404`, code scanning is not enabled or the token
lacks the `security_events` scope — report that and stop. If the list is empty,
report "no open code-scanning alerts" and stop.

### 3 — Group and map

Group alerts by `tool.name` (**CodeQL** vs **Scorecard**) and `rule.severity`,
mapping each to its rule and location:

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts --paginate -f state=open \
  --jq '.[] | "\(.tool.name)\t\(.rule.severity)\t\(.rule.id)\t\(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
```

### 4 — Report the gate

Cross-reference each **CodeQL** alert's path against the branch's changed set:

```bash
git diff main...HEAD --name-only
```

Output a concise structured report — no prose padding:

```
## Scan Triage — <PR #n or branch>

**Blocking (error-severity CodeQL, touches changed files):**
- <rule.id> — <path:line> — <one-line description>

**Other CodeQL alerts (not on changed files / lower severity):**
- <rule.id> [<severity>] — <path:line>

**Scorecard (supply-chain posture — config, not code):**
- <rule.id> [<severity>] — <one-line description>

**Merge status:** <mergeStateStatus from Step 1, e.g. BLOCKED / CLEAN>
```

Error-severity CodeQL alerts on changed files are the ones that block the
required `Analyze (...)` check. Scorecard alerts reflect repo/workflow posture,
not code defects — never silently dismiss them.

### 5 — Present remediation options

In a separate `## Remediation Options` section, present 3–5 options for the user
to choose from. For each: a one-line description, the concrete next step, and the
main tradeoff. Do not edit code or dismiss alerts here — hand the actual code fix
to the user or to `resolving-pr-comments`, and leave any alert dismissal (with a
justification) to the user.

If the alert count is large, write the full per-alert breakdown to a file and
keep the chat reply to the blocking-alert summary and merge status — don't
paste every alert inline.
