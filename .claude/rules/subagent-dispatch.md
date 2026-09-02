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

Subagent mid-turn truncation (a spoke hitting `maxTurns: 40` or an output-token
cap mid-thought) is this repo's most-recurring build divergence — 20+ logged
occurrences. The checklist:

- **Decompose before you dispatch.** Scale the dispatch to task complexity —
  a module/script spanning many files gets split into bounded sub-dispatches
  up front, not handed to one spoke as an indivisible turn. Don't rely on
  journaling to make an oversized turn safe. A single-file test suite is the
  worst case: a `test-author` dispatch expected to produce more than ~40
  tests in one file gets pre-split into two or more checkpointed batches (by
  describe-block group), each ending with a run of the partial suite, rather
  than authored in one unbroken pass — and a fix round crossing ~5+ distinct
  findings gets split by item count the same way
  (`2026-07-11-scripts-json-etl.md`, `2026-08-14-rds-data-sql.md`,
  `2026-08-16-core-pipeline.md`).
- **Size a FIX round by file, not by finding count.** A review fan-out returns
  findings grouped by concern; dispatching them that way hands one spoke every
  file the findings touch. Regroup by file — one spoke per file (or tight file
  group), every finding for that file in one prompt — so each spoke loads one
  file's context. Ten findings across four files in a single dispatch burned
  106 k tokens and wrote **nothing** (`2026-07-23-core-diagnostics.md`); the same
  ten, split one-spoke-per-file, landed cleanly in parallel. It also removes
  write conflicts, so the spokes can run concurrently.
- **Bound review-spoke INPUT scope too, not just output.** The above bullet
  covers writer turns; review fan-outs need the same discipline on the other
  side. Give each review spoke a tight per-spoke file list (2–5 files) and
  split a Phase-4 review dispatch **by concern** once the diff exceeds ~3–4
  files or a few hundred lines, rather than handing one reviewer the whole
  diff plus "explore the repo" latitude — an unbounded scope stalled 3 of 5
  review spokes for 60+ minutes in `docs/logs/2026-07-18-aws-athena.md` and a
  single oversized `code-reviewer` dispatch for over an hour in
  `docs/logs/2026-07-18-aws-eventbridge.md`, both fixed by narrowing the file
  list. Every review-spoke prompt also carries a **converge and report**
  instruction — stop once its checklist is answered rather than re-verifying
  indefinitely; a spoke that never converges is indistinguishable from a
  stalled one.
- **Pre-resolve the facts a writer would otherwise discover, not just its
  output scope.** Bounding what a writer produces (`≤~40` tests, one file)
  does not bound what it has to find out before writing a line — and
  discovery, not writing, is what exhausts `maxTurns: 40`. Four `test-author`
  spokes on PR #593 truncated at 40–41 tool calls while producing 3–20 tests
  each, well inside the output budget, and the two that finished their writes
  still truncated in the closing report — the turns went to deriving facts
  already knowable at dispatch time: which fixture yields which items, what
  shape the planner returns, what an empty plan still needs scripted. Resolve
  those facts yourself before dispatching — the exact fixture contents, a
  collaborator's return shape, the precise `file:line` anchors to edit — and
  hand the spoke the answers, so its first tool call is a write, not a
  search. A later dispatch in the same session, briefed this way, needed only
  a handful of calls
  (`docs/plans/2026-08-21-hub-board-restructure.md` §§ "Dispatch note",
  "Dispatch note (F27 applied)"). This is not license to raise `maxTurns`
  (`:151`) — it's the same scoping lever above, applied to the input side.
- **Two independent review lenses landing on the same line is signal, not
  redundancy.** Different-lens convergence has repeatedly marked the real
  defect: error-hierarchy and security reviewers on one unguarded `JSON.parse`
  (`2026-07-13-scripts-logs-insights.md`), three spokes on one identical bug
  with one of them finding a subtler second (`2026-07-18-s3-objects.md`), two on
  a duplicate collaborator construction
  (`2026-07-26-w5-promote-checkpoint-store.md`). Treat a convergent finding as
  confirmed and fix it — never discount the second report as a duplicate of the
  first.
- **Re-review every substantive fix round, bounded.** Must-fix fixes are new
  writer code with no reviewer between them and the commit; post-review fix
  batches introduced fresh Must-fix defects in at least four pipelines
  (`2026-07-02-core-text.md`, `2026-07-03-core-script.md`,
  `2026-07-03-core-importers.md`, `2026-07-13-dynamo-crud.md`). Dispatch a
  focused confirmation pass — the reviewer(s) whose findings drove the fixes,
  scoped to the changed files only, not a fresh full fan-out — before declaring
  the review loop closed.
