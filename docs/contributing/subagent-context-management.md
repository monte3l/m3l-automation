# Context management: the hub session and its subagents

Why a dedicated doc: an audit of `docs/logs/*.md` (2026-07-13) found subagent
mid-turn truncation is **the single most-recurring divergence** in this repo's
build history — a spoke hits its `maxTurns: 40` budget or an output-token limit
**mid-thought**, returning a fragment (`"Now the config module —"`) instead of a
completion report, in **20+ logged occurrences** across 16+ work logs, one
session recurring **5+ times**
(`docs/logs/2026-07-13-dynamo-crud.md`). Part 2 of this doc is the canonical
playbook for that failure: what causes it, how to prevent it, and how to
recover — grounded in this project's own incident history plus official
Anthropic guidance. The `.claude/rules/subagent-dispatch.md` extract is the
terse version consulted mid-task; this doc is the reference when you need the
full reasoning or the citations.

A 2026-08-27 audit (`/auditing`) found the hub **session itself** — as opposed
to the spokes it dispatches — had none of this doctrine: no compaction
strategy, no durable-artifact handoff, and an always-loaded-budget gate that
measured only 37% of what it governed (see ADR-0078). Part 1 below closes that
gap. The filename stays as-is even though it now covers both halves — see
ADR-0078's Considered Options for why a rename was rejected (31 referencing
files, 20 of them immutable historical records).

## Part 1 — The hub session

**Rollout note:** ADR-0078 is implemented across a six-PR sequence. PRs 1-4
have landed: the policy is recorded, `bin/check-context-budget.mjs` replaced
`bin/check-claude-md-budget.mjs` as the live gate (CI + pre-push),
`CLAUDE.md`'s always-loaded surface fits under budget with zero `@`-imports,
and the `PreCompact`/`SessionStart(compact|resume|startup)` handoff hooks
described below are live.

### What survives compaction

Per `code.claude.com/docs/en/context-window` and
`code.claude.com/docs/en/how-claude-code-works`: Claude Code clears older tool
outputs first, then summarizes the conversation if that alone doesn't free
enough space. On the automatic pass, the project-root `CLAUDE.md`, unscoped
`.claude/rules/*.md`, auto memory (`MEMORY.md`), and the plan-mode plan are
re-injected from disk; up to five most-recently-modified read/edited files are
re-read (over 5,000 tokens, a file returns as a path reference only); invoked
skill _bodies_ re-inject capped at 5,000 tokens/skill and 25,000 total, oldest
dropped first; the skill _listing_ is not re-injected; `paths:`-scoped rules
and nested `CLAUDE.md` reload only when a matching file is next read; and
`SessionStart` hooks matching source `compact` re-run (as of the 2026-09-02
ADR-0078 update below, the compact-handoff hook also re-runs on `resume` and
`startup`, outside a compaction pass proper). Early, conversation-only
instructions that never made it into `CLAUDE.md` can be lost — promote a rule
you need to survive compaction into `CLAUDE.md`, not just the conversation.

### `/clear` vs. `/compact` vs. `/rewind`

| Situation                                                    | Action                                            |
| ------------------------------------------------------------ | ------------------------------------------------- |
| Same task, context still coherent                            | Keep going                                        |
| Debugging went down a wrong path                             | `/rewind` (Esc×2), then redirect                  |
| Bloated with stale debugging detail but the task continues   | `/compact <focus>`                                |
| Genuinely new, unrelated task                                | `/clear`                                          |
| Known-verbose upcoming work (large file reads, broad search) | Delegate to a subagent instead of doing it inline |

`/compact` re-reads the whole conversation to summarize it — expensive for a
large context. `/clear` costs nothing. A bad auto-compact typically happens
when the model can't predict where the work is going (compacting mid-debug,
then pivoting to something the summary dropped) — when in doubt on a genuine
pivot, `/clear` rather than trusting compaction to carry the right context
forward.

### Durable-artifact compaction (ADR-0078)

