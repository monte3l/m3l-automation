# Harness refresh tracker

<!-- harness-refresh: last-verified=2026-09-06 claude-code-version=2.1.263 -->

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
   strings, not model/effort compatibility. **Updated 2026-09-06:**
   `claude-haiku-4-5-20251001` is still Active with **no formal deprecation
   notice issued**; Anthropic commits to ≥60 days' notice before retirement,
   so the "not sooner than 2026-10-15" tentative date (item 3, below) is now
   provably impossible to hit — earliest possible retirement is ≥2026-11-05.
   Lower urgency; still a watch item, no successor small model announced.
2. ~~**`CANONICAL_CLAUDE_MODELS` (`bin/lib/claude-models.mjs:19`) lists
   "Claude Fable 5" but not "Claude Fable 5.1"**~~ — **Found already
   resolved, 2026-09-06.** `bin/lib/claude-models.mjs:19-20` lists both
   `"Claude Fable 5.1"` and `"Claude Fable 5"`; this item was stale by the
   time of this sweep. Recorded here so the tracker stops carrying it as
   open.
3. **Haiku 4.5 retires no sooner than 2026-10-15** — see item 1's 2026-09-06
   update; the date is now known to be a lower bound only, not a live risk.
4. **`estimateTokens()` (chars/4) in `bin/check-context-budget.mjs` is stale
   against the current tokenizer** — Claude 4.7+ models use a tokenizer
   producing ~30% more tokens for the same text, so `MAX_APPROX_TOKENS =
3000` under-counts against it. **Reclassified 2026-09-06: accepted,
   documented limitation, not open drift.** Re-verified this sweep: Anthropic
   still publishes no local estimator ratio to swap in — the only accurate
   route is the `count_tokens` endpoint, which a `pre-push`/CI gate cannot
   call offline by default. `bin/check-context-budget.mjs:63-70` already
   documents the under-count and the `--exact` opt-in that calls the real
   endpoint. Nothing further to fix; re-check only if Anthropic ever
   publishes a recommended local ratio.
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
   confirmed to generalize beyond that one case. **Re-verified 2026-09-06:**
   the documented event count is **33**, not 32 (a prior-sweep miscount, not
   an upstream change) — `KNOWN_EVENTS` already holds exactly these 33 names
   with an empty set-difference in both directions.
   `docs/contributing/hooks-reference.md`'s own prose event list ("7 of 33")
   was diffed for the first time this sweep and agrees exactly with both. A
   fourth independent fetch of `Notification`'s matcher enum returned a
   fourth distinct value list — still correctly left unencoded.
6. ~~**`PostCompact` is a real, documented event, unwired in this repo**~~ —
   **Closed as not-actionable, 2026-09-06.** The documented `PostCompact`
   output schema exposes only `hookSpecificOutput.{hookEventName,
systemMessage?, terminalSequence?}` — no `additionalContext` field — so it
   cannot carry a handoff re-injection the way `SessionStart` does; wiring it
   would not accomplish what this item originally proposed. Separately, the
   existing `SessionStart` + `matcher:"compact"` route this item called
   "fragile" is now **empirically verified working**: session transcripts
   show `SessionStart:compact` firing 49 times, 14 of them successfully
   injecting the rendered handoff via `additionalContext`. (This also settles
   item 12's field-name question below — see the Hooks & lifecycle facet.)
7. ~~**`bin/check-hooks.mjs`'s `validateHooksConfig` never reads the
   entry-level `matcher` field**~~ — **Found already resolved, 2026-09-04.**
   The matcher-validation logic (reading `entry.matcher` against
   `KNOWN_MATCHERS`) was already present in the file when re-read this
   session, dated by its own comment to 2026-09-01 — this item was stale by
   the time of this sweep, not fixed by it. Recorded here so the tracker
   stops carrying it as open.
8. ~~**`check:hooks` runs in CI only** (`.github/workflows/ci.yml`), absent
   from the `pre-push` chain in `lefthook.yml`~~ — **Found already resolved,
   2026-09-06.** `lefthook.yml:133` includes `pnpm check:hooks` in the
   `pre-push` chain (with the remediation recorded in a comment at
   `lefthook.yml:100`); it also remains in CI at
   `.github/workflows/ci.yml:654`. This item was stale by the time of this
   sweep.
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
here as a stale "unconfigured" claim. **Also resolved as of this sweep
(2026-09-06):** items 2 and 8 (found already fixed, see above); item 6
(`PostCompact`, closed as not-actionable, see above).

## Facets

### Models & tiering

- CLAIM: all four pinned model IDs (`claude-sonnet-5`, `claude-opus-5`,
  `claude-haiku-4-5`, and the unused `claude-fable-5`/`5-1`) — current,
  non-deprecated — <https://platform.claude.com/docs/en/about-claude/models/overview>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). All Active on the
    deprecations table; `claude-fable-5` now shown under "Legacy models
    (still available)" on the overview page but still `Active` in the
    deprecations table (retirement not sooner than 2027-06-09).
- CLAIM: `claude-haiku-4-5` is absent from the effort-parameter
  supported-models list — <https://platform.claude.com/docs/en/build-with-claude/effort>
  (retrieved 2026-09-01, re-confirmed by direct fetch)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). Supported list: fable-5-1,
    mythos-5-1, fable-5, mythos-5, mythos-preview, opus-5, opus-4-8,
    opus-4-7, opus-4-6, opus-4-5-20251101, sonnet-5, sonnet-4-6. No Haiku.
    See Outstanding drift #1.
