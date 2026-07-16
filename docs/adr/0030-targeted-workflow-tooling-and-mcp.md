# 0030. Targeted workflow tooling and MCP adoption

- **Status:** Accepted
- **Date:** 2026-07-16
- **Deciders:** Enrico Lionello

## Context and problem statement

The repo's agent workflow is entirely CLI-mediated: agents invoke `bin/*.mjs`
scripts through an allowlisted Bash surface and parse human-readable prose to
decide next steps; five skills hand-roll `gh api --paginate` + `jq`
choreography; the `/syncing-docs` pipeline is an 8-step sequence of loose
scripts with documented ordering footguns; and recovery from writer-spoke
truncation (the repo's most-recurring build divergence, 20+ logged incidents)
is a fully manual playbook.

A research pass over official Anthropic guidance
([snapshot](../research/writing-custom-tools-and-mcp.md)) and a 4-facet repo
audit converged on the question: **should this repo add custom agent tools
and/or MCP servers, and if so, which ones?** Two prior ADRs already govern part
of the answer: ADR-0012/0023 defer an external _code-index_ MCP, and two skills
carried a "GitHub MCP blocked by enterprise policy" claim that is no longer
valid.

## Decision drivers

- **Anthropic's selection framework**: custom tools for _frequent,
  high-priority agent actions_; plain Bash/CLI for _ad-hoc work_; skills teach
  _how_, MCP provides _access_; few workflow-shaped tools, never API mirrors;
  structured, high-signal, token-cheap responses.
- **Minimal, uniform toolchain** (ADR-0001): Node/pnpm/ESM only; no new
  runtime dependencies; dev-only additions acceptable when they earn their
  keep.
- **Evidence-driven adoption** (the ADR-0023 precedent): build tooling against
  observed, logged friction — not speculative scale.
- **Security**: no secrets in committed configuration; `.mcp.json` may hold a
  server inventory but never a literal key.
- **No public-API impact**: everything here is repo tooling; the `exports`
  contract is untouched.

## Considered options

1. **Status quo** — keep the pure-CLI surface; agents continue parsing prose
   output and re-implementing gh choreography per skill.
2. **MCP-first migration** — wrap every `bin/` script as an MCP tool and
   rewrite all five GitHub-facing skills onto GitHub MCP in one pass.
3. **Targeted increments** — adopt exactly the tooling that maps to logged
   friction: structured (`--json`) output on agent-invoked scripts, a
   composite doc-sync entry point, a small in-repo MCP server of
   workflow-shaped tools, GitHub MCP configuration with incremental skill
   migration, and a truncation-recovery helper.

## Decision

We chose **option 3 — targeted increments**, applying the research's design
rules to each:

1. **`--json` output mode** on the `bin/` scripts agents invoke interactively
   (shared `bin/lib/report.mjs` result shape; human output and exit codes
   unchanged). Fixes brittle prose-parsing at the lowest possible cost.
2. **Composite doc-sync** (`bin/sync-docs.mjs`, `pnpm sync:docs`) — one
   deterministic entry point for the `/syncing-docs` sequence, with the two
   logged footguns fixed by construction: provenance re-stamping is scoped to
   the affected modules by default (repo-wide only behind `--all`), and
   `gen:index` ordering relative to prettier is baked in.
3. **In-repo MCP server** (`bin/mcp-server.mjs`, stdio, checked-in secretless
   `.mcp.json`) exposing a deliberately small (≤ 7) set of workflow-shaped
   tools — `repo_verify`, `docs_sync`, `worktree_manage`, `scaffold_script`,
   `commit_lint`, `catalog_query`, optionally `spoke_recover` — never a mirror
   of the ~30 underlying scripts. Dev-only dependencies:
   `@modelcontextprotocol/sdk`, `zod`.
4. **GitHub MCP adoption** — the "blocked by enterprise policy" claim recorded
   in `triaging-ci` and `triaging-scan-alerts` is **retired**: the policy no
   longer applies. GitHub's official remote MCP server is configured at
   project scope. Skills migrate **incrementally** — when a GitHub-facing
   skill is next edited, prefer MCP tools where they simplify its gh/jq
   choreography; the gh CLI remains a supported mechanism throughout.
5. **Truncation-recovery helper** (`bin/spoke-recovery.mjs`) — automates the
   manual playbook in `docs/contributing/subagent-context-management.md`:
   journal parsing, on-disk state verification, and a structured
   resume-vs-redispatch recommendation.

### Relationship to the code-index deferral (ADR-0012/0023)

The external code-index MCP deferral **stands**. ADR-0023's revisit trigger is
a two-part AND — the W2–W4 consumer fleet has landed **and** spokes exhibit
grep/context friction the generated catalog cannot answer — and neither branch
has fired: the fleet is early, and the audit's pain-point sweep across 16+
work logs found no symbol-lookup friction.

However, the committed artifacts are now large enough that _reading_ them is
itself the cost (`symbol-map.json` ≈ 45 KB ≈ 11k tokens for a ~50-token
answer). The in-repo server therefore carries a **`catalog_query`** tool that
queries the committed, CI-gated `catalog.json`/`symbol-map.json` via
`bin/lib/reference-index.mjs` and returns only matching entries. This is the
Node-only, zero-infrastructure realization of the indexer's core value —
consistent with the deferral, not a reversal — and it **sharpens ADR-0023's
trigger**: spokes still falling back to grep sweeps _after_ a cheap typed
lookup exists is exactly the observable friction evidence the trigger waits
for.

### Secrets posture for `.mcp.json`

A committed `.mcp.json` must be secretless: server entries reference
credentials via `${VAR}` environment expansion or OAuth; real keys live in the
user's environment. Until the secretless version lands, the file is
gitignored as a stopgap (it briefly held a literal API key).

## Consequences

- **Positive:**
  - Agents get structured, machine-readable results from the scripts they run
    most, ending prose-parsing and invocation-pattern drift.
  - The doc-sync footguns (unscoped re-stamp, gen:index/prettier ordering)
    become impossible rather than documented.
  - `catalog_query` turns an ~11k-token cold-start file read into a ~50-token
    tool call and instruments the ADR-0023 revisit trigger with real usage
    evidence.
  - The GitHub-integration stance is recorded here instead of as an unsourced
    policy claim inside two skill descriptions.
- **Negative / trade-offs:**
  - Three invocation layers (CLI flag, pnpm script, MCP tool) must stay in
    sync where a script is exposed through all of them.
  - Two new dev-only dependencies (`@modelcontextprotocol/sdk`, `zod`) and one
    long-lived stdio server process per session.
  - Incremental skill migration means gh CLI and GitHub MCP coexist for a
    while; per-skill consistency is settled only when each skill is next
    touched.
- **Semver impact:** none — repo tooling and documentation only; the public
  `exports` contract is untouched.

## Links

- Supersedes / superseded by: none. Retires the "GitHub MCP blocked by
  enterprise policy" claim formerly stated in
  `.claude/skills/triaging-ci/SKILL.md` and
  `.claude/skills/triaging-scan-alerts/SKILL.md`.
- Related: [ADR-0001](./0001-toolchain-choices.md) (toolchain ethos),
  [ADR-0012](./0012-defer-external-code-index-mcp.md) /
  [ADR-0023](./0023-reaffirm-code-index-mcp-deferral.md) (code-index deferral,
  unchanged by this ADR),
  [research snapshot](../research/writing-custom-tools-and-mcp.md) (the
  official-guidance evidence base, retrieved 2026-07-16).
