# Claude PR Review Action tuning for this repo's PR-size profile

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from 35
> official Anthropic sources (`code.claude.com`, `platform.claude.com`,
> `claude.com`, `anthropic.com/engineering`, and `github.com/anthropics/claude-code-action`).
> Synthesized: 2026-07-13. Full source list: see [Sources](#sources) below.

## Why this exists

A 2026-07-13 audit of 121 merged PRs in this repo found: mean 940.7 total
changes / 14.6 changed files per PR, median 424 / 10 (the mean is skewed
upward by large submodule/script-implementation PRs), p90 2,667 / 35, max
observed 5,029 / 71. This snapshot captures what official Anthropic sources
say about tuning `claude-pr-review.yml` (built on
`anthropics/claude-code-action`) for PRs of that size, so the reasoning behind
the resulting workflow/doc changes is traceable later without re-running the
research.

## Consensus / best practices

- **No diff-size threshold is published for `max_turns`, `timeout_minutes`,
  or model tier.** The action's own docs give only general advice ("5–15
  turns for most tasks," "configure appropriate timeouts") [S1, S2, S30, S33].
  The separate, paid Code Review product _does_ scale its internal agent
  fleet by PR complexity (84% of 1,000+-line PRs surface findings vs. 31% of
  <50-line PRs; ~$15–25/review, ~20 min average) but exposes none of that
  scaling logic to the GitHub Action's config surface [S9, S14].
- **`timeout_minutes` moved to job-level GitHub Actions config in the
  action's v1.0**, no longer an action input — set at
  `jobs.<job-id>.timeout-minutes` [S2].
- **Effort-tuning before model-switching is the official lever hierarchy**:
  raise effort within a model tier before downgrading/upgrading models; a
  smaller model at high effort can cost _more_ tokens than a larger model at
  lower effort for equivalent quality [S11, S12]. This repo's
  `docs/contributing/model-selection.md` step 5 ("escalate on evidence: raise
  effort first, then one tier") already follows this.
- **No official model-tier recommendation exists specifically for automated
  PR review** — Sonnet is the de facto default in the action's own examples,
  and general complexity-based routing (Haiku < Sonnet < Opus) is the only
  published principle, not a review-specific decision tree [S1, S10, S13,
  S15].
- **The action truncates diffs at ~150,000 characters** to fit the context
  window [S1]. This repo's max observed PR (5,029 lines / 71 files) could
  plausibly approach that in raw patch-character terms, which is why a
  truncation-risk warning was added to the workflow (see
  `.github/workflows/claude-pr-review.yml`'s metrics step).
- **File exclusion has no `.claudeignore` mechanism** in `claude-code-action`
  — the only documented lever is `.claude/settings.json` (or a job-level
  `settings` input) `permissions.deny` on `Read` [S3, S8]. **This does not
  apply cleanly to this repo's architecture**: `claude-pr-review.yml`
  pre-computes the entire PR diff into one `.claude-pr-diff.patch` file that
  the reviewer reads wholesale via a single `Read` call — a `Read` deny rule
  on a specific path is never consulted, because that path's diff is already
  inlined in the one patch file. The practical fix is stripping the
  low-value hunk (`pnpm-lock.yaml`) out of the patch at generation time
  instead — see the workflow's "Pre-compute PR diff for review" step.
- **Prompt caching does not benefit this workflow's shape.** All caching
  guidance emphasizes multi-turn/repeated-context reuse — a single-shot
  review request pays the 25% cache-write penalty with no follow-up read to
  amortize it against [S18, S19, S20, S23]. Caching is out of scope unless
  the review were restructured into multiple passes over the same diff
  content.
- **Context management for large inputs favors chunked reads and subagent
  isolation over stuffing full content.** This repo's review prompt already
  instructs "read the patch in chunks with `Read` offset/limit" for very
  large diffs [S24, S30] — already aligned with official guidance.
- **Read-only review jobs should scope `allowedTools` narrowly** — the
  action's own PR-review example allows only
  `Bash(gh pr diff/view/comment:*)` plus an inline-comment tool [S4, S5].
  This repo's `Bash,Read` is broader (it reads the pre-computed patch file
  directly rather than shelling out to `gh pr diff` per-turn, which is a
  deliberate turn-budget optimization, not an oversight).

## Contradictions / drift

- **Single-turn caching benefit** — the Prompt Caching blog [S19] lists
  code-review-adjacent use cases among caching's benefits, but the GitHub
  Actions docs [S1] are silent on whether a one-shot PR-review request
  benefits at all. Resolved: it doesn't, per the mechanics (write penalty,
  no read) — S1 is more directly applicable to this workflow's shape than
  S19's general use-case list.
- **Document-position guidance vs. context-sparseness guidance** — Prompting
  best practices [S31] says to place large documents near the top of the
  prompt for up to 30% quality improvement; Effective context engineering
  [S25] says to curate content sparingly rather than stuffing exhaustively.
  Not a real conflict: they optimize different axes (position vs. density) —
  place the diff at/near the top, but don't pad it with unnecessary
  surrounding content.
- **`track_progress` silently widens `allowedTools`** — the Configuration
  Guide's read-only example [S3] conflicts with an open action bug [S6]:
  enabling `track_progress: true` adds write tools (Edit, Write, git
  commands) that override an explicit `--allowedTools` read-only
  restriction. Not applicable here — this workflow does not set
  `track_progress`.

## Coverage gaps

- No published diff-size threshold for switching review strategy (splitting
  into passes, escalating model, sampling instead of full-reading, or
  declining review outright) — confirmed absent across all five research
  facets (action config, model selection, prompt caching, context
  management, cost/timeout).
- No numeric `timeout-minutes` recommendation — only the qualitative "~20
  minutes average" cost-estimation figure from the Code Review product,
  which is a different product than the GitHub Action.
- No PR-review-specific file-exclusion guidance — the general
  `permissions.deny` mechanism exists, but no official example targets a
  review-only job's diff-content exclusion the way this repo needed
  (pre-computed single-patch-file architecture).

## Addendum (2026-08-19) — effort, context stripping, and cache reuse

> **Provenance** — Synthesized via `/researching-anthropic-guidance` from three
> parallel facets (action config, model/effort/caching economics, agentic
> review structure) against 40+ official sources. Synthesized: 2026-08-19.
> Superseding sources are marked `T*` below; the original `S*` list is kept
> unchanged above it for history.

Once the 2026-08-19 CI performance work cut `ci.yml` to 70–170s, the review
bot's ~215s median became the actual merge-latency floor. This addendum
revisits three conclusions from the original pass with what changed since:

- **The "prompt caching does not benefit this workflow's shape" conclusion
  above was reasoned from a single-shot request model.** Measured runs
  actually use 8–28 turns (median ~16) — a real multi-turn conversation, not
  one-shot. Separately, `--exclude-dynamic-system-prompt-sections` did not
  exist in the original pass; it moves per-machine context (cwd, platform,
  shell, OS version) out of the system prompt specifically so a cached prefix
  can be reused **across** machines/runners, not just within one [T5, T6].
  Anthropic's caching docs describe the prefix as otherwise scoped to one
  machine + one directory, meaning a fresh GitHub Actions runner starts cold
  every time [T5] — this flag is the documented mitigation. Revised
  conclusion: caching is still not a large lever for this workflow (each PR's
  runs are typically >1h apart, cold-missing the TTL even with the flag), but
  it is no longer correctly described as "out of scope" — it costs nothing to
  enable and pays off on same-PR re-reviews landing inside the 1h TTL.
- **Effort tuning, not model tuning, is the lever this workflow was missing.**
  Opus 5 (and Sonnet 5) default to `high` effort unless overridden [T4]. The
  cost/intelligence guide's internal measurements found `medium` on
  long-horizon coding work gives up ~2 points of pass rate for roughly half
  the cost [T3]; the Code Review docs separately describe low/medium effort as
  a precision dial — "reports only the findings it's most confident in" [T7]
  — which suits a blocking gate averaging 2.5 re-review rounds per PR. Neither
  fact was in the original pass (the `effort` parameter's Code-Review framing
  didn't exist in the 2026-07-13 source set).
- **`--safe-mode` is the direct answer to the file-exclusion gap this doc
  originally reported.** The original pass concluded there was "no
  PR-review-specific file-exclusion guidance" beyond `permissions.deny` on
  `Read`, which doesn't apply to this workflow's single-pre-computed-patch
  architecture. `--safe-mode` (headless docs, [T8]) sidesteps the problem
  entirely for a different reason: it was never about excluding _diff_
  content, it was about **not loading CLAUDE.md, skills, agent definitions,
  hooks, and MCP servers** that a diff-only review never needed in the first
  place — none of that content is in the patch file to begin with.

### New sources (this addendum)

- T1: Optimizing for cost and intelligence — <https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence> (docs/best-practice)
- T2: Effort — <https://platform.claude.com/docs/en/build-with-claude/effort> (docs)
- T3: Optimizing for cost and intelligence, effort-sweep section (same as T1) — long-horizon coding cost/accuracy tradeoff figures
- T4: Model configuration — <https://code.claude.com/docs/en/model-config> (docs)
- T5: How Claude Code uses prompt caching — <https://code.claude.com/docs/en/prompt-caching> (docs)
- T6: CLI reference (`--exclude-dynamic-system-prompt-sections`) — <https://code.claude.com/docs/en/cli-reference> (docs)
- T7: Code Review — <https://code.claude.com/docs/en/code-review> (docs)
- T8: Run Claude Code programmatically (headless), `--safe-mode` — <https://code.claude.com/docs/en/headless> (docs)
- T9: Manage costs effectively — <https://code.claude.com/docs/en/costs> (docs)
- T10: When to use multi-agent systems (and when not to) — <https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them> (blog)

## Addendum (2026-08-19b) — scoped `--allowedTools` regressed in production

> Written same day as the addendum above, after the first two real PRs
> (#501, #502) ran the new config and both failed the `review` required
> check.

The scoped `--allowedTools` shipped in PR #500
(`Read,Bash(gh pr comment:*),Bash(cat:*),Bash(echo:*),Bash(grep:*),Bash(rg:*),Bash(wc:*)`)
was live for exactly two PRs before both failed. Both runs logged
`permission_denials_count` in the low twenties (20 and 23, against
`--max-turns 35`) — the model was denied on nearly every attempt to run the
prompt's own mandated final step:

```bash
echo -n 'PASS' > "$GITHUB_WORKSPACE/.claude-review-verdict"
```

`Bash(echo:*)` is a command-prefix pattern; it authorizes the `echo`
invocation, not the redirect. Per Claude Code's permissions docs
(<https://code.claude.com/docs/en/permissions#redirections>), a shell
redirect target (`>`, `>>`, `2>`) is checked separately, as a file write,
against `Edit` allow/deny rules — never against the Bash rule that matched
the command itself. Nothing in PR #500's allowlist granted write access to
`.claude-review-verdict`, so every attempt to satisfy the prompt's required
final action was denied, and the model kept retrying rather than giving
up — each retry consumes a turn. PR #502 (17 files, 1,366 changed lines)
ran out of turns entirely (`num_turns: 36` against the cap of 35) after
already posting a complete, correct review comment with a PASS verdict —
the required check still failed, because the wrapper's turn-budget
enforcement is independent of whether a valid verdict was already posted.
PR #501 (22 files, 2,797 changed lines, 387,443-character patch — over the
action's ~150k truncation threshold) finished at `num_turns: 40`, over the
cap, so the action's own post-hoc bounds check (`claude reported a
successful result after 40 turns, exceeding the configured maximum of 35`)
failed the job even though the SDK's own execution completed normally
(`subtype: success`).

The plan's own gate 2 ("does the verdict write survive the scoped
allowlist?") had flagged exactly this risk, with a pre-authorized fallback
to blanket `--allowedTools "Bash,Read"`. A first pass applied that fallback,
but a same-day security review of the fix correctly flagged it as a real
control regression: blanket `Bash` also un-blocks `curl`/`wget`/arbitrary
exec against untrusted PR-diff content, which the scoped list was blocking
independently of the verdict-write bug — a broader rollback than the one
bug required. The permissions docs research above shows the precise fix:
keep the scoped Bash list (still no network egress, no arbitrary exec) and
add one narrow grant, `Edit(./.claude-review-verdict)`, which is what
`Edit` rules are for — the redirect-target check consults `Edit(path)` and
`Read(path)` rules only; a `Write(path)` rule is accepted but silently
never consulted for this check. `--safe-mode` still removed
`guard-readonly-bash.mjs`, so the scoped Bash list plus this one `Edit`
grant are the write barrier now, not a blanket allowance. `--effort
medium`, `--exclude-dynamic-system-prompt-sections`, and `--max-turns 35`
are unchanged; once the permission-denial retry loop is gone, turn counts
should return toward the original 8–28 baseline, leaving headroom under 35
again.

### New source (this addendum)

- T11: Configure permissions, Redirections — <https://code.claude.com/docs/en/permissions#redirections> (docs)

## Addendum (2026-08-19c) — the `Edit` grant didn't match: unexpanded `$GITHUB_WORKSPACE`

> Written after PR #503 (the addendum above's fix) merged, and the very
> next `review` run on PR #502 still failed the same way.

`Edit(./.claude-review-verdict)` landed correctly in the resolved
`--allowedTools` list (confirmed in the run's own `SDK options` log dump),
but the run still logged 19 permission denials, still hit
`error_max_turns` (`num_turns: 36`), and this time posted no review
comment at all — worse than the addendum-b incident, where a comment had
at least gone out before the run failed.

The verdict-write command at the time was:

```bash
echo -n 'PASS' > "$GITHUB_WORKSPACE/.claude-review-verdict"
```

Claude Code's permission matcher checks a Bash redirect's target as
written in the command — it does not resolve shell variables before
matching. The rule `Edit(./.claude-review-verdict)` matches the literal
string `./.claude-review-verdict`; the command's actual target string was
`$GITHUB_WORKSPACE/.claude-review-verdict`, which never matches regardless
of what the variable resolves to at runtime. Nothing in the permissions
docs (T11, addendum b) states this explicitly for environment variables —
it documents `~`-prefixed and glob-containing targets needing approval,
but is silent on plain `$VAR` expansion — so this was inferred from the
denial count being unchanged after the `Edit` grant was added, not
confirmed from a specific line in the docs. Verify against a live run
before relying on this further.

**Fix:** the prompt's mandated final action now writes to the plain
relative path `./.claude-review-verdict` with no shell variable, matching
the `Edit(./.claude-review-verdict)` rule by literal string. The action's
working directory is already the checked-out repo root, so no
`$GITHUB_WORKSPACE` prefix is needed for a Bash-tool-issued command (the
verdict-_read_ step later in the job is a plain `run:` shell step outside
Claude Code's permission system, where `$GITHUB_WORKSPACE` still expands
normally and is unaffected).

No new sources — this is an operational finding pending confirmation on
the next real PR review run.

## Addendum (2026-08-20) — measured: the denial tax, the saturated turn cap, and 37-88% wasted patch

> Written after PR #523 failed the `review` gate three times in one morning
> (runs `32356973634`, `32359063571`, `32363303781` — 7, 8 and 10 denials,
> `error_max_turns` every time, ~$8.15 total, no verdict). Addenda b and c
> above each shipped a fix inferred from an unchanged denial count. This one
> replaces inference with measurement, and confirms addendum c's fix was
> correct but incomplete.

### The denial tax was never eliminated, and it is on every run

Denials on the last ten runs that actually reviewed: 13, 12, 7, 15, 9, 10, 7,
8, 10. Not a tail case — a denial on **every** run, median ~10, i.e. roughly
30% of a 35-turn budget spent on rejected calls.

### The turn cap had no margin left

Turns used on runs that _succeeded_: 20, 24, 28, 31, 32, 34 — up to 97% of
cap. `--max-turns 35` was set from "observed max 28/100" and was already
stale when it shipped. PR #523 did not break a healthy system; it tipped a
saturated one.

### Most of the patch was content the gate declares non-reviewable

`is_ignored()` marks `*.md`, `docs/**` and `.github/dependabot.yml`
non-reviewable, but it only ever decided _whether_ to review — the
pre-compute step filtered exactly one path, `pnpm-lock.yaml`, and handed
every doc hunk over. Total vs. reviewable patch bytes across the 14 PRs
merged before this change:

| Merged PR                                         | Total    | Reviewable | Reviewable share |
| ------------------------------------------------- | -------- | ---------- | ---------------- |
| `24f7dea` semantic priority vocabulary            | 575,724  | 76,817     | 13%              |
| `6c1bd73` pipeline phase trace                    | 257,523  | 142,557    | 55%              |
| `ac1efcd` polling no-progress witness             | 244,035  | 103,691    | 42%              |
| `cb92b81` hub board identity                      | 113,760  | 92,046     | 81%              |
| `6557f91` ADR-0050 stance                         | 98,382   | 28,046     | 29%              |
| `bdc5a50` / `55522bb` / `4db211a` docs programmes | 88k-138k | 4.2k-4.7k  | 3-5%             |

The 581,270-char patch that reviewed successfully in 32 turns was `24f7dea`
— 77KB of it was reviewable. This repo's markdown makes it worse than the
percentages suggest: lines run up to **6,315 chars**, so a 5-line edit to
`docs/implementation-status.md` contributed 61KB of patch and a 192-line edit
to `docs/reference/core/errors.md` contributed 139KB. PR #523's patch was
1,102,980 chars total, 696,940 reviewable — 4.9x the largest reviewable
patch in the table.

### Probe results: what was actually being denied (Claude Code 2.1.237)

Run locally against the real CLI with `--safe-mode`, because the action
hides its transcript and the SDK's denial reporting is undocumented:

| Probe | `allowedTools`                                         | Action                       | Denials | Turns | Conclusion                                                   |
| ----- | ------------------------------------------------------ | ---------------------------- | ------- | ----- | ------------------------------------------------------------ |
| P1    | `Bash(cat:*)`                                          | `cat sample.txt`             | 0       | 2     | colon-prefix syntax IS valid                                 |
| P2    | `Bash(cat:*)`                                          | `head -n 1 sample.txt`       | 0       | 2     | read-only builtins auto-approved when unlisted               |
| P3    | `Bash(echo:*)`, `Edit(./out.txt)`                      | `echo -n x > ./out.txt`      | 0       | 2     | `Edit()` DOES grant a new-file redirect                      |
| P4    | `Bash(echo:*)`, `Write(./out.txt)`                     | same redirect                | 3       | 4     | `Write()` is NOT consulted for redirects                     |
| P5    | `Bash(echo:*)` only                                    | same redirect                | 4       | 5     | no grant -> denial spiral -> `error_max_turns`               |
| P6    | `Read`                                                 | native `Grep` tool           | 0       | 1     | read-only native tools need no grant                         |
| P7    | `Read`                                                 | native `TodoWrite` tool      | 0       | 4     | `TodoWrite` needs no grant                                   |
| P8    | `Bash(cat:*)`, `Bash(grep:*)`                          | `cat f \| grep two`          | 0       | 2     | pipe fine when both granted                                  |
| P9    | `Bash(cat:*)` only                                     | `cat f \| grep two`          | 0       | 2     | read-only builtins fine inside a pipe too                    |
| P10   | `Bash(cat:*)`, `Bash(echo:*)`, `Bash(gh pr comment:*)` | heredoc a 2-line `body.md`   | **3**   | 4     | **no writable scratch path -> denial spiral**                |
| P11   | + `Edit(./body2.md)`                                   | same heredoc                 | 0       | 2     | one grant removes it entirely                                |
| P12   | `Bash(gh pr comment:*)`                                | `gh pr diff 523 --name-only` | **1**   | 2     | **`gh pr diff` denied — but the prompt told it to run that** |

This settles the questions addenda b and c had to guess at. Addendum c's fix
was right: `Edit()` on a plain relative path does grant a redirect (P3), and
`Write()` genuinely is never consulted (P4). What it missed is that the
verdict file was not the only write the reviewer needs. A multi-line markdown
comment is naturally posted with `gh pr comment --body-file`, which requires
writing the body to disk first — and no path was writable for it, so a
_two-line_ heredoc cost 3 denials over 4 turns (P10). Separately, the prompt
instructed a `gh pr diff` fallback that the allowlist forbade (P12).

Also confirmed: denials consume turns and provoke retries (P5, P10), so the
tax compounds. And several things previously suspected are simply not
problems — `Bash(head:*)`/`Bash(tail:*)` grants are unnecessary (P2, P9), and
`Grep`/`Glob`/`TodoWrite` need no grants (P6, P7).

### A separate latent bug: the prior-PASS skip had never fired

The guard step's comment fetch was written as:

```bash
gh api ... --paginate --slurp --jq '...' 2>/dev/null || true
```

`gh` rejects `--slurp` combined with `--jq` outright ("the `--slurp` option is
not supported with `--jq` or `--template`", gh 2.97.0). The error went to
`/dev/null`, `|| true` swallowed the exit code, and `body` was
unconditionally empty — so the step always fell through to "No prior
claude[bot] comment — running review" and the prior-PASS skip optimisation
never once fired. It failed safe (over-reviewing, never under-reviewing),
which is why it survived unnoticed. Fixed by piping to `jq` instead of using
`--jq`.

### Fixes applied

- the pre-computed patch and changed-file list are now filtered by the same
  predicate as `is_ignored()`, with a `(diff omitted — …)` marker per file
- reviewable diffs over `MAX_REVIEWABLE_BYTES` (300,000) get a deterministic
  `FAIL` plus a comment naming the largest contributors, with Claude never
  starting — 2.1x the largest reviewable patch above, rejecting 0 of 14
- the verdict falls back to the posted comment when the file is missing, but
  only on a `claude-review-sha` match against the head commit
- `Enforce review verdict` runs under `!cancelled()` so it is no longer
  skipped exactly when the action fails
- added `Edit(./.claude-review-comment.md)` and `Bash(gh pr diff:*)`; the
  prompt now enumerates the permitted tools
- `MAX_TURNS` (60) is a single job-level env shared by `claude_args` and the
  metrics step; the near-cap warning is 90% of it rather than a hardcoded 33
- the metrics step reports _which_ tools were denied, from the result
  entry's `permission_denials` array (confirmed present by probe)

Sourcing note: P1-P12 are local observations of Claude Code 2.1.237, not
documentation. The action pinned in the workflow installs 2.1.233. Re-probe
before relying on them across a major CLI bump.

## Sources

- S1: Claude Code GitHub Actions docs — <https://code.claude.com/docs/en/github-actions> (docs)
- S2: Migration Guide — <https://github.com/anthropics/claude-code-action/blob/main/docs/migration-guide.md> (guide)
- S3: Configuration Guide — <https://github.com/anthropics/claude-code-action/blob/main/docs/configuration.md> (guide)
- S4: Usage Guide — <https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md> (guide)
- S5: PR Review Example — <https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml> (guide)
- S6: GitHub Issues — track_progress vs allowedTools — <https://github.com/anthropics/claude-code-action/issues/860> / #533 (issue)
- S7: GitHub Issues — sticky comment limitations — <https://github.com/anthropics/claude-code-action/issues/419> / #705 / #1108 / #1052 (issue)
- S8: Claude Code Settings Docs — <https://code.claude.com/docs/en/settings> (docs)
- S9: Code Review Blog Post — <https://claude.com/blog/code-review> (blog)
- S10: Platform Docs — Choosing the Right Model — <https://platform.claude.com/docs/en/about-claude/models/choosing-a-model> (docs)
- S11: Platform Docs — Effort Parameter — <https://platform.claude.com/docs/en/build-with-claude/effort> (docs)
- S12: Claude Code Blog — Model & Effort in Claude Code — <https://claude.com/blog/claude-model-and-effort-level-in-claude-code> (blog)
- S13: Claude by Anthropic — Choosing the Right Claude Model — <https://claude.com/resources/tutorials/choosing-the-right-claude-model> (guide)
- S14: Code Review Docs — <https://code.claude.com/docs/en/code-review> (docs)
- S15: Anthropic Research — Building Effective Agents — <https://www.anthropic.com/research/building-effective-agents> (whitepaper)
- S16: Claude Blog — Building Multi-Agent Systems — <https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them> (blog)
- S17: Claude Code — Subagents — <https://claude.com/blog/subagents-in-claude-code> (blog)
- S18: Platform Docs — Prompt Caching Guide — <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> (docs)
- S19: Blog — Prompt Caching with Claude — <https://claude.com/blog/prompt-caching> (blog)
- S20: Claude Cookbook — Prompt Caching — <https://platform.claude.com/cookbook/misc-prompt-caching> (best-practice)
- S21: Docs — Tool Use with Prompt Caching — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching> (docs)
- S22: Docs — Cache Diagnostics — <https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics> (docs)
- S23: Blog — Token-Saving Updates — <https://claude.com/blog/token-saving-updates> (blog)
- S24: Effective harnesses for long-running agents — <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> (blog)
- S25: Effective context engineering for AI agents — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> (blog)
- S26: Using Claude Code: session management and 1M context — <https://claude.com/blog/using-claude-code-session-management-and-1m-context> (blog)
- S27: Managing context on Claude Developer Platform — <https://claude.com/blog/context-management> (blog)
- S28: Context editing documentation — <https://platform.claude.com/docs/en/build-with-claude/context-editing> (docs)
- S29: Compaction documentation — <https://platform.claude.com/docs/en/build-with-claude/compaction> (docs)
- S30: Best practices for Claude Code — <https://code.claude.com/docs/en/best-practices> (guide)
- S31: Prompting best practices (long context) — <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices> (docs)
- S32: Context windows documentation — <https://platform.claude.com/docs/en/build-with-claude/context-windows> (docs)
- S33: Large Codebases & Monorepo Configuration — <https://code.claude.com/docs/en/large-codebases> (docs)
- S34: Claude Code in Large Codebases Blog — <https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start> (blog)
- S35: Platform Docs — Task Budgets — <https://platform.claude.com/docs/en/build-with-claude/task-budgets> (docs)
