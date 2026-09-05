# Work log — context7-mcp-load-bearing (2026-09-05)

This log covers a 3-PR sequence (ADR-0072) making the `context7`
documentation-lookup MCP server load-bearing: PR 1
[#1038](https://github.com/monte3l/m3l-automation/pull/1038) (ADR + allowlist

- generalized `check:integration-stance`), PR 2
  [#1043](https://github.com/monte3l/m3l-automation/pull/1043) (the
  `check:reference-freshness` gate + snapshot refresh), PR 3
  `feat/context7-mcp-grant` (this PR, the `code-implementer` spoke grant, use
  points, and eval rewrites).

Plan of record: [`docs/plans/archive/2026-09-05-context7-mcp-load-bearing.md`](../plans/archive/2026-09-05-context7-mcp-load-bearing.md)

## Summary

**PR 1 (#1038, merged):** `docs/adr/0093-documentation-lookup-mcp-context7.md`
— adoption stance, distinguishes this from the ADR-0012/0023 code-index
deferral, re-examines ADR-0030's 2026-08-14 re-open condition #1 in a
dedicated section (reaffirms gh-CLI unchanged for the five GitHub-facing
skills). `docs/research/subagent-mcp-tool-grants.md` (23 official Anthropic
sources via `/researching-anthropic-guidance`) is its evidence base.
`.claude/settings.json` allowlists both `mcp__context7__*` tools.
`bin/lib/integration-stance.mjs` generalized from a single hard-coded GitHub
check into an `INTEGRATION_DESCRIPTORS` table, preserving every existing
GitHub-descriptor behavior byte-for-byte (hand-traced against all 15 original
test cases). `docs/contributing/skills-catalog.md` gained an "External
documentation" section.

**PR 2 (#1043, merged):** `bin/lib/reference-freshness.mjs` (pure
derivation) + `bin/check-reference-freshness.mjs` (CLI wrapper) +
`bin/tests/reference-freshness.test.ts` (10 tests) — parses a
`<!-- reference-freshness: library=… tracks=name@version,… snapshot=…
refresh=major|minor -->` stamp on each Context7-sourced skill reference
snapshot, compares tracked-package versions against installed manifests
under the stamp's own declared policy (major-only fails on a major bump;
minor fails on major-or-minor; patch drift never fails), and fails on a
retired `` `ctx7 <verb>` `` CLI claim reappearing. Wired into
`verify-steps.mjs`/`ci.yml`/`command-catalog.mjs`. All three snapshots
(`tsconfig-strict-esm`, `eslint-flat-config`, `vitest-coverage-types-mocks`)
were stamped and their stale "repo uses" version strings corrected — the
gate did not land red (none of the three had drifted past their own
declared policy), so this was documentation-accuracy work, not gate-forced
remediation, confirming a premise the plan corrected during its own
authoring.

