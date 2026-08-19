# CLAUDE.md runtime token budget

**Status: shipped** — PR `feat/claude-md-token-budget` (commit `feb459e`).

## Context

An exploratory audit of `CLAUDE.md`, run with `/auditing` fanning out both a
repo-state read and a `/researching-anthropic-guidance` pass over official
Anthropic sources, found the file's always-loaded runtime content (everything
outside HTML comments — Claude Code strips block comments before injection)
had grown to 23,318 chars / ~5,829 tokens across 314 lines, against
Anthropic's stated `<200`-line target and its documented harm: "Bloated
CLAUDE.md files cause Claude to ignore your actual instructions," not merely a
token-cost concern. The cost compounds in this repo specifically — custom
subagents load the full `CLAUDE.md` hierarchy at launch (only the built-in
Explore/Plan agents skip it), so a 9-spoke roster re-pays the preamble on
every dispatch, not once per session. The audit also surfaced five factual
defects, the most consequential being a `/start-work` reference to a slash
command that has never existed in this repo (the capability is the
`starting-work` skill) — live in both `CLAUDE.md` prose and the
`inject-decision-gate.mjs` hook's injected reminder text.

## Approach / Decisions

**Table gates first, content second.** Three scripts parse `CLAUDE.md`
structurally (`check:cadence`, `check:workflows-doc`, `bin/lib/count-sites.mjs`
for the Core/AWS barrel counts) — reading each gate's source before editing
established that they only read a table's skeleton (stage cells, backticked
check tokens, `` `name.yml` `` first cells, the count-word sentence), never
the Trigger/Purpose prose that made up most of the tables' bytes. That made
the largest single block — the CI/CD table's Purpose column, 1.5k tokens, 26%
of the file — safe to relocate wholesale to `docs/contributing/ci-cd.md` with
`bin/check-workflows-doc.mjs` repointed at it, rather than trimmed in place.

**Prose-wrap discipline for gate-critical phrases.** The repo's `proseWrap:
preserve` Prettier config keeps whatever line breaks the author writes — it
does not auto-wrap. A first attempt at compressing the Repository Layout
section manually broke `Core namespace barrel (22 documented submodules)`
across two lines for readability, which silently broke `count-sites.mjs`'s
regex (no `\s` in the pattern). Fixed by keeping every gate-matched literal
phrase on one continuous source line, however long; `check:doc-counts` caught
the break immediately as a real-time regression signal rather than a shipped
defect.

**Line count, not just token count, needed a second pass.** After the
duplicated-section eviction and defect fixes landed the token count under
budget (~3,000), the line count was still ~40 over the 200-line target — bullet
lists and manually word-wrapped paragraphs cost one line each regardless of
length. Collapsing wrapped paragraphs and bullets into single continuous lines
(safe under `proseWrap: preserve`) cut line count without changing char count,
landing at 148 lines / ~2,747 tokens.

**A budget gate, not just a one-time cleanup.** Added `check:claude-md-budget`
(200-line / 3,000-token thresholds, warns on Prettier-padded table rows >200
chars) so the file can't silently regrow — wired into the same four places
every `check:*` script in this repo touches (`package.json`,
`command-catalog.mjs`, `verify-steps.mjs`, `ci.yml`'s `gates` lane), deliberately
CI-only rather than added to `lefthook.yml` pre-push (that would have churned
the very cadence table this plan was shrinking).

**Ancestor exclusion.** `/home/enri3l/CLAUDE.md` (an unrelated chezmoi
dotfiles guide, an ancestor of every project under the home directory) was
loading into every session and spoke launch here — 980 tokens for zero
relevance. `claudeMdExcludes` in `.claude/settings.json` is the documented
mechanism; it also happened to be the same file already dirtied by this
session's earlier `/plugin` installs, landed in the same commit per explicit
user instruction rather than split.

## Outcome

- `CLAUDE.md` — restructured; runtime content 5,829 → ~2,747 tokens (314 → 148
  lines); 5 factual defects fixed (`starting-work` skill naming, the
  `GITHUB_TOKEN`-only credential claim, "the published library" self-contradiction,
  the missing `subagent-dispatch.md` rules-list entry and its broken reciprocal
  link, the missing `packages/m3l-cli/` layout entry)
- `.claude/hooks/inject-decision-gate.mjs` — fixed the same `/start-work` →
  `starting-work` defect at its live source (the injected per-prompt reminder)
- `docs/contributing/ci-cd.md` — new; holds the full CI/CD workflow table
- `bin/check-workflows-doc.mjs` — repointed at the new doc file
- `bin/check-claude-md-budget.mjs` — new gate; `bin/tests/check-claude-md-budget.test.ts`
  — 19 unit tests (dispatched to `test-author`, the only guarded-path write)
- `package.json`, `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`,
  `.github/workflows/ci.yml` — new gate wired into the standard four sites
- `.claude/settings.json` — `claudeMdExcludes` added for the irrelevant ancestor
  CLAUDE.md
- `.claude/rules/subagent-dispatch.md` — fixed its own broken "linked from
  CLAUDE.md's Agent Operating Model section" claim
- `docs/README.md` — new Contributing-index row for `ci-cd.md`
- `pnpm verify`: 40/40 applicable steps pass (3 skipped: gitleaks/turbo-cache
  need local creds, hub-drift is push-only); full `test:coverage` run: 180+41
  test files, 8,348 tests, all green
