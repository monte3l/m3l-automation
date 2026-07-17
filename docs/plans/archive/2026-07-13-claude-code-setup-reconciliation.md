# Claude Code setup: official-guidance research vs. repo audit

**Status: shipped** (PR #130, commit 6f71fe9)

## Context

The user asked for a research pass on official Anthropic guidance for
setting up Claude Code in a monorepo/large codebase, an audit of this
repo's actual `.claude/` setup, a comparison of the two, and a prioritized
resolution plan — run as parallel Explore-agent fan-outs (4 research facets
restricted to official Anthropic domains, 4 audit facets reading the live
repo). The repo's Claude Code setup was found to be unusually mature (9
agents, 19 skills, 18 hooks, 3 machine-verified consistency checks) and
already matched most official guidance (model tiering, hub-and-spoke
depth-1 subagents, least-privilege tool grants, CI workflow docs). The gaps
found were narrow and mechanical, not architectural: six dead
`rules/01-06-*.md` references, an incomplete hook inventory in CLAUDE.md,
and CLAUDE.md running roughly 1.75-2x its own stated ~200-line
runtime-visible target.

## Approach / Decisions

User decisions bound the scope: retire the six dead rule-file references
rather than author them, trim CLAUDE.md aggressively toward the official
target, include the lower-priority nice-to-haves in the same pass, and keep
the research briefing inline rather than as a separate snapshot doc.

- **Retire dead references** (P1): replaced the `rules/01-06-*.md` table in
  `.claude/rules/domain-knowledge.md` with a pointer to
  `docs/contributing/style-guide.md` and the per-path `.claude/rules/*.md`
  extracts; removed the same dead links from `style-guide.md`,
  `coding-standards.md`, `CLAUDE.md`, `security-reviewer.md`, and
  ADR-0007 — leaving the frozen archived plan untouched (historical record,
  excluded from `lint:md`).
- **Complete the hook inventory** (P1): rewrote CLAUDE.md's "Claude Code
  hooks" paragraph as a compact table listing all 18 hooks (previously only
  10 were documented), closing the gap against the "keep one authoritative
  hook inventory" guidance and folding the scattered `guard-secret-writes`
  mentions into the same table.
- **Trim CLAUDE.md toward ~200-220 visible lines** (P1): moved the "Agent
  Operating Model" section's detail into a new
  `docs/contributing/agent-operating-model.md`, and "Git Workflow"/"Git
  worktrees" detail into `docs/contributing/contributing.md` and the
  existing worktree ADRs — leaving in CLAUDE.md only the pointers and the
  hard rules that must stay top-of-mind every session. Trimmed prose padding
  around the pre-push cadence table, keeping the machine-verified table
  itself.
- **Nice-to-haves** (P2): added a one-line rationale for why this repo uses
  path-scoped rules instead of nested per-package CLAUDE.md files (rules fit
  better when conventions are cross-cutting rather than directory-owned);
  checked every `SKILL.md` body against the ~500-line progressive-disclosure
  guidance; added an ownership/review-cadence line to CLAUDE.md's intro.
- No architectural changes — MCP servers, `worktree.sparsePaths`, and
  `claudeMdExcludes` were all confirmed out of scope for the repo's current
  size, and documented as such rather than silently skipped.

## Outcome

Landed as PR #130 (commit `6f71fe9`) on 2026-07-13: the six dead-reference
fixes, the completed 18-hook table in CLAUDE.md, the new
`docs/contributing/agent-operating-model.md`, the Git Workflow/worktree
trim, and the P2 nice-to-haves. Verified with `pnpm check:agents`,
`pnpm check:hooks`, and `pnpm check:workflows-doc` passing unchanged (the
edits touched only documentation, not the underlying agents/hooks/workflows
those checks enforce), plus `pnpm lint:md` over the touched docs and a
manual recount confirming CLAUDE.md landed inside its ~200-220 visible-line
target.
