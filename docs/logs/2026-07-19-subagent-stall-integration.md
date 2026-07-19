# Work log — `subagent-stall-integration` (2026-07-19)

This log covers a three-phase session: (1) exploring `docs/logs/*.md` for prior
subagent-stall/truncation incidents and mapping existing recovery
infrastructure, (2) researching official Anthropic guidance on preventing and
recovering from subagent stalls via `/researching-anthropic-guidance`, and
(3) auditing the repo against that guidance via `/auditing` to find concrete
integration gaps, then implementing the confirmed gaps. It records what
shipped, what matched the plan, what diverged during implementation, and
durable lessons for future hook/dispatch-rule work.

Skills used: `researching-anthropic-guidance`, `auditing` (via the
`audit-fanout` workflow), `starting-work`, `writing-commits`,
`writing-work-logs`.

## Summary

**Exploration phase** (2 parallel Explore agents): scanned all 43
`docs/logs/*.md` files and found two recurring subagent-stall modes — writer-
spoke mid-turn/summarization truncation (20+ occurrences; worst case burned an
entire 150k-token budget writing zero files) and review-fan-out stalls on
oversized scope (`aws-athena`, `aws-eventbridge`, `aws-s3`: 3-of-5 spokes
stalled 60+ minutes, fixed each time by narrowing the per-spoke file list). A
second agent mapped existing infrastructure: the
`subagent-context-management.md` playbook, `mcp__m3l__spoke_recover`/
`bin/spoke-recovery.mjs` (a hub-triggered diagnostic that does not self-fire),
and a single advisory pre-dispatch hook (`guard-writer-dispatch-journal.mjs`).
Recovery was entirely manual — no `SubagentStop`/`PreCompact` hook existed
despite both being in `check-hooks.mjs`'s `KNOWN_EVENTS` allowlist.

**Research phase** (5 parallel Explore agents, one per facet): synthesized
~29 official Anthropic sources into
[`docs/research/subagent-stall-recovery.md`](../research/subagent-stall-recovery.md).
Key consensus: the `stop_reason`/`ResultMessage.subtype` detection signals,
Claude Code v2.1.199's partial-output-with-a-"didn't finish"-note behavior,
that `SubagentStop`/`PreCompact` hooks exist and are documented but unused
here, context-isolation-as-compression (a subagent should return a
1,000–2,000-token distilled digest), and resume-not-restart as the recovery
pattern.

**Audit phase** (`audit-fanout` workflow, 5 facets, 20 agents, adversarial
verify): 11 confirmed / 4 refuted / 2 hub-verified-by-hand findings
cross-referencing the repo against the research. Confirmed: no
`SubagentStop`/`PreCompact` hook; the review-input-scoping + "converge and
report" lesson was never codified (the `aws-eventbridge` log explicitly
flagged this); `docs-consistency-reviewer` was missing the bounded-output
section the other five reviewers carry; `Explore.md` had no baked-in digest
instruction; no done-after-verify gate on writer-spoke journals; the
`hooks-reference.md` table was stale (18 rows vs. 19 wired hooks at audit
time). Refuted (correctly, on inspection): the memory-tool "ASSUME
INTERRUPTION" protocol doesn't apply here (a category mismatch — this repo's
same-session `SendMessage` resume already satisfies the specific Anthropic
quote its journal pattern is grounded on); the JSON-vs-Markdown journal
durability claim was backwards (Markdown/line-based logging degrades more
gracefully under truncation than JSON would); and the append-log-vs-checklist
"inconsistency" was already explicitly reconciled in `outstandingPending`'s
own docstring.

**Implementation** (commit `a75f3f7`, `chore: integrate anthropic
stall-recovery guidance into dispatch`, 21 files, +500/-36): new
`SubagentStop` hook (`.claude/hooks/detect-spoke-truncation.mjs`, advisory
detector-only per user decision) wired into `.claude/settings.json`; the
review-input-scoping + "converge and report" lesson codified in
`subagent-dispatch.md`, both `implementing-*/SKILL.md` Phase 4 steps, and all
six reviewer prompts; bounded-output sections added to `Explore.md` and
`docs-consistency-reviewer.md`; journal verification-gating added to
`test-author.md`/`code-implementer.md` plus a cross-link comment in
`spoke-recovery.mjs`; doc drift fixed across `hooks-reference.md` (18→20
rows), `CLAUDE.md`, `subagent-context-management.md`, and
`agent-operating-model.md`; the research snapshot persisted and indexed.

