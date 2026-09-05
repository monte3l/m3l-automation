---
paths:
  - ".claude/skills/**"
  - ".claude/agents/**"
---

# Subagent dispatch rules (truncation prevention & recovery)

> Canonical rationale + full incident history:
> [`docs/contributing/subagent-context-management.md`](../../docs/contributing/subagent-context-management.md).
> This file is the terse checklist consulted when dispatching or resuming a
> spoke. No natural path-glob covers "dispatching a subagent," so this rule is
> also listed in `CLAUDE.md`'s "Coding, errors & tests" rules list and linked
> from the dispatching skills — read it there too.

- **Decompose before you dispatch.** Scale the dispatch to task complexity — a
  module/script spanning many files gets split into bounded sub-dispatches up
  front, not handed to one spoke as an indivisible turn. A single-file test
  suite over ~40 tests, or a fix round over ~5 findings, splits into
  checkpointed batches the same way. `code-implementer` is the spoke this
  bites hardest — measured over 30 days it took 0.24 prompt-cache breaks per
  call at 3.15M tokens/call against `test-author`'s 0.06 and 1.50M, and every
  read-only reviewer's zero. Hand it an explicit file list **and** a byte
  budget per file, measured before dispatch; a spoke told the ceiling shrinks
  the file instead of ratcheting the baseline
  (`docs/logs/2026-09-03-u11-retry-resume-cancellation.md`).
- **Size a FIX round by file, not by finding count.** Regroup findings by
  file — one spoke per file (or tight file group), every finding for that
  file in one prompt — so each spoke loads one file's context. This also
  removes write conflicts, so spokes can run concurrently.
- **Bound review-spoke INPUT scope too, not just output.** Give each review
  spoke a tight per-spoke file list (2–5 files) and split a review dispatch
  by concern once the diff exceeds ~3–4 files or a few hundred lines. Every
  review-spoke prompt also carries a **converge and report** instruction —
  stop once its checklist is answered rather than re-verifying indefinitely.
- **Pre-resolve the facts a writer would otherwise discover, not just its
  output scope.** Discovery, not writing, is what exhausts `maxTurns: 40`.
  Resolve the exact fixture contents, a collaborator's return shape, and the
  precise `file:line` anchors yourself before dispatch, so the spoke's first
  tool call is a write, not a search.
- **Two independent review lenses landing on the same line is signal, not
  redundancy.** Treat a convergent finding as confirmed and fix it — never
  discount the second report as a duplicate of the first.
- **Re-review every substantive fix round, bounded.** Must-fix fixes are new
  writer code with no reviewer between them and the commit. Dispatch a
  focused confirmation pass — the reviewer(s) whose findings drove the fixes,
  scoped to the changed files only, not a fresh full fan-out — before
  declaring the review loop closed.
- **When a reader and an executor disagree about a guard, the executor
  wins.** A review spoke reasoning over source answers "does the `try`
  enclose the call"; only one running a probe answers "when is the property
  actually read." Point a refute pass at the **seam, not the diff**, and
  never let a clean read-through overturn a failing probe. A single spoke's
  claim needs no contradicting spoke to warrant this: a claim about a
  parser, a serializer, or a CLI's actual behaviour is a claim to **run**,
  not to weigh — including when you are only quoting it into an explanatory
  comment, where a paraphrase can flip the causality and outlive the review
  thread
  (`docs/logs/2026-09-03-x12-containerization-images-and-scanning.md`,
  `2026-09-05-x8-close-out.md`).
- **Hand writer spokes (`test-author`, `code-implementer`) an explicit
  journal path** in the dispatch prompt.
  `.claude/hooks/guard-writer-dispatch-journal.mjs` warns (non-blocking) when
  one is missing.
- **Pre-verify test content in a scratchpad before handing it to
  `test-author`**, when the hub can already write the source file but not
  the guarded test path — write the test outside `bin/tests/**`, run it
  against the real source with a throwaway `vitest.config.ts`, then hand
  over only verified content.