**PR 3 (this PR):** `code-implementer` gained `mcpServers: [context7]` +
`mcp__context7__resolve-library-id`/`mcp__context7__query-docs` in `tools:`,
plus body guidance (dist-types precedence, never-required, data-not-
instructions). `bin/lib/agent-roster.mjs` gained `MCP_SPOKES`,
`parseMcpServers`, `deriveMcpGrantIssues`; `bin/check-agents.mjs` wires them
into a new gate (an agent outside `MCP_SPOKES` holding any `mcp__*` tool
fails; an `MCP_SPOKES` member's tool must be scoped to a server it also
names in `mcpServers:`) plus `bin/tests/agent-roster.test.ts` (10 tests).
Doc corrections: `docs/contributing/agent-operating-model.md` and
`docs/contributing/skills-catalog.md`'s "MCP is hub-only" claims, both
scoped to name the one exception (ADR-0030's 2026-09-05 amendment had
already anticipated and pre-written this correction during PR 1, so no
ADR-0030 edit was needed here). Use points + ADR-0093 stance lines in
`implementing-submodules/SKILL.md` (Step 3's dependency-gate docs check,
Step 4's dist-types-plus-context7 precedence paragraph) and
`reviewing-dependabot-prs/SKILL.md` (Step 3d's escalation-path option). Eval
rewrites for `eslint-flat-config` (case 3) and `vitest-coverage-types-mocks`
(case 4), replacing the nonexistent `context7-mcp` plugin-skill escape
hatch with grading on the real `mcp__context7__*` mechanism.

Skills used: `starting-work` (three times, one per PR), `finishing-work`
(after PR 2), `creating-prs` (per PR), `researching-anthropic-guidance`
(PR 1, overturning the plan's initial hub-only premise),
`writing-work-logs` (this log, deferred from PR 2's close-out to cover all
three PRs per the plan's own PR 3 scope).

## What went as planned

- The three-PR split (ADR-0072) worked cleanly: PR 1's governance/stance
  landed independently of PR 2's gate-plus-refresh, which landed
  independently of PR 3's actual grant — each reviewable and mergeable on
  its own.
- PR 2's gate genuinely did not land red, exactly as the plan (corrected
  mid-authoring) predicted: honoring each snapshot's own declared
  `refresh=` policy meant none of the three tracked-package drifts as of
  PR 2 crossed their threshold.
- The pure-derivation/CLI-wrapper split (mirroring `integration-stance.mjs`)
  carried over cleanly to both `reference-freshness.mjs` (PR 2) and the new
  `deriveMcpGrantIssues`/`parseMcpServers` functions (PR 3) — both were
  fully testable without spawning anything, and both invariants were
  mutation-tested (temporarily violated, confirmed to fail, then reverted)
  before their test files were written.
- The guarded-path pre-verify-then-dispatch pattern
  (`.claude/rules/subagent-dispatch.md`) worked identically both times:
  `bin/tests/reference-freshness.test.ts` (PR 2) and
  `bin/tests/agent-roster.test.ts` (PR 3) were each verified byte-for-byte
  against the real lib in a scratchpad throwaway vitest config before
  `test-author` wrote the guarded file, confirmed identical afterward both
  times.
- ADR-0030's 2026-09-05 amendment, written during PR 1, correctly
  pre-answered PR 3's doc-correction requirement — it explicitly named
  which two doc files would need editing and when ("once that PR lands"),
  so PR 3 needed no ADR-0030 edit at all, only the two corrections it had
  already scoped.

## What didn't go as planned, and why

### 1. A slot collision forced a mid-flight ADR renumber during PR 1

PR 1 was originally authored as ADR-0092, then renumbered to ADR-0093 in a
follow-up commit (`fix: renumber ADR-0092 to ADR-0093 (slot collision)`)
after another, unrelated PR claimed ADR-0092 first
(`docs/adr/0092-out-of-band-usage-cache.md`, the statusline weekly-usage
work landing concurrently). PR 1's merge commit title still reads "ADR-0092"
even though the actual file is `0093-documentation-lookup-mcp-context7.md`
— the title string was not updated after the rename. Every session
resuming this plan after PR 1 (including this one, via the carried-forward
`/compact` handoff) had to substitute ADR-0092 → ADR-0093 throughout the
original plan document by hand, since the plan itself was authored and
approved before the collision was discovered.

**Why it happened:** ADR numbers are assigned sequentially by convention,
not reserved atomically — two concurrent sessions authoring new ADRs in the
same numeric neighborhood will collide if neither checks the other's
in-flight (not-yet-merged) work first.

**Fix for future:** Before assigning a new ADR number, check not just
`docs/adr/` on `main` but also open PRs/branches for an ADR file already
claiming the next number, if concurrent-session work is a live possibility
(this repo runs several sessions in parallel per CLAUDE.md's own
concurrent-session warning). A plan referencing a specific ADR number
should be treated as provisional until that ADR actually merges.

### 2. The end-to-end MCP-grant verification step could not be completed in this session's environment

The plan's own Step 10 required proof the grant actually reaches
`code-implementer` — the tool being absent from a subagent's session fails
silently (no prompt, no error), so a passing `check:agents` gate is not
evidence the grant took. Four separate dispatches (three `code-implementer`,
one baseline `code-reviewer`) were run to test this directly: every one
reported a tool list restricted to `Read, Write, Edit, Bash` (or `Read,
Bash` for the read-only baseline), missing `Grep`/`Glob` — tools the
_unedited_ `code-reviewer` frontmatter has always granted — as well as both
`mcp__context7__*` tools. Since even a pre-existing, unmodified grant
(Grep/Glob on `code-reviewer`) failed to reach the dispatched agent, this
does not look like a defect in this PR's frontmatter; it looks like this
session's specific dispatch environment not fully wiring subagent `tools:`/
`mcpServers:` frontmatter through to Agent-tool dispatches at all. Filed as
product feedback rather than debugged further, since it is outside this
PR's ability to fix from within the repo.

**Why it happened:** Unknown — not root-caused in-session. Possibly a
sandbox/harness-specific restriction on this particular execution
environment rather than a general Claude Code behavior; the repo's own
`check:agents` gate and this whole ADR-0093 design assume the documented
`tools:`/`mcpServers:` contract is honored by the harness, which is standard
Claude Code Agent-tool behavior per Anthropic's own subagent documentation.

**Fix for future:** Re-run the plan's Step 10 verification (dispatch
`code-implementer` on a real docs-lookup task, confirm `mcp__context7__*` is
actually called) from a session/environment known to fully honor subagent
`tools:` frontmatter, before relying on the grant in a real submodule
implementation. Until then, treat the grant as configured-and-gated but not
yet live-verified.

## Lessons learned

- **A plan's cited ADR/artifact numbers are provisional until that artifact
  actually merges**, especially across a multi-session, multi-PR sequence —
  re-derive them from the live repo at the start of each session rather
  than trusting the plan document's original numbers (this session's own
  `/compact` handoff correctly flagged the ADR-0092→0093 substitution
  needed, avoiding a repeat of the mistake).
- **A passing structural gate (`check:agents`) proves the _configuration_ is
  correct, never that a runtime grant (an MCP tool reaching a live subagent
  dispatch) actually took effect.** The two are genuinely independent
  claims — verify the live behavior directly, and if the environment can't
  support that verification, say so explicitly rather than treating a green
  gate as sufficient proof.