All quality gates passed: `check:hooks` (20 wired hooks), `check:agents`,
`check:doc-counts`, `check:index`, `lint:md`, `eslint`, `typecheck`,
`format:check`, the full test suite (132 files / 3,865 tests), and `build`.
Pre-existing unrelated changes to `README.md`/`package.json` (present before
this session started) were deliberately excluded from the commit.

## What went as planned

- **The 5-facet research fan-out and 5-facet audit fan-out both completed
  cleanly** — every Explore agent returned a compact digest as instructed,
  and (for the audit) the adversarial verify pass ran to completion with no
  agent errors (20/20 done, 0 errors).
- **Plan-mode Explore/research spokes correctly reported findings inline**
  when file writes were blocked (read-only tool grants + active plan mode) —
  each agent recognized it couldn't write its scratchpad file and returned
  full findings in its response instead of silently losing them.
- **`starting-work` correctly determined no isolation was needed** — the
  change touched only `.claude/**` and `docs/**`, no guarded paths
  (`packages/*/src`, `scripts/*/src`, `tests/**`), so the shared checkout was
  the right call and `guard-branch-isolation.mjs` never fired.
- **Every quality gate passed on the first full run** after implementation —
  no re-work loop was needed across `check:hooks`, `check:agents`, lint,
  typecheck, format, tests, or build.
- **The commit-staging discipline held**: pre-existing unrelated
  `README.md`/`package.json` changes (present in `git status` before this
  session began) were correctly excluded from the commit by listing exact
  file paths rather than `git add -A`.

## What didn't go as planned, and why

### 1. The new hook's first-draft truncation heuristic false-positived on a clean bounded digest

The first draft of `detect-spoke-truncation.mjs`'s `looksTruncated()`
function flagged any message that didn't end in terminal punctuation
(`.`, `!`, `?`, etc.). Manual testing during implementation (a step the plan
itself specified: "manually pipe a fabricated truncated-message payload...
and a clean payload") surfaced that this flagged a clean, correctly-bounded
review digest ending in a bullet list (`"- Nits: 3 items"`) — exactly the
kind of return the hook is supposed to stay silent on. This would have made
the hook noisy on a large fraction of legitimate review-spoke returns,
undermining its own design goal (documented in its header comment) of
staying "quiet on a clean return."

**Why it happened:** Terminal punctuation is a poor proxy for completeness —
structured output (bullet lists, digests, code fences, tables) legitimately
ends without a period far more often than prose does, and this repo's
review-spoke digest format is exactly that shape.

**Fix for future:** Tightened the heuristic to only three signals: an
empty/missing message, a trailing ellipsis, or an unclosed trailing-intent
phrase (`"let me"`/`"now"`/`"next"` etc. with nothing completing it before
end-of-string). This trades recall (a truncated report that happens to end on
a grammatically complete sentence, e.g. the logged `"Let me replace these
prepares."` case, won't be caught) for a much lower false-positive rate. For
any future prose heuristic in a hook meant to run on every return, test it
against the tool's own clean/expected output shape before wiring it, not just
against the failure cases the heuristic was built to catch.

## Lessons learned

- **Test a "quiet on success" heuristic against your own tool's clean output,
  not just its target failure cases.** A detector built from failure-mode
  examples (truncated fragments) can still misfire on legitimate output the
  author didn't think to check — the review-digest bullet-list ending here.
  Before wiring any advisory hook that fires on every event of a given type,
  run it against a sample of known-good output from that exact event.
- **Adversarial audit verification catches over-eager findings, not just
  under-supported ones.** 4 of 15 raw findings from the audit fan-out were
  refuted on inspection — two because the "gap" was measuring the repo
  against guidance that didn't actually apply (a category mismatch between
  cross-session and same-session resume models), one because the claimed
  fix direction was backwards. Running every finding through an independent
  refute pass before it reaches the plan is worth the extra agent spend.
- **A work log explicitly flagging "not yet folded into a durable rule"
  (`2026-07-18-aws-eventbridge.md`) is a reliable signal for a real,
  actionable gap.** It survived both the audit fan-out and the adversarial
  verify pass unchanged — self-reported process debt in a log is a
  high-precision source for future audits to prioritize.
- **When persisting a research snapshot assembled from several parallel
  agents' inline reports (not scratchpad files, since plan mode blocked
  those), de-duplicate source URLs by hand before writing the provenance
  header** — the same official source (e.g. "How the agent loop works")
  surfaced independently across three of the five research facets, and
  citing it three times with different S-numbers would have inflated the
  apparent source count and made the Sources list harder to audit.
