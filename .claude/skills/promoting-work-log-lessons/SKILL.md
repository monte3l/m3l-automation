---
name: promoting-work-log-lessons
description: >-
  Closes the work-log → rules feedback loop for m3l-automation. Reads every
  docs/logs/*.md work log, finds the lessons that recur across multiple logs,
  and promotes them into their durable home (.claude/rules/*.md,
  .claude/agents/*.md, or an existing skill's SKILL.md) so the project's rules
  track lived experience instead of drifting from it. Invoke whenever the user
  says /promoting-work-log-lessons, "promote work-log lessons", "sync the work
  logs into the rules", "which lessons keep recurring", "fold the log lessons
  into the rules/agents", "close the work-log loop", "audit the work logs for
  recurring lessons", or after several submodules have shipped and the hub wants
  to check the logs against the rules. Use it even when the user only says
  "review the work logs" or "what have we learned that isn't written down yet" —
  this is the skill that turns narrative logs into durable rule/agent edits.
  Distinct from /auditing (which reads live code): this reads the logged history.
  Also reads the auto-memory store and `pnpm telemetry:sessions` output, so
  invoke it for "what does our session telemetry say", "are our memories
  drifting", or "which subagent is eating our token budget".
---

# promoting-work-log-lessons

The `/writing-work-logs` skill writes a durable narrative after each task, and its
Step 4 asks the author to fold generalizable lessons into the rules **in the
same change set**. That step is discretionary and single-log: the same agent
that just wrote one log decides, in the moment, whether a lesson is worth
promoting. Nothing ever looks _across_ logs. So a lesson that shows up once and
is skipped as "too specific" can recur three logs later and still never reach
`.claude/rules/` — the loop leaks.

This skill closes that leak. It reads the whole `docs/logs/` corpus at once,
finds the lessons that recur (recurrence is the strongest signal that a lesson
generalizes), and promotes each to the durable home where it will actually
change future behavior. A promoted lesson is stamped back in its source logs so
the next run skips it — that provenance marker is how the loop stays closed
instead of re-proposing the same thing forever.

**Three evidence sources, not one** (ADR-0084). Work logs are the narrative
record, but they are not the only place this project's lived experience
accumulates:

| Source                    | What it is good for                                                      |
| ------------------------- | ------------------------------------------------------------------------ |
| `docs/logs/*.md`          | Narrative cause-and-effect: what was tried, what broke, what fixed it.   |
| The auto-memory store     | Facts a past session judged durable enough to write down unprompted.     |
| `pnpm telemetry:sessions` | Measured harness behaviour no human narrates: token share, cache breaks. |

The three fail differently, which is the point. A log records what an author
noticed; a memory records what an author chose to keep; telemetry records what
actually happened whether or not anyone noticed. A lesson corroborated across
two of them is much stronger evidence than one repeated twice inside a single
system — see the extended recurrence criterion in Step 2.

**Every considered log is recorded in `docs/research/retrospective.md`,
including the ones this skill rejects.** That is not bookkeeping: without a
`no-durable-lesson` row, a log that was read and found barren is
indistinguishable from a log nobody has opened, and the backlog cannot be
counted. `check:retrospective` reads that tracker's header on every
`pre-push`.

**This skill runs only in the main (hub) agent.** It reads across the whole repo
and, in apply mode, edits rules/agents/skills — leaf spokes should not.

## Modes

The skill has two modes. **Default is propose** — it writes nothing and ends in a
report. Only switch to apply after the user has seen and approved the proposals.

- **propose** (default): scan, aggregate, route, and print a structured report of
  proposed edits with citations. No file writes.
- **apply**: invoked as `/promoting-work-log-lessons --apply`, or when the user
  approves the proposals in the same session. Writes the routed edits into the
  target files **and** stamps the provenance marker into every source log the
  promoted lesson came from.

Propose first even when the user asks to apply directly, unless they have already
seen the specific edits — a wrong promotion pollutes a rule file every future
task reads, so a look-before-write beat is cheap insurance.

## Workflow checklist

Copy this into your working notes and check items off as you go:

```
- [ ] Step 1: Scan every docs/logs/*.md; extract lessons + divergences with source
- [ ] Step 1b: Read the auto-memory store; run `pnpm telemetry:sessions`
- [ ] Step 2: Aggregate by theme; apply the recurrence criterion; drop the
              already-promoted (provenance marker) and already-captured (grep)
- [ ] Step 3: Route each surviving lesson to its durable home
- [ ] Step 4: (propose) Print the report — no writes — and stop
- [ ] Step 5: (apply) Write the edits + stamp provenance markers, then verify
- [ ] Step 6: Update docs/research/retrospective.md — EVERY log considered,
              including the rejected ones, plus the header's last-swept date
```

## Step 1 — Scan the corpus

Read **every** file in `docs/logs/` in full — not a grep, not the first screen.
The signal you are after (the same lesson phrased two different ways in two
different logs) is invisible to a keyword search and easy to miss in an excerpt.

From each log extract, with its source file and item number:

- Every bullet under **Lessons learned**.
- Every numbered item under **What didn't go as planned** — specifically its
  headline and its `Fix for future:` line, which is the actionable part.

Ignore anything under **What went as planned** and the **Summary** — those record
what happened, not what should change.

Note whether a lesson already carries a provenance marker (see the marker syntax
in Step 5). A marked lesson is already promoted; carry it forward only to skip it
in Step 2.

## Step 1b — Read the other two sources

**The auto-memory store.** It lives at
`~/.claude/projects/<slug>/memory/`, outside git — `check:retrospective`
resolves the path the same way, from `git rev-parse --git-common-dir`. Read
`MEMORY.md` for the index, then the individual memories whose `description:`
touches a theme you extracted in Step 1. A memory is a fact a past session
judged durable _without being asked to_, which makes it independent evidence
rather than a second copy of the log.

**Session telemetry.** Run `pnpm telemetry:sessions` (defaults to the last
30 days, scoped to this project). It is the only sanctioned reader of the
transcript store, and it exits non-zero if the payload shape has changed —
**if it fails, stop and report that**, do not fall back to reading transcripts
directly. The transcript format is internal to Claude Code and officially
unsupported to parse (ADR-0084); a hand-rolled reader is exactly the silent
zero-report that adapter exists to prevent.

## Step 2 — Aggregate, then filter to what's worth promoting

Group the extracted lessons by theme. Two bullets that say the same thing in
different words belong in one group — you are clustering by meaning, not string
match (e.g. "verify the writer spoke's on-disk state" and "don't trust the
implementer's truncated summary — check the files" are one theme).

Keep a theme as a **promotion candidate** only if it clears all three filters:

1. **Recurs across ≥2 distinct logs — OR appears in ≥1 log _and_ ≥1 memory.**
   A lesson that appears in exactly one log is either already handled by that
   log's own Step 4 or genuinely specific to that submodule. Recurrence is what
   distinguishes a durable convention from a one-off. (If the user explicitly
   asks to promote a specific single-log lesson, honor that — this is the
   default discovery signal, not a hard gate.)

   The memory arm is not a loosening of the bar, it is a different and
   stronger measurement of it. Two mentions in `docs/logs/` can be one author
   repeating themselves across two tasks in one week. A log entry plus a
   memory written in a _different_ session, through a _different_ mechanism,
   with no shared authoring moment, is genuine independent capture — the
   project noticed the same thing twice, in two systems, unprompted. Treat
   that as at least as strong as two logs, and cite both sources in Step 4.
   Count occurrences by **grepping every log for the theme's keyword**, not from
   memory of what you read — a lesson is easy to miss in one log when that log
   also carries a louder sibling divergence, and undercounting silently drops a
   real candidate. `grep -rl "gen:index" docs/logs` is more reliable than recall.

2. **Not already promoted.** Drop any theme whose source lessons already carry a
   `promoted → …` provenance marker.
3. **Not already captured in the rules.** Before proposing, grep the likely
   targets for the lesson's keyword — e.g.
   `grep -rin "gen:index" .claude/rules .claude/agents .claude/skills`. If the
   convention is already written down, the loop is already closed for it; drop it.

What survives all three is a real gap: a lesson the project keeps re-learning
that its durable rules still don't mention.

## Step 3 — Route each lesson to its durable home

A lesson only changes behavior if it lives where the next agent will read it.
Route by _who needs it and when_:

- **General code conventions** (ESM/error/test/API rules that apply to all
  library or script code) → `.claude/rules/`:
  `library-src.md`, `tests.md`, `scripts.md`, or `domain-knowledge.md`.
- **Agent/spoke tactics** (how a specific writer or reviewer spoke should act) →
  `.claude/agents/`: e.g. `test-author.md`, `code-implementer.md`,
  `spec-conformance-reviewer.md`, `code-reviewer.md`, and the other reviewers.
- **Process / step-ordering lessons** that belong to a specific workflow → that
  workflow's `.claude/skills/<name>/SKILL.md` (e.g. a "run `gen:index` before
  `format`" ordering lesson belongs in the `syncing-docs` skill's step sequence).
- **Cross-cutting project constraints** with no better home → `CLAUDE.md`.
- **Harness-shaped findings from telemetry** → the owning skill's or agent's
  own file, or `docs/contributing/model-selection.md` when it is a tiering
  question.

If a lesson could land in two places, prefer the most specific one an agent
actually reads while doing the relevant work — a tactic buried in `CLAUDE.md` is
weaker than the same tactic in the spoke prompt that governs the task.

Write the promotion as the rules themselves are written: terse, imperative, and
explaining the _why_ (a rule the reader understands survives edge cases a bare
imperative does not). Include a code snippet only when the exact syntax _is_ the
lesson. Keep it to a few lines — you are adding a rule, not pasting the log.

### Telemetry-derived findings

`pnpm telemetry:sessions` surfaces a class of problem no work log ever
records, because nobody experiences it as an event. Read its payload for:

- **Disproportionate token share** — `by_subagent_type` or `by_skill` where one
  entry's `total_tokens` dwarfs its `calls`. A spoke averaging several times
  the tokens per call of its siblings is usually over-briefed (too much
  context handed in) or under-scoped (doing work that should have been split).
  That is a fixable prompt or dispatch problem, and its home is the agent's own
  `.claude/agents/*.md` or the dispatching skill.
- **Cache-break clustering** — `cache_breaks` entries repeatedly attributed to
  the same skill or workflow. A prompt-cache break costs real tokens, and a
  cluster means something in that path mutates early context on every run.
- **`overall.input_tokens.pct_cached` trending down** across `by_day` — a
  whole-harness regression, most often something newly injected at session
  start.

**Read `by_skill` with its attribution rule in hand.** `analyze-sessions.mjs`
attributes every API call to the most recently invoked skill until the next
**plain human message** resets it (`setSkill(null)`). A skill invoked early in
a long autonomous run therefore owns that entire run's tokens. `starting-work`
measured 1.21 B tokens across 6367 invocations over 14 days on 2026-09-01 for
exactly that reason — it is mandated as the first call of every change session,
not because a five-question decision gate is expensive. Compare
`by_subagent_type` instead, where attribution is per-transcript and a per-call
average means something, and read a `by_skill` total as "how much work followed
this skill", never as "what this skill cost".

Route these like any other lesson, with one difference: **cite the numbers**.
A telemetry finding whose proposed edit does not carry the measurement that
motivated it cannot be re-checked after the fix, and the next sweep has no way
to tell whether it worked.

## Step 4 — Propose (default mode: stop here)

Print a report and **write nothing**. For each promotion candidate:

```
### <theme, one line>
- Evidence:  docs/logs/<file-a>.md (#<n>), docs/logs/<file-b>.md (#<n>)
             memory/<slug>.md            (when the memory arm carried it)
             telemetry: <the metric and its value>  (when it is a measurement)
- Target:    .claude/rules/<file>.md  (or agents/ or a skill SKILL.md)
- Proposed edit:
    <the terse rule text you would add, verbatim>
```

End with a one-line summary: how many themes were extracted, how many survived
the filters, how many were dropped as already-promoted or already-captured. Then
stop and let the user review. Do not proceed to Step 5 unless the invocation was
`--apply` or the user approves.

If many themes survive, write the full per-theme breakdown to a scratch file and
keep the chat reply to the summary line plus theme names — don't paste every
candidate's citations and proposed edit inline.

## Step 5 — Apply (only when approved)

For each approved promotion:

1. **Edit the target file** — insert the rule text where it fits the file's
   existing structure (under the matching heading, alongside sibling rules). Match
   the surrounding formatting exactly.
2. **Stamp the provenance marker** into every source log the lesson came from, so
   the next run's Step 2 filter skips it. The marker is an italic suffix appended
   to the lesson's bullet or divergence headline:

   ```
   **<keyword>** … the lesson text. _(promoted → .claude/rules/tests.md)_
   ```

   This is the same marker `/writing-work-logs`'s Step 4 uses when it promotes a
   lesson at write time — the two skills share one convention so a log's promotion
   state is always readable from the log itself.

3. **Incident → eval.** If the promoted lesson originated from a gate or CI
   failure (not just a behavioral correction with no failing check attached),
   check whether the owning skill's `evals/evals.json` should gain a case
   reproducing it — a lesson that once broke a real gate is exactly the shape
   of regression an eval case exists to catch. Add one if it's missing; skip
   this for lessons with no gate/CI failure behind them (most behavioral
   corrections have nothing concrete to encode as a pass/fail case).

## Step 6 — Record every considered log in the tracker

Update `docs/research/retrospective.md` for **every log this run read**, not
only the ones that produced an edit. A log read and found barren gets
`no-durable-lesson`; a log carrying a candidate held back gets `deferred` with
the reason. Skipping the rejects is what made the previous marker-only scheme
uncountable, and it is the one step whose omission the gate cannot detect —
`check:retrospective` compares `logs-considered` against the live log count, so
an under-recorded sweep simply looks like a smaller backlog.

Then update the header comment:

```markdown
<!-- retrospective: last-swept=<today, from `date`> logs-considered=<n> -->
```

`<n>` is the cumulative count of logs with any outcome other than
`not-yet-swept` — not the number this run touched. Run `date` to get today;
no gate catches a wrong-but-well-formed date.

This step runs in **apply mode only**. A propose run reads the tracker and
writes nothing, like every other target.

Do **not** commit. Report the files edited and the logs stamped, then hand off to
`/writing-commits` (a `docs:` change — no `src/` or `version` is touched, so this is
not a release event).

**Verify after applying:**

- `pnpm lint:md` — the edited logs and any Markdown rule files stay lint-clean.
- `pnpm check:agents` — if you edited any `.claude/agents/*.md`, confirm the agent
  references still resolve.
- `pnpm check:skill-evals` — if you added an eval case per Step 5's item 3,
  confirm the skill's `evals/evals.json` still clears the case-count minimum.
- `pnpm check:retrospective` — confirms the tracker header parses and that the
  backlog it now reports matches what this run actually swept. It warns and
  never blocks, so read its output; a green push is not evidence it passed.
- Re-read one edited target to confirm the rule reads naturally in context, not as
  a bolted-on fragment.

## Relationship to /auditing and /writing-work-logs

- **/writing-work-logs** writes one log and _may_ promote that log's own lessons at
  write time. This skill is the periodic cross-log sweep that catches what those
  single-log passes left behind. They share the provenance-marker convention.
- **/auditing** finds gaps by reading _live code_; this skill finds gaps by reading
  _logged history_. They are complementary — auditing surfaces "the code is missing
  X"; this surfaces "five logs show we keep hitting Y and never wrote it down."
- Both this skill and `/auditing` can edit `.claude/rules` and `.claude/agents`. Do
  not run them concurrently in one session — finish one before starting the other
  so their edits don't race on the same file.