- CLAIM: context/output limits — Fable 5.1 1M/128K; Opus 5 1M/128K; Sonnet 5
  1M/128K; Haiku 4.5 200K/64K — <https://platform.claude.com/docs/en/about-claude/models/overview>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06); matches
    `docs/contributing/model-selection.md:159-166` exactly.
- CLAIM: Sonnet 5 pricing is $2/$10 per MTok, and the previously scheduled
  increase to $3/$15 on 2026-09-01 "will not occur" —
  <https://platform.claude.com/docs/en/about-claude/pricing> (retrieved
  2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). The
    `claude-sonnet-5-introductory-pricing` note now reads that $2/$10 "is
    now the standard price" and the increase "will not occur" — i.e. the
    date has passed and the note held.
- CLAIM: `promptCacheTtl`/`subagentPromptCacheTtl` take only `"5m"`/`"1h"`;
  subagents default to 5m even on a subscription; `experimental.cacheTtl` in
  agent frontmatter is subagent-file-only (v2.1.248+) —
  <https://code.claude.com/docs/en/prompt-caching> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). Precedence order confirmed
    (`FORCE_PROMPT_CACHING_5M` → env var → setting → subagent
    `experimental.cacheTtl` → `ENABLE_PROMPT_CACHING_1H` → bucket default);
    `1h` in frontmatter is ignored while a subscription is on usage credits.
    No repo file sets any of these — correctly, per this sweep's cost
    analysis (spokes run in short bursts, never idle past 5m).
- NEW (2026-09-06): Claude Mythos 5.1 (`claude-mythos-5-1`) now exists,
  limited availability / Project Glasswing, priced identically to Fable 5.1
  ($10/$50, 0.025x cache reads); supports effort incl. `max`/`xhigh` and
  per-message effort — <https://platform.claude.com/docs/en/about-claude/pricing>,
  <https://platform.claude.com/docs/en/build-with-claude/effort>. Absent
  from the models-overview comparison table and the deprecations table
  (limited availability, not GA). REPO-IMPACT: `docs/contributing/model-selection.md:194`
  updated to mention it; `.claude/settings.json`'s `availableModels` needs
  no change (correctly still excludes the `mythos` family).
- NEW (2026-09-06): `xhigh` is **not** universal among effort-supporting
  models — available on Fable 5.1/5, Mythos 5.1/5, Opus 5/4.8/4.7, Sonnet 5
  only (not Opus 4.6/4.5, not Sonnet 4.6) —
  <https://platform.claude.com/docs/en/build-with-claude/effort>.
  REPO-IMPACT: none — every `xhigh` pin here is on `claude-opus-5`
  (`security-reviewer.md:7`, `spec-conformance-reviewer.md:7`,
  `type-design-analyzer.md:7`), all supported.
  `bin/lib/claude-models.mjs:122`'s `EFFORT_LEVELS` validates the level set
  but not per-model availability — an `xhigh` pin on a future
  non-supporting model would pass `check:agents` and fail at runtime.
  Latent gap, not a current defect.
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
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; verbatim example still
    `# Compact instructions` / "When you are using compact, please focus on
    test output and code changes"). Repo's `## Compact Instructions` (H2,
    title case) is a stylistic variant of a documented, supported idiom — no
    required exact heading string/level is documented.
- CLAIM: auto-compact is configurable via `autoCompactWindow` (settings key),
  `/autocompact <value>`, `--autocompact <value>`, and env var
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `autoCompactEnabled` boolean (default
  true); Sonnet 5 auto-compacts at ~967K on its native 1M window —
  <https://code.claude.com/docs/en/model-config#set-the-auto-compact-window> ,
  <https://code.claude.com/docs/en/settings-reference> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). "Sessions auto-compact
    before the window fills, at about 967K tokens by default"; accepted
    values 100K–1M. 2.1.260's "improved auto-compact for 1M-context models"
    changelog entry did not move the documented figure. Repo sets neither
    key — runs on model defaults (ADR-0078 Part D deliberately dropped
    pinning this; still correct per this sweep).
- CLAIM: what survives compaction is a documented table — system prompt,
  CLAUDE.md, memory, MCP tools auto-reload; up to 5 most-recently-modified
  files + matching rules re-read; each _invoked_ skill's body re-injected
  capped at 5,000 tokens/skill; the skill _listing_ does not reload;
  `SessionStart` hooks matching source `compact` run and their output is
  added to compacted context — <https://code.claude.com/docs/en/context-window#what-survives-compaction>
  (retrieved 2026-09-01)
  - VERDICT: CHANGED (re-fetched 2026-09-06) — detail added, nothing
    removed.
  - NOW: skill bodies "re-injected, capped at 5,000 tokens per skill **and
    25,000 tokens total; oldest dropped first**." New rows: "the plan Claude
    wrote in plan mode — re-injected from disk"; and, as of v2.1.198, "the
    summarization request inherits your session's extended thinking
    configuration." A re-read file over 5,000 tokens returns as `Referenced
