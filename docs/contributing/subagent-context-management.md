# Subagent context management: preventing and recovering from mid-turn truncation

Why a dedicated doc: an audit of `docs/logs/*.md` (2026-07-13) found subagent
mid-turn truncation is **the single most-recurring divergence** in this repo's
build history — a spoke hits its `maxTurns: 40` budget or an output-token limit
**mid-thought**, returning a fragment (`"Now the config module —"`) instead of a
completion report, in **20+ logged occurrences** across 16+ work logs, one
session recurring **5+ times**
(`docs/logs/2026-07-13-dynamo-crud.md`). This doc is the canonical playbook:
what causes it, how to prevent it, and how to recover — grounded in this
project's own incident history plus official Anthropic guidance. The
`.claude/rules/subagent-dispatch.md` extract is the terse version consulted
mid-task; this doc is the reference when you need the full reasoning or the
citations.

## The failure pattern

A **writer spoke** (`test-author` in RED, `code-implementer` in GREEN) is
dispatched against a large multi-file module or script. It spends its turn
budget on up-front exploration and planning, then hits the turn/token limit
before finishing — sometimes before writing anything at all. The worst logged
case, `docs/logs/2026-07-11-scripts-json-etl.md` §1, had `test-author` burn its
**entire** 150k-token budget across 55 tool calls and write **zero files**,
returning a truncated `"Now the config module —"`. Representative occurrences:

