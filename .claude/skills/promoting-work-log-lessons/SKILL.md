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
- [ ] Step 2: Aggregate by theme; keep lessons recurring across ≥2 logs; drop the
              already-promoted (provenance marker) and already-captured (grep)
- [ ] Step 3: Route each surviving lesson to its durable home
- [ ] Step 4: (propose) Print the report — no writes — and stop
- [ ] Step 5: (apply) Write the edits + stamp provenance markers, then verify
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

## Step 2 — Aggregate, then filter to what's worth promoting

Group the extracted lessons by theme. Two bullets that say the same thing in
different words belong in one group — you are clustering by meaning, not string
match (e.g. "verify the writer spoke's on-disk state" and "don't trust the
implementer's truncated summary — check the files" are one theme).

Keep a theme as a **promotion candidate** only if it clears all three filters:

1. **Recurs across ≥2 distinct logs.** A lesson that appears in exactly one log
   is either already handled by that log's own Step 4 or genuinely specific to
   that submodule. Recurrence is what distinguishes a durable convention from a
   one-off. (If the user explicitly asks to promote a specific single-log lesson,
   honor that — the ≥2 rule is the default discovery signal, not a hard gate.)
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

If a lesson could land in two places, prefer the most specific one an agent
actually reads while doing the relevant work — a tactic buried in `CLAUDE.md` is
weaker than the same tactic in the spoke prompt that governs the task.

Write the promotion as the rules themselves are written: terse, imperative, and
explaining the _why_ (a rule the reader understands survives edge cases a bare
imperative does not). Include a code snippet only when the exact syntax _is_ the
lesson. Keep it to a few lines — you are adding a rule, not pasting the log.

## Step 4 — Propose (default mode: stop here)

Print a report and **write nothing**. For each promotion candidate:

```
### <theme, one line>
- Recurs in: docs/logs/<file-a>.md (#<n>), docs/logs/<file-b>.md (#<n>)
- Target:    .claude/rules/<file>.md  (or agents/ or a skill SKILL.md)
- Proposed edit:
    <the terse rule text you would add, verbatim>
```

End with a one-line summary: how many themes were extracted, how many survived
the filters, how many were dropped as already-promoted or already-captured. Then
stop and let the user review. Do not proceed to Step 5 unless the invocation was
`--apply` or the user approves.

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

Do **not** commit. Report the files edited and the logs stamped, then hand off to
`/writing-commits` (a `docs:` change — no `src/` or `version` is touched, so this is
not a release event).

**Verify after applying:**

- `pnpm lint:md` — the edited logs and any Markdown rule files stay lint-clean.
- `pnpm check:agents` — if you edited any `.claude/agents/*.md`, confirm the agent
  references still resolve.
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
