# Harness refresh tracker

<!-- harness-refresh: last-verified=2026-09-04 claude-code-version=2.1.260 -->

Living record of `/refreshing-anthropic-guidance` sweeps — the per-facet,
per-source state a run diffs against, so each sweep reports what **changed**
since the last one instead of rediscovering the whole harness from scratch.
Unlike the dated point-in-time snapshots in this directory, this file is
updated **in place** on every run; `docs/research/README.md`'s index links
here rather than listing dated copies. Read
[`docs/research/README.md`](README.md) for the directory's general
conventions and the `refreshing-anthropic-guidance` skill for how this file
is produced and consumed.

This is the **first real sweep** (previously a stub, `last-verified=unset`).
It ran scoped to context management/engineering, token-usage optimization,
and compaction — driven by a companion `/auditing` pass on the same topic —
rather than the skill's full unscoped run, so several facets below carry
partial coverage this round; a future unscoped sweep should fill the gaps
each facet section notes.

## Outstanding drift

Confirmed drift with real repo impact, most recent sweep first. Each item
names the file(s) it affects; see the sweep's plan
(`context-management-and-engineering-eventual-quill`, 2026-09-01) for full
remediation detail.

1. **`effort:` is inert on the two Haiku spokes** — `claude-haiku-4-5` is
   absent from Anthropic's effort-supported model list.
   `.claude/agents/Explore.md` (`effort: low`), `.claude/agents/docs-consistency-reviewer.md`
   (`effort: medium`), and `docs/contributing/model-selection.md:285-286`
   all carry a dead field. `bin/lib/claude-models.mjs` validates effort
   strings, not model/effort compatibility.
2. **`CANONICAL_CLAUDE_MODELS` (`bin/lib/claude-models.mjs:19`) lists
   "Claude Fable 5" but not "Claude Fable 5.1"**, the current Fable model.
   A commit trailer naming it would fail `lint-commit`.
3. **Haiku 4.5 retires no sooner than 2026-10-15**, ~6 weeks out, with no
   successor small model announced. Watch item for both Haiku pins.
4. **`estimateTokens()` (chars/4) in `bin/check-context-budget.mjs` is stale
   against the current tokenizer** — Claude 4.7+ models use a tokenizer
   producing ~30% more tokens for the same text, so `MAX_APPROX_TOKENS =
3000` under-counts against it. A free, no-quota
   `POST /v1/messages/count_tokens` endpoint (CLI: `ant messages
count-tokens`) exists as the accurate alternative.
5. ~~**`bin/check-hooks.mjs`'s `KNOWN_EVENTS` (17) is a strict subset of the
   documented 32 hook events**~~ — **Resolved 2026-09-04** (`fix/check-hooks-event-coverage`).
   `KNOWN_EVENTS` widened to the full documented set; `KNOWN_MATCHERS` widened
   to add `SessionEnd` and `DirectoryAdded`'s closed enums. `WorktreeCreate`/
   `WorktreeRemove` deliberately left out of `KNOWN_MATCHERS` (docs confirm
   "no matcher support"); `Notification`'s enum was deliberately left
   unencoded — three independent fetches of the same page (this sweep and a
   prior one) returned mutually inconsistent value lists, and a raw-cell
   fetch returned the description "notification type" rather than an enum —
   the same fetch-summarizer-instability pattern the Hooks & lifecycle facet
   below already recorded for `SessionStart`'s input field name, now
   confirmed to generalize beyond that one case.
6. **`PostCompact` is a real, documented event, unwired in this repo** — the
   direct, matcher-free counterpart to the fragile `SessionStart` +
   `matcher:"compact"` re-injection route. Still open; PR1 of the 2026-09-04
   lifecycle-remediation plan only widened the validator, it did not wire any
   new hook.
7. ~~**`bin/check-hooks.mjs`'s `validateHooksConfig` never reads the
   entry-level `matcher` field**~~ — **Found already resolved, 2026-09-04.**
   The matcher-validation logic (reading `entry.matcher` against
   `KNOWN_MATCHERS`) was already present in the file when re-read this
   session, dated by its own comment to 2026-09-01 — this item was stale by
   the time of this sweep, not fixed by it. Recorded here so the tracker
   stops carrying it as open.