| Log                                                                        | What happened                                                                                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-07-01-core-json.md` §5                                               | Implementer truncated mid-thought; hid an incomplete barrel re-export                                                                                                   |
| `2026-07-01-core-analysis.md` §2                                           | GREEN implementer truncated twice mid-sentence during type-error rework                                                                                                 |
| `2026-07-02-core-config.md` §2                                             | GREEN implementer truncated **four times** — "a single module spanning 20 files exceeds one turn's budget"                                                              |
| `2026-07-02-core-polling.md` §1                                            | Implementer truncated twice; neither report reflected true state                                                                                                        |
| `2026-07-02-core-storage.md` / `-text.md` / `-messaging.md` / `-prompt.md` | Same pattern across RED and GREEN; `core-text.md` §1: "a truncated return is the norm here, not the exception"                                                          |
| `2026-07-03-core-exporters.md` §6                                          | Truncated **three times**; hid an un-done re-export and doc edit                                                                                                        |
| `2026-07-03-core-files.md` §7                                              | Repeated truncation; coined "treat any truncated spoke return as 'state unknown'"                                                                                       |
| `2026-07-03-core-importers.md` §1 / `-logging.md` §2                       | Truncated twice / "more than once"                                                                                                                                      |
| `2026-07-03-core-script.md` §2                                             | Truncated **5+ times** in one submodule                                                                                                                                 |
| `2026-07-09-script-pipeline.md`                                            | Both a **reviewer** and `test-author` hit turn limits mid-report                                                                                                        |
| `2026-07-11-scripts-json-etl.md` §1                                        | Worst case — zero files written, entire budget spent exploring                                                                                                          |
| `2026-07-11-core-script-preset-seam.md` §1                                 | `test-author` burned ~105k tokens/42 tool calls writing only two import lines; **the hub had not handed it a journal path**, so the truncated run left no durable trace |
| `2026-07-13-scripts-logs-insights.md` §8                                   | Two resumptions needed; a near-miss where the hub almost resumed via a fresh `Agent` call instead of `SendMessage`, which would have lost all prior context             |
| `2026-07-13-dynamo-crud.md` §1                                             | Truncated twice; lessons section: "recurred at least 5 times across this session's dispatches"                                                                          |
| `2026-07-13-sqs-etl.md` §5                                                 | Truncated three times across `test-author` and `code-implementer`                                                                                                       |

## Detecting truncation

Per the Claude API/Agent SDK reference (`platform.claude.com/docs/en/build-with-claude/handling-stop-reasons`,
`code.claude.com/docs/en/agent-sdk/agent-loop`):

- A response cut off at the **output-token cap** carries `stop_reason: "max_tokens"`.
- A subagent that exhausts its **turn/loop budget** (`maxTurns`) returns an SDK
  `ResultMessage` with `subtype: "error_max_turns"` — critically, the `result`
  (final text) field is **absent** on this subtype. Never read a spoke's
  narrated "final" text as authoritative without first checking whether it
  actually completed; a mid-thought fragment is the signature of exactly this
  case. A budget-capped dispatch (`maxBudgetUsd`) exhausts the same way with
  `subtype: "error_max_budget_usd"`.
- **As of Claude Code v2.1.199**, a foreground subagent that already produced
  some text before truncating returns that **partial output plus an explicit
  "didn't finish" note**, rather than a bare fragment — a stronger signal than
  the older mid-thought-guess heuristic when it's present. A subagent that
  produced nothing before truncating instead fails outright ("Agent terminated
  early due to an API error"). A subagent that never gets a result at all
  (a connection/process failure) is a **third, distinct** stall shape — no
  `ResultMessage` is emitted, so there's nothing to read `stop_reason` from.
- **A `SubagentStop` hook (`.claude/hooks/detect-spoke-truncation.mjs`) is now
  wired**, closing the "nothing inspects a spoke's output" gap: it runs a
  prose heuristic over the finished spoke's last message (empty, a trailing
  ellipsis, or an unclosed "let me"/"now"/"next" phrase) and prints a
  stderr reminder to verify before trusting the report. It is advisory
  only and a heuristic over text, not a parse of `stop_reason`/`subtype` (the
  hook payload doesn't expose those) — treat its absence of a warning as "no
  signal," not as proof the report is trustworthy.
- Recovery for a turn-limit exhaustion: resume the session (capture and reuse
  its ID / call `SendMessage` to the **same** spoke) rather than starting a
  fresh agent — a fresh dispatch has no memory of the prior exploration and
  restarts the whole budget from zero (the near-miss in
  `2026-07-13-scripts-logs-insights.md` §8).

## Prevent: decompose before you dispatch

Anthropic's primary lever for avoiding this is **not** journaling — it's
**scoping the dispatch to the task's complexity** before the first tool call.
From `anthropic.com/engineering/multi-agent-research-system`: "Simple
fact-finding requires just 1 agent with 3-10 tool calls... complex research
might use more than 10 subagents" — effort should scale with decomposition, not
with a bigger budget on one dispatch. Concretely in this repo:
`implementing-submodules` and `implementing-scripts` size the writer dispatch up
front (split GREEN into bounded sub-tasks when a module/script spans many
files) instead of handing one spoke an indivisible, oversized turn. A
deterministic backstop, `.claude/hooks/guard-writer-dispatch-journal.mjs`, warns
when a writer-spoke dispatch omits a journal path — closing the exact gap
`2026-07-11-core-script-preset-seam.md` hit.

## Prevent: durable external memory (the journal pattern)

The writer spokes' "Journal as you go (survive a turn limit)" section
(`.claude/agents/test-author.md`, `.claude/agents/code-implementer.md`) is a
direct instance of Anthropic's endorsed external-memory pattern, not a
repo-local workaround:

- **Structured note-taking**: "Structured note-taking allows the agent to
  track progress across complex tasks"
  (`anthropic.com/engineering/effective-context-engineering-for-ai-agents`).
- **Progress files for resumption**: a `claude-progress.txt` "keeps a log of
  what agents have done," and agents "get their bearings by reading progress
  files and git logs before resuming"
  (`anthropic.com/engineering/effective-harnesses-for-long-running-agents`).

Three refinements keep the pattern aligned with that guidance rather than
substituting for it:

1. **Decompose first, journal second.** The journal is a safety net for a turn
   that ran long despite being reasonably scoped — it is not license to hand
   one spoke an oversized turn on the assumption a journal will make truncation
   free. See "Prevent: decompose before you dispatch" above.
2. **Keep the cadence coarse.** Each journal append is a tool round-trip
   against `maxTurns: 40`. Writing to a file (not the context window) avoids
   context rot, but over-journaling spends the very budget it protects — the
   spoke prompts deliberately say "before each _major_ step, 1–2 lines," and
   also reserve enough budget to write the journal's final line before the
   limit rather than mid-sentence.
3. **A resumed spoke re-reads its own journal first**, matching "get their
   bearings by reading progress files... before resuming" — cheaper than the
   hub re-deriving state and re-narrating it into the resume prompt.

Review spokes (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`,
`type-design-analyzer`, `spec-conformance-reviewer`, `docs-consistency-reviewer`)
are read-only and produce no on-disk work product to resume, so they don't
carry this journal pattern.
Their mitigation is different — see the next section.

## Recover: automate the manual first step

