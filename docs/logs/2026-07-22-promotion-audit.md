# Work log — promotion-audit (2026-07-22)

This log covers a full audit of the work-log → rules feedback loop: every
archived plan (`docs/plans/archive/**`, 64 files) and every work log
(`docs/logs/*.md`, 41 files at audit time) was read by fan-out Explore spokes
and cross-referenced against every durable home (`.claude/rules/`,
`.claude/agents/`, the skills, `docs/contributing/`, the ADRs, and the
hook/check enforcement layer). Each recorded lesson was classified as
**promoted** (lives in a durable home), **unpromoted** (never landed anywhere),
or **unlearned** (a remediation shipped but the failure recurred afterward).
The confirmed gaps were remediated in this change set — documentation edits
only.

## Summary

- Audit scope: 64 archived plans + 41 work logs, verified against 6 durable-home
  classes (rules, agents, skills, contributing docs, ADRs, hooks/check scripts).
- Findings: **6 unpromoted** lessons (F1–F6 below), **2 unlearned** (F7–F8),
  **2 lost-tracking restorations**, and a set of verified-learned items recorded
  here so the next audit doesn't re-derive them.
- Files edited: 2 SKILL playbooks (`implementing-submodules`,
  `implementing-scripts`), 1 agent (`test-author`), 3 rules (`tests.md`,
  `scripts.md`, `subagent-dispatch.md`), 4 contributing docs, `writing-work-logs`
  SKILL (new template field + cadence check), 2 trackers (`IMPLEMENTATION.md`,
  `ROADMAP.md`), 6 log files (provenance stamps only), `docs/logs/README.md`.
- Skills used: auditing (manual hub-driven variant), writing-work-logs.
- Spoke incidents: 1 truncation / 0 stalls / 1 resume (a verification Explore
  spoke stopped mid-report and was resumed via `SendMessage`; recovered
  losslessly — inaugurating this template line, see
  `docs/contributing/subagent-context-management.md` § Efficacy watch).

## Classification

### Unpromoted → remediated this change set

| #   | Lesson                                                                                        | Source log(s)                                                                                                                                             | Promoted to                                                                                                   |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| F1  | Verify a documented mechanism end-to-end before documenting it                                | `2026-07-11-scripts-json-etl.md`; cited: `2026-07-18-scripts-athena-query.md` (contract page shipped `script.aws.athena` for `script.aws.clients.athena`) | `implementing-scripts` + `implementing-submodules` SKILL Step 8                                               |
| F2  | Post-review fix rounds are unreviewed writer code — dispatch a bounded confirmation re-review | `2026-07-02-core-text.md`, `2026-07-03-core-script.md`, `2026-07-03-core-importers.md`; cited: `2026-07-13-dynamo-crud.md`                                | both implementing SKILLs (review phase) + `.claude/rules/subagent-dispatch.md`                                |
| F3  | Re-run `pnpm knip` as its own gate after every fix/remediation round                          | `2026-07-18-scripts-athena-query.md`, `2026-07-18-eventbridge-schedules.md`, `2026-07-17-adr-0030-workflow-tooling-mcp.md`                                | `implementing-scripts` SKILL Step 7 + `.claude/rules/scripts.md`                                              |
| F4  | Stacked branches × squash merges need `git rebase --onto`                                     | `2026-07-17-adr-0030-workflow-tooling-mcp.md`                                                                                                             | `docs/contributing/contributing.md` § Branches and versioning                                                 |
| F5  | Bash-write bypass of `Write\|Edit` PreToolUse guards — tracking was lost                      | `archive/2026-07-12-hook-hardening.md` claimed a tracker row "was recorded" in `IMPLEMENTATION.md`; it never was                                          | row restored in `IMPLEMENTATION.md` P2 table + accepted-risk note in `docs/contributing/hooks-reference.md`   |
| F6  | Promotion-sweep cadence had "no scheduling mechanism" (self-reported by `skills-catalog.md`)  | `docs/contributing/skills-catalog.md` § Periodic maintenance                                                                                              | every-5-logs rule in `docs/logs/README.md`, checked by `writing-work-logs` SKILL Step 5; catalog cell updated |

### Unlearned → remediated this change set

| #   | Finding                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                          | Remediation                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F7  | Truncation/stall **prevention is unproven; recovery works.** The 2026-07-14 hardening wave did not stop incidents: 7 writer-spoke truncations on 2026-07-17 (all recovered losslessly) and 3 review-spoke stalls of 60+ minutes on 2026-07-18. The 2026-07-19 second wave (SubagentStop detector + scope binding) has no efficacy evidence yet | `2026-07-17-adr-0030-workflow-tooling-mcp.md`; `2026-07-18-aws-athena.md` / `-aws-eventbridge.md` / `-aws-s3.md`                                  | honest "Efficacy watch" section in `subagent-context-management.md` + a mandatory `Spoke incidents:` line in the work-log template so the next audit has hard counts |
| F8  | Typecheck-as-separate-gate was promoted **asymmetrically**: it landed in `code-implementer.md` (2026-07-09) but never in `test-author.md`, so test-file type bugs kept surfacing at later gates                                                                                                                                                | `2026-07-03-core-importers.md` ("Runtime-green ≠ typecheck-green"); recurred `2026-07-18-eventbridge-schedules.md` §1, `2026-07-18-s3-objects.md` | RED-phase separate-mandatory-gate wording in `test-author.md` Procedure step 6 + a "Runtime-green ≠ typecheck-green" gotcha bullet in `.claude/rules/tests.md`       |