file` (path only); rules still reload.
  - REPO-IMPACT: none — the `SessionStart` matcher registration in
    `.claude/settings.json` still matches the documented `compact` source
    behavior. This is the doc that validates the repo's
    `PreCompact`/`SessionStart(compact)` hook pair as the supported
    pattern, not a workaround.
- CLAIM: no "microcompact"/partial-compaction feature is documented; the
  only related mechanism is automatic clearing of old tool results from
  context (not user-configurable) — <https://code.claude.com/docs/en/statusline#prompt-cache-fields>
  (retrieved 2026-09-01)
  - VERDICT: CHANGED (re-fetched 2026-09-06).
  - NOW: partial compaction **is** now documented — "Compact part of the
    conversation: run `/rewind`, select a message, and choose **Summarize
    from here** or **Summarize up to here**"
    (<https://code.claude.com/docs/en/context-window>). Still no
    "microcompact" name; tool-result clearing remains non-configurable.
  - REPO-IMPACT: none.
- CLAIM: exact token/context settings and env vars —
  `autoCompactEnabled`/`autoCompactWindow`, `promptCacheTtl`/
  `subagentPromptCacheTtl`, `modelPricing` (managed-only), `outputStyle`,
  `statusLine`, `cleanupPeriodDays` (default 30), `MAX_MCP_OUTPUT_TOKENS`
  (default 25,000, warning at 10,000, per-tool hard ceiling 500,000 chars),
  `MAX_THINKING_TOKENS`, `ENABLE_TOOL_SEARCH` —
  <https://code.claude.com/docs/en/settings-reference> (retrieved 2026-09-01)
  - VERDICT: CHANGED (re-fetched 2026-09-06).
  - NOW: `MAX_MCP_OUTPUT_TOKENS` default is now **8000** (requires v2.1.181+)
    — the 25,000/10,000/500,000 figures no longer appear on `env-vars`.
    `MAX_THINKING_TOKENS` default 10000. `ENABLE_TOOL_SEARCH` is now `1`/`0`
    (unset = on for the direct Anthropic API, off elsewhere) — the
    `auto`/`false` values still appear on the context-window page, an
    upstream inconsistency. `cleanupPeriodDays` default 30 confirmed. All
    other keys still present and correctly named.
  - REPO-IMPACT: none (repo sets none of these — `MAX_MCP_OUTPUT_TOKENS` was
    considered and deliberately skipped per ADR-0078's 2026-08-27 Update);
    `.claude/settings.json`'s `cleanupPeriodDays: 14` remains a valid
    override. `statusLine` is wired (see the resolved-since-last-sweep note
    above); no `outputStyle` anywhere under `.claude/`.
- CLAIM: MCP tool schemas are deferred by default (tool search) — only tool
  names + server instructions enter context (~120 tokens/server); full
  schemas load on demand — <https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; corroborated verbatim on the
    context-window page too: "MCP tools (deferred) … 120" tokens). This
    invalidates the audit's "~90 unscoped schemas load every session" cost
    estimate for the `github` MCP server — the real number needs a live
    `/context` check, not a per-tool estimate. The underlying GAP (no
    toolset/read-only scoping documented for GitHub MCP) stands; Anthropic
    documents no such scoping for that server.
- NEW (2026-09-06): `bashOutputMaxChars` (v2.1.261+) — sets how much of a
  successful command's output Claude receives inline, up to 128,000
  characters; sizes the inline ceiling and the read-back window together and
  Claude Code then ignores `BASH_MAX_OUTPUT_LENGTH` —
  <https://code.claude.com/docs/en/settings-reference>,
  <https://code.claude.com/docs/en/tools-reference#output-limits>.
  REPO-IMPACT: `.claude/settings.json` sets neither this nor
  `BASH_MAX_OUTPUT_LENGTH` (default 30,000 chars, max 150,000) — unset by
  choice, not a gap (confirmed with the maintainer during this sweep's
  remediation).
- NEW (2026-09-06): `taskOutputMaxChars` (v2.1.261+) — sets how much output
  from a task Claude Code receives inline; numeric default/ceiling not
  stated on the pages fetched (partial coverage gap on the exact default) —
  <https://code.claude.com/docs/en/settings-reference>. REPO-IMPACT:
  directly relevant to `.claude/settings.json`'s `SubagentStop` →
  `detect-spoke-truncation.mjs` spoke-truncation problem; unset by choice
  (confirmed with the maintainer during this sweep's remediation, not
  adopted this round).
- NEW (2026-09-06): `CLAUDE_CODE_AUTO_COMPACT_WINDOW` upstream
  self-contradiction — `env-vars` calls it "context window **percentage** …
  (default: `80`)" while `model-config` says "the environment variable
  accepts only the plain token count." REPO-IMPACT: none (repo leaves it
  unset), but blocks any repo doc from stating the unit confidently if this
  var is ever adopted.
- NEW (2026-09-06): hook `if:` field is now also evaluated on
  `PostToolUseFailure`, `PermissionRequest`, and `PermissionDenied` (beyond
  `PreToolUse`/`PostToolUse`); on any other event a hook with `if` set never
  runs. New common hook fields `statusMessage`, `once`; command fields
  `args`, `async`, `asyncRewake`, `shell`; hook `type` now accepts `"http" |