Anthropic's harness-design guidance argues structured artifact handoffs
outperform in-place summarization for long-running work — "git commits
eliminated the need for an agent to have to guess at what had happened"
(`anthropic.com/engineering/effective-harnesses-for-long-running-agents`).
This repo's own incident history validated the same pattern one layer down:
every one of the 20+ logged subagent truncations recovered losslessly via its
journal, none via a narrated summary. ADR-0078 extends that pattern to the hub
session itself: `.claude/hooks/write-compact-handoff.mjs` (`PreCompact`)
writes branch, worktree, the last commit's SHA and signature status, and
`git status --porcelain`'s uncommitted-file list to `tmp/compact-handoff.json`
(this repo's gitignored scratch directory — not the ephemeral OS-level
session scratchpad, which a hook has no documented way to address);
`.claude/hooks/reinject-compact-handoff.mjs` (`SessionStart`, matcher
`compact|resume|startup` as of the 2026-09-02 ADR-0078 update) reads it back
as `additionalContext` and deletes it (one-shot) — so state reconstruction
doesn't depend on the summary having retained it, whether the next session
started from a compaction, a `--resume`, or a fresh `startup` on a dirty
branch. Deliberately excludes a live PR-number lookup (`gh` is a network
call; every other hook in this repo stays fast and dependency-free) and a
genuine "open spoke journal" list (no reliable way to discover it from a
hook) — the artifact lists only journal-shaped files under `tmp/` itself, an
honest, best-effort proxy rather than a fabricated claim.

### The always-loaded budget, measured honestly

`bin/check-context-budget.mjs` (ADR-0078) resolves `CLAUDE.md`'s `@`-imports
before measuring — `@path` imports "help organization but don't reduce
context" (`code.claude.com/docs/en/memory`); an import is not a scoping
mechanism, it's a paste. It also reports the conditional load each
`.claude/rules/*.md` adds by its `paths:` glob (a ratchet against a committed
baseline, mirroring `bin/check-file-budget.mjs`), and sums skill-listing
description weight. `CLAUDE.md` itself carries no `@`-imports any more — the
gate would otherwise be measuring 37% of what it governs, the defect that
motivated this ADR. Keep `CLAUDE.md` itself under ~200 lines —
"bloated CLAUDE.md files cause Claude to ignore your actual instructions"
(`code.claude.com/docs/en/best-practices`) — and prefer moving procedural
detail into a skill over growing `CLAUDE.md` or a broadly-scoped rule.

A 2026-09-01 harness-refresh sweep found two further gaps and closed them the
same informational-first way: the gate now also totals `.claude/skills/*/SKILL.md`
and `.claude/agents/*.md` **body** bytes (the previously entirely-unbudgeted
per-invocation/per-dispatch payload, as opposed to the listing-only weight
above) — visibility only, not ratcheted, since no evidenced per-body ceiling
exists yet — and `--exact` optionally calls Anthropic's real
`POST /v1/messages/count_tokens` endpoint for the always-loaded block, since
the gate's own chars/4 `estimateTokens()` under-counts by roughly the ~30%
the current tokenizer adds over the older one it was calibrated against.
`--exact` needs `ANTHROPIC_API_KEY` and a network call, so it stays opt-in —
never wired into `pre-push` or CI.

**Context rot**: more context is not automatically better. Anthropic: "as
token count grows, accuracy and recall degrade, a phenomenon known as context
rot" — curate the smallest high-signal set rather than defaulting to a larger
window as the fix for pressure.

Full research synthesis, contradictions between Anthropic sources, and
coverage gaps: `docs/research/context-window-and-compaction.md`.