8. **`check:hooks` runs in CI only** (`.github/workflows/ci.yml`), absent
   from the `pre-push` chain in `lefthook.yml` — broken compaction-hook
   wiring is not caught locally before push.
9. **ADR-0078's "PRs 1-4 (Parts A-C) landed as described" claim is false for
   Part C** — corrected in the ADR's own 2026-09-01 Update note rather than
   here; see `docs/adr/0078-session-context-management.md`.

**Resolved since the last sweep:** item 11 (seven read-only spokes
instructed to write overflow findings to a scratchpad file they hold no
`Write`/`Edit` tool for) — fixed by mirroring `audit-fanout.js`'s inline,
character-capped digest pattern into all seven agent prompts plus
`researching-anthropic-guidance/SKILL.md` (which carried the same defect via
its own Explore fan-out), and correcting `docs/contributing/subagent-context-management.md`'s
false claims about which surfaces already used which pattern. Item 10
(`statusLine` "entirely unconfigured") — wired at PR #869, broadened into a
multi-widget dashboard with a `refreshInterval: 30` timer at PR #892
(issue #879), and given an in-flight-spoke segment at the PR this line ships
in; the underlying fact this item recorded (no hook payload carries
token/context-size data, so `statusLine` remains the only implementation
route for a context-pressure surface) is still true and now lives in
`docs/contributing/hooks-reference.md`'s `statusLine` section instead of
here as a stale "unconfigured" claim.

## Facets

### Models & tiering

- CLAIM: all four pinned model IDs (`claude-sonnet-5`, `claude-opus-5`,
  `claude-haiku-4-5`, and the unused `claude-fable-5`/`5-1`) — current,
  non-deprecated — <https://platform.claude.com/docs/en/about-claude/models/overview>
  (retrieved 2026-09-01)
  - VERDICT: confirmed live this sweep (first-run, no prior claim to diff).
- CLAIM: `claude-haiku-4-5` is absent from the effort-parameter
  supported-models list — <https://platform.claude.com/docs/en/build-with-claude/effort>
  (retrieved 2026-09-01, re-confirmed by direct fetch)
  - VERDICT: confirmed. See Outstanding drift #1.
- CLAIM: context/output limits — Fable 5.1 1M/128K; Opus 5 1M/128K; Sonnet 5
  1M/128K; Haiku 4.5 200K/64K — <https://platform.claude.com/docs/en/about-claude/models/overview>
  (retrieved 2026-09-01)
  - VERDICT: confirmed; matches `docs/contributing/model-selection.md:159-166`
    exactly.
- CLAIM: Sonnet 5 pricing is $2/$10 per MTok, and the previously scheduled
  increase to $3/$15 on 2026-09-01 "will not occur" —
  <https://platform.claude.com/docs/en/about-claude/pricing> (retrieved
  2026-09-01)
  - VERDICT: confirmed, effective the day of this sweep. Worth re-checking
    next sweep in case pricing moves again.
- CLAIM: `promptCacheTtl`/`subagentPromptCacheTtl` take only `"5m"`/`"1h"`;
  subagents default to 5m even on a subscription; `experimental.cacheTtl` in
  agent frontmatter is subagent-file-only (v2.1.248+) —
  <https://code.claude.com/docs/en/prompt-caching> (retrieved 2026-09-01)
  - VERDICT: confirmed. No repo file sets any of these — correctly, per this
    sweep's cost analysis (spokes run in short bursts, never idle past 5m).
- COVERAGE GAP: no Anthropic guidance exists on per-model `maxTurns`/turn-budget
  sizing (checked directly against the sub-agents doc). The repo's uniform
  `maxTurns: 40` across all 9 spokes is unfalsified by any guidance, not
  contradicted — treat as a repo tuning choice, not a conformance item.
- COVERAGE GAP: `modelPricing` (managed-settings-only) — changelog-only
  description this pass; no dedicated settings-reference section fetched.
  Inapplicable to this single-maintainer, project-scoped-settings repo
  regardless.

### Claude Code features & settings