### Verified learned / excluded (no action; evidence pointers for the next audit)

- **Stale-plan-premise re-validation** — promoted (`implementing-submodules`
  SKILL Step 2); the 07-17/07-18 "premises rotted" mentions are the rule
  _working_ (premises caught at re-validation), not recurrences.
- **`minimumReleaseAge` vs fresh Dependabot bumps** — documented in
  `pnpm-workspace.yaml` (supply-chain cooldown comment block).
- **`git rebase --continue` skips the pre-commit prettier hook** — promoted
  (`resolving-merge-conflicts` SKILL, "Re-check formatting" step).
- **Context7 API-key incident (2026-07-17)** — fixed in PR #141
  (`${CONTEXT7_API_KEY}` placeholder, `ctx7sk-` pattern in
  `guard-secret-writes.mjs`, `.gitleaks.toml`).
- **ADR-0035 diagnostics phases 1–5, F1b, F6b, F3, F7/onUnknownFormat** —
  already tracked (ADR rollout section / `IMPLEMENTATION.md` P2 rows); planned,
  not unpromoted.
- **`check-test-counts.mjs` stale-column bug** (flagged in
  `2026-07-02-core-polling.md`) — fixed (`a373d27` → `44e4506` rescoped the
  parser; header-row guard present); `bin/tests/gen-doc-counts.test.ts` carries
  the synthetic-bump suite for the generator/checker pair (T7).
- **Review-scope binding, journal-path dispatch, bounded digests, CLI-over-IDE,
  expectTypeOf precision, coverage-never-by-deletion, TSDoc-orphan,
  error-code registration, denylist swallows** — all verified present in their
  durable homes; no action.

### Lost-tracking restorations

- **Bash-write bypass** (F5 above) — the 2026-07-12 hook-hardening plan said
  "recorded as a tracked follow-up in `docs/plans/IMPLEMENTATION.md`"; no such
  row existed until this change set.
- **ADR-0032 visibility-hub implementation** — the ADR mandates follow-up work
  (`gen:project-hub`, `pages.yml`, custom domain, two one-way sync scripts,
  the addendum's commit-stats endpoint-badge migration) that was never filed in
  either tracker; rows added to `IMPLEMENTATION.md` (P2) and `ROADMAP.md`
  (Priority 2).
- **`docs/logs/README.md` index** — its tables stopped at 2026-07-16 while ten
  later logs existed; rows reconciled in this change set.

## What didn't go as planned, and why

### 1. Three audit findings were corrected by design-time reading

The remediation design pass refuted parts of the audit's own draft: (a)
`docs-consistency-reviewer` was a proposed F1 home, but it is structurally
read-only (`guard-readonly-bash.mjs`) and cannot execute a mechanism end-to-end
— F1 landed in the SKILL playbooks only; (b) F3 was drafted as "add knip as a
gate," but knip already _is_ a gate — the unpromoted lesson was specifically
_re-running it after fix rounds_; (c) F6 was drafted as "no cadence exists,"
but `docs/logs/README.md` already carried a "by feel, every ~5–8 logs" note —
the gap was concreteness and a checklist hook, not absence.

**Why it happened:** classification was done against an inventory digest, not
against every target file's full text.

**Fix for future:** before drafting a remediation for an "absent" lesson, read
the candidate target file in full — half-existing guidance changes the edit
from "add" to "sharpen."

### 2. The audit itself hit a spoke truncation

The verification Explore spoke stopped mid-run with only a transition sentence
("Now I'll continue…") as its final message — the exact failure shape this
repo's playbook documents. It was resumed via `SendMessage` with two extra
checks appended and completed the full V1–V15 report losslessly.

**Why it happened:** a 15-question verification brief is a large single
dispatch; the spoke paced itself past its budget mid-report.

**Fix for future:** the existing playbook worked as designed (detect →
resume-same-spoke); counted in this log's `Spoke incidents:` line as the first
datapoint for the efficacy watch.

## Lessons learned

- **A plan claiming "recorded as a tracked follow-up" must be verified against
  the live tracker in the same review** — the F5 Bash-bypass row and the
  ADR-0032 backlog items were both promised in accepted documents and silently
  never filed. A claim of tracking is not tracking.
  _(remediated structurally this change set: both rows restored; the audit
  report itself is the durable record)_
- **The promotion loop mostly works** — of ~40 distinct recurring lessons
  examined, all but six had landed in a durable home, usually within days.
  The gaps clustered in (a) lessons whose home is a _process step_ rather than
  a code rule, and (b) follow-ups deferred out of a shipping change set.
- **"Remediated" needs an efficacy check, not just a landing check** — F7/F8
  show a remediation can ship and still not resolve the failure (wrong spoke,
  or prevention-vs-recovery conflation). The new `Spoke incidents:` field turns
  the next such judgment from opinion into counts.
