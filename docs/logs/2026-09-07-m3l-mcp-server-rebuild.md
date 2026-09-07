# Work log — m3l MCP server rebuild (2026-09-07)

This log covers the second half of a 4-PR wave (ADR-0096) that rebuilt the
in-repo `m3l` MCP server from scratch after an `/auditing` pass found it
configured, reachable, and never once invoked. It picks up from PR2 already
merged and covers PR3 (the governance gate) and PR4 (discoverability wiring)
through to the wave's completion — what shipped, what matched the plan, what
diverged, and the durable lessons.

Plan of record: [`the-in-project-m3l-mcp-fizzy-wirth.md`](~/.claude/plans/the-in-project-m3l-mcp-fizzy-wirth.md) (session-local plan file, not committed to the repo)

## Summary

**The audit finding (context for the whole wave):** a parse of every
`tool_use` block across 249 session transcripts found zero calls to any
`mcp__m3l__*` tool, while the Bash-CLI equivalents of the same 7 tools ran
~1,425 times. Root cause was discoverability, not mechanics — no skill or
rule anywhere named an m3l tool, no subagent could hold an MCP grant for it,
the permission allowlist covered only 3 of 7 tools, and server enablement
lived only in a gitignored `.claude/settings.local.json`. Real correctness
defects existed too (a `cwd`-pinning bug after a mid-session
`EnterWorktree`, no cancellation, head-of-line blocking, discarded child
stderr, no output-size discipline) — all consequences of the original
design shelling out via `execFileSync` for every tool.