- CLAIM: a `# Compact instructions` CLAUDE.md heading + prose is Anthropic's
  own documented pattern for custom compaction guidance —
  <https://code.claude.com/docs/en/costs> (retrieved 2026-09-01)
  - VERDICT: confirmed. Repo's `## Compact Instructions` (H2, title case) is
    a stylistic variant of a documented, supported idiom — no required exact
    heading string is documented.
- CLAIM: auto-compact is configurable via `autoCompactWindow` (settings key),
  `/autocompact <value>`, `--autocompact <value>`, and env var
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `autoCompactEnabled` boolean (default
  true); Sonnet 5 auto-compacts at ~967K on its native 1M window —
  <https://code.claude.com/docs/en/model-config#set-the-auto-compact-window> ,
  <https://code.claude.com/docs/en/settings-reference> (retrieved 2026-09-01)
  - VERDICT: confirmed; matches changelog 2.1.253. Repo sets neither key —
    runs on model defaults (ADR-0078 Part D deliberately dropped pinning
    this; still correct per this sweep).
- CLAIM: what survives compaction is a documented table — system prompt,
  CLAUDE.md, memory, MCP tools auto-reload; up to 5 most-recently-modified
  files + matching rules re-read; each _invoked_ skill's body re-injected
  capped at 5,000 tokens/skill; the skill _listing_ does not reload;
  `SessionStart` hooks matching source `compact` run and their output is
  added to compacted context — <https://code.claude.com/docs/en/context-window#what-survives-compaction>
  (retrieved 2026-09-01)
  - VERDICT: confirmed. This is the doc that validates the repo's
    `PreCompact`/`SessionStart(compact)` hook pair as the supported pattern,
    not a workaround.
- CLAIM: no "microcompact"/partial-compaction feature is documented; the
  only related mechanism is automatic clearing of old tool results from
  context (not user-configurable) — <https://code.claude.com/docs/en/statusline#prompt-cache-fields>
  (retrieved 2026-09-01)
  - VERDICT: confirmed as a coverage gap — no official page names or exposes
    this as a setting.
- CLAIM: exact token/context settings and env vars —
  `autoCompactEnabled`/`autoCompactWindow`, `promptCacheTtl`/
  `subagentPromptCacheTtl`, `modelPricing` (managed-only), `outputStyle`,
  `statusLine`, `cleanupPeriodDays` (default 30), `MAX_MCP_OUTPUT_TOKENS`
  (default 25,000, warning at 10,000, per-tool hard ceiling 500,000 chars),
  `MAX_THINKING_TOKENS`, `ENABLE_TOOL_SEARCH` —
  <https://code.claude.com/docs/en/settings-reference> (retrieved 2026-09-01)
  - VERDICT: confirmed. Repo sets `cleanupPeriodDays: 14` (valid); none of
    the others. No `statusLine`, no `outputStyle` anywhere under `.claude/`.
- CLAIM: MCP tool schemas are deferred by default (tool search) — only tool
  names + server instructions enter context (~120 tokens/server); full
  schemas load on demand — <https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search>
  (retrieved 2026-09-01)
  - VERDICT: confirmed. This invalidates the audit's "~90 unscoped schemas
    load every session" cost estimate for the `github` MCP server — the
    real number needs a live `/context` check, not a per-tool estimate. The
    underlying GAP (no toolset/read-only scoping documented for GitHub MCP)
    stands; Anthropic documents no such scoping for that server.