- **When a reader and an executor disagree about a guard, the executor wins.** A
  review spoke reasoning over source answers "does the `try` enclose the call";
  only one running a probe answers "when is the property actually read".
  `safeDescribe` was read and cleared by `code-reviewer`, `type-design-analyzer`
  and `spec-conformance-reviewer`, then broken independently by
  `silent-failure-hunter` and `security-reviewer` probing built `dist/`
  (`2026-08-20-a6-pipeline-phase-trace.md`). In
  `2026-08-19-a4-checkpoint-fingerprint.md` every defect and both regressions
  were found by probe and none by reading — each lived in the gap between two
  components' assumptions, which a reader checking each component against its
  own contract structurally cannot see. So point a refute pass at the **seam,
  not the diff**, and never let a clean read-through overturn a failing probe.
- **Hand writer spokes (`test-author`, `code-implementer`) an explicit journal
  path** in the dispatch prompt. `.claude/hooks/guard-writer-dispatch-journal.mjs`
  warns (non-blocking) when one is missing.
- **When the hub can already write the production file directly but not the
  paired guarded test file, pre-verify the exact test content in an isolated
  scratchpad `vitest` config before dispatching `test-author`, rather than
  handing over untested prose.** Write the test file to the scratchpad
  (outside `bin/tests/**`), point a throwaway `vitest.config.ts` at that one
  path, and run it against the real (already-edited) source file first. Only
  once it passes, hand the verified content to `test-author` verbatim for
  placement into the guarded path. Across roughly six such dispatches in one
  session this caught zero bad handoffs and needed zero re-dispatch rounds
  (`docs/logs/2026-09-02-session-naming-convention.md`).
