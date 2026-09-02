---
name: reviewing-dependabot-prs
description: >-
  Reviews every open Dependabot PR, proposes merge/hold/reject by semver level
  and check status, executes the confirmed batch: auto-merge safe bumps, hold
  risky ones, close bad ones. Use for /reviewing-dependabot-prs, "review the
  dependabot PRs", "merge the safe dependabot updates". Only acts on explicit
  invocation after batch confirmation. GitHub stance: gh CLI.
---

# reviewing-dependabot-prs

Dependabot PR events don't receive this repo's secrets (GitHub withholds them
from bot-triggered `pull_request` runs), which is why `claude-pr-review.yml`
already excludes `dependabot[bot]` from the mandatory review gate — Dependabot
PRs only clear `verify`, `dependency-review`, and CodeQL today, with no review
step and no merge/hold/reject decision at all. This skill fills that gap by
running as **you**, through your own `gh` auth and Claude access, so it needs
no workflow secret and no new CI wiring.

## Boundary rules

- Never execute a merge, comment, or close for any PR until you've shown the
  full batch of proposed verdicts for **every** open Dependabot PR in this run
  and gotten one explicit confirmation covering the batch. Never ask
  per-PR — that defeats the point of automating a backlog sweep.
- Never enable the repo's Settings → General → "Allow auto-merge" toggle
  yourself — that's a repository setting, not a PR action, and stays a human
  call. If `gh pr merge --auto` fails because it's off, report that as a
  prerequisite the user needs to flip and stop; don't work around it.