- CLAIM: complete `statusLine` stdin payload field list, including
  `context_window.{total_input_tokens, total_output_tokens,
context_window_size, used_percentage, remaining_percentage,
current_usage}`, `exceeds_200k_tokens` (fixed 200K threshold regardless of
  actual window), `prompt_cache.*` (v2.1.251+), `pr.{number,url,kind}`,
  `worktree.*` — <https://code.claude.com/docs/en/statusline> (retrieved
  2026-09-01, cross-confirmed by a second independent fetch)
  - VERDICT: confirmed by two independent fetches. See Outstanding drift #10.
  - CORRECTION (2026-09-02): this excerpt is a non-exhaustive highlight
    list, not the full schema. A PR review bot read its "including"
    wording as exhaustive and flagged `workspace.git_worktree` (used in
    `.claude/hooks/statusline-context-pressure.mjs`) as a nonexistent
    field. It is real: "Git worktree name when the current directory is
    inside a linked worktree created with `git worktree add`. Populated
    for any git worktree, unlike `worktree.*`, which is present only in a
    worktree session." This repo's `pnpm worktree:new` (ADR-0013/0014)
    creates plain `git worktree add` worktrees, so `workspace.git_worktree`
    is the correct field here — `worktree.branch` (what the bot proposed
    instead) only populates for Claude Code's own worktree-session
    feature, unused in this repo, and would read `undefined`. Also present
    but previously unlisted: `workspace.current_dir`, `workspace.cwd`,
    `workspace.project_dir`, `workspace.added_dirs`, `workspace.repo`,
    `model.*`, `cost.*`, `session_id`, `session_name`, `prompt_id`,
    `transcript_path`, `version`, `output_style.*`, `fast_mode`,
    `effort.level`, `thinking.enabled`, `rate_limits.*`, `vim.mode`,
    `agent.name`, `pr.review_state`. Lesson: this tracker's CLAIM lines
    are triage pointers into the source, not an exhaustive substitute for
    re-reading it.
- GONE: `https://platform.claude.com/docs/en/docs/claude-code/settings` and
  `.../costs` — 404. Claude Code docs live under `code.claude.com/docs/en/<page>`
  (flat path, no `/docs/claude-code/` segment) — confirmed by two facets
  independently. Worth grepping repo docs for any stale
  `docs.claude.com/en/docs/claude-code/` links in a future sweep.
- COVERAGE GAP: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var — unverified this
  pass (fetch truncated before reaching it). Don't assume existence or
  absence; re-check next sweep.
- COVERAGE GAP: GitHub MCP toolset/read-only scoping — no Anthropic-owned
  source documents this (it would be a GitHub-side feature). Not substituted
  with a third-party source per this skill's coverage discipline.
- CLAIM (2026-09-03, scoped session-naming/renaming check, ADR-0087/0088):
  no hook field, `settings.json` key, or environment variable lets anything
  other than the user's own `--name`/`-n` flag or `/rename` command set a
  session's name — <https://code.claude.com/docs/en/cli-reference> and
  <https://code.claude.com/docs/en/sessions> (retrieved 2026-09-03)
  - VERDICT: confirmed, zero drift from ADR-0087's original constraint.
    Anthropic documents no shell-integration or auto-naming pattern either.
    See ADR-0088's "Reaffirmed (2026-09-03)" section.
- NEW: accepting a plan in plan mode auto-generates a session title from the
  plan content when the session isn't already named; a "default display
  name" (`<workspace-dir>-<2-char-suffix>`, v2.1.196+) is also assigned to
  every unnamed interactive session for listings, though it isn't a resume
  handle — <https://code.claude.com/docs/en/sessions#name-your-sessions>
  (retrieved 2026-09-03)
  - REPO-IMPACT: none directly (neither is controllable to produce an
    ADR-0087-conformant `<kind>-<slug>` name), but softens ADR-0087's
    original addressability framing — see its 2026-09-03 amendment note.
- NEW: the session picker already filters to the current git branch
  (`Ctrl+B`) — <https://code.claude.com/docs/en/sessions#use-the-session-picker>
  (retrieved 2026-09-03)
  - REPO-IMPACT: none (this repo's naming convention targets `ListAgents`/
    `SendMessage`, which have no equivalent filter, not the interactive
    picker).
- NEW: `--worktree`/`-w` is Anthropic's stated default worktree workflow —
  "Most sessions need only the first two sections: start Claude in a
  worktree, then clean up when you exit." Creates `.claude/worktrees/<name>/`
  on branch `worktree-<name>`. Creating "with git directly" is the documented
  answer only when you need to check out a specific existing branch, or
  place the worktree outside the repository — <https://code.claude.com/docs/en/worktrees>
  (retrieved 2026-09-04)
  - REPO-IMPACT: `docs/adr/0013-*.md`/`0014-*.md` (`pnpm worktree:new`'s
    sibling-directory placement is exactly the second documented case for
    git-directly, so this is not a deviation); `CLAUDE.md` § Git Workflow.
