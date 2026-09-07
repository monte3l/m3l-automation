---
name: triaging-scan-alerts
description: >-
  Triage GitHub code-scanning alerts on a PR/branch via gh CLI: fetch open
  alerts, group by tool and severity, map to file:line, gate on error-severity
  CodeQL blocking merge, present remediation — no code edited. Use for
  /triaging-scan-alerts, "check the CodeQL alerts". Skip for bot findings or CI
  failures. GitHub stance: gh CLI (ADR-0030).
---

Diagnose the GitHub **code-scanning alerts** on a PR or branch via `gh`, group
them by tool and severity, and report which ones block merge — then present
remediation options for the user to choose from. This skill does not edit code
or dismiss alerts; it ends with options, not actions.

CodeQL runs via GitHub "default setup" (repo settings, not a workflow file).
The **required** merge context is the single consolidated `CodeQL` check — the
per-language `Analyze (...)` runs do report on human PRs, but they are not the
gate (see `docs/contributing/branch-protection.md`). Scorecard uploads
supply-chain alerts to the same code-scanning surface.

**This skill is reactive by design, and that is not an oversight.** It reads
what code scanning has already published; it never triggers a scan and is not
a pre-push gate — that half is `creating-prs` Step 8, which checks
_pre-existing_ alerts against the files a branch touches, before the push. The
split is forced by the platform: a scan cannot analyze code that has not been
pushed yet, so nothing earlier than "after the push" has anything new to read.
The cost of the split is a wait, and Step 1a below is where this skill pays
it — not by scanning earlier, but by refusing to read a scan that has not
finished.

## Steps

### 1 — Resolve the PR and repo

Confirm `gh` is authenticated, then find the PR for the current branch:

```bash
gh auth status
gh pr view --json number,headRefName,headRefOid,url,mergeable,mergeStateStatus
```

If no PR is open for the branch, the alerts still apply to the branch head —
continue and note that findings are reported against the branch, not a PR. Use
`git rev-parse HEAD` for `headRefOid` in that case.

Resolve `{owner}/{repo}` for the API calls:

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

### 1a — Confirm the scan for this head has finished

Skip this step if the alerts were handed to you rather than fetched live (a
saved export, a pasted list), or if the head commit was pushed more than ~5
min ago. Otherwise the alerts endpoint may still be answering for the
_previous_ head, and an empty answer is indistinguishable from a clean scan:

```bash
gh api repos/{owner}/{repo}/commits/{headRefOid}/check-runs \
  --jq '.check_runs[] | select(.name | startswith("Analyze ("))
        | "\(.name)\t\(.status)\t\(.conclusion)"'
```

Proceed only once **every** row reports `completed`. Empty output means no
scan has been created for this commit yet — wait and re-run; never read it as
"no alerts". Do **not** substitute the required `CodeQL` check for this — it
completes well before the `Analyze (...)` runs that actually produce the
alerts, so it can be green while the analysis is still in flight. Typical
waits: ~2 min on a PR head, ~5 min on a direct `main` push (which produces no
`CodeQL` check at all). Measured figures and rationale:
`docs/contributing/branch-protection.md` § CodeQL scan timing and alert
readiness.

If the wait is unacceptable, say so and stop — do not report a possibly-stale
alert list as current.

### 2 — Fetch open code-scanning alerts

Pull every open alert (`--paginate` so alerts beyond the first page are not
silently missed):

```bash
gh api --method GET repos/{owner}/{repo}/code-scanning/alerts --paginate -f state=open
```

`--method GET` is required: `gh api` silently switches to POST whenever a
`-f` field is present unless the method is stated explicitly, and this
endpoint only has a GET handler — a POST here 404s instead of 405, which
looks identical to code scanning being disabled.

If the endpoint still returns `403`/`404` with `--method GET` in place, code
scanning is not enabled or the token lacks the `security_events` scope —
report that and stop. If the list is empty, report "no open code-scanning
alerts" and stop.

### 3 — Group and map

Group alerts by `tool.name` (**CodeQL** vs **Scorecard**) and `rule.severity`,
mapping each to its rule and location:

```bash
gh api --method GET repos/{owner}/{repo}/code-scanning/alerts --paginate -f state=open \
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

Error-severity CodeQL alerts on changed files are the ones that fail the
required `CodeQL` check. Scorecard alerts reflect repo/workflow posture,
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
