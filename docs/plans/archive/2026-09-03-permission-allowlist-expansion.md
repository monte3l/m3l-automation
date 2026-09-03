# Expand the project Bash/gh/WebFetch permission allowlist

**Status: shipped** — landed on `chore/permission-allowlist`, closing out a
`/fewer-permission-prompts`-triggered follow-up.

## Context

`/fewer-permission-prompts` had already added five entries to
`.claude/settings.json` (`git merge-base`, `pnpm verify`,
`mcp__github__issue_read`, and two others) earlier in the same session. The
follow-up question was whether the historical transcript corpus supported
further additions — so three Explore agents mined it: 1,140 JSONL transcripts
across 16 project directories (the main checkout plus 15 worktree session
dirs, ~463 MB total).

The headline finding reframed the exercise. The corpus contains no evidence of
allowlist-driven permission prompts: of 300 recorded `permission-rule`
denials, 291 were this repo's own PreToolUse hooks (273
`guard-readonly-bash.mjs`, 18 `guard-hub-src-writes.mjs`) and 8 were `curl`
correctly hitting the deny list — zero were an allowlist gap. Sessions run
overwhelmingly in `auto` permission mode (5,029 turns vs 189 in `default`),
which absorbs permission decisions silently and leaves no transcript marker
for an approved-after-prompt decision. So the additions below are justified by
**usage frequency**, not observed denials — 63,292 Bash invocations were
censused and only ~6% matched a rule already in place.

## Approach / Decisions

- Additions land in project `.claude/settings.json` (checked in, shared
  across worktrees), not `settings.local.json` or user settings.
- Read-only entries only. `find`/`awk`/`xargs`/`echo` were excluded despite
  high volume — they execute or write without needing shell redirection at
  all (`find -exec`, `awk`'s `system()`, `xargs <cmd>`), or their dominant
  real-world write form _is_ the redirect (`echo x > f`); `cat` was excluded
  outright since ~980 of its 1,718 censused uses were `cat > file` heredoc
  writes.
- Additive plus repair of existing rules whose glob shape never matched
  reality — no removals, even where the census found unused entries
  (`mcp__m3l__*`, never invoked in the whole corpus).
- Two raw census claims were corrected against the repo before acting on
  them: `pnpm sync:docs` was reported read-only but actually spawns
  `prettier --write` (`bin/sync-docs.mjs:386`) and regenerates the reference
  index, so it was excluded; three `pnpm check:*` scripts
  (`check-context-budget.mjs`, `check-file-budget.mjs`,
  `check-exports-snapshot.mjs`) write baseline/snapshot files, which is
  pre-existing exposure under the already-allowed `Bash(pnpm check:*)`, not
  new.
- The highest-value additions were **near-miss repairs**, not new commands:
  rules that looked correct but whose literal-prefix matching never fired —
  `gh api` invoked with a flag before the path, `{owner}/{repo}` placeholder
  paths, `pnpm --filter <pkg> <script>` and `-C <dir>` forms, and the
  `pnpm exec` spelling of `prettier`/`vitest`/`eslint`.
- `WebFetch(domain:…)` matches host only, with no path filter, so the
  eight-host allowlist reused
  `.claude/skills/researching-anthropic-guidance/references/official-sources.md`
  as the authority rather than inventing a new list — and deliberately
  excluded `raw.githubusercontent.com`/`github.com` despite being the largest
  remaining WebFetch volume, because that same file's own rule restricts
  fetches to the `anthropics` org, which a bare domain rule cannot express.

## Outcome

`.claude/settings.json`'s `permissions.allow` grew from 40 to 119 entries
(the pre-session `/fewer-permission-prompts` additions carried into this
same commit, hence the count from `origin/main` rather than the session's
own working-tree starting point): 87 insertions covering read-only
`git`/`gh`/shell utilities, `gh api`
method/placeholder repairs, `pnpm --filter`/`-C` script variants, eight
`WebFetch` domains, and bare `WebSearch`. No MCP additions — the entire
corpus held only 129 MCP calls and everything non-trivial was already
allowlisted.

Filed separately rather than folded into this change:
`guard-readonly-bash.mjs` produced 273 of the 300 recorded denials by
blocking read-only spokes from writing to the session scratchpad the system
prompt directs them to use — it degraded both census agents in this session,
forcing single-pass streaming pipelines with no staged intermediates. The fix
(permit writes whose target resolves under the session scratchpad) is hook
logic plus test updates, a different concern from a permissions-only PR.
