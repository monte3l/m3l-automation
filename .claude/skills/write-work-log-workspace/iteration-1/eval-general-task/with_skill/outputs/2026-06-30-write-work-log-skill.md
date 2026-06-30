# Work log — write-work-log-skill (2026-06-30)

This log covers the creation of the `write-work-log` Claude Code skill. The
work ran through an audit phase (parallel Explore agents), a planning phase
(user-approved plan), a skill-creation phase (skill-creator with a pre-written
spec), and a setup phase for eval scaffolding. It records what shipped, what
matched the plan, two notable divergences that occurred during skill-creator
execution, and the durable lessons from the session.

## Summary

- **Skill created:** `.claude/skills/write-work-log/SKILL.md` — a 4-step skill
  that turns a conversation into a durable `docs/logs/` entry covering summary,
  what went as planned, what diverged (with root-cause and fix-for-future
  structure), and lessons learned
- **Audit phase:** 4 parallel Explore agents surveyed the 9 existing skills in
  `.claude/skills/`, the `docs/logs/` format, the `skill-creator` interface, and
  the `implement-submodule` pipeline — completed in a single pass
- **Gap found:** `implement-submodule` Step 8 says "Report" (verbal only); it
  never prescribes writing a `docs/logs/` file — inconsistent with `CLAUDE.md`
  which calls `docs/logs/` "the durable source" for process lessons
- **Plan:** written and approved by user without changes
- **Skill-creator invoked** with a pre-written spec; SKILL.md first draft
  matched the spec closely on first generation
- **Eval scaffolding created:** 3 test cases set up under
  `.claude/skills/write-work-log-workspace/`
- **No CI gates run** (skill file only; no src/ or dist/ changes)

## What went as planned

- **Parallel audit pass found all key gaps in one round.** Four Explore agents
  ran concurrently and together surfaced the implement-submodule inconsistency,
  the exact `docs/logs/` format conventions, and the skill-creator spec
  requirements — no follow-up searches needed.
- **Plan approved without changes.** The user reviewed the draft plan and
  accepted it as written, confirming the scoping and approach were correct on
  first pass.
- **skill-creator accepted pre-written spec without re-interviewing from
  scratch.** Providing a fully-formed spec saved significant back-and-forth;
  the skill-creator focused on generation rather than elicitation.
- **SKILL.md first draft matched spec closely.** The generated SKILL.md
  followed the required 4-step structure, included the format-reference section
  with example items, and used the exact template prescribed in the spec — no
  major structural rewrites were needed.

## What didn't go as planned, and why

### 1. skill-creator attempted description optimisation before any eval results existed

The skill-creator began running `run_loop.py` (description-optimization) immediately
after writing the first SKILL.md draft, before any eval cases had been executed.
This wasted a round and had to be redirected: the correct sequence is evals first,
then description optimisation once baseline results are available.

**Why it happened:** The skill-creator's internal instructions mention description
optimisation as a later step but the model treated "later" as "immediately after
drafting" rather than "after reviewing eval results". Without an explicit ordering
constraint in the provided spec, it defaulted to running the optimisation eagerly.

**Fix for future:** When providing a spec to skill-creator, include an explicit
ordering note: "Run description optimisation only after reviewing eval results —
not immediately after the first draft." This turns the implicit ordering into a
hard constraint the model cannot skip over.

### 2. Worktree .claude/skills directory required explicit creation of the new skill subdirectory

When working inside the worktree (`worktrees/feat+write-work-log-skill/`), the
`.claude/skills/write-work-log/` directory did not exist and had to be created
explicitly before the skill file could be written. There was a mistaken
assumption that the worktree would mirror the parent `.claude/` directory
structure automatically.

**Why it happened:** Git worktrees copy only tracked files from the git tree.
The `.claude/` directory (or its contents) is not part of the tracked tree in
the usual way, so symlinked or untracked skill directories are not present in
the worktree by default. The parent `.claude/skills/` contents were not
reproduced.

**Fix for future:** At the start of any skill-creation session in a worktree,
always create the target skill directory explicitly (`mkdir -p
.claude/skills/<skill-name>/`) before invoking skill-creator. Do not assume the
worktree `.claude/skills/` structure mirrors the parent working tree.

## Lessons learned

- **Pre-write the spec before invoking skill-creator.** Providing a
  fully-formed spec (rather than answering skill-creator's interview questions)
  avoids multiple elicitation rounds and produces a first draft that is already
  close to the target. The time cost is front-loaded into the planning phase,
  where it belongs.

- **Include explicit step-ordering constraints in skill-creator specs.**
  Saying "description optimisation happens in step N" is not enough — add "do
  not run step N until eval results are available". The model will otherwise
  choose the most eager valid reading of ambiguous ordering.

- **Worktrees require explicit .claude/ directory setup.** Git worktrees do not
  replicate untracked or symlinked `.claude/` content. When a skill or hook
  needs to live in the worktree's `.claude/skills/` directory, create the
  subdirectory explicitly at session start rather than assuming it will be present.

- **Parallel Explore agents are the right audit pattern.** Four concurrent
  agents covering different scopes (skills inventory, logs format, skill-creator
  interface, implement-submodule pipeline) converged all key gaps in one pass.
  This pattern is worth repeating for any audit where the sources are
  well-separated and independently readable.

- **The implement-submodule / docs/logs gap is now addressed.** The
  `write-work-log` skill closes the inconsistency between `implement-submodule`
  Step 8 (verbal report only) and `CLAUDE.md`'s statement that `docs/logs/` is
  the durable source for process lessons. Future sessions should invoke
  `/write-work-log` at the end of every implement-submodule run.