## Part 2 — Subagents: preventing and recovering from mid-turn truncation

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
- **The one deterministic detector: diff the tree against the expected file
  list.** Every heuristic above reads the spoke's _text_. Run
  `git diff --stat` (plus `git status --short`) and compare against the files
  the dispatch was supposed to touch — this is the only check that catches the
  worst shape, where a spoke reports work, truncates, and has made **zero
  functional progress**. `2026-08-18-a1-cooperative-cancellation-seam.md` §2: an
  AWS implementer spent ~98k tokens and 67 tool calls adding a field to five
  options interfaces, never reached a single `client.ts`, and left the failing
  test count byte-identical to the RED baseline. The prose heuristic flagged the
  truncation; only the diff revealed the work was hollow. Corollary: re-run the
  spoke's own gates from the hub afterwards — a truncated spoke that finished
  its edits and a truncated spoke that did not are indistinguishable from their
  transcript tail.
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

**Parallelise by file, never by concern within a file.** Sizing a dispatch small
is necessary but not sufficient — two spokes writing the _same_ file are
independently correct and jointly broken. A2 dispatched two `test-author` spokes
in parallel against one contract; the first pinned a field as required, the
second (written after the contract changed) pinned it optional, both landed in
`prompt-destructive-target.test.ts`, and `typecheck` then failed `TS2344`
regardless of the implementation. Disjoint files parallelised cleanly across the
same run. When a contract changes mid-run, **re-dispatch the spoke that pinned the
old shape** rather than adding a second alongside it
(`docs/logs/2026-08-18-a2-target-graded-destructive-confirmation.md`).

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
Their mitigation is different — see the next section. They now get one
passive substitute the journal pattern couldn't give them: the statusline's
in-flight-spoke segment (`track-inflight-spokes.mjs`, `SubagentStart`/
`SubagentStop`) shows an elapsed-time readout for every spoke currently
running, review spokes included, closing the gap an `/auditing` pass on
status reporting found — a stalled review fan-out previously gave the user
no visible signal at all until it either returned or a human noticed the
clock. This is deliberately not a substitute for recovery (it carries no
journal to resume from, still), only for visibility: it answers "is anything
still running, and for how long," not "what has it found so far."

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
`multi-agent-research-system`).