"mcp_tool" | "prompt" | "agent"` —
  <https://code.claude.com/docs/en/hooks#the-if-field>. REPO-IMPACT:
  `docs/contributing/hooks-reference.md` updated with the three newly
  eligible events.
- COVERAGE GAP (new, 2026-09-06): `/skill-doctor` (CHANGELOG 2.1.261) and
  `--append-subagent-system-prompt-file` are absent from
  `code.claude.com/docs/en/commands` and `.../costs` respectively as of this
  sweep, though `/skill-doctor` is documented on `.../skills` (see the
  Skills & context engineering facet). The 2.1.261 `/context` local-estimate
  change is undocumented on any allowlisted page.
- CLAIM: complete `statusLine` stdin payload field list, including
  `context_window.{total_input_tokens, total_output_tokens,
context_window_size, used_percentage, remaining_percentage,
current_usage}`, `exceeds_200k_tokens` (fixed 200K threshold regardless of
  actual window), `prompt_cache.*` (v2.1.251+), `pr.{number,url,kind}`,
  `worktree.*` — <https://code.claude.com/docs/en/statusline> (retrieved
  2026-09-01, cross-confirmed by a second independent fetch)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; all nine `statusLine`
    triggers, the 300ms debounce, in-flight-cancel behavior, and "runs
    locally and does not consume API tokens" all re-confirmed verbatim by
    the Hooks & lifecycle facet — see that section below for the new nuance
    that a change to the `command` itself skips the debounce).
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
  `.../costs` — 404 (re-confirmed 2026-09-06: `.../settings` still 404s;
  `code.claude.com/docs/en/settings-reference` and `.../costs` both
  resolve). Claude Code docs live under `code.claude.com/docs/en/<page>`
  (flat path, no `/docs/claude-code/` segment) — confirmed by two facets
  independently. **Closed 2026-09-06:** a repo-wide grep for
  `docs.claude.com/en/docs/claude-code/` and
  `platform.claude.com/docs/en/docs/claude-code/` found only prose that
  discusses the redirect itself (this file, `session-naming.md`,
  `official-sources.md`) — no stale citation anywhere in the repo.
- COVERAGE GAP: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var — **resolved
  2026-09-06.** Documented at `code.claude.com/docs/en/env-vars`: "Maximum
  number of tokens Claude Code includes in a single response to the model
  (default: 8000)."
- COVERAGE GAP: GitHub MCP toolset/read-only scoping — no Anthropic-owned
  source documents this (it would be a GitHub-side feature). Not substituted
  with a third-party source per this skill's coverage discipline. Still
  open as of 2026-09-06.
- CLAIM (2026-09-03, scoped session-naming/renaming check, ADR-0087/0088):
  no hook field, `settings.json` key, or environment variable lets anything
  other than the user's own `--name`/`-n` flag or `/rename` command set a
  session's name — <https://code.claude.com/docs/en/cli-reference> and
  <https://code.claude.com/docs/en/sessions> (retrieved 2026-09-03)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06) — zero drift from ADR-0087's
    original constraint. Anthropic documents no shell-integration or
    auto-naming pattern either. See ADR-0088's "Reaffirmed (2026-09-03)"
    section.
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
- NEW: CHANGELOG delta above 2.1.260 (this sweep, retrieved 2026-09-06):
  **2.1.263** — "Bug fixes and reliability improvements" only. **2.1.261** —
  added `bashOutputMaxChars`/`taskOutputMaxChars`, `/skill-doctor`,
  `--append-subagent-system-prompt-file`, an 'Organization policy' line to
  `/status`/`claude doctor`; changed `/context` token counting to use a
  local estimate when the token-counting API is unavailable; fixed resuming
  a session losing hook output around parallel tool calls, and
  `claude -p --resume <file>` adopting a malformed session ID. See the new
  claims and coverage gaps recorded against these entries throughout this
  section and the Skills & Agent-design sections below.

### Agent & subagent design

- CLAIM: subagent context isolation is one-way and total — a subagent's
  first request doesn't read the parent's cache (different system prompt);
  the parent's own cache and prefix are unaffected by the subagent's call —
  <https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; "Its first request doesn't
    read the parent's cache, because the two prefixes differ... The
    parent's cache is unaffected" still verbatim). Matches
    `.claude/agents/Explore.md:22-27`'s existing self-description exactly.
- CLAIM: `subagent_type: "fork"` (default on since v2.1.232) inherits the
  parent's full system prompt, tools, and conversation history, including
  its cache — <https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache> ,
  <https://code.claude.com/docs/en/sub-agents> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; "A fork, by contrast,
    inherits the parent's system prompt, tools, and conversation history
    exactly, so its first request reads the parent's cache" still
    verbatim).
  - **Repo doc gap now fillable (2026-09-06):** the sub-agents page now
    documents a fork-vs-fresh selection rule — fork when the task needs
    significant main-conversation context, for parallel approaches from one
    starting point, when re-explaining would cost too much, or when the
    same system prompt/tools/model are needed; fresh when self-contained,
    when enforcing tool restrictions or a different permission mode, to
    isolate verbose output, or when a different model/system prompt is
    needed. Fork mode is on by default in interactive sessions
    (`CLAUDE_CODE_DISABLE_FORK_MODE=1` disables it). REPO-IMPACT:
    `.claude/rules/subagent-dispatch.md` and
    `docs/contributing/agent-operating-model.md` still give no fork-vs-fresh
    criterion — this is now fillable from an official source rather than a
    documented gap. Not actioned this sweep (docs-only remediation scope).
- CLAIM: recommended sub-agent return-payload size is "typically 1,000–2,000
  tokens per agent output" —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; "often 1,000-2,000 tokens"
    still verbatim). `audit-fanout.js`'s `REPORT_MAX_CHARS` (8000 chars,
    ~2,000 tokens) and `.claude/rules/subagent-dispatch.md`'s "roughly
    8,000 characters (~2,000 tokens)" instruction both sit at the top of
    this band — correctly sized and correctly sourced.
- CLAIM: the documented return-payload pattern is "subagents call tools to
  store their work in external systems, then pass lightweight references
  back to the coordinator" —
  <https://www.anthropic.com/engineering/multi-agent-research-system>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06, verbatim). Confirms the
    defect in resolved Outstanding drift item 11 — the documented pattern
    presumes a write tool; no fallback is documented for a read-only agent
    (still true — see the coverage-gap re-check below).
- CLAIM: no Anthropic guidance ties `maxTurns` to model/context-window tier
  — checked directly against the sub-agents doc's `maxTurns` section.
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). The page now documents
    `maxTurns` semantics (partial-output marking, resumability) but still
    gives no numeric sizing guidance and no tie to model tier — coverage
    gap confirmed absent, not contradicted, not endorsed. The repo's
    uniform `maxTurns: 40` across all ten agents remains a repo-local
    choice with no upstream contradiction.
- CLAIM: multi-agent systems use "about 15× more tokens than chats"; use
  multi-agent only "where the value of the task is high enough to pay for
  the increased performance" —
  <https://www.anthropic.com/engineering/multi-agent-research-system>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06, both sentences verbatim);
    relevant background for `model-selection.md`'s tiering rationale, no
    direct repo-file impact.
- NEW (2026-09-06): `--append-subagent-system-prompt-file <path>` (v2.1.261+)
  — reads appended subagent system-prompt text from a file when it is too
  long for the command line — <https://code.claude.com/docs/en/sub-agents>.
  REPO-IMPACT: none — no repo file references subagent system-prompt
  appending; unexercised capability, not a contradiction.
- NEW (2026-09-06): `taskOutputMaxChars` (v2.1.261+) raises how much
  background-task/Task output Claude receives inline, up to 128,000
  characters, before overflow to a file; sibling `bashOutputMaxChars`
  (v2.1.261+, also up to 128,000 chars) takes precedence over
  `BASH_MAX_OUTPUT_LENGTH` (default 30,000) —
  <https://code.claude.com/docs/en/tools-reference>,
  <https://code.claude.com/docs/en/settings-reference>. REPO-IMPACT:
  directly adjacent to `.claude/rules/subagent-dispatch.md`'s ~8,000-char
  inline cap, which remains a self-imposed authoring budget well under the
  platform's inline ceiling — no change forced. `taskOutputMaxChars`'s
  exact default is a partial coverage gap (indexed in settings-reference,
  described only in the changelog and search summaries). Considered and
  not adopted this sweep — see the deliberately-out-of-scope note at the
  bottom of this file.
- NEW (2026-09-06): full documented agent-frontmatter field set is `name`,
  `description` (both required), `tools`, `disallowedTools`, `model`,
  `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`,
  `background`, `effort`, `isolation`, `color`, `initialPrompt`,
  `experimental` (`cacheTtl: 5m|1h`) — <https://code.claude.com/docs/en/sub-agents>.
  REPO-IMPACT: reading all ten `.claude/agents/*.md` files against this set
  found two divergences: `.claude/agents/Explore.md`'s `color: gray` is not
  in the documented enum (`red, blue, green, yellow, purple, orange, pink,
cyan`) and is unguarded by `bin/check-agents.mjs` — **fixed this sweep,
  changed to `cyan`**; and `Explore.md`'s `name: Explore` (capital E) is
  deliberate, documented as an intentional override of the built-in agent
  (`bin/check-agents.mjs:61-65`), not a violation. Documented-but-unused
  fields the repo could adopt: `skills`, `memory`, `isolation`,
  `experimental.cacheTtl`, `hooks`, `background`, `initialPrompt` — not
  adopted this sweep (docs-only remediation scope).
- GONE: `https://platform.claude.com/en/docs/claude-code/sub-agents` and
  `https://platform.claude.com/docs/en/docs/claude-code/sub-agents` — 404
  (re-confirmed 2026-09-06). `https://docs.claude.com/en/docs/claude-code/sub-agents`
  301s to `https://code.claude.com/docs/en/sub-agents` (re-confirmed
  2026-09-06).
- COVERAGE GAP: no Anthropic documentation of the read-only-agent
  scratchpad-write mismatch, and no documented fallback pattern for a
  tool-less agent's overflow output. Re-checked 2026-09-06: still absent;
  `taskOutputMaxChars` (above) is the closest new lever but is a
  receiving-side cap, not a fallback for a tool-less agent, so the gap
  stands. The repo's inline-digest workaround
  (`.claude/rules/subagent-dispatch.md`) remains repo-invented, correctly
  not attributed upstream.
- NEW (2026-09-06): no post published on
  <https://www.anthropic.com/engineering> on or after 2026-08-15 (most
  recent listed as of this sweep: "An update on recent Claude Code quality
  reports", Apr 23 2026). No new engineering-blog guidance since the last
  sweep.

### Skills & context engineering

- CLAIM: context engineering canon — "the smallest possible set of
  high-signal tokens," just-in-time retrieval, context rot (accuracy
  decreases as tokens increase), sub-agent condensed summaries (1,000-2,000
  tokens), external structured note-taking —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; post still dated Sep 29,
    2025 on the `/engineering` index, no successor post). Canonical source,
    cited in `subagent-context-management.md`.
- CLAIM: SKILL.md hard limits (Agent Skills spec, portable/`agentskills.io`
  surface) — `name` max 64 chars; `description` max 1,024 chars; body
  recommended under 500 lines —
  <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; both the "Skill structure"
    Note and the "Technical notes → YAML frontmatter requirements" section
    still state 64/1,024/500) — confirmed real but **not applicable** to
    this repo's gate, see next claim. Re-measured directly: 0/23 skill
    descriptions exceed 1,024 chars (longest 462, `resolving-merge-conflicts`);
    0/23 skill bodies exceed 500 lines (longest 416,
    `implementing-submodules`).
- CLAIM: Claude Code's own skill-listing cap is `skillListingMaxDescChars`,
  documented default **1,536** characters ("the combined `description` and
  `when_to_use` text is truncated at 1,536 characters in the skill listing
  to reduce context usage"), distinct from the portable Agent Skills spec's
  1,024-char limit above — <https://code.claude.com/docs/en/skills> (retrieved
  2026-09-01, direct fetch to resolve a conflict with the platform
  best-practices page)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06, setting name and 1,536
    default both re-confirmed verbatim). `bin/check-context-budget.mjs`'s
    `SKILL_DESC_WARN_CHARS = 1536` remains **correct as-is**. Note the cap
    covers `description` **+ `when_to_use`** combined; no repo skill sets
    `when_to_use`, so the repo's measurement remains equivalent.
- CLAIM: a supported, free, no-quota token-counting endpoint exists —
  `POST /v1/messages/count_tokens` (CLI `ant messages count-tokens`; SDK
  `count_tokens`/`countTokens`); accepts system prompts, tools, images,
  PDFs; counts under the tokenizer of the `model` passed —
  <https://platform.claude.com/docs/en/build-with-claude/token-counting> ,
  <https://platform.claude.com/docs/en/api/messages-count-tokens> (retrieved
  2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; "free to use but subject to
    requests-per-minute rate limits," Start tier 5,000 RPM, separate from
    Messages limits). See Outstanding drift #4 (reclassified as an
    accepted, documented limitation this sweep).
- CLAIM: "Claude 4.7 and later models and Claude Mythos Preview use a newer
  tokenizer. The same input text produces approximately 30 percent more
  tokens than on earlier models." — same source as above.
  - VERDICT: UNCHANGED (re-fetched 2026-09-06), with a new section, "Token
    counts on Claude Fable and Claude Mythos models," extending the same
    ~30% figure to Fable 5.1/Mythos 5.1/Fable 5/Mythos 5. **No recommended
    local estimator ratio is documented anywhere** — re-verified this
    sweep; the 2.1.261 `/context` "local estimate" changelog entry is not
    documented on any allowlisted page. See Outstanding drift #4.
- CLAIM: CLAUDE.md guidance — target under 200 lines; Claude Code loads a
  CLAUDE.md up to 4 MiB in full; `@`-imports load at launch and don't reduce
  context; `/doctor` (v2.1.206+) proposes trims of codebase-derivable
  content — <https://code.claude.com/docs/en/memory> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06, all four confirmed verbatim).
    `MAX_RUNTIME_LINES = 200` in `bin/check-context-budget.mjs` matches
    exactly. `CLAUDE.md` measures 193 lines, ~2,999 estimator-tokens against
    the 3,000-token cap — one token of headroom, re-verified live
    2026-09-06 via `pnpm check:context-budget` (this sweep's own docs edits
    did not touch `CLAUDE.md`).
  - NEW, unused by repo: `/doctor`'s trim proposal targets exactly the kind
    of content CLAUDE.md's own § Repository Layout carries (derivable from
    the codebase) — worth trying next time the line budget gets tight.
- CLAIM: a published "reduce token usage" doc for Claude Code enumerates
  levers — `/clear` between tasks, custom `/compact` instructions, model
  choice per subagent, reducing MCP overhead, hooks/skills offloading,
  moving instructions from CLAUDE.md to skills, `/effort`/`MAX_THINKING_TOKENS`,
  delegating verbose ops to subagents, agent-team cost (~7× more tokens in
  plan mode) — <https://code.claude.com/docs/en/costs> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; every lever still present,
    "approximately 7x more tokens than standard sessions when teammates run
    in plan mode" still verbatim; the page does not mention `/skill-doctor`,
    `bashOutputMaxChars`, or `taskOutputMaxChars`). Repo's `gh`-CLI
    preference (CLAUDE.md § Git Workflow) already matches the doc's "prefer
    CLI over MCP" lever.
- NEW (2026-09-06): `/skill-doctor` (v2.1.252+) is documented at
  <https://code.claude.com/docs/en/skills>: "Run `/skill-doctor` to see what
  each of your skills costs and how often it gets used, so you can decide
  which ones to turn off." Interactive sessions render it in the `/plugin`
  manager's Stats tab; `-p` headless prints text. Covers session skills
  (not bundled/enterprise), flags listed-but-never-invoked skills, lists
  unused plugins; unavailable when feature-flag fetching is skipped; must
  run on the machine hosting the session. REPO-IMPACT:
  `docs/contributing/skills-catalog.md` updated to cite it at the
  hand-authored `researching-anthropic-guidance` cost row, which currently
  derives its usage figure by hand — `/skill-doctor` is the officially
  supported way to derive that empirically.
- NEW (2026-09-06): the documented SKILL.md frontmatter field set is now 21
  fields — `name`, `description`, `when_to_use`, `argument-hint`,
  `arguments`, `disable-model-invocation`, `user-invocable`,
  `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`,
  `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`,
  `compatibility` — all optional. REPO-IMPACT: none is a violation — this
  repo's 23 skills set only `name` (23/23), `description` (23/23), and
  `disable-model-invocation` (1); every field the repo sets is documented.
  Omitted-but-notable: `paths` (path-scoped activation — a direct context
  saving), `model`/`effort` (per-skill tiering instead of prose in
  `model-selection.md`), `allowed-tools`. Not adopted this sweep
  (docs-only remediation scope).
- COVERAGE GAP: `/claude-api cost-optimize` (changelog 2.1.247) — still no
  dedicated published doc on allowlisted domains as of 2026-09-06.
- COVERAGE GAP: `www.anthropic.com/engineering`, `/news`, `claude.com/blog`
  index pages not enumerated directly this pass (budget) — **narrowed
  2026-09-06:** `www.anthropic.com/engineering`, `www.anthropic.com/research`,
  and `www.claude.com/blog` were each enumerated directly this sweep — no
  new 2026 post on skills, context engineering, or token management on any
  of them. `www.anthropic.com/news` was still not enumerated (budget); gap
  narrowed, not closed.
- COVERAGE GAP (new, 2026-09-06): three CHANGELOG items in the
  v2.1.260→v2.1.263 delta have no allowlisted documentation:
  `bashOutputMaxChars`/`taskOutputMaxChars` and
  `--append-subagent-system-prompt-file` are absent from the costs page,
  and the 2.1.261 `/context` local-token-estimate change is undocumented —
  which is also why the tokenizer claim above yields no estimator ratio.

### Hooks & lifecycle

- CLAIM: full documented hook event list (32 events, including `Setup`,
  `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`,
  `PostToolUseFailure`, `PostToolBatch`, `MessageDisplay`, `TaskCreated`,
  `TaskCompleted`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`,
  `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`,
  `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`,
  `PostModelSwitch`, `Elicitation`, `ElicitationResult`) —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: CHANGED (re-fetched 2026-09-06) — the recorded count was a
    **miscount, not an upstream change**. The page enumerates **33** events,
    not 32: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion,
    PreToolUse, PermissionRequest, PermissionDenied, PostToolUse,
    PostToolUseFailure, PostToolBatch, Notification, MessageDisplay,
    SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop,
    StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange,
    CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate,
    WorktreeRemove, PreCompact, PostCompact, PreModelSwitch,
    PostModelSwitch, Elicitation, ElicitationResult, SessionEnd. Diffed
    against `bin/check-hooks.mjs`'s `KNOWN_EVENTS`: **empty set-difference
    in both directions** — no event added or removed, no drift. See
    Outstanding drift #5, #6 (`PostCompact` closed as not-actionable
    2026-09-06).
- CLAIM: `PreCompact`'s documented input carries `trigger` (`"manual"` |
  `"auto"`), also usable as the `PreCompact`/`PostCompact` matcher value; no
  `custom_instructions` field is documented in `PreCompact`'s input —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: CHANGED (re-fetched 2026-09-06) — partially unpinnable. Two
    fetches could not surface a `PreCompact` input schema at all (content
    truncated both times); the **`PostCompact`** schema that did return
    names the field **`compaction_trigger`**, not `trigger`. Matcher
    _values_ `manual`/`auto` are confirmed for both events (matcher table).
    Whether the _input field_ is `trigger` or `compaction_trigger` for
    `PreCompact` specifically could not be pinned today — one fetch, no
    corroboration. `custom_instructions` still absent in both fetches
    (consistent with the original claim). REPO-IMPACT: none blocking —
    `bin/check-hooks.mjs`'s matcher-enum validation for `manual`/`auto` is
    confirmed correct either way; `write-compact-handoff.mjs` reads neither
    field name, so the "can't distinguish manual from auto" gap stands
    regardless. Any future hook reading `PreCompact`'s payload must not
    assume `trigger` without re-verifying.
- CLAIM: `SessionStart` matcher values are `startup`, `resume`, `clear`,
  `compact`, `fork` — <https://code.claude.com/docs/en/hooks> (retrieved
  2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06, two fetches, both returned
    these five verbatim); `.claude/settings.json`'s
    `matcher: "compact|resume|startup"` targets live values.
- CLAIM: every hook event receives common fields `session_id`, `prompt_id`,
  `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`,
  `agent_id`, `agent_type`; the transcript file "is written asynchronously
  and may lag the in-memory conversation"; no documented hook field anywhere
  carries context size, token counts, or remaining window —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06). The nine common-input fields
    returned verbatim; the no-token-counts fact was re-verified explicitly
    against both the common-input table and every per-event schema
    fetched — `statusLine`, by contrast, exposes
    `context_window.total_input_tokens`, `context_window_size`,
    `exceeds_200k_tokens`, `rate_limits.*`, `prompt_cache.*`, confirming the
    repo's statusLine-not-hook approach as still correct.
- CLAIM: `UserPromptSubmit`/`SessionStart` output contract is
  `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}`;
  a top-level `systemMessage` warns the user without blocking; blocking is
  exit code 2 or `decision:"block"` + `reason` —
  <https://code.claude.com/docs/en/hooks> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; the `PostCompact` schema
    fetched for the item above confirms the same
    `hookSpecificOutput`/`systemMessage` shape). `inject-decision-gate.mjs`
    and `reinject-compact-handoff.mjs` both emit the correct shape.
    `systemMessage` is available but unused anywhere in the repo.
- CLAIM: `statusLine` invocation cadence — session start/resume, new
  assistant message, `/compact` finishing, permission-mode change, vim-mode
  toggle, `command` setting change, `refreshInterval` timer, rate-limit
  reset, prompt-cache expiry; 300ms debounce; a new trigger cancels an
  in-flight script; runs locally, no API tokens consumed —
  <https://code.claude.com/docs/en/statusline> (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06; all nine triggers confirmed
    verbatim). New nuance: "a change to the `command` itself skips the
    debounce" and an edited _script_ only takes effect on the next trigger;
    it "temporarily hides during autocomplete, help menu, and permission
    prompts." `.claude/settings.json` wires `statusLine` +
    `subagentStatusLine`, `refreshInterval: 30` ≥ 1.
- CLAIM: no hook fires on approaching the context limit or auto-compact
  threshold; the only controls are the `autoCompactEnabled`/
  `autoCompactWindow` settings — <https://code.claude.com/docs/en/settings-reference>
  (retrieved 2026-09-01)
  - VERDICT: UNCHANGED (re-fetched 2026-09-06, corroborated by the
    common-fields re-verification above).
- CLAIM (2026-09-04): `WorktreeCreate` fires only for `--worktree`,
  `isolation: "worktree"`, or a background session — the `EnterWorktree`
  tool is not among the triggers.
  - VERDICT: UNCHANGED (re-fetched 2026-09-06); `docs/contributing/hooks-reference.md`
    still states this correctly.
- CLAIM (2026-09-04): `WorktreeCreate`/`WorktreeRemove` have no matcher
  support; `Notification`'s matcher enum was deliberately left unpinned due
  to fetch instability.
  - VERDICT: UNCHANGED for the worktree events (re-fetched 2026-09-06: "does
    not support a matcher… always fires"). For `Notification`: **still
    unpinned** — a fourth independent fetch (across sweeps) returned a
    fourth distinct value list (12 values this time: `permission_prompt`,
    `idle_prompt`, `auth_success`, `elicitation_dialog`,
    `elicitation_url_dialog`, `elicitation_complete`,
    `elicitation_response`, `agent_needs_input`, `agent_completed`,
    `quota_auto_resume_fired`, `quota_auto_resume_stale`,
    `quota_auto_resume_disabled`). Not corroborated; `bin/check-hooks.mjs`
    correctly continues to leave it unencoded.
- GONE: `platform.claude.com/docs/en/docs/claude-code/hooks` and
  `.../statusline` — 404 (re-confirmed 2026-09-06). Same path-migration
  pattern as the features/settings facet above.
- COVERAGE GAP: the exact SessionStart input field name for the compact
  matcher could not be pinned with full confidence — three fetches of the
  same hooks page returned inconsistent field names (`source` vs
  `how_started` vs `how` vs `start_source`), most likely fetch-summarizer
  instability rather than a real doc discrepancy. **Resolved 2026-09-06 —
  empirically, not by fetch.** A fifth doc fetch this sweep returned a
  fifth value (`session_start_reason`), which would imply
  `reinject-compact-handoff.mjs`'s `shouldReinject()` (reads only
  `input.source`, fails closed/silent on a mismatch) has been dead all
  along. Checking session transcripts directly disproves this:
  `SessionStart:compact` fired 49 times across this project's local
  sessions, and **14 of those emitted a populated `additionalContext`
  containing the rendered handoff** (`"Prior-session handoff (ADR-0078) —
..."`), which `shouldReinject()` only returns `true` for when
  `input.source` matches. `input.source` is confirmed correct by execution.
  This closes the gap for good: this doc page has now returned five
  mutually inconsistent field names across sweeps and is not a trustworthy
  source for this value — future verification of this specific fact should
  use the transcript method again, not another fetch.
- COVERAGE GAP: `docs/contributing/hooks-reference.md`'s prose event list
  was not diffed against the documented 32 this pass (budget) — **closed
  2026-09-06.** `docs/contributing/hooks-reference.md`'s "7 of 33" event
  list was diffed name-by-name against both `KNOWN_EVENTS` and today's
  documented 33 events: all three sets agree exactly, no drift.
- NEW (2026-09-06): documented hook handler `type`s beyond `command`:
  `"http"`, `"mcp_tool"`, `"prompt"`, `"agent"`; new per-hook
  `statusMessage`/`once` fields —
  <https://code.claude.com/docs/en/hooks>. REPO-IMPACT: every entry in
  `.claude/settings.json` uses `"type": "command"`; `bin/check-hooks.mjs`
  neither validates nor rejects the other four types (it only reads
  `command`/`timeout`/`if`), so a future `http`/`agent` hook would pass
  unvalidated. Advisory only — not actioned this sweep (docs-only
  remediation scope; see the deliberately-out-of-scope note below).
- NEW (2026-09-06): CHANGELOG 2.1.261 "Fixed resuming a session losing hook
  output and other context around parallel tool calls" — relevant to
  `reinject-compact-handoff.mjs`'s resume path; no doc-level contract
  change found.
