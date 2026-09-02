# Context engineering, token optimization & compaction remediation (2026-09-01 – 2026-09-02)

**Status: shipped** (PR #850, commit 8037f83d — through PR #876)

## Context

`/auditing` (five-facet fan-out, 20 agents, adversarially verified) found
this repo's context-management machinery — ADR-0078's `PreCompact`/
`SessionStart(compact)` handoff pair, `bin/check-context-budget.mjs`, the
hub-and-spoke delegation model — measured in the wrong places and validated
by almost nothing: the gates covered ~14 KB of always-loaded `CLAUDE.md`
while leaving 320 KB of skill/agent bodies, ~90 GitHub MCP tool schemas, and
seven read-only spokes carrying a scratchpad-write instruction they held no
tool for. A follow-on `/refreshing-anthropic-guidance` sweep (the tracker's
first real population, `docs/research/harness-refresh.md`) grounded the
findings against Anthropic's current documentation, confirming which audit
items reflected real drift versus stale repo assumptions. A third pass asked
`claude-automation-recommender` for a compaction-monitoring automation,
scoped to what's actually implementable: `statusLine` is the only documented
surface exposing live `context_window.used_percentage` — no hook event
carries token/context data — so a hook-based monitor was never on the table.

## Approach / Decisions

`/starting-work` recommended splitting the remediation into seven small,
independently-landable PRs (ADR-0072) rather than one large one, each in its
own linked worktree (`pnpm worktree:new`), landed one at a time with an
explicit merge confirmation between each:

- **PR #850** — populated `docs/research/harness-refresh.md` from its
  `unset` stub with the audit + refresh findings, and corrected ADR-0078's
  false "PRs 1-4 landed as described" claim for Part C via an `Update` note
  (ADRs are immutable once Accepted; corrections are appended, never edited
  in).
- **PR #851** — `bin/check-hooks.mjs` gained `matcher`-value validation for
  `SessionStart`/`PreCompact`/`PostCompact` against Anthropic's documented
  closed enum, closing the "a typo in `matcher: \"compact\"` silently
  disables re-injection" gap; moved `check:hooks` into the `pre-push`
  `lefthook.yml` chain (was CI-only).
- **PR #854** — extended `bin/check-context-budget.mjs` with informational
  skill/agent body-byte measurement and an opt-in `--exact` token-counting
  mode (`POST /v1/messages/count_tokens`), never wired into CI/pre-push by
  design; fixed a stale header comment and a 2-byte baseline drift.
- **PR #858** — corrected two confirmed-stale model facts: `claude-haiku-4-5`
  is absent from the effort-parameter-supported model list (the two Haiku
  spokes' `effort:` field is inert, documented rather than removed since
  `check:agents` requires a legal value with no exception), and
  `CANONICAL_CLAUDE_MODELS` was missing "Claude Fable 5.1".
- **PR #865** — replaced the unsatisfiable "write overflow findings to a
  scratchpad file" instruction across seven read-only spokes (`Explore` +
  six reviewers) and the `researching-anthropic-guidance` skill with the
  inline, ~8,000-character-capped digest pattern `audit-fanout.js` already
  used correctly — none of these agents ever held a `Write`/`Edit` tool, and
  `guard-readonly-bash.mjs` blocks every shell write route regardless, so the
  instruction never worked in any mode.
- **PR #869** — added `.claude/hooks/statusline-context-pressure.mjs`, wired
  under a new `statusLine` key in `.claude/settings.json`: a colorized
  `ctx NN%` segment (green/yellow/red at 70%/90%, matching Anthropic's own
  documented thresholds) and, past 90%, a `/compact preserve ...` suggestion
  built only from fields already in the statusLine payload — no `git`/network
  calls. A `claude-pr-review` bot Must-fix on this PR was disputed rather
  than applied: the bot cited this repo's own harness-refresh tracker excerpt
  (a non-exhaustive "including ..." list) as if it were the complete
  statusLine schema and flagged `workspace.git_worktree` as nonexistent; a
  full re-fetch of the live docs confirmed the field is real and is
  specifically the one populated for a plain `git worktree add` worktree
  (this repo's own convention) — the bot's proposed fix would have read
  `undefined` in every real render.
- **PR #876** — closes the loop: a retroactive work log for ADR-0078's
  original rollout (reconstructed from git history, explicitly flagged as
  thinner than a live log would be), a new `Compaction events:` work-log
  convention alongside `Spoke incidents:`, and promotion of the
  `plan-mode-blocks-audit-scratchpad` auto-memory lesson into
  `.claude/rules/subagent-dispatch.md`.

## Outcome

Every confirmed-drift item from the audit + refresh sweep is closed: the
compaction-hook matcher gap, the context-budget gate's blind spots (now
measured, not fixed — visibility was the explicit scope), both stale model
facts, the seven-spoke scratchpad defect, the missing compaction-pressure
surface, and the work-log feedback loop that let ADR-0078's own rollout ship
without a log. `docs/research/harness-refresh.md` is the durable tracker for
the next sweep to diff against. Two adjacent, out-of-scope defects were
flagged rather than fixed and remain open: `security-reviewer.md`'s
refute-mode scratchpad-probe instruction (the same class of defect as the
seven-spoke fix, not yet addressed), and `audit-fanout.js`'s untyped refuter
dispatch (documented in-file, pending confirmation that an explicit
`agentType` composes safely with its model/effort override).
