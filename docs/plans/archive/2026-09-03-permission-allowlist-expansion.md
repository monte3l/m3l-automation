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
- `WebSearch` is deliberately left unscoped, asymmetric with the
  domain-pinned `WebFetch` entries beside it — stated explicitly here per a
  bot-review ask (round 4, below) to document the intent rather than leave
  it unaddressed a third time. Unlike every removed finding in this doc,
  unscoped `WebSearch` is not a privilege-escalation defect: Claude Code has
  no `WebSearch(domain:…)` rule syntax to restrict it further (confirmed —
  only `WebFetch` supports domain scoping), and a search query has no
  filesystem or execution impact the way every removed entry above did. The
  intent is general-purpose search availability, not "Anthropic docs only"
  (that narrower need is what the domain-pinned `WebFetch` entries and
  `researching-anthropic-guidance`'s own `allowed_domains` parameter already
  cover at the call site); kept as-is.

## PR review — four rounds of security findings

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

A fourth bot review, on the round-3 fix commit, found a different bug class
in four entries the first three rounds hadn't examined closely: `Bash(pnpm
--filter * typecheck*)` (and the `build*`/`test*`/`lint*` siblings) placed
the wildcard **between** `--filter` and the script name rather than only at
the end. Confirmed directly: any command starting `pnpm --filter ` that
contains the literal substring ` typecheck` _anywhere_ later matches, with
nothing required in between — including `pnpm --filter . exec bash -c
'<payload>' typecheck`, a real `pnpm --filter <selector> exec <cmd>`
invocation that runs an arbitrary shell command, needing no chaining
operator at all since the whole thing is one command Claude Code's
prefix-glob matches as a unit. All four were removed rather than
re-anchored to an enumerated package list — this monorepo's workspace
package set changes over time, and hand-verifying every real package name
stayed correct was worse than dropping four already-marginal entries. The
Should-fix in the same review (`Bash(node bin/check-*.mjs*)` — a wildcard
inside the path segment admits `../` path-traversal, e.g. `node
bin/check-x/../../evil.mjs` escaping `bin/` entirely) was dropped for the
same reason: `pnpm check:*` already covers the primary invocation form, so
the direct-`node` spelling was optional value, not core to the PR. Two
harmless nits were folded in — `git worktree list*`/`git reflog show*`
missing the space before `*` that every sibling entry uses (split into a
bare-form-plus-spaced-form pair rather than left glob-ambiguous) — and a
`deny`-list widening was applied as suggested (`~/.claude/.credentials.json`
→ `~/.claude/.credentials*`, covering rotated/backup credential-file
variants). The WebSearch/WebFetch asymmetry, raised again in this round,
was resolved by documenting intent explicitly (Approach/Decisions, above)
rather than by another removal — see that section for why it's not the same
defect class as everything else in this list.

## Outcome

`.claude/settings.json`'s `permissions.allow` grew from 40 to 75 entries and
`permissions.deny` from 13 to 16 (both counts against `origin/main`, since
the pre-session `/fewer-permission-prompts` additions carried into the same
commit as this PR). Net of four security-review rounds, the surviving
additions cover read-only `git status`/`rev-parse`/`branch --show-current`/
`worktree list`/`remote get-url`/`for-each-ref`/`ls-tree`/`ls-files`/
`reflog show`, `test -f`/`pwd`, `gh` read commands, the literal
(non-placeholder) `gh api` path repairs, `pnpm exec prettier --check`/`knip`,
eight `WebFetch` domains, and bare `WebSearch`. The large majority of the
original design's highest-census-volume entries — `git diff`/`log`/`show`,
`grep`/`head`/`tail`/`ls`/`wc`/`cut`/`tr`, `jq`, `rg`, `cd`, `sed -n`, `sort`,
`uniq`, `gh api --method GET *`, `pnpm -C *`/`--filter *`, `pnpm exec rumdl
check`, `git cat-file`, `node bin/check-*.mjs*` — did not survive review;
each had a real write, arbitrary-execution, or unscoped-read path with no
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
`guard-readonly-bash.mjs`-covered subagent context would clear. Round 4 added
a second, distinct lesson: a wildcard's **position**, not just its presence,
determines the blast radius. `Bash(pnpm test *)`'s trailing wildcard only
admits extra content _after_ a fully-formed, safe command; `Bash(pnpm
--filter * typecheck*)`'s wildcard sat _before_ the anchor text, so it
admitted arbitrary injected content _between_ a safe-looking prefix and a
safe-looking suffix — a shape none of the first three rounds' findings had,
and one worth checking for explicitly (every wildcard's position relative to
the fixed anchors, not just whether one exists) on any future rule with more
than one literal segment.

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
