# Work-log lesson sweep — the 20-log backlog clear

**Status: shipped** — PR on `docs/work-log-sweep`.

## Context

`docs/research/retrospective.md` had gone quiet on its own polling arm since
the 2026-09-03 sweep (`last-swept=2026-09-03 logs-considered=135`), while
`docs/logs/` grew to 155 — a 20-log backlog, four times
`check:retrospective`'s 5-log cadence threshold. This run cleared it, reading
all three ADR-0084 evidence sources: the 20 unswept logs in full, the
auto-memory store, and `pnpm telemetry:sessions`' 30-day payload.

## Approach / Decisions

Seven themes cleared all three Step 2 filters (recur across ≥2 logs, or
≥1 log plus a corroborating memory; not already promoted; not already
captured) and were routed to the file the relevant agent actually reads:

- **`.claude/rules/tests.md`** — a fix round that adds branches isn't done
  until the _gated_ `test:coverage` run passes, not a scoped single-file
  `vitest` call (3 logs). Landed against a 19-byte-headroom file, so the
  edit paid for itself with an offsetting prose trim elsewhere in the same
  file rather than growing past the 10,000-byte rule ceiling.
- **`.claude/rules/harness-artifacts.md`** — widened its `paths:` scope to
  `bin/**` (with `CLAUDE.md`'s mirrored rule-glob prose kept in parity) and
  added "run a new `check:*` gate live against the repo before writing its
  tests" — a docker-ban gate flagged its own filename; a staleness gate
  found a real unwired path in seconds, in both cases faster than any
  synthetic fixture would have.
- **`.claude/rules/subagent-dispatch.md`** — extended "the executor wins"
  from reader-vs-executor disagreements to an _unexecuted_ single spoke
  claim (4 logs: a parser claim, a serializer paraphrase, a Must-fix
  contradicting an established fact, two research agents disagreeing); and
  gave `code-implementer` an explicit byte budget, backed by a telemetry
  measurement (0.24 prompt-cache breaks/call at 3.15M tokens/call, against
  `test-author`'s 0.06/1.50M and every reviewer's zero).
- **`creating-prs/SKILL.md` + `finishing-work/SKILL.md`** — the post-merge
  branch-deletion race's tell (`cannot lock ref … unable to resolve
reference`) and recovery (cherry-pick onto a fresh branch), plus the
  squash-merge ancestor check (`git log <branch> ^origin/main`) before any
  branch-deleting cleanup.
- **`starting-work/SKILL.md`** — a second concurrent worktree mid-session
  doesn't need `EnterWorktree` (it refuses); absolute paths work, and a
  successful `Write` doesn't confirm which checkout received the file.
- **`CLAUDE.md` § Forbidden Patterns** — never run a destructive command
  (`git reset --hard`, `rm -rf`) for a disposable purpose without checking
  `git status`/`git status --porcelain` first (two independent hub-side
  incidents in one day).

One candidate was investigated and rejected, not promoted: a log claimed
`EnterWorktree` "can never" enter a `pnpm worktree:new`-created sibling
worktree. That contradicts `starting-work/SKILL.md`'s own documented
default — this session's own `starting-work` invocation for this sweep used
exactly that pairing successfully minutes before the sweep read the log
making the opposite claim. Recorded `deferred` in the tracker with the
reason rather than shipped as a rule regression.

## Outcome

Six rule/skill files edited (`tests.md`, `harness-artifacts.md`,
`subagent-dispatch.md`, `creating-prs/SKILL.md`, `finishing-work/SKILL.md`,
`starting-work/SKILL.md`, `CLAUDE.md`) plus 2 new eval cases (`creating-prs`,
`vitest-coverage-types-mocks`) covering the two lessons that trace to a real
gate/push failure. `_(promoted → …)_` stamps landed across all 11 source
logs. `docs/research/retrospective.md` updated: `last-swept=2026-09-05
logs-considered=155` (117 `promoted`, 30 `no-durable-lesson`, 8 `deferred`,
0 `not-yet-swept`). A missing `MEMORY.md` index pointer for
`worktrees-share-git-hooks-race.md` was also fixed (auto-memory store,
outside git — no PR).

No `src/`, test, or `exports`-map changes; zero semver impact.

The durable finding for the sweep itself: telemetry corroboration (P7) and
live-execution corroboration (the rejected `EnterWorktree` claim) were each
stronger evidence than a second log citation would have been — a lesson
measured or run beats one merely read twice.
