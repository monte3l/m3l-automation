---
name: triaging-ci
description: >-
  Diagnose a CI failure via gh CLI: resolve the failing run, fetch logs, map the
  failure to its pipeline step, report root cause plus the exact local repro
  command, and present 3-5 fix options. Use for /triaging-ci, "why did CI fail",
  "CI is failing", "debug the CI run", or a specific run ID/URL. GitHub stance:
  gh CLI (ADR-0030; no Actions tools in the MCP toolset).
---

Diagnose why a GitHub Actions CI run failed by fetching its logs via `gh` and
mapping the failure back to the specific pipeline step and root cause, then
present 3–5 solution options for the user to choose from. This skill does not
apply fixes — it ends with options, not actions.

## Steps

### 1 — Resolve the run

If the user provided an explicit run ID or URL, extract the numeric ID from it.

Otherwise, find the most recent failed run on the current branch:

```bash
gh run list --branch $(git rev-parse --abbrev-ref HEAD) \
  --limit 5 \
  --json databaseId,status,conclusion,name,createdAt
```

Pick the most recent entry whose `conclusion` is `"failure"`.

If no failed run exists on the current branch (empty result or all passing), widen
the search to the 10 most recent runs across all branches:

```bash
gh run list --limit 10 \
  --json databaseId,status,conclusion,name,headBranch,createdAt
```

If a failed run exists in the broader search, proceed with that run and note the
branch it came from. If no failed run exists anywhere in the recent history, report
that clearly and stop — there is nothing to triage.

### 2 — Fetch the failing job logs

Pull only the logs from steps that failed:

```bash
gh run view <id> --log-failed
```

If that command returns nothing (the run was cancelled, or all steps are
technically "successful" but a post-step failed), fall back to the full log:

```bash
gh run view <id> --log
```

Do not reproduce the entire log output — find and keep only the region around
the first failure, typically the last 50–100 lines before the run aborted.

### 3 — Map to the pipeline step

`.github/workflows/ci.yml` runs a `changes` job that classifies the diff
(`bin/ci-changed-paths.mjs`), seven parallel lane jobs gated on its output
(`secrets`, `deps`, `lint`, `format`, `build`, `test`, `gates` — `secrets`
always runs regardless), and a `verify` aggregator. If a lane is missing from
a run entirely rather than failing, check whether `changes` skipped it
(compare the run's changed files against the categories in
`bin/lib/changed-paths.mjs`) before assuming something is broken. Otherwise,
note which lane the failing step's job belongs to (`gh run view --json jobs`
names it), then match the step itself against this table (steps within a lane
still run in the order listed here; the lanes themselves run concurrently):

| Step name                | Local command                     |
| ------------------------ | --------------------------------- |
| Secret scan (gitleaks)   | — (gitleaks, no local equivalent) |
| Security audit           | `pnpm audit --audit-level=high`   |
| Check dependencies       | `pnpm check:deps`                 |
| Validate commit messages | `node bin/lint-commit.mjs`        |
| Lint                     | `pnpm lint`                       |
| Format check             | `pnpm format:check`               |
| Markdown lint            | `pnpm lint:md`                    |
| Type check               | `pnpm typecheck`                  |
| Check API snapshot       | `pnpm check:api`                  |
| Check doc provenance     | `pnpm check:provenance`           |
| Check doc counts         | `pnpm check:doc-counts`           |
| Test coverage            | `pnpm test:coverage`              |
| Build                    | `pnpm build`                      |
| Check exports            | `pnpm check:exports`              |
| Check scaffold           | `pnpm check:scaffold`             |
| Check unused code        | `pnpm knip`                       |

The step name usually appears verbatim in the log lines (e.g.
`Run pnpm lint:md` or `##[error]...`). Match on that to identify the culprit.

### 4 — Report the diagnosis

Output a concise structured report — no prose padding:

```
## CI Triage — Run #<id>

**Failed step:** <step name from the table above>
**Reproduce locally:** <exact command, e.g. `pnpm lint:md`>
**Root cause:** <one sentence>
**Error excerpt:**
<quoted lines from the log — enough to identify the file/rule/test>
**Assessment:** <Real failure | Likely flake — explain why>
```

A "likely flake" is a transient runner issue: network timeout downloading
dependencies, OOM on a large test run, a GitHub-side runner error, or a retry
that would probably pass. Everything else is a real failure requiring a code fix.

### 5 — Present solution options

After the diagnosis, present 3–5 solution options in a separate
`## Solution Options` section so the diagnosis stays readable on its own. For
each option include: a one-line description, the exact command or change
needed, and the main tradeoff. Do not apply any fix — leave the choice to the
user.

If triaging several failed runs in one pass, write the per-run reports to a
file and keep the chat reply to a short summary table — don't paste every
report inline.
