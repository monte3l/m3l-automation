# GitHub CLI vs GitHub MCP reassessment (2026-07-27)

**Status: shipped** (commit db2b10f, branch `chore/github-mcp-reassessment`)

## Context

The maintainer asked for an audit of `gh` CLI usage across the project's
Claude automations (skills/subagents), with the goal of reassessing it for
integration or replacement with the configured GitHub MCP server. A
three-facet parallel-agent audit (gh-call-site inventory, MCP/permission
surface, documented-stance-vs-live-state) found the decisive fact
immediately: ADR-0030's decision item 4 ("skills migrate incrementally when
next edited") had produced **zero** migrations in the 11 days since
acceptance — not neglect, but a structural mismatch. `.mcp.json` configures
only the GitHub MCP _default_ toolset, which carries no Actions or
code-scanning tools; `mcp__github__merge_pull_request` has no auto-merge
equivalent; MCP tools are unreachable from any spoke (`.claude/agents/*.md`
tool grants are all closed lists); and `claude-pr-review.yml` pins
`--allowedTools Bash,Read` with no `--mcp-config`, so MCP is unavailable in
headless CI. Only one of the five gh-using skills — `resolving-pr-comments`,
hub-only and in-process — had full, unblocked MCP coverage. The audit also
found ADR-0030's own context overstated the jq surface ("five skills" vs.
the actual three using `gh api --paginate`), a stale dead permission entry,
and a genuine correctness bug (`creating-prs`'s CodeQL probe missing
`--paginate`, silently dropping alerts past page 1).

## Approach / Decisions

The aggregated findings were put to the user across two rounds of
`AskUserQuestion`: which target stance to adopt, whether to enable the
Actions/code-scanning toolsets, what to do with the permission allowlists,
how to handle the CI/spoke blockers, how to record the ADR correction, what
to do with `resolving-pr-comments`'s mechanism-asserting evals, and which
incidental fixes to fold in. The user chose the narrowest sufficient path
throughout: **selective migration + a falsifiable ADR amendment** (not full
migration, not a stance reversal); **keep the default MCP toolset** (skip
`/x/actions`/`/x/code_security` — the research snapshot's ~30–50-tool
degradation threshold outweighs unblocking two skills); **promote the
gh api/repo/auth patterns to project settings, drop the dead `gh pr checks`
entry, allowlist read-only `mcp__github__*` tools**; **document the CI/spoke
blockers as a hard constraint** (not wire MCP into CI); **an amendment
section in ADR-0030** (not a new superseding ADR); **rewrite evals
mechanism-neutral** so future migrations don't break them; and **fold in
all four incidental fixes** (the `--paginate` bug, consistent stance notes
across all five skills, the PAT-vs-OAuth log correction, and a new drift
gate).

Implementation (shared checkout, branch `chore/github-mcp-reassessment`, per
`/starting-work`) amended `docs/adr/0030-targeted-workflow-tooling-and-mcp.md`
with the coverage matrix, the structural-blocker record, a corrected count,
and a two-part falsifiable revisit trigger (mirroring the ADR-0023-precedent
trigger already in the same document) replacing the un-falsifiable "when
next edited" wording. `resolving-pr-comments` migrated its PR-detection,
comment-fetch, and reply-post steps to `mcp__github__list_pull_requests` /
`pull_request_read` / `add_issue_comment`, deleting the repo's worst
`gh api --paginate --jq ... | jq -s 'last'` choreography; its evals and
`triaging-ci`'s "(not MCP)" eval clause were rewritten to assert outcomes,
not mechanisms. The remaining four skills each gained a stance note naming
why they stay gh-CLI-based (no Actions/code-scanning tool in the default
toolset; no auto-merge MCP equivalent), and `creating-prs` gained the
missing `--paginate`. `.claude/settings.json` promoted the machine-local
`gh api`/`gh repo`/`gh auth` patterns, dropped the dead `gh pr checks` entry,
and allowlisted four read-only `mcp__github__*` tools (write tools stay
prompt-gated). `docs/contributing/agent-operating-model.md` and
`skills-catalog.md` gained the MCP-is-hub-only / MCP-unavailable-in-CI
constraint and a per-skill mechanism table. A new `check:github-stance` gate
(`bin/check-github-stance.mjs` + `bin/lib/github-stance.mjs`, unit tested)
fails CI if a GitHub-talking skill lacks an ADR-0030 stance reference,
asserts the retired "blocked by enterprise policy" claim, or names the wrong
mechanism — closing the exact gap that let that claim survive undetected for
months.

## Outcome

`docs/adr/0030-targeted-workflow-tooling-and-mcp.md`'s amendment is the
current GitHub-integration stance of record. `resolving-pr-comments` is the
first (and, per the coverage matrix, likely only near-term) skill on GitHub
MCP; the other four stay gh-CLI-based by documented decision. No
`exports`-map or public-API change — all edits are under `.claude/**`,
`docs/**`, `bin/**` (new dev-tooling files), `package.json`, and
`.github/workflows/ci.yml`. Full gate sweep passed (`lint`, `typecheck`,
`test:coverage` — 4992 tests across 149 files including the new
`bin/tests/github-stance.test.ts`, `build`, `knip`, `lint:md`, and the full
`/syncing-docs` reconciliation, plus every `check:*` governance script
touching `.claude/**`/`docs/**`). A manual negative test confirmed
`check:github-stance` fails when a stance note is stripped, and restores
clean. PR pending.
