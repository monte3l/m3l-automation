# Subagent mid-turn truncation hardening

**Status: shipped** (PR #133, commit `a36c5d8`)

## Context

Across the work-log corpus (`docs/logs/*.md`), subagent mid-turn truncation
was by far the most-recurring divergence — 16+ logs recorded it, one session
hitting it 5+ times, and one RED-phase run (`test-author` on `json-etl`)
burned its entire 150k-token budget writing zero files. The repo already had
a reactive playbook (verify on-disk state, resume the same spoke via
`SendMessage`) and partial prevention (writer-spoke journals, write-files-
first), but the gaps were uneven: only the two writer spokes had a survive-
a-turn-limit journal, review spokes had no fallback at all, there was no
proactive chunking guidance for oversized modules, the bounded-digest return
pattern lived only in one skill, and model tier was never tied to context-
window/truncation risk. The plan folded in official Anthropic guidance
(condensed-summary subagent returns, four-part briefs, effort-scaling,
external-memory/progress-file patterns, `stop_reason`/`error_max_turns`
detection, context rot) gathered via a dedicated research pass, and closed
all five gaps in one doc/prompt/config-only change set.

## Approach / Decisions

- Full scope across all five themes, doc/prompt/config only — no
  `src/**`/`tests/**` touched, so `guard-branch-isolation.mjs` didn't block,
  but the change set still landed via a reviewed PR given it touches
  enforcement infrastructure.
- **Durable memory (three homes):** a new canonical reference doc
  (`docs/contributing/subagent-context-management.md`) covering detect /
  prevent / recover, citing the logged occurrences and the Anthropic
  countermeasures; a terse `.claude/rules/subagent-dispatch.md` extract,
  made discoverable by referencing it from `CLAUDE.md` rather than relying
  on path-glob auto-load; and an auto-memory entry plus `MEMORY.md` index
  line.
- **Writer-journal refinements, not a rewrite:** kept the existing "journal
  as you go" pattern (endorsed as Anthropic's external-memory/progress-file
  practice), but reframed it as a safety net behind narrow scoping, kept the
  cadence coarse to avoid spending the very budget it protects, and added a
  rule for a resumed spoke to re-read its own journal first.
- **Bounded digest contract for review spokes:** the five review spokes
  (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`,
  `type-design-analyzer`, `spec-conformance-reviewer`) got a capped
  Must-fix/Should-fix/Nits return shape — write long detail to a scratchpad
  file, return only the digest — body-only edits so `pnpm check:agents`
  stayed green.
- **`auditing` harmonized with the digest pattern** already used by
  `researching-anthropic-guidance`: Explore agents write full findings to a
  per-facet scratchpad file and return a compact digest for hub aggregation.
- **Proactive chunking, both advisory and deterministic:** a "size the
  dispatch" heuristic added to the implementation skills, plus a new
  PreToolUse hook, `.claude/hooks/guard-writer-dispatch-journal.mjs`, that
  warns (non-blocking) when a writer-spoke dispatch omits a scratchpad
  journal path — directly targeting the failure mode that lost an entire
  RED-phase run.
- **Model tier ↔ context window note** added to
  `docs/contributing/model-selection.md` with the precise Anthropic context/
  output figures per tier, plus the context-rot caveat. Deliberately did not
  raise `maxTurns` — more context risks quality degradation, so scoping and
  write-first remain the preferred lever.

## Outcome

All five themes landed: the canonical playbook doc, the rules extract, the
new guard hook, the bounded-digest contract on the five review spokes plus
the two writer spokes, the `auditing` skill's digest alignment, and the
model-selection context-window note. See
[`docs/contributing/subagent-context-management.md`](../../contributing/subagent-context-management.md)
for the full detect/prevent/recover playbook and
[`.claude/rules/subagent-dispatch.md`](../../../.claude/rules/subagent-dispatch.md)
for the terse dispatch rule. `pnpm check:agents` and `pnpm check:hooks`
stayed green throughout since the change was body-only on agent frontmatter
and added one correctly-wired hook.