- Never post `@dependabot ignore` or otherwise permanently suppress a
  dependency. REJECT is always a plain close + rationale comment. Be exact
  about what that buys: on a **grouped** PR, Dependabot's own body says "This
  pull request was built based on a group rule. Closing it will not ignore any
  of these versions in future pull requests." That is a promise about
  _suppression_ — the versions stay eligible for some future run — and not a
  promise that this PR, or an equivalent one, comes back. A **solo**
  (single-dependency) PR carries no such statement at all. Permanent
  suppression remains a separate, deliberate action left to the user; see
  [REJECT is irreversible](#reject-is-irreversible) for what closing actually
  costs.
- Only act on PRs authored by `dependabot[bot]` — never touch a human PR that
  happens to also be about dependencies.
- Runs in-process as a single agent — no hub-and-spoke needed; this is
  operational tooling, not library or script code, so none of the
  `packages/*/src` or `scripts/*/src` review/test machinery applies.

## REJECT is irreversible

Closing a Dependabot PR deletes its head ref, and every recovery path is gone:

- `@dependabot reopen` was **removed** — announced 2025-10-06, effective
  2026-01-27, and absent from the current comment-commands reference.
- `@dependabot recreate` is a documented **no-op on a closed PR**. It replies
  "Looks like this PR is closed. If you re-open it, I'll rebase it."
- GitHub refuses to reopen a PR whose head ref has been deleted.

So the only way back is re-authoring the bump by hand. That is not
hypothetical here: PR #781 (a grouped `aws-sdk` bump) was closed over a
stranded lockfile — not an incompatibility — and had to be rebuilt by hand as
PR #790, because `git ls-remote --heads origin` showed no surviving
`dependabot/*` ref for it.

Note which way that example cuts. #781 was **grouped**, and being grouped
still did not bring the PR back; the group rule only kept the versions
eligible. A **solo** PR does not even get that. Treat every REJECT as final,
and a solo REJECT as final with nothing held in reserve.

Per `.github/dependabot.yml`, only three npm groups exist — `toolchain`,
`commit-tooling`, and `aws-sdk`. Any npm dependency matching none of those
patterns (today: `rumdl`, `@inquirer/prompts`) gets a solo PR. The
`github-actions` ecosystem groups on `"*"`, so those are always grouped.

---

## Steps

### 1 — Discover open Dependabot PRs

```bash
gh pr list --author "dependabot[bot]" --state open \
  --json number,title,body,headRefName,url,labels,statusCheckRollup,mergeStateStatus
```

If this returns nothing, tell the user "No open Dependabot PRs" and stop.

Resolve `{owner}/{repo}` once, for reuse in later API calls:

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

### 2 — Skip PRs already reviewed and unchanged

For each PR, fetch its comments and look for a prior verdict marker this
skill posted:

```bash
gh api repos/{owner}/{repo}/issues/{number}/comments --paginate --slurp \
  --jq 'add | [.[] | select(.body | test("<!-- dependabot-review-verdict:"))] | last // {} | .body // ""'
```

The marker has the form
`<!-- dependabot-review-verdict: sha=<head_sha> checks=<comma-joined check
conclusions> -->` (mirrors the `claude-review-sha` idiom already used by
`claude-pr-review.yml` to avoid redundant re-review work). If a marker exists
whose `sha` matches the PR's current head SHA **and** whose `checks` string
matches the current `statusCheckRollup` conclusions, this PR hasn't changed
materially since the last run — skip it (don't include it in Step 4's table,
or note it as "unchanged, skipped" if the user asked for a full listing).
Otherwise carry it into classification.

### 3 — Classify each remaining PR

**a. Parse the semver level per bumped dependency** straight from Dependabot's
own title/body text — no external tooling needed:

- Single-dependency PR: title reads `Bump <pkg> from <old> to <new>`.
- Grouped PR: the body contains a Markdown table, one row per bumped
  dependency, each with old/new versions.

Diff each old→new pair to patch/minor/major. If a PR bumps multiple deps and
any single one is major, treat the whole PR as major for routing purposes.

**Record the shape — grouped or solo — as a first-class field on the PR, not
just as a parsing detail used to find the versions.** It changes the routing
in **c**, the REJECT bar in **d**, and the table the user confirms in Step 4.
A PR is grouped if Dependabot's body carries the "built based on a group rule"
line; solo otherwise.

**b. Read `statusCheckRollup`** for the required contexts. Match by the
`name` field actually present on the PR's check runs — don't hardcode
assumed names, since `docs/contributing/branch-protection.md` itself notes
GitHub's default-setup CodeQL naming can drift. As observed on this repo's
live PRs, the four contexts report as `verify`, `review` (always `SKIPPED`
for Dependabot — expected, see branch-protection.md), `Dependency Review`,
and `CodeQL` (a single context, not two). Treat conclusion `SUCCESS` **or**
`NEUTRAL` as passing — CodeQL reports `NEUTRAL` rather than `SUCCESS` when a
scan completes with zero findings, which is the common case, not a
lesser-passing state. Treat `FAILURE`/`ERROR` as failing, and
`PENDING`/`IN_PROGRESS`/`EXPECTED`/anything still running as not yet decided.
`review` itself is never part of this evaluation — it's always skipped for
Dependabot PRs by design and carries no signal either way.

**c. Route:**

| Condition                                                                            | Route                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| All bumps patch/minor, `verify` + `Dependency Review` + `CodeQL` all SUCCESS/NEUTRAL | **Fast path → propose MERGE**                                                 |
| All bumps patch/minor, no check FAILURE, but ≥1 still running                        | **Propose HOLD** — "checks still running, re-run this skill once they finish" |
| **Solo** PR whose only defect is a stale base or a stranded lockfile                 | **Propose HOLD, never REJECT** — a rebase recovers it; a close does not       |
| Any bump major, or any required check FAILURE/ERROR                                  | **Escalation path** — read the changelog before deciding                      |

**d. Escalation path.** Before reaching for a network fetch, check the PR
body first — Dependabot itself usually embeds the release notes, changelog
excerpt, and commit list under collapsible `<details><summary>Release
notes</summary>` / `<summary>Changelog</summary>` sections. Read those. Only
fall back to `WebFetch` against the npm registry page (npm ecosystem) or `gh
api repos/<action-owner>/<action-repo>/releases` (github-actions ecosystem)
when the PR body doesn't already carry this information.

Judge breaking-change risk against this repo's actual constraints — strict
TypeScript, ESM-only output, the Node.js 24+ floor, and the zero-runtime-deps
policy for `m3l-common` (most Dependabot bumps here are devDependencies, so
the bar is "does this break the build/lint/test toolchain," not "does this
break a published API"). Decide:

- **MERGE** — changelog shows no change that would affect this repo's usage
  (e.g. a major bump that's actually just a version-scheme bump, or a
  breaking change in an area this repo doesn't touch).
- **HOLD** — genuinely ambiguous; needs a human to read the changelog
  themselves or test the bump locally. HOLD is the correct default whenever
  the defect is _positional_ rather than substantive — a stale base, a
  stranded lockfile, a flaky run — because those are recoverable and REJECT is
  not.
- **REJECT** — changelog or the failing check clearly shows an incompatible
  or regressive change (e.g. drops Node 24 support, removes a config option
  this repo's `eslint.config.js`/`tsconfig.base.json` relies on, or the
  failure is a real break, not a flake). REJECT is irreversible and the bar
  scales with the PR's shape:
  - **Grouped** — the versions stay eligible for a future run, but this PR is
    gone for good. Require a concrete incompatibility, named.
  - **Solo** — nothing is held in reserve; closing may lose the update
    permanently, including a security-relevant patch bump. Require that same
    named incompatibility _and_ mark the verdict "may be final" in Step 4's
    table. If you cannot name the break, the answer is HOLD.

If a required check is still `FAILURE` but looks like a transient CI flake
(network timeout, runner error) rather than a real incompatibility, treat it
like the "checks still running" case — propose HOLD with a note to re-run CI,
not REJECT.

### 4 — Build the summary table

One row per PR classified in Step 3 (skip ones filtered out in Step 2). The
**Shape** column is mandatory — it is what tells the maintainer, at
confirmation time, which rejections are recoverable and which are not:

```
| PR   | Title                          | Shape   | Semver | Verdict | Rationale                     |
| ---- | ------------------------------- | ------- | ------ | ------- | ------------------------------ |
| #142 | Bump typescript from 6.0 to 6.1 | grouped | minor  | MERGE   | patch/minor, all checks green  |
| #139 | Bump eslint from 9.x to 10.x    | grouped | major  | HOLD    | changelog: new flat-config default may need eslint.config.js updates |
| #135 | Bump rumdl from 0.2.6 to 0.3.0  | solo    | minor  | REJECT  | ⚠ may be final — drops the config key `lint:md` relies on |
```

Any REJECT row on a **solo** PR carries the `⚠ may be final` marker in its
rationale. Present this table in chat before touching anything.

### 5 — Confirm once

Ask the user to confirm the whole batch — e.g. "Proceed with these N
merges, M holds, and K rejects?" When any REJECT is on a solo PR, say so in
the same sentence and name the count — e.g. "…and K rejects, J of them solo
PRs that cannot be recovered once closed?" The maintainer must see the
irreversible cost before confirming, not after. A "no" or a request to change
individual verdicts means re-presenting the table with corrections and asking
again; never execute on a partial or implicit confirmation.

### 6 — Execute (only after confirmation)

**MERGE:**

```bash
gh pr merge <number> --auto --squash
```

If this fails because auto-merge isn't enabled on the repo, stop and tell the
user: "Auto-merge is off for this repo — enable it under Settings → General →
'Allow auto-merge', then re-run this skill." Don't retry, don't attempt a
direct `gh pr merge` without `--auto` as a workaround — that would bypass
required checks entirely.

**HOLD:**

```bash
gh api repos/{owner}/{repo}/issues/{number}/comments \
  --method POST --field body="$(cat <<'EOF'
Holding this Dependabot PR for human review: <rationale from Step 3>.

<!-- dependabot-review-verdict: sha=<head_sha> checks=<checks_string> -->
EOF
)"
```

**REJECT:** the comment must state what closing actually does, so pick the
wording that matches the PR's shape. Never tell a reader this PR will reopen —
it will not.

Grouped:

```bash
gh pr close <number> --comment "$(cat <<'EOF'
Closing this Dependabot PR: <rationale from Step 3>. This is not a permanent
suppression — the group rule keeps these versions eligible, so a future
scheduled run may propose them again in a new PR. This PR itself is closed for
good: its head ref is deleted and cannot be reopened.

<!-- dependabot-review-verdict: sha=<head_sha> checks=<checks_string> -->
EOF
)"
```

Solo:

```bash
gh pr close <number> --comment "$(cat <<'EOF'
Closing this Dependabot PR: <rationale from Step 3>. This is a
single-dependency PR, so there is no group rule holding these versions
eligible and no guarantee the update is proposed again. Closing deletes the
head ref and cannot be undone; recovering this bump means re-authoring it by
hand.

<!-- dependabot-review-verdict: sha=<head_sha> checks=<checks_string> -->
EOF
)"
```

The trailing marker on HOLD/REJECT comments is what makes Step 2's
idempotency check work on the next run. A MERGE doesn't need one — once
merged, the PR won't show up in Step 1's open-PR list again.

Report back a short summary: how many merged, held, rejected, and (for
merges) that GitHub will complete them automatically once required checks
finish.

---

## Verification

- Run the skill against this repo's actual open Dependabot PRs (if any exist)
  and sanity-check: semver classification matches what the PR title/body
  actually says, fast-path vs. escalation routing looks right, and the
  summary table before Step 5 is accurate.
- Confirm the batch-confirmation gate genuinely blocks — decline the
  confirmation once and verify nothing was merged/commented/closed.
- Re-run the skill immediately after a HOLD/REJECT and confirm Step 2 skips
  that PR (no duplicate comment, no second close attempt) since nothing
  material changed.
- If auto-merge is off in the repo, confirm the MERGE path surfaces that
  clearly instead of silently doing nothing or falling back to an
  unprotected merge.
- Confirm every row of the Step 4 table carries a Shape value, and that any
  solo REJECT is marked `⚠ may be final` before the Step 5 confirmation is
  asked for — an unmarked solo REJECT is the exact defect this skill's REJECT
  path was corrected for.
