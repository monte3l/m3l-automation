# Fix `audit-fanout` report transport: return reports inline, not via scratchpad files

**Status: shipped** — `fix/audit-fanout-report-transport`.

## Context

The `auditing` skill's `audit-fanout` workflow instructed each read-only
Explore facet finder to write a full EXISTING/GAP/INCONSISTENCY report to a
hub-supplied scratchpad directory, returning only a compact digest — the
ADR-0025 mechanism for keeping the hub's context lean at high fan-out.

The user's premise ("this can't write scratchpads in plan mode") was true but
incomplete. An `/auditing`-style investigation (two parallel Explore agents
plus direct verification of the guard's own classifier) found the finders were
structurally incapable of writing the report **in any mode**, for three
independent, stacked reasons:

1. **Tool grant.** `audit-fanout.js` dispatches `agentType: "Explore"`, and
   `.claude/agents/Explore.md` grants no `Write`/`Edit` tool — deliberate and
   machine-enforced by `bin/check-agents.mjs`'s least-privilege check.
2. **Read-only Bash guard.** Explore's only remaining route, a shell
   redirect, is blocked by `guard-readonly-bash.mjs` — verified directly by
   calling its exported `classifyBashCommand` against `cat >`, `mkdir -p`,
   `tee`, and `echo >>` targeting the scratchpad path: all blocked, no `/tmp`
   or scratchpad exemption.
3. **Plan mode.** Propagates read-only to subagents — the layer the user
   originally suspected, and real, but only the third of three.

Verdict: not an intended architectural limitation. The read-only invariant is
intended and worth keeping; instructing a read-only agent to write a file, and
losing its findings silently when it can't (`DIGEST_SCHEMA` had no field to
carry report prose as a fallback), is a defect.

## Approach / Decisions

Per the user's choices during the plan's clarifying round:

1. **Bounded inline report field**, not a write-capable finder agent or a
   scratchpad exemption in the Bash guard. `DIGEST_SCHEMA` gained
   `reportMarkdown` (`maxLength: 8000`), removing the filesystem dependency
   from both the Workflow-dispatched and manual-fallback paths at once, and
   preserving ADR-0025's context-leanness intent without weakening the
   read-only invariant the other options would have touched.
2. **New `check:workflows` rule R8** (agentType capability check): R8a — every
   `agentType:` literal must name a defined `.claude/agents/*.md` spoke; R8b —
   a read-only spoke's dispatch must not carry a write-instruction phrase
   (a small heuristic denylist, documented as such). R8a is the load-bearing
   half; R8b is the one that would have caught this specific bug.
3. **Hard `maxLength` cap** on `reportMarkdown` rather than prose-only
   guidance or dropping full reports to digest-only — a deterministic ceiling
   on hub context (5 facets × 8 KB ≈ 40 KB worst case), enforced by schema
   validation rather than trusted to the model.
4. **Single PR.** The workflow script and skill changes are coupled (schema
   shape and step-3 instructions move in lockstep), so splitting them would
   have produced two non-independently-reviewable halves.

### The one contradiction not fully resolved

The original 2026-07-16 acceptance run _did_ write a report file, four days
after `guard-readonly-bash.mjs` shipped, and its work log blamed path
separators rather than a guard block — suggesting the hook's `agent_type`
field may be unpopulated for Workflow-dispatched agents specifically, so the
guard historically bit only the manual-fallback path. This was flagged in the
plan as requiring a live run in both plan-mode and non-plan-mode to settle.
In practice, only the non-plan-mode run was performed: re-entering plan mode
mid-implementation would have blocked every further write in the session for
a question the fix itself makes moot — `audit-fanout.js` no longer attempts
any file write, so neither layer has anything left to block. Recorded here
rather than silently dropped.

## Outcome

`.claude/workflows/audit-fanout.js`, `bin/check-workflows.mjs` (+ 4 new R8
unit tests, dispatched to `test-author` since `bin/tests/**` is guarded),
`.claude/skills/auditing/SKILL.md`, `docs/contributing/model-selection.md`,
and this ADR-0025 amendment landed in one commit on
`fix/audit-fanout-report-transport`.

**Live-verified, not just gate-verified.** Per the original pilot's own
lesson ("run the artifact before shipping it" — `docs/logs/2026-07-16-audit-fanout-workflow.md`),
ran the fixed workflow end to end via the `Workflow` tool on a small 2-facet
topic (auditing the R8 rule's own implementation and documentation): both
finders returned `reportMarkdown` inline, no file-write attempt occurred, and
the refute phase ran to completion (1 confirmed finding, 0 refuted, 0
unverified). The run itself surfaced a real minor gap — the R8b regex
patterns were named in prose ("a small, explicit denylist") but never spelled
out — fixed in the same commit before pushing.

`pnpm verify` passed 51/51 applicable steps (10 skipped, all push-only/CI-only
by design). Full local suite: 12703 + 176 + 31 tests green;
`bin/tests/check-workflows.test.ts` 33/33 (29 existing R1–R7 + 4 new R8).
