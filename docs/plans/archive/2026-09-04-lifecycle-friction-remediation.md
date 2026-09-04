# Collapse the forced session boundary and fix work-log/multi-PR friction

**Status: shipped** — five sequenced PRs: #1007, #1016, #1018, #1020, and
this PR, closing out an `/auditing` + `/refreshing-anthropic-guidance` plan
on the full worktree-based development lifecycle.

## Context

An `/auditing` pass over the planning (Phase 1) and closing (Phase 5) phases
of the development lifecycle, prompted by three user-observed problems, all
confirmed by investigation:

1. **Bootstrap required two sessions.** Plan in session A, create the
   worktree, kill session A, `cd`, launch session B, re-derive the plan —
   a structural consequence of `bin/claude-launch.mjs` only being able to
   name a session at process launch, with no way to inject that flag into
   an already-running session.
2. **Nothing automated the closing phase**, and a multi-PR submodule
   landing broke the chain entirely at the first merge — `finishing-work`
   declared itself terminal with no notion that another slice was pending.
3. **Work logs landed in their own post-merge `docs:` PR**, the designed
   consequence of the pipeline's step order, plus a live contradiction
   between `writing-work-logs` ("do NOT commit") and `finishing-work`
   ("commit it immediately") that meant the actual outcome depended on
   which skill happened to be loaded.

A follow-up `/refreshing-anthropic-guidance` sweep, scoped to session/
worktree/hook lifecycle, found the native `EnterWorktree`/`ExitWorktree`
tools (which switch an already-running session's cwd into a worktree with
no restart) as the mechanism that collapses problem 1 — and confirmed this
repo's sibling-directory worktree placement (`pnpm worktree:new`, ADR-0013)
is Anthropic's own documented case for creating a worktree "with git
directly" rather than nested under `.claude/worktrees/`, not a deviation
from guidance.

## Approach / Decisions

Five independently reviewable PRs (ADR-0072), in dependency order:

- **PR1 (#1007) — hook event/matcher unblock.** `bin/check-hooks.mjs`'s
  `KNOWN_EVENTS` covered 17 of Claude Code's ~33 documented hook lifecycle
  events; wiring any of the missing ones was a false-positive gate failure.
  Widened to the full documented set, added `SessionEnd`/`DirectoryAdded`
  matcher enums, deliberately left `WorktreeCreate`/`WorktreeRemove` (no
  matcher support per the docs) and `Notification` (three fetches of
  Anthropic's docs returned mutually inconsistent enum values — encoding a
  wrong enum into a blocking gate is worse than leaving it unchecked)
  unencoded. Also filed H1–H12 (`docs/ROADMAP.md`) for every lifecycle-audit
  finding not folded into this plan, synced to GitHub as issues #994–#1005.
- **PR2 (#1016) — bootstrap collapse.** `starting-work`'s location default
  flipped from "shared checkout unless concurrent work signalled" to a
  linked worktree entered in-session via `pnpm worktree:new` +
  `EnterWorktree path:` — no restart, no second session. Session naming's
  primary route for this default moved from `pnpm session:launch` (a
  fresh-process launch flag) to `/rename <kind>-<slug>` immediately after
  entry. ADR-0013/0014/0088 amended to record the new mechanism without
  reversing the underlying sibling-directory placement decision. Demonstrated
  live: this session ran its own remaining PRs (3, 4, 5) via this exact
  pattern, zero restarts.
- **PR3 (#1018) — multi-PR continuity.** `finishing-work` gained a Step 8
  that reads a just-merged submodule's `## Landing plan` table
  (`bin/check-scaffold-seam.mjs`'s existing contract) before declaring
  terminal; a row not yet `Landed` hands off to the next slice via the same
  `EnterWorktree` mechanism plus an abbreviated `starting-work` re-entry.
  Scoped to submodule work only — the one case with a durable slice record;
  non-submodule multi-PR work (X8/X11/X12-style) has no equivalent and was
  deliberately not given a second mechanism (filed as H5).
- **PR4 (#1020) — work-log timing fix.** The narrowest slice: replaced
  `writing-work-logs`'s "Do NOT commit" instruction with `finishing-work`'s
  "commit it immediately" wording, resolving the live contradiction.
  Grep-verified no other reference to the old behavior survived anywhere in
  the repo.
- **PR5 (this PR) — context-budget headroom + CI-cost investigation.**
  `CLAUDE.md` sat at 2,998/3,000 estimated tokens against
  `check:context-budget`'s hard cap — one token of headroom, with the gate's
  own docblock noting the real tokenizer runs ~30% higher than its
  estimator. Trimmed prose across eight sections (cutting content derivable
  from `package.json`/repo structure, keeping pitfalls and non-default
  conventions) to ~2,829 estimated tokens. Investigated wiring the unused
  `changes.outputs.docs` CI output into a docs-only fast path per the
  original plan's scope, and found it would revert `ci.yml`'s own
  documented, already-reasoned decision to leave `gates`/`secrets`/
  `format:check` unconditional (four prior review rounds found audit gaps
  from narrower path-scoping) — documented the finding in
  `docs/contributing/ci-cd.md` instead of implementing it. Deferred a real
  trim of the four oversized `.claude/rules/*.md` files (~92 KB, all well
  over the ratchet ceiling) as its own follow-up (H13) rather than rushing
  ~92 KB of dense institutional memory into this PR.

Two mid-plan scope adjustments (PR3's non-submodule exclusion, PR5's CI
fast-path non-implementation and rule-file deferral) were each discovered
during implementation, not anticipated at planning time — consistent with
`CLAUDE.md`'s Task Workflow rule to re-derive an authored claim before
acting on it, since a plan's own premises can rot between authoring and use.

## Outcome

- Zero forced session restarts for a multi-PR task starting in plan mode.
- `finishing-work` → next-slice handoff works for submodule landings.
- `writing-work-logs`/`finishing-work` no longer contradict on commit
  timing.
- `CLAUDE.md`'s always-loaded budget has real (not estimator-margin-only)
  headroom for the first time since the cap was introduced.
- Twelve governance follow-ups (H1–H12) plus one context-budget follow-up
  (H13) filed and tracked, none silently dropped.