- NEW: `EnterWorktree` is the documented mid-session tool ("You can also ask
  Claude to 'work in a worktree' during a session") — free/un-prompted
  switching _inside_ `.claude/worktrees/`; entering a path _outside_ it "asks
  for your approval first… only `bypassPermissions` mode skips it", every
  entry, no persistent opt-out. `${CLAUDE_PROJECT_DIR}` "stays put" in a
  worktree; only `cwd` follows Claude — <https://code.claude.com/docs/en/worktrees>
  (retrieved 2026-09-04)
  - REPO-IMPACT: every `.claude/hooks/*.mjs` resolving guarded paths from
    `CLAUDE_PROJECT_DIR` (`guard-branch-isolation.mjs`,
    `guard-hub-src-writes.mjs`) would need a `cwd`-based rewrite before being
    trusted inside a worktree that isn't the session's original checkout.
- NEW: `WorktreeCreate` fires only for `--worktree`, `isolation: "worktree"`,
  or a background session — "The EnterWorktree tool is NOT listed among the
  triggers" (confirmed by two independent direct fetches this session) —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-04)
  - REPO-IMPACT: rules out a `WorktreeCreate` hook as a way to reconcile
    native worktree placement/branch-naming with `EnterWorktree`-based
    mid-session switching — the hook can only ever intercept the `-w`
    process-launch path, not the in-session tool call.
- NEW: `worktree.baseRef` is now upstream-documented with exactly this
  repo's semantics — `"fresh"` (default) branches from the remote default
  branch, `"head"` from local `HEAD`; "You can't set `worktree.baseRef` to a
  branch name" — <https://code.claude.com/docs/en/worktrees> (retrieved
  2026-09-04)
  - VERDICT: confirmed, matches ADR-0013's `worktree.baseRef = "fresh"`
    bullet and its 2026-07-16 amendment about the `origin/main`-absent
    fallback exactly.
- NEW: CLAUDE.md size — "target under 200 lines per CLAUDE.md file… Loads a
  CLAUDE.md file of up to 4 MiB in full and skips a larger file." Keep-vs-move
  guidance: "facts Claude should hold in every session… If an entry is a
  multi-step procedure or only matters for one part of the codebase, move it
  to a skill or a path-scoped rule instead." `/doctor` (v2.1.206+) proposes
  cuts for derivable content — <https://code.claude.com/docs/en/memory>
  (retrieved 2026-09-04)
  - REPO-IMPACT: `CLAUDE.md` is 194 lines raw, ~2,999 estimator-tokens against
    `bin/check-context-budget.mjs`'s 3,000-token cap (one token of headroom,
    verified live this session) — already at the edge of both this doc's own
    line target and the repo's own budget gate. See the 2026-09-04
    lifecycle-remediation plan's PR5.
