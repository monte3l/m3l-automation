# ADR-0030: custom tools & MCP tooling program (2026-07-16 – 2026-07-17)

**Status: shipped** (PR #140, commit 6826546 — through PR #151, commit fb7d696)

## Context

The user asked for official Anthropic guidance on writing custom tools and
MCP servers (TypeScript focus), then an audit of whether adding them to this
repo would add significant value. Research ran via `/researching-anthropic-guidance`
(5 Explore agents over official Anthropic domains only); the audit ran via
`/auditing` (4 Explore agents over the repo), with key claims re-verified
against the live repo by the hub. The repo's extension surface was already
lean and deliberate (18 hooks, 20 skills, 9 tiered agents, no `.mcp.json`,
ADR-0012/0023 explicitly deferring an external code-index MCP), so the
question was whether specific, workflow-shaped tools were worth the added
surface — not whether to adopt MCP wholesale.

## Approach / Decisions

Anthropic's own framework — custom tools for _frequent, high-priority_
actions, Bash for _ad-hoc_ work, skills teach _how_ while MCP provides
_access_, few workflow-shaped tools rather than API mirrors, start simple —
was applied per-candidate rather than as a blanket adoption. The user
confirmed all four proposed increments plus a fifth: the "GitHub MCP blocked
by enterprise policy" wording in two skills was stale and needed correcting
now that GitHub MCP is actually available. The work shipped as six phases:

- **Phase 1 — Research + ADR-0030:** persisted the research briefing to
  `docs/research/`, then wrote `docs/adr/0030-targeted-workflow-tooling-and-mcp.md`
  recording the selection framework, the four approved increments, the
  formal retirement of the stale "enterprise policy" claim, and an explicit
  ADR-0012/0023 reconciliation: the external code-index deferral stands
  (its revisit trigger hadn't fired on either branch), but a `catalog_query`
  tool on the future in-repo server was adopted as the interim, zero-infra
  answer to the same underlying need.
- **Phase 2 — GitHub MCP configuration:** added GitHub's official remote MCP
  server at project scope in a checked-in, secretless `.mcp.json` (OAuth, no
  token literals), with read-only `mcp__github__*` patterns allowlisted and
  write actions left prompt-gated. Skills kept `gh` CLI as their mechanism
  for now — migration is incremental, not a rewrite.
- **Phase 3 — `--json` structured output on agent-invoked bin scripts:** a
  shared `bin/lib/report.mjs` helper producing a uniform
  `{ ok, errors[], warnings[], updated?/created?[] }` result object, applied
  to the representative set of scripts skills invoke interactively
  (doc-provenance, doc-counts, impl-counts, doc-exports, test-counts,
  reference-index, check-agents, check-script-scaffold, scaffold-script,
  worktree lifecycle), with human text unchanged by default.
- **Phase 4 — Composite doc-sync (`bin/sync-docs.mjs`):** one deterministic
  entry point for the `/syncing-docs` sequence, reusing `bin/lib/` modules
  directly instead of shelling out, baking in the two documented footguns —
  scoped provenance re-stamp by default (repo-wide only behind `--all`) and
  correct `gen:index`-before-prettier ordering.
- **Phase 5 — In-repo MCP server:** `bin/mcp-server.mjs` +
  `bin/lib/mcp-tools.mjs`, deliberately kept to ≤6 workflow-shaped tools
  rather than a mirror of the ~30 bin scripts — `repo_verify`, `docs_sync`,
  `worktree_manage`, `scaffold_script`, `commit_lint`, and `catalog_query`
  (the Node-only, zero-infra realization of the ADR-0012/0023 code-index
  need, querying the committed catalog/symbol-map rather than requiring a
  file read of the ~11k-token `symbol-map.json`).
- **Phase 6 — Truncation-recovery helper:** `bin/spoke-recovery.mjs`, given a
  spoke journal path, parses it, verifies on-disk state against the dispatch
  punch-list, optionally runs a targeted vitest pass, and emits a JSON
  resume recommendation (resume-same-spoke vs. re-dispatch) per the
  subagent-context-management playbook; exposed as the `spoke_recover` MCP
  tool.

## Outcome

`docs/adr/0030-targeted-workflow-tooling-and-mcp.md` records the full
program. The in-repo `m3l` MCP server and GitHub MCP are both live in
`.mcp.json`; `pnpm sync:docs` is the new composite doc-reconciliation entry
point; agent-invoked bin scripts support `--json`; and
`bin/spoke-recovery.mjs` / `spoke_recover` close the loop on the repo's
most-recurring build divergence (subagent truncation recovery).