- **Never trust a "final" report at face value.** A mid-thought fragment
  (`"Now the config module —"`) is the signature of a truncated turn, not a
  benign quirk — verify on-disk state yourself (the spoke's journal, `git
status`/`git diff`, re-run `tsc`/`eslint`/`vitest`/coverage) before deciding
  what's actually done.
- **A spoke's scratchpad journal doesn't survive a session-level restart,
  but its git-worktree edits do.** A `stopped`/"no completion record"
  notification after an interruption broader than one spoke's own turn limit
  (a harness/process restart mid-fan-out, not a single `maxTurns` truncation)
  can leave `bin/spoke-recovery.mjs` with no journal path to read at all — the
  ephemeral scratchpad directory is gone, even though the spoke's actual file
  edits, written straight into the git worktree, persisted the whole time.
  Check `git status`/`git diff` in the worktree first; if the edits are
  already there and match the dispatch's spec, there is nothing to recover or
  redispatch (`docs/logs/2026-08-25-a3b-recovery-fleet-retrofit.md`).
- **A coherent-looking report can still be wrong — this is a separate failure
  mode from truncation.** A fix-round `code-implementer` once returned a
  clean, complete-sounding summary claiming all 4 requested items were done
  and verified; re-reading the actual diff and re-running `tsc` found only 2
  of the 4 had landed, with zero truncation signal (`docs/logs/2026-07-28-core-config-files-w5-promote.md`).
  Re-verify a fix round's completion the same way regardless of how confident
  the report reads.
- **A harness SECURITY WARNING on a subagent's action is a hard stop, not a
  data point to weigh.** Investigate real repository state (`git status`,
  file timestamps, tracked-vs-untracked counts) before taking or trusting any
  further action from that dispatch — including its own claimed results —
  and never let a fresh remediation compound the risk (list the exact files
  affected and act on that literal list, never a glob/`find`/`git clean`
  re-sweep). Same incident as above: the same dispatch had also mass-deleted
  ~450 unrelated untracked build artifacts outside its scoped file list.
- **Scope a fix-round dispatch defensively, not just precisely.** Naming the
  exact files to touch is necessary but not sufficient — also forbid the
  specific dangerous command classes for that task (bulk delete, raw compiler
  invocations bypassing the project's build config) and instruct the spoke to
  stop-and-report on any unexpected repository state rather than
  self-remediating it.
- **Resume the SAME spoke via `SendMessage`**, never a fresh `Agent`/`Task`
  dispatch — a fresh agent has no memory of the prior exploration and restarts
  the whole budget from zero. Hand it a scoped punch-list of exactly what's
  left, not a full re-explanation.
- **Verification can conclude "no resume needed" — prefer hub verification
  over a resume when only the report is missing.** A truncated return whose
  artifacts are already on disk (files written, gates green when you run them
  yourself) needs no `SendMessage` resume at all — re-running the
  verification battery from the hub is cheaper and faster than paying a
  resume round. Reserve resumes for truncations where the work itself is
  genuinely unfinished; six separate sessions confirmed the
  report-cut-off-but-work-done case is at least as common as the
  work-cut-off case.
- **Review spokes return a bounded digest**, not an open-ended report — the
  full report travels back **inline in the structured return value**, capped
  at roughly 8,000 characters (~2,000 tokens, Anthropic's documented
  sub-agent output band). No review or audit spoke writes a scratchpad file:
  none holds a `Write`/`Edit` tool, and `guard-readonly-bash.mjs` blocks
  every shell write route regardless — an earlier version of this bullet
  described a scratchpad-spill mechanism that never actually worked for a
  read-only spoke and is not used anywhere in this repo (fixed 2026-09-02,
  `docs/contributing/subagent-context-management.md`'s "Prevent: bounded
  output" section has the full history). Applies to `code-reviewer`,
  `security-reviewer`, `silent-failure-hunter`, `type-design-analyzer`,
  `spec-conformance-reviewer`, `docs-consistency-reviewer`, `Explore`, and
  any `auditing`/`researching-anthropic-guidance` fan-out dispatch.
- **Plan mode propagates its read-only restriction to every subagent it
  dispatches — not just the ones already read-only by design.** A
  `test-author`/`code-implementer` writer spoke dispatched while plan mode
  is active loses write access for that dispatch too, the same as a review
  spoke. First surfaced 2026-07-22: an `audit-fanout` run under active plan
  mode had its Explore finders return digests successfully while silently
  never writing the report files their (then-current) instructions
  described — not an agent failure, but plan mode's blanket restriction
  applying to a step that assumed it wouldn't. If a skill or workflow's
  design depends on a subagent writing a file (a report, a scratch note,
  a journal), that dependency silently breaks under plan mode with no
  error — verify with `git status`/`ls` after the dispatch rather than
  trusting the return value's success claim, and prefer a dispatch
  contract (like the inline-digest pattern above) that doesn't depend on
  subagent file writes at all when correctness under plan mode matters.
- **A `SubagentStop` hook (`detect-spoke-truncation.mjs`) now flags a
  suspicious-looking return automatically** — treat its stderr reminder as a
  prompt to apply the "never trust a final report" step below, not as a
  replacement for it; it's a heuristic over prose, not a parse of the SDK's
  actual truncation signal.
- **A backgrounded or piped command reports the wrong exit code.** A command
  ending in a pipe, or in `echo "…$?"`, notifies success regardless of what
  happened; a long `git push` that dies in `pre-push` looks identical to one
  that landed. Write a real sentinel into the log (`rc=$?; printf
'REAL_EXIT=%s\n' "$rc" >>log`) from a script FILE, not an inline multi-line
  command — a multi-line command's newlines can collapse, corrupting the
  sentinel and making a waiter fire early. Then confirm the outcome against
  ground truth (`git ls-remote`), never against the log.
- **Don't raise `maxTurns` as the fix.** More context/turns is not free —
  Anthropic's context-rot finding says accuracy degrades as token count grows.
  Scoping, journaling, and pacing are the preferred levers.
- **Run `bin/spoke-recovery.mjs` (or the `mcp__m3l__spoke_recover` tool)
  first** when recovering a truncated/ambiguous spoke — it automates the
  journal-parse + on-disk-verification step so you judge from a structured
  recommendation instead of re-deriving state by hand.
- **A templated dispatch prompt needs a per-target assumption check, not just
  a per-target file-list check.** Reusing one prompt shape across N similar
  targets (e.g. "retrofit script X onto library class Y") is efficient, but
  the template's implicit assumptions can be false for one target even when
  true for the rest — verify the assumption itself (e.g. "this script uses
  exactly one error code") against each target's own docs/tests before
  dispatch, not just the file scope. `codepipeline-ops`'s two-code split
  (`ERR_CODEPIPELINE_OPS_CONFIG`/`_INPUT`) was collapsed into one code by a
  spoke correctly following a template written for its 5 single-code
  siblings; the hub's post-dispatch `grep` across all 6 scripts' reference
  docs caught it, but a pre-dispatch check would have prevented it entirely
  (`docs/logs/2026-07-28-w5-config-accessor-fleet-retrofit.md`). This is
  distinct from — and a supplement to — "never trust a final report at face
  value" above: the defect here was semantically wrong but syntactically
  valid, so `typecheck`/`lint`/`build` all passed clean; only a check against
  the _documented contract_ caught it.
- **A module whose seam plan (`implementing-submodules` Step 5, ADR-0072)
  projects more than one slice is never dispatched as a single RED/GREEN
  pair.** `core/procedure`/B2 (#523) tried to write and review a whole large
  module as one turn per phase and hit non-convergence after five review
  rounds and two mid-task truncations — including a reviewer returning
  nothing after 13 minutes and 183k tokens. Dispatch each slice's Phase 2/3
  as its own bounded turn, with its own Phase 4 review, landing as its own PR
  before the next slice's dispatch begins — don't let "it's one module" carry
  a many-file, many-concept RED/GREEN pair back into a single dispatch.
- **Make barrel wiring its own numbered, separately-verified step in any
  multi-file dispatch.** It is the step most often left for last, so it is the
  step truncation most often lands on — and a missing
  `export * from "./<module>/index.js"` line passes the entire suite green while
  nothing in the module is reachable as `Core.*`/`AWS.*`. Give it its own prompt
  item with its own verification command, so a truncation mid-verification
  still leaves the wiring done
  (`2026-08-11-aws-sqs-redrive-athena-template.md`; the same omission hid behind
  truncated returns in `2026-07-01-core-json.md`,
  `2026-07-03-core-exporters.md` and `2026-07-23-core-diagnostics.md`). Budget
  for it when sizing a slice too: barrel lines, error-catalog entries and
  ESLint-zone entries are unnamed but required bytes
  (`2026-08-21-core-procedure.md`).
