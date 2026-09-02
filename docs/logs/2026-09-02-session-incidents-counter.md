# Work log — `session-incidents-counter` (2026-09-02)

This log covers PR #878, the final slice (Slice 3 of 3) of the session-continuity
remediation plan produced by an `/auditing` pass over the repo's session-continuity
automations. It closes Gap 2 (compaction data loss): two work logs
(`docs/logs/2026-08-29-aws-bedrock-runtime-tools.md`,
`docs/logs/2026-08-30-v7-agent-decision-log.md`) recorded spoke-incident counts as
explicitly unrecoverable after mid-task compaction, because those counts were only
held in conversational context. Slice 1 (post-merge finalization, the `finishing-work`
skill) merged as #857; Slice 2 (resume/startup handoff re-injection) merged as #873;
both were closed out separately. This log records what shipped, what matched the
plan, a real bot-caught defect that diverged sharply from the plan, and durable
lessons — including the close-out of PR #878 performed by the very skill Slice 1
delivered.

Plan of record: `~/.claude/plans/how-the-current-automations-quiet-hoare.md`
(session plan-mode file, now being archived to `docs/plans/archive/` as the
follow-up to this log).

## Summary

`.claude/hooks/detect-spoke-truncation.mjs` gained a new exported
`INCIDENTS_REL_PATH` constant and `appendIncident()` function: on every detected
truncation it now appends a `{timestamp, agentType, agentId?, kind: "truncation"}`
JSON line to `tmp/session-incidents.jsonl`, in addition to its existing stderr
warning. New `.claude/hooks/rotate-session-incidents.mjs` deletes that file at the
start of a genuinely new session (`matcher: "startup|clear"`, after a bot-caught
correctness fix — see below) so it never accumulates unbounded in the gitignored
`tmp/` directory. `.claude/skills/writing-work-logs/SKILL.md`'s "Spoke incidents"
summary step now reads the file for the truncation count when present.
`docs/contributing/hooks-reference.md` was updated to match (new hook row, hook-count
bump).

Two new guarded test files, both written by the `test-author` spoke:
`bin/tests/detect-spoke-truncation.test.ts` (14 tests — no test file existed for
this hook before this slice) and `bin/tests/rotate-session-incidents.test.ts`
(5 tests initially, extended to 27 after the Must-fix below). `pnpm verify` passed
in full three separate times across the task (57/57 non-skipped steps each time).

Skills used: starting-work, writing-commits, syncing-docs, creating-prs,
resolving-pr-comments, finishing-work, writing-work-logs.

Spoke incidents: none (no `tmp/session-incidents.jsonl` present at the end of this
session — no truncation was detected on any spoke dispatched during this task; two
`test-author` dispatches and two review-spoke dispatches all completed cleanly).

Compaction events: none observed this session.

## What went as planned

- **`pnpm check:hooks` validated the matcher scoping on every attempt** — both the
  original `startup|clear` addition and the post-Must-fix rewiring passed
  `KNOWN_MATCHERS` validation immediately, no typo round-trips needed.
- **The bounded re-review converged quickly and cleanly.** The `code-reviewer`
  dispatch scoped to exactly the 4 files touched by the Must-fix fix returned PASS
  with zero Must-fix/Should-fix findings on the first pass, confirming the fix
  actually closed the defect (verified the settings.json JSON directly, not just
  the diff prose) rather than just looking plausible.