**PR1** (`#1080`, merged before this log's session began): ADR-0096 superseded
ADR-0030 item 3, recording the audit evidence and the decision to replace the
7-tool CLI-wrapper design with a 6-tool read-only query surface.

**PR2** (`#1085`, merged before this log's session began): rebuilt the server
— `adr_query`, `logs_query`, `commands_query`, `hooks_query` new;
`catalog_query`/`commit_lint` kept. MCP `roots`-based `cwd` resolution
(`resolveRepoRoot`), `outputSchema`/`structuredContent` on every tool, a
server `instructions` string. Two independent review passes
(`silent-failure-hunter`, `code-reviewer`) plus a fixup round that caught a
real NUL-byte defect in `bin/lib/mcp-tools.mjs` via `pnpm
check:control-chars` — neither review spoke caught it; the repo's own gate
did.

**PR3** (`#1102`): added `bin/check-mcp.mjs` (`check:mcp`) — reconciles
`.mcp.json`, the registered `TOOLS` array, and `.claude/settings.json`'s
allowlist 1:1 in both directions, plus a real, unmocked protocol-level test
(`bin/tests/mcp-server.e2e.test.ts`) spawning the actual server and talking
real MCP over stdio. The gate's first live run caught genuine drift:
`.claude/settings.json` still allowlisted the dropped `repo_verify` tool and
was missing four of the six current tools. A CI review round
(`claude-pr-review.yml`) found and fixed 3 further Should-fix findings: a
non-string `permissions.allow` entry could crash the gate instead of being
reported, every gate error was misattributed to `.mcp.json` regardless of
which file it actually concerned, and the e2e test over-coupled to
ADR-0030's exact status string. 82→120 `bin/tests/**` assertions across the
PR, all mutation-tested.

**PR4** (`#1109`, the wave's final slice): wired up discoverability — a
third `m3l` descriptor (ADR-0096) in `bin/lib/integration-stance.mjs`
alongside GitHub/context7, genuinely-justified `mcp__m3l__*` usage added to
three skills whose actual procedures fit a targeted lookup
(`syncing-docs`, `promoting-work-log-lessons`, `triaging-ci`), a scoped
`mcp__m3l__*` grant for the `audit-refuter` spoke (the one spoke whose brief
— verifying a claim by checking whether something exists "under other
names, paths, or conventions" — is a direct fit; every other spoke's brief
was checked and found not to touch these corpora), removal of 6 dangling
`mcp__m3l__spoke_recover` mentions (a tool retired in PR2; 2 of the 6 found
by this session's own grep beyond the 2 the original plan named), and
`enabledMcpjsonServers` moved from the gitignored `.claude/settings.local.json`
into the committed `.claude/settings.json`. A CI review round caught one
vacuous live-fixture test (asserted the gate reported no issues without
first proving the gate's trigger condition had actually fired) —
mutation-tested and fixed.

`pnpm verify` passed clean on every PR (67 passed / 10 skipped, none
failing). All four PRs squash-merged.

**Skills used:** `finishing-work`, `syncing-docs`, `creating-prs`,
`writing-work-logs` (this log).

**Spoke incidents:** 3 truncations / 0 stalls / 2 resumes — `test-author`
hit its 40-turn limit twice during PR3 (once on the initial dispatch, once
on its continuation), and `docs-consistency-reviewer` hit it once during
PR3's pre-push review. Two of the three were correctly resumed via
`SendMessage`; the first `test-author` truncation was NOT resumed — see
divergence #1 below.

**Compaction events:** 1 compaction / 1 recovered via handoff — the visible
session began from a compaction summary that correctly preserved the PR1/PR2
status, the plan reference, and the in-flight PR3 push check. A separate,
distinct incident (a mid-PR4 process restart, not a `/compact`) is recorded
as divergence #3 below.

## What went as planned

- **The audit's own root-cause finding held up end to end.** Every fix in
  PR3/PR4 mapped directly to a gap the audit named — the governance gate
  (PR3) for "no `check:*`/smoke-start/`tools/list` assertion", the
  discoverability wiring (PR4) for "no skill/rule names an m3l tool" and "no
  spoke can hold an MCP grant". Nothing in the plan needed re-derivation once
  execution started.
- **Both new gates (`check:mcp`, the `m3l` integration-stance descriptor)
  caught real, pre-existing drift on their first live run** — the settings.json
  allowlist gap in PR3, confirming `harness-artifacts.md`'s "run a new
  `check:*` gate live before writing its test suite" rule earns its keep
  every time it's followed.
- **Both PR3 and PR4 survived a real git race** (another PR merging to `main`
  between the rebase-before-push and the push landing) without any content
  loss — `docs/adr/provenance.json` conflicted both times (not covered by the
  `merge=m3l-generated` driver), resolved identically both times via
  `git checkout --theirs` + `pnpm sync:docs` regeneration, never a hand-merge.
- **Every CI review round's Should-fix findings were genuinely correct** and
  cheap to fix in place (a missing `typeof` guard, a misattributed error
  location, an over-coupled assertion, a vacuous live-fixture check) — none
  needed disputing, and each fix shipped with its own
  `Acknowledged-Should-Fix:` commit footer per this repo's convention.
- **`test-author` dispatches for PR4 (unlike PR3) completed without hitting
  the turn limit** — the PR4 test tasks were more tightly scoped (two small,
  well-specified additions to existing test files rather than three new
  test files plus mutation-testing from scratch), suggesting the smaller
  the diff-shaped ask, the less likely a 40-turn ceiling bites.

## What didn't go as planned, and why

### 1. A `SendMessage` resume was accidentally replaced with a fresh `Agent` dispatch

During PR3, the first `test-author` dispatch hit its 40-turn limit mid-task.
The correct recovery (per `.claude/rules/subagent-dispatch.md`) was to
`SendMessage` that same agent to resume it from its own transcript. Instead,
a second `Agent` call was made with a fresh `subagent_type: "test-author"` —
a brand-new agent with no memory of the first one's progress, briefed only
via a prompt that assumed continuity it didn't have. The mistake was caught
immediately (before the fresh agent did any real work) by re-reading
`SendMessage`'s own tool description, and — since a stray no-op `Agent`
dispatch was also mistakenly created while correcting course — a `TaskStop`
was issued for it. The originally-truncated agent was never resumed; its
partial progress was abandoned, but the fresh agent's full self-contained
brief (exact file paths, exact functions, exact SDK import paths) let it
complete the same work correctly on its own, so no work was actually lost —
only the resume mechanism's cheaper continuation path was.

**Why it happened:** `Agent` and `SendMessage` are easy to reach for
interchangeably in the moment — both "continue this agent's work" — but only
`SendMessage` targets an existing agent's transcript; `Agent` always starts
fresh regardless of `subagent_type` matching a prior dispatch.

**Fix for future:** Before dispatching any follow-up to a spoke that just
truncated, explicitly check whether the intent is "resume the same agent"
(→ `SendMessage` with its agent id/name) or "start unrelated new work"
(→ `Agent`) — the two tools are never interchangeable for the same
in-flight task, and the check costs one extra second against an entire
wasted dispatch.

### 2. Two accidental `Agent` calls where `SendMessage` should have followed a stray tool result

Separately from #1, this session twice called `Agent` with a placeholder/no-op
prompt purely as a workaround attempt to reach the `SendMessage` tool schema
via `ToolSearch` first — once producing a genuinely wasted no-op agent
dispatch (immediately `TaskStop`'d, cost: one fast no-op agent run). This
compounds with #1: both mistakes share the same root cause of reaching for
`Agent` under time pressure instead of pausing to load the exact tool needed.

**Why it happened:** `SendMessage` is a deferred tool that must be loaded via
`ToolSearch` before its first use in a session; under the immediate pressure
of "I need to resume this agent right now," the faster-seeming (but wrong)
`Agent` tool was reached for instead of taking the one extra `ToolSearch`
round-trip.

**Fix for future:** Load `SendMessage`'s schema via `ToolSearch` proactively
at the start of any task expected to involve multi-turn spoke dispatch,
rather than discovering the need for it reactively mid-truncation-recovery
under pressure to act fast.

### 3. A mid-session process restart dropped every backgrounded task's tracking

Partway through PR4 (during the second rebase-and-push cycle), the Claude
Code process itself restarted — not a `/compact`, a full session
restart/relaunch. Every backgrounded shell command this session had started
(gate re-runs, `git push`, `Monitor` watches) lost its completion record; a
system notification reported five orphaned tasks as "stopped," and CLAUDE.md
plus the session's `userEmail`/`gitStatus` context were all re-read fresh, as
happens at session start. Recovery required treating every piece of tracked
state as unverified and re-deriving it directly: `git status`, `git log`,
`gh pr view` against the live remote, rather than trusting any prior
notification or Monitor state. Nothing was actually lost on disk — the local
rebase, the commits, and the working tree all survived intact — but the
in-flight verification (an already-passing gate run, an already-running
`Monitor`) had to be redone from scratch.

**Why it happened:** A background shell command or `Monitor` watch is
tracked only by the running Claude Code process; a process restart has no
mechanism to hand that tracking off to the new process, even though the
underlying work (a `git push`, a completed test run) may have already
finished successfully on the host.

**Fix for future:** After any signal that a restart occurred (an orphaned-task
notification, re-read instruction files, a fresh `userEmail`/`gitStatus`
block), re-verify ground truth directly before continuing — `git log`,
`git status`, `gh pr view --json ...` — rather than assuming a
previously-reported "still running" or "completed" state still holds. This
matches `creating-prs`' own Step 9 guidance for a push specifically; the
lesson generalizes to every backgrounded command, not just pushes.

## Lessons learned

- **A gate's first live run against a real repo is worth more than its whole
  synthetic test suite for finding actual drift.** `check:mcp` and the `m3l`
  integration-stance descriptor both caught genuine pre-existing gaps
  (a stale allowlist, in the settings.json case) the moment they were run
  live — neither gap was hypothetical or manufactured to give the gate
  something to catch.
- **A CI review's Should-fix findings on a freshly-written gate are usually
  real, not noise.** Across PR3 and PR4, every single Should-fix finding
  from `claude-pr-review.yml` was a genuine defect (a crash path, a
  misattribution, an over-coupled assertion, a vacuous test) worth fixing in
  a follow-up commit with an `Acknowledged-Should-Fix:` footer — none needed
  disputing.
- **`SendMessage` vs `Agent` needs a conscious check before every spoke
  follow-up, not just at first dispatch.** Two separate near-misses this
  session (divergences #1 and #2) came from reaching for `Agent` when
  `SendMessage` was the correct tool for continuing an in-flight agent —
  worth a deliberate pause any time a spoke has already been dispatched once
  in the conversation.
- **Grant an MCP tool to a spoke only after checking its actual documented
  brief against the tool's purpose, never by pattern-matching on "this spoke
  seems related."** Only `audit-refuter` (of ten spokes) was granted m3l
  tools in PR4, after reading every other spoke's brief and confirming none
  of them touch ADR/hooks/logs/command corpora as part of their core job —
  this kept the grant narrow and evidence-driven rather than blanket.
- **A "wire up discoverability" task doesn't mean mechanically forcing tool
  usage into every site an audit named.** PR4 deliberately left
  `promoting-work-log-lessons`' full `docs/logs/` scan untouched — that read
  is intentionally exhaustive by design (recurrence detection needs
  completeness, not a targeted query), not a discoverability gap. Distinguish
  "nobody knew this shortcut existed" from "the full read is the point"
  before adding a tool call.
- **Re-verify ground truth directly after any restart signal, never trust a
  background-task tracker across one.** _(see divergence #3 above)_
