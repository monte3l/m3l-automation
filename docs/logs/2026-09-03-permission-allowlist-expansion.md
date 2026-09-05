# Work log — permission-allowlist-expansion (2026-09-03)

This log covers expanding `.claude/settings.json`'s `permissions.allow`/`deny`
from a transcript-frequency census through four rounds of `claude-pr-review.yml`
security findings to a merged PR, plus the review-round-limit workaround that
closed and reopened it partway through. It records what shipped, what
diverged across the four review rounds, and durable lessons — most
significantly, that a plain-prefix-glob permission DSL with no flag- or
path-awareness cannot safely allowlist most argument-taking shell commands for
the hub session, since the repo's only Bash guard hook explicitly excludes
hub-issued calls.

Plan of record: [`docs/plans/archive/2026-09-03-permission-allowlist-expansion.md`](../plans/archive/2026-09-03-permission-allowlist-expansion.md)

## Summary

Three Explore agents censused 1,140 session transcripts (63,292 Bash
invocations, 129 MCP calls, 499 WebFetch calls) across the main checkout and
15 worktree session directories, finding zero allowlist-driven permission
denials in the corpus (sessions run overwhelmingly in `auto` mode, which
leaves no denial marker) — so the change was justified by usage frequency
rather than observed prompts. The resulting design (~119 `permissions.allow`
entries) went through four `claude-pr-review.yml` rounds on
[PR #950](https://github.com/monte3l/m3l-automation/pull/950), which was
closed after hitting the platform's review-round cap and reopened as
[PR #953](https://github.com/monte3l/m3l-automation/pull/953) (merged) to
finish. Final state: `permissions.allow` 40 → 75 entries and
`permissions.deny` 13 → 16, measured against `origin/main`. Four commits
landed on the branch: the initial expansion, and three review-response fix
commits (round 2's fixes were folded into commit 2; rounds 3 and 4 each got
their own commit).

- **Files changed:** `.claude/settings.json`,
  `docs/plans/archive/2026-09-03-permission-allowlist-expansion.md` (new),
  `docs/plans/README.md`.
- **Gates:** `pnpm verify` ran clean on all four commits; `pnpm sync:docs`
  (all 13 steps) ran clean four times with zero drift produced each time;
  `pnpm check:hooks`, `pnpm format:check`, `pnpm lint:md` all passed
  throughout. No `src/**` changes, so no coverage/typecheck-relevant gates
  applied.
- **Review spoke verdicts:** `docs-consistency-reviewer` (pre-push,
  `creating-prs` Step 7) — 1 Must-fix (a stale entry-count claim measured
  against the session's uncommitted working-tree state rather than
  `origin/main`), fixed before push. `code-reviewer` + `security-reviewer`
  (bounded re-review, `resolving-pr-comments` Step 7, round 2) — the
  security-reviewer found and **proved by direct execution** a Must-fix
  (`jq -n env` dumping this session's own `GH_TOKEN`; `git ls-remote
--upload-pack=<cmd>` and `rg --pre <cmd>` as command-execution vectors;
  `git diff/log/show --output=<file>` as arbitrary writes), all removed.
- **Skills used:** starting-work, creating-prs, resolving-pr-comments (×4
  rounds against PR #950/#953), syncing-docs (×4 runs via `pnpm sync:docs`),
  finishing-work, writing-work-logs.
- **Spoke incidents:** none (no `tmp/session-incidents.jsonl` entries; every
  dispatched agent — 3 census agents, `docs-consistency-reviewer`,
  `code-reviewer`, `security-reviewer` — converged with real output and
  needed no `SendMessage` resume). Two runs were long (the permission-denial
  census agent ~11 min; the `docs-consistency-reviewer` pre-push review
  ~19.5 min) but neither required hub intervention to unstick, so neither is
  counted as a stall in the ">15 min without converging" sense the term
  describes.
- **Compaction events:** the session's token counter reset to its full
  budget at least three distinct points across this long, multi-round task
  (visible as `<total_tokens>` jumping back to 15000000 mid-conversation).
  Branch state, PR number, and prior review-round findings were never lost
  across any of these resets — every subsequent turn correctly referenced
  PR #950/#953, the worktree location, and earlier rounds' fixes — consistent
  with the `PreCompact`/`SessionStart(compact)` handoff working, though this
  was not independently verified by reading `tmp/compact-handoff.json`
  mid-session (the file was absent by the time this log checked, consistent
  with normal post-use rotation).

## What went as planned

- **The census methodology surfaced real signal, not noise.** All three
  Explore agents (permission-denial hunt, main Bash census, MCP/worktree
  census) returned specific, actionable, well-evidenced findings — the
  headline "zero allowlist-driven denials in the corpus" finding correctly
  reframed the whole task's justification before any code was written.
- **Every `pnpm verify` run was clean on the first try**, across all four
  commits — no gate failure ever required a second attempt once a commit was
  staged, meaning the format/hook/JSON-validity checks run before each commit
  reliably caught issues before the expensive full-verify pass.
- **`pnpm sync:docs` never produced drift** across four separate runs, on a
  branch that never touched `src/**` — confirming the composite reconciliation
  correctly no-ops when there's nothing to reconcile, rather than needing to
  be told the change was docs-only.
- **The `starting-work` gate correctly recommended a linked worktree** given
  the standing "always use worktrees" preference, and the stash-based handoff
  of the session's pre-existing uncommitted `.claude/settings.json` diff into
  the new worktree worked cleanly on the first attempt.

## What didn't go as planned, and why

### 1. The census-driven design lost roughly a third of its entries to four rounds of real security findings

The original 119-entry design was built by evaluating each candidate command
by its base verb's reputation ("`grep`/`head`/`git diff` are read-only tools").
Four `claude-pr-review.yml` rounds instead evaluated each rule by what its
_wildcard_ actually admits as literal text, and found a different defect class
in every round: round 1 caught commands whose write-mode flag the trailing
wildcard also matched (`sed -n -i`, `sort -o`, `uniq IN OUT`) and an
unscoped `gh api --method GET *` admitting a repeated `--method` override;
round 2 (a self-dispatched bounded re-review, proven by direct execution)
caught `jq -n env` (full secret dump), `git ls-remote --upload-pack=<cmd>`
and `rg --pre <cmd>` (command execution), and `git diff/log/show
--output=<file>` (arbitrary write, invisible to the repo's own
`guard-readonly-bash.mjs` redirect regex); round 3 caught that the
credential-file `deny` entries added in round 2 only gate Claude Code's
`Read` tool, not `Bash`, so the kept `grep`/`head`/`tail`/`ls`/`wc`/`cut`/`tr`
utilities bypassed them entirely with zero backstop (the repo's only Bash
guard hook explicitly excludes hub-issued calls); round 4 caught a wildcard
placed _before_ a literal anchor (`Bash(pnpm --filter * typecheck*)`)
admitting injected content between two safe-looking anchors, enabling
arbitrary execution via `pnpm --filter . exec bash -c '<payload>'
typecheck`. Each round's fix was removal — no entry survived with a
settings.json-expressible scoped alternative — taking the surviving design
down to 75 entries.

**Why it happened:** the census method measured _frequency of a base
command_, not _what that command's full argument space, combined with a
trailing/interior wildcard, actually permits_. Claude Code's Bash permission
matching is plain-text prefix-glob matching with no flag-awareness and no
path-scope-awareness, and the repo's `guard-readonly-bash.mjs` hook — the only
structural backstop against a mutating Bash call — explicitly scopes itself to
subagent contexts only, leaving the hub's own Bash calls with `permissions.allow`
as their _sole_ gate. Neither fact was checked during the original design pass.

**Fix for future:** before proposing any `permissions.allow` addition for an
argument-taking command, explicitly check (a) whether _any_ flag of that
command can write, execute, or traverse paths, regardless of the base verb's
reputation — test the specific flag directly (`--output=`, `-i`, `-o`,
`--pre`, `env`, etc.) rather than reasoning from the command's name; and (b)
whether the wildcard's _position_ (trailing-only vs. between two literal
segments) could admit injected content between anchors rather than only
after the last one. Do this as a required design-time step for any command
the hub session itself will run — a subagent-scoped census (where
`guard-readonly-bash.mjs` provides a backstop) does not automatically
transfer to hub-session safety.

### 2. The PR hit its review-round cap partway through a still-productive review cycle, requiring a close-and-reopen

After round 3's fix, round 4's `claude-pr-review.yml` pass found a genuinely
new defect class (the mid-command wildcard bug, item 1 above) — the fourth
review comment on the same PR. The user then reported the review-round limit
(3/3) had been reached and PR #950 would auto-FAIL from that point regardless
of content. Per instruction, #950 was closed (with an explanatory comment)
and an equivalent PR #953 opened from the same branch, which then merged
cleanly after review passed.

**Why it happened:** the review workflow enforces a fixed re-review budget
(3 re-reviews after the initial pass) per PR, independent of whether each
round is finding genuinely new, real issues (as every round here did — this
wasn't repeated cycling on the same finding). A four-round security
discovery process, while a good outcome for the final artifact, exceeded a
cap sized for a smaller number of iterations.

**Fix for future:** when a change touches an inherently exploit-prone surface
— a permission/security DSL, an auth boundary, anything where "safe-looking"
commonly hides a real gap — front-load a broader adversarial self-review
_before_ the first push, rather than relying on the bot's own iterative,
round-capped discovery. Dispatching a `security-reviewer` (or an equivalent
adversarial pass) against the _entire_ candidate rule set, checking flag
behavior and wildcard position for every new entry as this log's item 1
describes, would likely have caught 3 of the 4 rounds' findings in one pass
before the first push, leaving headroom in the review-round budget for
whatever the bot still catches independently.

### 3. The GitHub MCP server's `get_comments` method truncated a bot review comment body mid-sentence

The first fetch of PR #950's comments via `mcp__github__pull_request_read({
method: "get_comments", ... })` returned the round-1 `claude[bot]` review
comment cut off mid-sentence inside the Must-fix section, hiding the bulk of
the actual findings. Recovered by falling back to `gh api
repos/{owner}/{repo}/issues/{n}/comments --jq '.body'`, which returned the
complete text. Every subsequent round fetched review bodies via `gh api`
directly, bypassing the MCP tool for this purpose entirely.

**Why it happened:** unclear from available evidence — the MCP tool's schema
documents no length cap for a comment `body`, and the same content came back
complete via `gh api`, so this looks like a server-side truncation behavior
specific to the `get_comments`/`get_reviews` methods rather than a client-side
issue in how the result was rendered.

**Fix for future:** don't trust `mcp__github__pull_request_read`'s
`get_comments` (or `get_reviews`) for a security-review bot's comment body —
a bot review is exactly the kind of long, structured content most likely to
hit whatever limit caused this. Go straight to `gh api
repos/{owner}/{repo}/issues/{n}/comments --jq '.body'` for `resolving-pr-comments`'
Step 2 instead. _(promoted → .claude/skills/resolving-pr-comments/SKILL.md)_

### 4. A plan-archive doc was momentarily written to the shared checkout instead of the linked worktree

While executing `creating-prs` Step 6 (archive the originating plan), the
first `Write` call for the new archived-plan doc targeted the shared
checkout path (`/home/enri3l/workspaces/monte3l/m3l-automation/docs/plans/
archive/...`) instead of the linked worktree
(`.../m3l-automation-permission-allowlist/docs/plans/archive/...`). Caught
via `git status` on both checkouts before any commit; the stray file was
removed from the shared checkout and rewritten correctly in the worktree.

**Why it happened:** this environment resets the Bash tool's shell `cwd` to
the shared checkout after every command, so all worktree operations in this
session used explicit absolute paths or `-C`/`--dir` flags rather than an
actual `cd`. After several such calls, one `Write` call was issued with a
shared-checkout-relative assumption rather than the worktree's full path.

**Fix for future:** when operating on a linked worktree in an environment
whose shell `cwd` doesn't persist across tool calls, treat every
filesystem-touching tool call (`Write`, `Edit`, bare `Read`, not just `Bash
-C`) as needing the full worktree path explicit and unabbreviated. After any
file-creation step for a file not yet git-tracked, spot-check with `git
status` scoped to the worktree specifically — success from the `Write` tool
alone doesn't confirm which checkout received the file.
_(promoted → .claude/skills/starting-work/SKILL.md)_

## Lessons learned

- **A command's "read-only" reputation is not evidence of safety in a
  flag-unaware permission DSL.** Every one of the four review rounds found a
  specific flag or wildcard-position gap that a base-verb-level read/write
  classification missed entirely. Test the actual flag space, not the verb's
  name.
- **The hub session has no Bash guard-hook backstop.**
  `guard-readonly-bash.mjs` explicitly scopes itself to subagent contexts
  (`agent_type` present in the payload); for the hub, `permissions.allow` is
  the only gate. This materially raises the bar for what's safe to allowlist
  for hub use versus what the same census would clear for a
  `guard-readonly-bash.mjs`-covered subagent.
- **A wildcard's position matters as much as its presence.** A trailing
  wildcard only admits extra content _after_ a complete, safe command; a
  wildcard placed between two literal segments (`pnpm --filter * typecheck*`)
  admits arbitrary injected content _between_ them — a distinct, easy-to-miss
  shape worth checking explicitly on any multi-segment rule.
- **`Read(...)` deny entries don't protect against `Bash`.** They're two
  separate enforcement surfaces; a credential-file `deny` addition is
  incomplete if the same diff also allowlists a generic argument-taking
  read command with no path scoping.
- **`gh api repos/{owner}/{repo}/...*` style GET-only rules stay exploitable
  via an appended `--method`/`-X` flag even without a `--method GET *`
  prefix**, since `gh`'s flag parser accepts flags interspersed anywhere on
  the command line. This was left as an accepted, out-of-scope pre-existing
  gap in this PR (not touched by the diff), but is worth a dedicated future
  look.
- **`mcp__github__pull_request_read`'s `get_comments` truncated a long bot
  review body; `gh api ... --jq '.body'` did not.** Prefer the `gh api`
  fallback for fetching a `claude-pr-review.yml` comment's full text.
  _(promoted → .claude/skills/resolving-pr-comments/SKILL.md)_
- **A review-round cap can be exceeded by a genuinely productive review,
  not just a stuck one.** When a change touches a security-sensitive DSL,
  front-load an adversarial self-review before the first push rather than
  relying on the bot's own capped iteration to find everything.
- **Closing and reopening a PR from the same branch resets the review-round
  counter cleanly.** The new PR picked up the branch's full, already-fixed
  commit history as a single diff; writing an accurate body for the new PR
  (reflecting current state) rather than copying the stale original body
  mattered, since the diff a reviewer sees no longer matches the original
  PR's narrative once several fix commits have landed.