- **The `finishing-work` skill's close-out ran cleanly for the third time**, now
  against a third distinct PR (#878), reinforcing that it generalizes rather than
  being overfit to any one PR's shape.
- **`docs-consistency-reviewer`'s pre-push pass caught a real prose-precision gap**
  (the "advisory hooks inject via stdout/JSON" line not accounting for
  `rotate-session-incidents` being silent even on success) before push, exactly the
  kind of doc/reality drift it exists to catch.

## What didn't go as planned, and why

### 1. The rotation hook's original matcher scoping was a real, bot-caught correctness defect

`rotate-session-incidents.mjs` was originally wired into `.claude/settings.json`'s
matcher-less `SessionStart` block — the same block `guard-worktree-ready.mjs`,
`warn-host-resources.mjs`, and `warn-node-version.mjs` live in, which fires on every
`SessionStart` source unconditionally. This meant the hook also fired on `compact`
and `resume`, not just a fresh `startup`. On a mid-task auto-compaction, the hook
would delete `tmp/session-incidents.jsonl` — the same session's own,
just-recorded incident data — before `writing-work-logs` (or a resumed session
recovering from a crash) ever got to read it. This is exactly the data loss the
whole feature exists to prevent, and it shipped in the first push. `claude-pr-review.yml`'s
bot caught it and posted FAIL; the hub's own drafting, `pnpm verify`, and the
`docs-consistency-reviewer` pre-push pass had all missed it, since none of them
reason about hook-wiring _semantics_ — `check:hooks` validates that a matcher
value is a known token, not that the token choice is logically correct for the
hook's own stated purpose.

**Why it happened:** The plan's own Decisions section (Q7) specified "rotate at
`SessionStart` (no matcher — every start)" without distinguishing "every start" in
the human sense (once per fresh session) from "every start" in the harness's
literal sense (every time the `SessionStart` event fires, including mid-session
after a compaction). The implementation followed the plan's literal wording rather
than re-deriving what "every start" should mean given the feature's own purpose.

**Fix for future:** When wiring a `SessionStart`/`PreCompact`/`PostCompact` hook,
explicitly enumerate which of the 5 documented matcher values (`startup`, `resume`,
`clear`, `compact`, `fork`) the hook's own stated purpose is actually safe for —
don't default to "no matcher" just because a plan said "every start." A hook that
deletes or resets state needs the narrowest matcher set that still satisfies the
purpose, verified against each matcher's _meaning_, not just validated against the
known-token list.

### 2. A stray, non-gitignored scratchpad file nearly landed in a commit

A `test-author` dispatch wrote its dispatch journal to `.scratch/test-author-rotate-session-incidents.md` in the repo root — a directory that, unlike `tmp/`, is not covered by `.gitignore`. A subsequent `git add -A` (staging `/syncing-docs`'s output before commit) picked it up along with the intended files. Caught before the commit was created by reviewing `git status --porcelain` output rather than trusting the `add -A` blindly.

**Why it happened:** The dispatch prompt didn't specify an explicit journal path for this particular `test-author` call, so the spoke picked its own location, and `.scratch/` (unlike `tmp/`) has no `.gitignore` entry in this repo.

**Fix for future:** Always hand a writer spoke (`test-author`, `code-implementer`) an explicit journal path under `tmp/` in the dispatch prompt — `.claude/hooks/guard-writer-dispatch-journal.mjs` already warns (non-blocking) when one is missing, and this incident is a concrete instance of what that warning is trying to prevent. Also added `.scratch/` to `.gitignore` as a backstop in this same change set, since a missed dispatch-prompt journal path will keep producing this same near-miss otherwise. _(promoted → .gitignore)_

## Lessons learned

- **A hook's matcher scoping needs to be verified against the hook's own purpose, not just against the known-token list.** `check:hooks` (and a plan's own prose) can both validate that `"startup|clear"` is a real matcher value while missing that `"compact|resume|startup"` — or no matcher at all — would silently defeat what the hook is _for_. Ask "which of these five sources is this hook actually safe to fire on, given what it does" as an explicit design step, not an afterthought. _(promoted → .claude/rules/harness-artifacts.md)_
- **A resume from a crash is not the same case as a fresh startup, even though both eventually run the same session-start hooks.** `resume` was deliberately excluded from the rotation matcher alongside `compact` — a resumed session may be recovering from a crash whose incidents were never read yet, so rotating on `resume` would erase exactly the evidence Slices 1–2 of this same plan were built to preserve. When two matcher values look similar (`startup` vs `resume` — both "the process is (re)starting"), check what state each one is protecting before treating them as interchangeable.
- **Explicitly hand writer spokes a `tmp/`-scoped journal path.** A dispatch that omits one can produce a scratchpad file outside the gitignored convention, which then rides along on the next broad `git add`. Always specify the path; treat `guard-writer-dispatch-journal.mjs`'s warning as load-bearing, not decorative.
- **A bounded re-review earns its cost even after `pnpm verify` and a docs-consistency pass both already came back clean.** Neither of those two gates reasons about hook-wiring logic — only a reviewer explicitly told to verify the fix against the JSON (not just the diff) confirmed the Must-fix was actually closed.
