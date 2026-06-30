---
name: write-work-log
description: >-
  Invoked by /write-work-log or any request to write, add, create, or document
  a work log. Also triggers for: "document this task", "log the lessons from
  this task", "log what happened", "record what we built", or similar phrasing
  where the user wants a written record of completed implementation work.
  Produces a structured Markdown file saved to docs/logs/ with sections covering
  what shipped, what went as planned, what diverged and why, and durable lessons
  learned. Invoke proactively when a significant coding task wraps up and the
  user signals they're done — real-time context (test results, decisions,
  divergences) is permanently lost once the session closes.
---

# write-work-log

This skill turns the current conversation into a durable `docs/logs/` entry — a
Markdown file that records what shipped, what went smoothly, what diverged (and
why), and concrete lessons for future tasks in this project.

The log is most valuable when written _during_ the same session as the task,
because that is when real-time context is available: spoke verdicts, exact test
counts, coverage numbers, lint/typecheck outcomes, and the specific sequence of
events that caused a divergence. After the session closes, that context must be
reconstructed from memory or git history — both are less precise.

## Step 1 — Determine task identity

Read the conversation context and extract:

- **Task name and namespace**: the module, feature, or task just completed
  (e.g. `core/config`, `aws/ssocredentials`, or a freeform slug like
  `write-work-log-skill` for non-submodule work)
- **Date**: today's date in `YYYY-MM-DD` format — read it from the environment,
  do not guess
- **Target filename**:
  - Submodule task: `YYYY-MM-DD-<ns>-<module>.md`
    (e.g. `2026-06-30-core-config.md`)
  - General task: `YYYY-MM-DD-<slug>.md`
    (e.g. `2026-06-30-write-work-log-skill.md`)
- **Target path**: `docs/logs/<filename>.md`

If the identity is genuinely ambiguous (e.g. multiple modules completed in one
session), ask one focused question: "Which task or module should this work log
cover?" — then proceed without further interruption.

**Overwrite guard:** Check whether `docs/logs/<filename>.md` already exists
before writing. If it does, stop and inform the user — the log is immutable once
committed. Ask whether they want a different filename or prefer to skip. Never
overwrite silently.

## Step 2 — Synthesise the work log from conversation context

Extract all four sections from what already happened in this conversation. Do
not ask the user to fill in sections. If something is genuinely unknowable from
the conversation (e.g. no divergences occurred), say so briefly rather than
inventing content.

### Summary

What shipped, tailored to the task:

- **Submodule implementation**: public symbols exported, test count (module +
  full-suite total), coverage % across all four V8 metrics, CI gate results
  (`typecheck`, `lint`, `build`, `check:api`, `check:provenance`, etc.), and a
  one-line verdict per review spoke that ran (conformant / secure / score /
  must-fix count).
- **General task**: files created/modified/deleted, commands run and their
  outcomes, any notable metrics.

The summary should be dense enough that a reader can understand the scope in
30 seconds without reading the rest of the log.

### What went as planned

Bullet list of phases or steps that executed correctly and without surprises.
Be concrete — instead of "everything went fine", write things like:

- **RED failed for the right reason** — `Cannot find module` rather than a type
  error in the test logic itself
- **GREEN was clean on first pass** — the implementer delivered lint-clean,
  typecheck-clean code without a re-dispatch
- **All review spokes returned no Must-fix items** in the implementation logic

Omit this section only if truly nothing went as intended (rare).

### What didn't go as planned, and why

Numbered items. Each item must follow this exact structure:

```
### N. <headline: one-line description of the divergence>

<narrative paragraph: what happened, what was affected, how it was resolved>

**Why it happened:** <root cause — one or two sentences>

**Fix for future:** <specific, actionable prevention for the next submodule —
one or two sentences>
```

If nothing diverged, write: "Everything executed as planned; no divergences
were observed." — and omit the numbered list entirely. Do not pad the section
with manufactured divergences.

### Lessons learned

Bulleted synthesis from the "What didn't go as planned" items plus any
non-obvious insights from the "What went as planned" section.

Each bullet:

- Leads with a **bold keyword phrase** (2–6 words) capturing the lesson topic
- Follows with one or two sentences of specific, actionable guidance

Write at least one lesson even when everything went smoothly — a smooth run
confirms prior lessons still hold, or identifies a workflow element worth
repeating explicitly.

## Step 3 — Write the file

Use this exact template. No YAML frontmatter.

```markdown
# Work log — `<ns>/<module>` submodule (YYYY-MM-DD)

<one-paragraph intro: what task this log covers, what pipeline it ran through,
and what it records (what shipped, what matched the plan, what diverged,
durable lessons)>

Plan of record: [`docs/plans/<plan-file>.md`](relative-link)

## Summary

…

## What went as planned

…

## What didn't go as planned, and why

…

## Lessons learned

…
```

For non-submodule tasks, adjust the title:
`# Work log — <task slug> (YYYY-MM-DD)`

Omit the "Plan of record" line entirely if no plan file was used for this task.

## Step 4 — Report

After writing, print:

1. The full path of the created file
2. A one-line summary of what the log captures

Do NOT commit the file. Committing is the user's next step via `/write-commit`
with a `docs:` message. Remind them of this so the handoff is clear.

---

## Format reference

The examples below show the expected style for the two most distinctive
sections. Match this style — future agents read these logs to extract process
lessons, so precision matters.

### "What didn't go as planned" — example item

```markdown
### 1. RED-phase eslint-disable blocks required a post-GREEN cleanup spoke

The test-author added two `eslint-disable` blocks to suppress
`@typescript-eslint/no-unsafe-*` and `import-x/no-unresolved` errors during
RED. After GREEN, ESLint flagged them as unused directives. A separate cleanup
spoke was needed to remove them and strip dead test-teardown code.

**Why it happened:** Writing tests against a non-existent module generates
import-resolution errors. The test-author suppressed them to keep lint green in
the RED state, but those blocks become stale the moment the module exists.

**Fix for future:** Do not add eslint-disable blocks during RED. Lint warnings
are acceptable in the RED state — the only signal needed is that tests fail for
the right reason (missing module, not a logic error). The blocks self-resolve
once the module exists.
```

### "Lessons learned" — example bullets

```markdown
- **Never add RED-phase eslint-disable blocks for import-resolution errors.**
  The test runner does not care about lint in the RED state. Disable blocks
  create a cleanup spoke after GREEN that adds no value.

- **`@example` blocks in library source are normative consumer guidance.**
  They must follow project standards even when the spec shows a different
  pattern. When spec and project rules diverge, state the correct pattern
  explicitly in the implementer prompt — do not assume the implementer resolves
  the conflict in the right direction.
```