**The scratchpad-handoff form of this pattern never worked for a read-only
spoke and is not used anywhere in this repo.** Anthropic's own phrasing —
"subagents call tools to store their work" — presumes a write tool; every
read-only spoke here (`Explore` and the six review spokes) holds
`tools: Read, Grep, Glob, Bash` with no `Write`/`Edit`, and
`guard-readonly-bash.mjs` blocks every shell write route regardless. Two
surfaces carried this exact instruction — a spoke told to write a scratchpad
file it structurally cannot write — until a 2026-09-01 harness-refresh sweep
found it live in `researching-anthropic-guidance` and in all seven read-only
`.claude/agents/*.md` files; the sweep's own dispatches had to route around
the stale instruction to get any results back. Both are now fixed the way
`.claude/workflows/audit-fanout.js` (the one surface that got this right from
the start, ADR-0025) already does it: a read-only agent returns its **full**
report **inline in its response**, capped at roughly 8,000 characters (~2,000
tokens — the top of Anthropic's documented band), rather than writing
anything to disk.

- **Review spokes** (`code-reviewer`, `security-reviewer`,
  `silent-failure-hunter`, `type-design-analyzer`,
  `spec-conformance-reviewer`, `docs-consistency-reviewer`) carry a bounded
  return contract — the Must-fix/Should-fix/Nits shape stays, capped at
  roughly 8,000 characters inline: the blocking list in full, everything
  else compressed to a count plus a one-line summary once a report would
  otherwise run long.
- **`researching-anthropic-guidance`** now mirrors `audit-fanout.js`'s
  inline-capped-digest shape for its Explore fan-out — no scratchpad run
  directory, no per-agent file.
- **`auditing`**'s Explore fan-out (via `audit-fanout.js`) already returned
  full findings inline under a hard schema-enforced cap; it was never the
  scratchpad-based one and needed no change here.

## Prevent: bound input discovery, not just output

Every prevention lever above — decomposing the dispatch, sizing a fix round by
file, the digest pattern — bounds what a spoke **produces**. None of them
bound what it has to **find out** before producing anything, and discovery,
not writing, is what exhausts `maxTurns: 40`.

Four `test-author` spokes dispatched against `docs/plans/2026-08-21-hub-board-restructure.md`'s
PR #593 truncated at 40–41 tool calls each. The common factor was not output
volume: the spokes produced 3–20 tests apiece, well inside the existing
`≤~40`-tests-per-dispatch ceiling, and the two that finished writing their
tests still truncated in their closing report rather than mid-write. What
burned the turn budget was **discovery** — a spoke asked to add tests for a
tracker-drift fixture spends twenty-odd tool calls establishing which fixture
emits which items, what shape the planner's return value takes, and what a
truly-empty plan still needs scripted, before it writes a single assertion.
None of that is undiscoverable in principle; it's just discoverable by the
hub, at dispatch time, once — instead of separately, by each spoke, inside
its own budget.

The fix, applied later in the same session (`docs/plans/2026-08-21-hub-board-restructure.md`
§ "Dispatch note (F27 applied)"): brief the next three test spokes with every
fact pre-resolved — the exact failing test names, the exact unscripted `gh`
argv, the rule helper to add, and the precise reason a predicate needed
widening. Briefed that way, each spoke needed only a handful of calls. One of
the pre-resolved facts was itself a defect the hub found while doing the
resolving (`isMutatingIssueCall` couldn't see a `gh api graphql` mutation,
since it keyed off `-X` rather than the operation keyword) — a second-order
benefit of doing the discovery once, carefully, up front rather than trusting
each spoke to rediscover it correctly.

Concretely: before dispatching a writer, resolve the facts it would otherwise
have to derive — exact fixture contents, a collaborator function's return
shape, the precise `file:line` anchors to edit, the exact command argv it
needs to construct — and hand the spoke the answers directly in the prompt.
The spoke's first tool call should be a write, not a search. This mirrors
`.claude/rules/subagent-dispatch.md`'s "Bound review-spoke INPUT scope too,
not just output" bullet, applied to the writer side instead of the review
side: that bullet already established that output-scoping and input-scoping
are two independent constraints for review fan-outs; PR #593 is the writer-side
confirmation that the same is true for `test-author`/`code-implementer`
dispatches.

This is **additive to decomposition, not a substitute for it** — "Prevent:
decompose before you dispatch" above still governs how a task is split into
bounded sub-dispatches in the first place. Pre-resolving facts makes a
correctly-sized dispatch cheaper to execute; it does not make an oversized
dispatch safe, and it is not license to raise `maxTurns` as a workaround for
either problem — "Don't raise `maxTurns` as the fix" in
`.claude/rules/subagent-dispatch.md` still applies unchanged.

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

**2026-08-20 update: two truncations on one module confirm prevention is the
harder, still-unsolved half.** `core/procedure` (B2/#523, five review rounds,
abandoned — see [ADR-0072](../adr/0072-reviewable-slice-discipline.md)) had
**two** spokes truncate mid-task on the same module, one of them a reviewer
that returned nothing after 13 minutes and 183k tokens. Both truncations
happened despite the brief-bounding guidance above already being in force —
scope-narrowing a single spoke's turn was not sufficient at this scale.
Prevention needed a structural complement, not a tighter brief: the module's
public surface was never partitioned into independently-testable slices
before RED, so every dispatch — writer and reviewer alike — carried the whole
module's surface regardless of how tightly its individual prompt was scoped.
ADR-0072's seam plan (`implementing-submodules` Step 5) addresses this by
moving the split decision earlier than the dispatch itself: the module is
partitioned before any spoke is dispatched, so brief-bounding then has
something genuinely bounded to scope each dispatch to, rather than a
same-sized slice of an indivisibly large module. Brief-bounding and journaling
remain necessary — they are what makes each individual slice's dispatch
recoverable — but this is the first confirmed case where they were not
sufficient on their own.

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

## Sources (Part 2 — subagents)

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

**Part 1 — hub session** sources (43 total, including contradictions and
coverage gaps): `docs/research/context-window-and-compaction.md`. The
governing decision record for Part 1: [ADR-0078](../adr/0078-session-context-management.md).
