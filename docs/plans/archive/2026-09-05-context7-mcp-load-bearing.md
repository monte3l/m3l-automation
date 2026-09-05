# Make the context7 MCP load-bearing

**Status: shipped** — PR 1 [#1038](https://github.com/monte3l/m3l-automation/pull/1038)
(ADR + allowlist + generalized `check:integration-stance`), PR 2
[#1043](https://github.com/monte3l/m3l-automation/pull/1043) (the
`check:reference-freshness` gate + snapshot refresh), PR 3
`feat/context7-mcp-grant` (this PR, the `code-implementer` spoke grant, use
points, and eval rewrites).

## Context

`.mcp.json` declared three MCP servers. Two — `m3l` and `github` — were
allowlisted, named in skill frontmatter, governed by ADR-0030, and gated by
`check:integration-stance`. The third, `context7`, had none of that: no
allowlist entry (every call prompted), no decision of record (it predates
ADR-0030 and is never named by it — ADR-0030 Phase 2 only made the
already-existing entry secretless after a live `ctx7sk-…` key was found
untracked in the repo root), and no prose anywhere.

It was not, however, unused. Three skill reference snapshots
(`tsconfig-strict-esm`, `eslint-flat-config`, `vitest-coverage-types-mocks`)
were authored _from_ Context7 and carried provenance blocks naming the
library id, the pinned version, and a refresh policy — all dated 2026-07-02,
all drifted, all instructing the reader to "re-run `ctx7 skills generate`", a
command that never existed, on a CLI that was being uninstalled. Two eval
suites graded responses on routing to a nonexistent `context7-mcp` skill.
Intent was real and left three kinds of residue — provenance blocks, eval
expectations, secret guards — but nothing connected the server to a
workflow, and nothing noticed when the snapshots rotted.

## Approach / Decisions

Full scope, not document-only: allowlist, a governing ADR, real use points,
and a freshness gate — three sequenced PRs (ADR-0072).

**Mechanism: MCP, hub plus one scoped spoke — not hub-only.**
`/researching-anthropic-guidance` (`docs/research/subagent-mcp-tool-grants.md`)
settled this against the initial "hub-only" premise: granting the tool _is_
the mechanism by which a subagent self-retrieves, and the official guidance
weighs routing everything through the hub as an information bottleneck with
real token overhead. Against that, least-privilege guidance argues for the
narrowest grant that works — one spoke, `code-implementer`, via `mcpServers:
[context7]` in its frontmatter (which also keeps the server's tool schemas
out of the hub's own context), not a blanket grant.

**This selective grant fires ADR-0030's 2026-08-14 re-open condition #1**
verbatim ("`.claude/agents/*.md` gains an `mcp__*` tool grant for a spoke").
ADR-0093 redoes the GitHub-MCP-migration examination the condition demands,
in a dedicated section, and reaffirms `gh` CLI unchanged for all five
GitHub-facing skills — the grant is to a spoke with no GitHub-facing role,
so neither the 2026-07-27 amendment's toolset-coverage blocker nor its
headless-CI blocker is affected. ADR-0030 itself is not rewritten
(append-only convention); it carries a 2026-09-05 amendment recording the
exception and pointing at ADR-0093.

**The gate does not land red.** Under an "honor each snapshot's own declared
refresh policy" rule (`refresh=major` fails only on a major bump;
`refresh=minor` fails on major-or-minor; patch drift never fails), none of
the three snapshots' drift as of PR 2 crossed their own threshold — eslint
10.5→10.9 is a minor bump under a major-only policy, vitest 4.1.9→4.1.11 is a
patch under a minor policy, typescript hadn't moved. PR 2's snapshot refresh
was still justified — the embedded "repo uses" strings were factually stale
and every block cited the dead `ctx7 skills generate` command — but it was
documentation-accuracy work, not gate-forced remediation. This corrected a
premise stated earlier in the same planning session.

**A machine-readable stamp encodes the policy**, mirroring
`docs/research/harness-refresh.md`'s `harness-refresh` HTML-comment
precedent: `<!-- reference-freshness: library=… tracks=name@version,…
snapshot=YYYY-MM-DD refresh=major|minor -->` on line 2 of each snapshot. The
human `> **Provenance**` prose stays; the stamp is what
`bin/lib/reference-freshness.mjs` parses, comparing each tracked package's
stamped version against its installed version across every workspace
manifest.

**`bin/lib/integration-stance.mjs` (PR 1) generalized** from a single
hard-coded GitHub check to a table of `INTEGRATION_DESCRIPTORS`, so a second
governed integration (docs lookup) reuses the same missing-stance-note /
retired-claim / mechanism-mismatch machinery instead of a hand-rolled copy.
A skill whose body literally uses `mcp__context7__` must carry an ADR-0093
stance line (`Docs stance: context7 MCP (ADR-0093).`) in its frontmatter
description, checked against the ~206-char skill-listing budget headroom
before landing (measured: +76 chars across two skills, well within bounds).

**`bin/check-agents.mjs` (PR 3) makes "selective, not blanket" structural**,
not just a convention: `MCP_SPOKES` (`bin/lib/agent-roster.mjs`) names which
agents may hold any `mcp__*` tool at all, and a member's grant must also be
scoped to a server it names in its own `mcpServers:` frontmatter — so a
second, unreviewed server can't be added to an existing spoke's grant
without the gate catching it. Both invariants were mutation-tested (each
temporarily violated, confirmed to fail, then reverted) before the
supporting test file was written.

**Guarded-path writes went through the pre-verify-then-dispatch pattern**
(`.claude/rules/subagent-dispatch.md`): `bin/tests/reference-freshness.test.ts`
(PR 2) and `bin/tests/agent-roster.test.ts` (PR 3) were each written and run
against the real lib modules in the scratchpad first (a throwaway vitest
config, no guarded path touched), then handed to `test-author` to write the
byte-verified content to the guarded path, confirmed identical afterward.

## Outcome

- **PR 1** (`docs/adr/0093-documentation-lookup-mcp-context7.md`,
  `docs/research/subagent-mcp-tool-grants.md`, `.claude/settings.json`
  allowlist, `docs/contributing/skills-catalog.md`'s new "External
  documentation" section, `bin/lib/integration-stance.mjs` generalization +
  tests).
- **PR 2** (`bin/lib/reference-freshness.mjs`, `bin/check-reference-freshness.mjs`,
  `bin/tests/reference-freshness.test.ts`, `check:reference-freshness` wired
  into `verify-steps.mjs`/`ci.yml`/`command-catalog.mjs`; all three skill
  reference snapshots stamped and refreshed to current installed versions).
- **PR 3** (this PR): `code-implementer`'s `mcpServers: [context7]` +
  `mcp__context7__resolve-library-id`/`mcp__context7__query-docs` grant, its
  body's precedence/never-required/data-not-instructions guidance;
  `MCP_SPOKES` + `deriveMcpGrantIssues`/`parseMcpServers` in
  `bin/lib/agent-roster.mjs` and the matching `bin/check-agents.mjs` gate +
  `bin/tests/agent-roster.test.ts`; doc corrections in
  `docs/contributing/agent-operating-model.md` and
  `docs/contributing/skills-catalog.md` (the "MCP is hub-only" claims,
  scoped to name the one exception); use points in
  `implementing-submodules/SKILL.md` (Step 3's dependency-gate docs check,
  Step 4's dist-types-plus-context7 precedence paragraph) and
  `reviewing-dependabot-prs/SKILL.md` (Step 3d's escalation-path option),
  both gaining an ADR-0093 stance line; eval rewrites for
  `eslint-flat-config` (case 3) and `vitest-coverage-types-mocks` (case 4)
  grading on deferring to context7 MCP docs instead of the nonexistent
  `context7-mcp` plugin-skill escape hatch. **End-to-end verification not
  completed**: four throwaway dispatches (three `code-implementer`, one
  baseline `code-reviewer` with an unmodified, pre-existing tool grant)
  each reported a tool list missing not just the new `mcp__context7__*`
  tools but also `Grep`/`Glob` — tools the baseline agent's frontmatter has
  always granted. This looks like this session's specific dispatch
  environment, not a defect in this PR's configuration; see the work log's
  "What didn't go as planned" section for detail. The grant is
  configured and gated, not yet live-verified.