- **Never trust a "final" report at face value.** A mid-thought fragment
  (`"Now the config module —"`) is the signature of a truncated turn, not a
  benign quirk — verify on-disk state yourself (the spoke's journal, `git
status`/`git diff`, re-run `tsc`/`eslint`/`vitest`/coverage) before deciding
  what's actually done.
- **A spoke's scratchpad journal doesn't survive a session-level restart,
  but its git-worktree edits do.** After a harness/process restart
  mid-fan-out, check `git status`/`git diff` **in the worktree the spoke ran
  in, not this repo's own root** — the edits may already be there even with
  no journal left to read.
- **A coherent-looking report can still be wrong — a separate failure mode
  from truncation.** Re-verify a fix round's completion (re-read the diff,
  re-run the gates) regardless of how confident the report reads.
- **A harness SECURITY WARNING on a subagent's action is a hard stop, not a
  data point to weigh.** Investigate real repository state before trusting
  any further action from that dispatch, and act only on the exact list of
  affected files — never a glob/`find`/`git clean` re-sweep.
- **Scope a fix-round dispatch defensively, not just precisely.** Also
  forbid the specific dangerous command classes for that task (bulk delete,
  raw compiler invocations bypassing the project's build config) and
  instruct the spoke to stop-and-report on unexpected repository state
  rather than self-remediating it.
- **Resume the SAME spoke via `SendMessage`**, never a fresh `Agent`/`Task`
  dispatch — a fresh agent has no memory of the prior exploration and
  restarts the whole budget from zero. Hand it a punch-list, not a recap.
  `fork` never resumes; it forks the hub.
- **Verification can conclude "no resume needed."** A truncated return whose
  artifacts are already on disk (files written, gates green when you run
  them yourself) needs no `SendMessage` resume at all — re-running the
  verification battery from the hub is cheaper. Reserve resumes for
  truncations where the work itself is genuinely unfinished.
- **Review spokes return a bounded digest**, not an open-ended report — the
  full report travels back inline in the structured return value, capped at
  roughly 8,000 characters (~2,000 tokens). No review or audit spoke writes
  a scratchpad file.
- **Plan mode propagates its read-only restriction to every subagent it
  dispatches** — not just the ones already read-only by design. A writer
  spoke dispatched while plan mode is active loses write access too. If a
  design depends on a subagent writing a file, verify with `git status`/`ls`
  after the dispatch rather than trusting the return value's success claim.
- **A `SubagentStop` hook (`detect-spoke-truncation.mjs`) flags a
  suspicious-looking return automatically** — treat its stderr reminder as a
  prompt to verify (see "never trust a final report" above), not as a
  replacement for it.
- **A backgrounded or piped command reports the wrong exit code.** Write a
  real sentinel into the log from a script FILE, not an inline multi-line
  command (its newlines can collapse the sentinel), then confirm the
  outcome against ground truth (e.g. `git ls-remote`), never against the
  log.
- **Don't raise `maxTurns` as the fix.** More context/turns is not free —
  Anthropic's context-rot finding says accuracy degrades as token count
  grows. Scoping, journaling, and pacing are the preferred levers.
- **Run `bin/spoke-recovery.mjs` (or the `mcp__m3l__spoke_recover` tool)
  first** when recovering a truncated/ambiguous spoke — it automates the
  journal-parse + on-disk-verification step so you judge from a structured
  recommendation instead of re-deriving state by hand.
- **A templated dispatch prompt needs a per-target assumption check, not
  just a per-target file-list check.** Verify the template's implicit
  assumptions against each target's own docs/tests before dispatch, not
  just the file scope — a defect here can be semantically wrong but
  syntactically valid, passing `typecheck`/`lint`/`build` clean.
- **A module whose seam plan (`implementing-submodules` Step 5, ADR-0072)
  projects more than one slice is never dispatched as a single RED/GREEN
  pair.** Dispatch each slice's Phase 2/3 as its own bounded turn, with its
  own Phase 4 review, landing as its own PR before the next slice's dispatch
  begins.
- **Make barrel wiring its own numbered, separately-verified step in any
  multi-file dispatch.** It's the step most often left for last, so it's the
  step truncation most often lands on — a missing
  `export * from "./<module>/index.js"` line passes the suite green while
  nothing in the module is reachable as `Core.*`/`AWS.*`.