The manual recovery routine above — re-read the spoke's journal, verify
on-disk state with `git status`/`git diff`, optionally re-run the targeted
tests, then decide resume-vs-redispatch — was, until ADR-0030 Phase 6, done
entirely by hand each time. `bin/spoke-recovery.mjs` (also exposed as the
`mcp__m3l__spoke_recover` tool) automates exactly that deterministic first
step: it parses the journal's progress markers, cross-references `--expected`
paths against `git status --porcelain`, optionally runs a targeted vitest
pattern (CLI-only — the MCP tool omits this so it stays read-only and fast),
and emits a `resume` / `redispatch` / `none` / `unverifiable` recommendation
with a punch-list. Run it (or call the tool) right after a writer-spoke
truncates or reports something ambiguous, then apply the hub's own judgment
on top — it feeds the decision above, it does not replace it. Its
outstanding-item heuristic assumes one journal tracks one linear
workstream (the dispatch convention — one spoke, one scoped task, one
journal); a journal that interleaves two parallel workstreams can let a
later "done" entry for one retroactively mask an earlier still-open item
for the other, so don't hand a single spoke a journal spanning multiple
independent workstreams if you need that heuristic to stay trustworthy.

## Prevent: bounded output (the digest pattern)

Anthropic: subagents should act as "intelligent filters," returning "a
condensed, distilled summary of its work (often 1,000-2,000 tokens)" rather
than raw content, so "the detailed search context remains isolated within
sub-agents, while the lead agent focuses on synthesizing"
(`anthropic.com/engineering/effective-context-engineering-for-ai-agents`,
`multi-agent-research-system`). This repo's `researching-anthropic-guidance`
skill already implements this: each Explore agent writes full findings to a
scratchpad file and returns only a compact digest to the hub. Two extensions
close the remaining gaps:

- **Review spokes** now carry a bounded return contract — the existing
  Must-fix/Should-fix/Nits shape stays, but long detail spills to a scratchpad
  file with only the capped digest returned inline, so a large findings report
  can't itself exhaust the reviewer's own turn budget mid-report (the
  `2026-07-09-script-pipeline.md` reviewer-truncation case).
- **`auditing`** now mirrors `researching-anthropic-guidance`'s scratchpad +
  digest shape for its Explore fan-out, instead of returning full findings
  inline.

## Efficacy watch (as of 2026-07-22)

Honest status of the two mitigation layers: **recovery works, prevention is
unproven.** After the 2026-07-14 hardening wave (this doc, the
`subagent-dispatch.md` extract, journal refinements), 7 writer-spoke
truncations still occurred on 2026-07-17
(`docs/logs/2026-07-17-adr-0030-workflow-tooling-mcp.md` — all recovered
losslessly via journals, zero lost work) and 3 review spokes stalled 60+
minutes on 2026-07-18 (`2026-07-18-aws-athena.md`,
`2026-07-18-aws-eventbridge.md`, `2026-07-18-aws-s3.md`). The 2026-07-19
second wave (the `SubagentStop` detector + the review-scope-binding rule in
`subagent-dispatch.md`) has **no efficacy evidence yet** — the log history
ends too soon after it landed. To give the next audit hard data, every work
log now records a **`Spoke incidents:`** line (see
`.claude/skills/writing-work-logs/SKILL.md`, Step 2 → Summary) — judge this
section against those counts, and update it when the evidence lands either
way.

## A note on model tier and context window

Context/output limits differ meaningfully by tier (see
`docs/contributing/model-selection.md` for the full note and citations):
Haiku 4.5 runs the smallest window (200k context / 64k output) of the tiers
this repo uses; Opus and Sonnet run 1M/128k. A spoke pinned to a narrower tier
has less room before either limit bites — one more reason `Explore` (Haiku)
stays scoped to excerpting rather than reading exhaustively, per its own
prompt.

**Context rot**: more context is not automatically better. Anthropic: "as
token count grows, accuracy and recall degrade, a phenomenon known as context
rot" — curate the smallest high-signal set rather than defaulting to a larger
window as the fix for truncation.

## Sources

- Anthropic, ["How we built our multi-agent research
  system"](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic, ["Effective context engineering for AI
  agents"](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic, ["Effective harnesses for long-running
  agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Claude Docs, ["Stop reasons and
  fallback"](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- Claude Docs, ["Context
  windows"](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- Claude Agent SDK, ["How the agent loop
  works"](https://code.claude.com/docs/en/agent-sdk/agent-loop#handle-the-result)