- NEW: GitHub Actions cost-control list — "Write specific `@claude` requests…;
  Keep your `CLAUDE.md` concise, since Claude reads it on every run; Set
  `--max-turns`…; Set workflow-level timeouts…; Use GitHub's concurrency
  controls to limit parallel runs." Built-in skip: "Claude skips draft and
  closed pull requests, pull requests it judges not to need a review, such as
  automated or trivial ones" — <https://code.claude.com/docs/en/github-actions>
  (retrieved 2026-09-04)
  - REPO-IMPACT: `.github/workflows/claude-pr-review.yml` already implements
    an equivalent docs-only short-circuit ("Gate 0") independently of this
    guidance. `REVIEW.md` skip-rules (<https://code.claude.com/docs/en/code-review>)
    are scoped to the managed Code Review product, not this repo's
    self-hosted `claude-code-action` — inapplicable as-is.
- COVERAGE GAP: no documented guidance on partitioning one plan into several
  sequential PRs (ADR-0072 is unsupported-by-docs, not contradicted); no
  documented plan-mode/worktree sequencing (enter before or after plan
  accept); no official docs-only CI skip recipe for a self-hosted review
  Action.
- NEW: CHANGELOG delta above 2.1.257 (ADR-0088's "only 2.1.258/2.1.259
  released" claim is now stale — 2.1.260 exists) —
  <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>
  (retrieved 2026-09-04): 2.1.260 fixed `-p --resume`/`--continue` failing on
  every retry once a session's worktree lost its git metadata, and
  `/rewind`/`--rewind-files` reporting false success; 2.1.259 fixed
  concurrent sessions reverting each other's `~/.claude.json` changes and
  worktree isolation refusing hook-created worktrees on some `git rev-parse`
  error messages; also (per a prior fetch) "frontmatter `model:` on custom
  commands and skills being ignored in interactive sessions" (2.1.259) —
  worth a one-time spot-check that spoke `model:` tiering actually took
  effect pre-2.1.259.
  - REPO-IMPACT: `docs/adr/0088-*.md`'s version claim.

### Agent & subagent design

- CLAIM: subagent context isolation is one-way and total — a subagent's
  first request doesn't read the parent's cache (different system prompt);
  the parent's own cache and prefix are unaffected by the subagent's call —
  <https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache>
  (retrieved 2026-09-01)
  - VERDICT: confirmed. Matches `.claude/agents/Explore.md:22-27`'s existing
    self-description exactly — now backed by an official citation.
- CLAIM: `subagent_type: "fork"` (default on since v2.1.232) inherits the
  parent's full system prompt, tools, and conversation history, including
  its cache — <https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache> ,
  <https://code.claude.com/docs/en/sub-agents> (retrieved 2026-09-01)
  - VERDICT: confirmed. Repo doc gap: `agent-operating-model.md` and
    `subagent-dispatch.md` predate this feature and give no fork-vs-fresh
    rule — noted as a gap, not a defect (a fork's shared history would
    undermine the reviewer-independence property those docs rely on, so the
    repo's non-use of fork for review spokes is likely still correct).
- CLAIM: recommended sub-agent return-payload size is "typically 1,000–2,000
  tokens per agent output" —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
  (retrieved 2026-09-01)
  - VERDICT: confirmed. `.claude/workflows/audit-fanout.js`'s
    `REPORT_MAX_CHARS = 8000` (~2,000 tokens) sits at the top of this band —
    correctly sized. The six reviewer-spoke prompts with an unnumbered
    "capped digest" instruction are the outlier against this figure, not
    the workflow.
- CLAIM: the documented return-payload pattern is "subagents call tools to
  store their work in external systems, then pass lightweight references
  back to the coordinator" —
  <https://www.anthropic.com/engineering/multi-agent-research-system>
  (retrieved 2026-09-01)
  - VERDICT: confirmed, and confirms the defect in Outstanding drift #11 —
    the documented pattern presumes a write tool; no fallback is documented
    for a read-only agent.
- CLAIM: no Anthropic guidance ties `maxTurns` to model/context-window tier
  — checked directly against the sub-agents doc's `maxTurns` section.
  - VERDICT: coverage gap, confirmed absent (not contradicted, not endorsed).
- CLAIM: multi-agent systems use "about 15× more tokens than chats"; use
  multi-agent only "where the value of the task is high enough to pay for
  the increased performance" —
  <https://www.anthropic.com/engineering/multi-agent-research-system>
  (retrieved 2026-09-01)
  - VERDICT: confirmed; relevant background for `model-selection.md`'s
    tiering rationale, no direct repo-file impact.
- GONE: `https://platform.claude.com/en/docs/claude-code/sub-agents` and
  `https://platform.claude.com/docs/en/docs/claude-code/sub-agents` — 404.
  `https://docs.claude.com/en/docs/claude-code/sub-agents` 301s to
  `https://code.claude.com/docs/en/sub-agents`.
- COVERAGE GAP: no Anthropic documentation of the read-only-agent
  scratchpad-write mismatch, and no documented fallback pattern for a
  tool-less agent's overflow output.

### Skills & context engineering

- CLAIM: context engineering canon — "the smallest possible set of
  high-signal tokens," just-in-time retrieval, context rot (accuracy
  decreases as tokens increase), sub-agent condensed summaries (1,000-2,000
  tokens), external structured note-taking —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
  (retrieved 2026-09-01)
  - VERDICT: confirmed; canonical source, cite in `subagent-context-management.md`.
- CLAIM: SKILL.md hard limits (Agent Skills spec, portable/`agentskills.io`
  surface) — `name` max 64 chars; `description` max 1,024 chars; body
  recommended under 500 lines —
  <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
  (retrieved 2026-09-01)
  - VERDICT: confirmed as real, but confirmed **not applicable** to this
    repo's gate — see next claim. Re-measured directly: 0/21 skill bodies
    exceed 500 lines (largest, `creating-prs`, 409 lines).
- CLAIM: Claude Code's own skill-listing cap is `skillListingMaxDescChars`,
  documented default **1,536** characters ("the combined `description` and
  `when_to_use` text is truncated at 1,536 characters in the skill listing
  to reduce context usage"), distinct from the portable Agent Skills spec's
  1,024-char limit above — <https://code.claude.com/docs/en/skills> (retrieved
  2026-09-01, direct fetch to resolve a conflict with the platform
  best-practices page)
  - VERDICT: confirmed by direct re-fetch. `bin/check-context-budget.mjs`'s
    `SKILL_DESC_WARN_CHARS = 1536` is **correct as-is** — no fix needed.
    Re-measured all 21 descriptions directly: 0 exceed 1,536; 8 exceed the
    unrelated 1,024 figure (`resolving-pr-comments` 1,518;
    `reviewing-dependabot-prs` 1,398; `refreshing-anthropic-guidance` 1,235;
    `promoting-work-log-lessons` 1,185; `scaffolding-scripts` 1,155;
    `resolving-merge-conflicts` 1,133; `researching-anthropic-guidance`
    1,125; `starting-work` 1,050) — not a repo-relevant threshold since
    Claude Code, not the portable spec, is the runtime in use.
- CLAIM: a supported, free, no-quota token-counting endpoint exists —
  `POST /v1/messages/count_tokens` (CLI `ant messages count-tokens`; SDK
  `count_tokens`/`countTokens`); accepts system prompts, tools, images,
  PDFs; counts under the tokenizer of the `model` passed —
  <https://platform.claude.com/docs/en/build-with-claude/token-counting> ,
  <https://platform.claude.com/docs/en/api/messages-count-tokens> (retrieved
  2026-09-01)
  - VERDICT: confirmed. See Outstanding drift #4.
- CLAIM: "Claude 4.7 and later models and Claude Mythos Preview use a newer
  tokenizer. The same input text produces approximately 30 percent more
  tokens than on earlier models." — same source as above.
  - VERDICT: confirmed.
- CLAIM: CLAUDE.md guidance — target under 200 lines; Claude Code loads a
  CLAUDE.md up to 4 MiB in full; `@`-imports load at launch and don't reduce
  context; `/doctor` (v2.1.206+) proposes trims of codebase-derivable
  content — <https://code.claude.com/docs/en/memory> (retrieved 2026-09-01)
  - VERDICT: confirmed. `MAX_RUNTIME_LINES = 200` in
    `bin/check-context-budget.mjs` matches exactly. Measured `CLAUDE.md` =
    192 lines / 14,009 B, inside the cap.
  - NEW, unused by repo: `/doctor`'s trim proposal targets exactly the kind
    of content CLAUDE.md's own § Repository Layout carries (derivable from
    the codebase) — worth trying next time the line budget gets tight.
