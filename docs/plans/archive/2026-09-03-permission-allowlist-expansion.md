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
  reality — no removals of pre-existing baseline entries, even where the
  census found unused ones (`mcp__m3l__*`, never invoked in the whole
  corpus). Two PR-review rounds (below) did remove several of this PR's own
  additions after they proved unsafe.
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

## PR review — three rounds of security findings

`claude-pr-review.yml` FAILed the initial PR with 2 Must-fix findings, both
confirmed real: `Bash(sed -n *)`/`Bash(sort *)`/`Bash(uniq *)` each also
match a write form of the same command (`sed -n -i`, `sort -o FILE`, `uniq
IN OUT`) since Claude Code's permission matching is plain-text prefix
matching, not flag-aware; and `Bash(gh api --method GET *)`/`-X GET *`
dropped repo scoping and admit a repeated `--method`/`-X` flag later on the
same command line overriding to a mutating verb. Should-fix items in the
same review (`Bash(cd *)` de-scoping every relative-path rule in a compound
command, `pnpm -C *` running an arbitrary directory's script, the
`{owner}/{repo}` gh api mirrors resolving against whichever remote is
active) were fixed by removal rather than left open, since they shared the
same root cause and a scoped alternative wasn't expressible.

A bounded re-review (`code-reviewer` + `security-reviewer`, scoped to the
one changed file) found the same defect class had survived in entries the
first pass didn't reach — several proven by direct execution, not just
argued: `Bash(jq *)` auto-approves `jq -n env` (full environment/secret
dump), `Bash(git ls-remote *)` and `Bash(rg *)` both admit an
attacker-controlled-command flag (`--upload-pack=<cmd>`, `--pre <cmd>`), and
— confirmed by directly testing `git diff`/`log`/`show`/`status` — the
first three all honor `--output=<file>` (arbitrary write, and invisible to
`guard-readonly-bash.mjs`'s `>`-only redirect regex even for the subagents
that hook does cover) while `status` genuinely does not. All were removed;
`git branch -vv*`/`git reflog *` were tightened to their non-mutating forms
instead of dropped, and three plaintext-credential-file `deny` entries
(`~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.claude/.credentials.json`) were
added, since this PR's own broad read-utility rules made them more reachable.

The same reviewers also surfaced the identical defect class in **pre-existing**
baseline entries this PR didn't touch — `git fetch *` (same `--upload-pack`
vector), the 5 remaining literal `gh api repos/monte3l/m3l-automation/...*`
entries (same appended-flag-mutation gap as the 4 already removed),
`pnpm exec eslint/tsc *` and `pnpm {exec }vitest run *`/`pnpm test *`
(RCE via `--config`), and `gh pr view/run view --web` (lower severity: local
browser launch). These are real and left deliberately out of this PR's
diff — fixing them means touching entries the maintainer already approved
for reasons unrelated to this transcript census, several of which (`git
fetch`) this repo's own skills depend on directly, so a silent removal here
would be scope creep. Filed as a follow-up rather than folded in.

A third bot review, on the fix commit, found the fundamental gap underlying
both prior rounds: the three credential-file `deny` entries added in round
2 (`~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.claude/.credentials.json`) only
gate Claude Code's built-in `Read` tool — confirmed by reading
`guard-readonly-bash.mjs`'s own header, they do nothing to stop the kept
generic Bash utilities (`grep`/`head`/`tail`/`ls`/`wc`/`cut`/`tr`) from
reading the exact same files via an unconstrained absolute-path argument,
since the settings.json permission DSL has no way to express "path argument
must be repo-relative" — every rule is a plain prefix-glob against raw
command text. Worse, this repo's only Bash `PreToolUse` hook
(`guard-readonly-bash.mjs`) explicitly scopes itself to subagent contexts
only (`agent_type` present in the payload) and no-ops for the hub's own Bash
calls, so for the hub session — the one actually running this settings.json
— `permissions.allow` is the _only_ gate, with no backstop at all. `git
cat-file *` (Should-fix, narrower blast radius: only committed blob objects,
not arbitrary filesystem paths) shared the same class and was dropped
alongside it. Given no scoped fix is expressible in the DSL and no hook
exists to add path-scoping for the hub, removal was again the only correct
resolution — this round cost the single largest chunk of the original
census-driven value (`grep`/`head`/`tail`/`ls`/`wc`/`cut` together were
over 20,000 combined census uses).

## Outcome

`.claude/settings.json`'s `permissions.allow` grew from 40 to 78 entries and
`permissions.deny` from 13 to 16 (both counts against `origin/main`, since
the pre-session `/fewer-permission-prompts` additions carried into the same
commit as this PR). Net of three security-review rounds, the surviving
additions cover read-only `git status`/`rev-parse`/`branch --show-current`/
`worktree list`/`remote get-url`/`for-each-ref`/`ls-tree`/`ls-files`/
`reflog show`, `test -f`/`pwd`, `gh` read commands, the literal
(non-placeholder) `gh api` path repairs, `pnpm --filter`/`exec prettier
--check`/`knip`, eight `WebFetch` domains, and bare `WebSearch`. The large
majority of the original design's highest-census-volume entries —
`git diff`/`log`/`show`, `grep`/`head`/`tail`/`ls`/`wc`/`cut`/`tr`, `jq`,
`rg`, `cd`, `sed -n`, `sort`, `uniq`, `gh api --method GET *`, `pnpm -C *`,
`pnpm exec rumdl check`, `git cat-file` — did not survive review; each had a
real write, arbitrary-execution, or unscoped-read path with no
settings.json-expressible fix, so removal was the correct minimal
resolution each time rather than shipping a known hole. No MCP additions —
the entire corpus held only 129 MCP calls and everything non-trivial was
already allowlisted.

**Durable lesson, beyond this one PR:** a plain prefix-glob permission DSL
with no flag-awareness and no path-scoping cannot safely allowlist any shell
command capable of reading or writing an argument-supplied path with a
wildcard suffix — the wildcard always admits an absolute path, an unexpected
flag, or both, and there is no way to express "relative path only" or
"no `-i`/`-o`/`--output`/`--pre` flag" in the rule itself. Combined with the
hub's own Bash calls having zero hook backstop (unlike subagents, which
`guard-readonly-bash.mjs` does cover), this rules out most "obviously
read-only" coreutils as safe allowlist candidates for the hub specifically —
a materially different bar than the same census applied to a
`guard-readonly-bash.mjs`-covered subagent context would clear.

Filed separately rather than folded into this change:
`guard-readonly-bash.mjs` produced 273 of the 300 recorded denials by
blocking read-only spokes from writing to the session scratchpad the system
prompt directs them to use — it degraded both census agents in this session,
forcing single-pass streaming pipelines with no staged intermediates. The fix
(permit writes whose target resolves under the session scratchpad) is hook
logic plus test updates, a different concern from a permissions-only PR.
Also filed as a follow-up: the pre-existing-baseline security gaps the
PR-review rounds surfaced but which this PR's diff didn't touch (two
sections up) — `git fetch *`'s `--upload-pack` RCE vector is the most severe
and warrants the closest look, since removing it outright would break `git
fetch origin main` calls this repo's own `creating-prs`/
`resolving-pr-comments` skills issue directly. A third follow-up this round
adds: whether a hub-scoped sibling to `guard-readonly-bash.mjs` (path-scoping
argument-taking read commands to the repo tree) is worth building, since
that structural gap is what forced this PR's biggest value loss and would
recur for any future attempt to allowlist generic read utilities.
