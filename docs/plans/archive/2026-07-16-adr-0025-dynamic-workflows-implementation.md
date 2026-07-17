# ADR-0025 dynamic workflows: governance gate + auditing pilot (2026-07-16)

**Status: shipped** (PR #144, commit bc281cf; PR #147, commit 7f8a0fe)

## Context

This is **stage 2** of the program started by
[2026-07-12-adr-0025-dynamic-workflows-assessment.md](2026-07-12-adr-0025-dynamic-workflows-assessment.md),
which recorded ADR-0025 as Proposed: "adopt dynamic workflows selectively,
gated on governance." The last gated item in the trackers' governance
backlog was the ADR-0025 pilot itself — re-expressing the `auditing` skill's
Explore fan-out as a `.claude/workflows/` script with adversarial
verification — but the ADR explicitly gated that pilot on four
prerequisites: validating the new `.claude/workflows/` surface the way
`.claude/agents/` already is, a token/agent-count guardrail, documented
branch isolation for src/test-writing workflows, and a per-step model/effort
convention. No `.claude/workflows/` directory existed yet — this was
greenfield.

## Approach / Decisions

- Split into two sequential PRs: prerequisites first, pilot after, so the
  gate is provably in place before anything depends on it.
- **PR 1 — `feat/check-workflows`:** a new `bin/check-workflows.mjs`,
  structurally mirroring `bin/check-cadence-doc.mjs` (pure exported helpers +
  a main guard doing fs I/O), kept distinct from the pre-existing
  `bin/check-workflows-doc.mjs` (which syncs the CLAUDE.md CI/CD table).
  Rules R1–R7 covered: every `workflow-script` row's file exists; exactly one
  file-level row per script; every model/effort literal in the file matches a
  matrix row; no stale rows; literals pass `isValidWorkflowModel`/
  `isValidEffort` (reused from `bin/lib/claude-models.mjs`, no new exports
  needed); dynamic (non-literal) model/effort values are rejected; and a
  `// max-agents: <N>` header is required, capped at 25. Wired as a CI-only
  step (no lefthook/cadence-table change, matching the `check:deps`
  precedent). ADR-0025 flipped from Proposed to Accepted in this PR.
- **PR 2 — `feat/auditing-workflow-pilot`:** `.claude/workflows/audit-fanout.js`
  — a `find` phase (`parallel` over audit facets, each an Explore agent
  returning a digest) followed by a `verify` phase (`pipeline` per finding, a
  `sonnet`/`medium` refute agent transplanting the security-reviewer's Refute
  mode: assume the finding false, hunt under other names/paths, confirm only
  if refutation genuinely fails). Findings beyond a `VERIFY_MAX` clamp are
  returned as `unverified` rather than silently dropped, so the hub can
  manually verify overflow. No `isolation` options were needed — all agents
  in the pilot are read-only. `.claude/skills/auditing/SKILL.md` was edited
  to coexist: the workflow now owns fan-out + verify, the hub keeps
  aggregation/questions/plan-mode, and a compact manual-dispatch fallback was
  kept for Workflow-less sessions.
- Governance mechanics: new MODEL-MATRIX rows for `audit-fanout.js` (file-level
  `inherit`/`n/a`) and `audit-fanout.js:verify` (`sonnet`/`medium`); an ESLint
  globals override for the ambient workflow hooks
  (`agent`/`parallel`/`pipeline`/`log`/`phase`/`args`/`budget`); `knip.json`
  entry for `.claude/workflows/**/*.js`.

## Outcome

`pnpm check:workflows` gates the `.claude/workflows/` surface in CI, and
`.claude/workflows/audit-fanout.js` is live as the ADR-0025 pilot — completing
the two-stage program started in
[2026-07-12-adr-0025-dynamic-workflows-assessment.md](2026-07-12-adr-0025-dynamic-workflows-assessment.md).
The pilot's build is recorded in
[docs/logs/2026-07-16-audit-fanout-workflow.md](../../logs/2026-07-16-audit-fanout-workflow.md).