- CLAIM: a published "reduce token usage" doc for Claude Code enumerates
  levers — `/clear` between tasks, custom `/compact` instructions, model
  choice per subagent, reducing MCP overhead, hooks/skills offloading,
  moving instructions from CLAUDE.md to skills, `/effort`/`MAX_THINKING_TOKENS`,
  delegating verbose ops to subagents, agent-team cost (~7× more tokens in
  plan mode) — <https://code.claude.com/docs/en/costs> (retrieved 2026-09-01)
  - VERDICT: confirmed. Repo's `gh`-CLI preference (CLAUDE.md § Git Workflow)
    already matches the doc's "prefer CLI over MCP" lever.
- COVERAGE GAP: `/claude-api cost-optimize` (changelog 2.1.247) — no
  dedicated published doc found on allowlisted domains; only the changelog
  line and the general costs page corroborate its existence.
- COVERAGE GAP: `www.anthropic.com/engineering`, `/news`, `claude.com/blog`
  index pages not enumerated directly this pass (budget) — a future sweep
  should check these directly per `official-sources.md`'s "first-class
  sources" list, since search ranking is not exhaustive.

### Hooks & lifecycle

- CLAIM: full documented hook event list (32 events, including `Setup`,
  `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`,
  `PostToolUseFailure`, `PostToolBatch`, `MessageDisplay`, `TaskCreated`,
  `TaskCompleted`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`,
  `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`,
  `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`,
  `PostModelSwitch`, `Elicitation`, `ElicitationResult`) —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: confirmed. `PostCompact` is real. See Outstanding drift #5, #6.
- CLAIM: `PreCompact`'s documented input carries `trigger` (`"manual"` |
  `"auto"`), also usable as the `PreCompact`/`PostCompact` matcher value; no
  `custom_instructions` field is documented in `PreCompact`'s input —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: confirmed. `write-compact-handoff.mjs` reads neither `trigger`
    nor any custom-instructions field — the handoff artifact can't
    distinguish manual from auto compaction. Low-risk gap, not a break.
- CLAIM: `SessionStart` matcher values are `startup`, `resume`, `clear`,
  `compact`, `fork` — <https://code.claude.com/docs/en/hooks> (retrieved
  2026-09-01)
  - VERDICT: confirmed; `.claude/settings.json:89`'s `matcher: "compact"`
    targets a live value.
- CLAIM: every hook event receives common fields `session_id`, `prompt_id`,
  `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`,
  `agent_id`, `agent_type`; the transcript file "is written asynchronously
  and may lag the in-memory conversation"; no documented hook field anywhere
  carries context size, token counts, or remaining window —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: confirmed. See Outstanding drift #10 — this is the fact that
    rules out a hook-based context-pressure monitor.
- CLAIM: `UserPromptSubmit`/`SessionStart` output contract is
  `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}`;
  a top-level `systemMessage` warns the user without blocking; blocking is
  exit code 2 or `decision:"block"` + `reason` —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: confirmed. `inject-decision-gate.mjs` and
    `reinject-compact-handoff.mjs` both emit the correct shape.
    `systemMessage` is available but unused anywhere in the repo.
- CLAIM: `statusLine` invocation cadence — session start/resume, new
  assistant message, `/compact` finishing, permission-mode change, vim-mode
  toggle, `command` setting change, `refreshInterval` timer, rate-limit
  reset, prompt-cache expiry; 300ms debounce; a new trigger cancels an
  in-flight script; runs locally, no API tokens consumed —
  <https://code.claude.com/docs/en/statusline> (retrieved 2026-09-01)
  - VERDICT: confirmed.
- CLAIM: no hook fires on approaching the context limit or auto-compact
  threshold; the only controls are the `autoCompactEnabled`/
  `autoCompactWindow` settings — <https://code.claude.com/docs/en/settings-reference>
  (retrieved 2026-09-01)
  - VERDICT: confirmed.
- GONE: `platform.claude.com/docs/en/docs/claude-code/hooks` and
  `.../statusline` — 404. Same path-migration pattern as the features/settings
  facet above.
- COVERAGE GAP: the exact SessionStart input field name for the compact
  matcher could not be pinned with full confidence — three fetches of the
  same hooks page returned inconsistent field names (`source` vs
  `how_started` vs `how` vs `start_source`), most likely fetch-summarizer
  instability rather than a real doc discrepancy. The repo's own code
  (`reinject-compact-handoff.mjs:110`, `input?.source`) and its authoring
  comment agree on `source`, and the failure mode is safe (silent no-op, not
  a crash) if wrong — but this branch has zero test coverage in
  `bin/tests/reinject-compact-handoff.test.ts` today. Re-verify verbatim on
  the next sweep; a real test closes this gap independent of the doc fetch.
- COVERAGE GAP: `docs/contributing/hooks-reference.md`'s prose event list
  was not diffed against the documented 32 this pass (budget) — may carry
  the same 16-event shortfall as `bin/check-hooks.mjs`'s `KNOWN_EVENTS`;
  check on the next sweep or when `KNOWN_EVENTS` is widened.
