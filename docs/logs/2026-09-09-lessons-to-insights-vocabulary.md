# Work log — `lessons-to-insights-vocabulary` (2026-09-09)

This log covers the three-PR rename of the project's undefined "lesson"
concept to a strictly defined **observation → insight** two-stage vocabulary
(glossary + ADR-0099), landing as PR #1137's squash merge
(`d28ed700707fe63821157bbd0f2553bd3d61dbfa`). It records what shipped across
all three PRs, what matched the plan, what diverged (a mid-review dependency
block, a CI-flake dispute, a rebase conflict in a generated provenance file),
and durable insights for the next multi-PR vocabulary or rename change.

Plan of record: [`docs/plans/archive/2026-09-09-lessons-to-insights-vocabulary.md`](../plans/archive/2026-09-09-lessons-to-insights-vocabulary.md)

## Summary

Three PRs, ~40 files total, all landed on `feat/lessons-to-insights` →
`main` via a single squash merge:

- **PR1** — `docs/contributing/glossary.md` (new) and ADR-0099 defined the
  two-stage vocabulary: **observation** (raw, run-specific noticing) →
  **insight** (generalized, actionable claim; candidate/promoted states).
  `docs/README.md` and `docs/adr/README.md` registered both.
- **PR2** — `git mv .claude/skills/promoting-work-log-lessons/`
  → `promoting-work-log-insights/`, rewrote `SKILL.md` and `evals/evals.json`,
  and added a `RENAMED_TARGETS` alias in `bin/lib/promotion-stamps.mjs` so
  every pre-existing promotion stamp pointing at the old
  `promoting-work-log-lessons/SKILL.md` path (in an immutable `docs/logs/`
  entry) keeps resolving. Mechanical dependents (gates, catalog, tests,
  fixtures, provenance) updated in the same PR.
- **PR3** (this PR, #1137) — `writing-work-logs/SKILL.md`'s
  `### Lessons learned` → `## Insights` template section, dual/triple-heading
  recognition (`## Lessons learned` / `## Lessons` / `## Insights`, since 175
  pre-cutover logs are never rewritten), and a full prose sweep of
  `docs/research/retrospective.md`'s 155-row ledger (including the
  `no-durable-lesson` → `no-durable-insight` outcome token), `CLAUDE.md`, and
  several `docs/contributing/` pages. `docs/logs/README.md` and
  `docs/plans/README.md` got registration-only edits; `docs/logs/` and
  `docs/plans/archive/` content itself was left untouched (immutability
  convention).

Verification: `pnpm verify --continue` passed 80/81 steps pre-rebase (the one
failure a pre-existing, unrelated `js-yaml`/`nodemailer` audit finding).
After a mid-review rebase onto `main` (see divergence #4), the full gate
sequence — `lint`, `typecheck`, `build-cli`, `test:coverage` across all four
coverage configs (608 test files, all green), `build`, `knip`,
`check:command-catalog`, `check:promotion-stamps` — passed clean. Final bot
review verdict: **PASS**, no Must-fix / Should-fix / Nit items.

Skills used: `starting-work`, `syncing-docs`, `creating-prs`,
`triaging-ci`, `finishing-work`, `writing-work-logs`.

Spoke incidents: none (this task ran no writer/reviewer spoke dispatches —
docs-only diffs used `docs-consistency-reviewer` directly, and PR3's
pre-push review dispatched it once, clean).

Compaction events: 1 compaction (mid-session, after the issue-#1087 comment
was posted and corrected) / 1 recovered via handoff — the PreCompact/
SessionStart(compact) handoff correctly preserved the branch/worktree state,
the open PR number, and the pending Step-15 merge-path instruction; no state
loss observed.

## What went as planned

- **The `RENAMED_TARGETS` mechanism worked exactly as designed on first try**
  — the same pattern as the `sync-docs` → `syncing-docs` precedent. All 313
  promotion stamps and 107 reverse log citations resolved after the skill
  rename, with no manual stamp edits needed.
- **The dual-heading recognition change required zero logic changes** to the
  sweep skill's scan beyond the heading-pattern list itself — `check-retrospective.mjs`
  never parsed `no-durable-lesson` literally and `logs_query` only reads log
  titles, exactly as the plan's pre-verification predicted.
- **All three PRs' bot reviews returned PASS with zero Must-fix/Should-fix**
  on first submission (PR1, PR2) or after the mid-review rebase (PR3) — the
  mechanical rename stayed internally consistent across `bin/`, skill
  frontmatter, and eval fixtures throughout.
- **The `js-yaml`/`nodemailer` dependency-audit block self-resolved** without
  any action from this branch — an unrelated dependency-fix PR (#1138/#1139)
  landed on `main`, and rebasing PR3 onto it picked up the fix automatically.

## What didn't go as planned, and why

### 1. A double-backgrounded `git push` gave a false-completion signal

Running `git push -u origin HEAD > log 2>&1 &` inside a
`run_in_background: true` Bash tool call produced a premature "completed
(exit code 0)" task notification — the harness tracked only the wrapper
shell (which echoed a PID and exited instantly after backgrounding), while
the real `git push`/lefthook pre-push process kept running detached and
invisible.

**Why it happened:** Backgrounding a command twice (once via the shell's own
`&`, again via the tool's `run_in_background`) makes the harness observe the
outer wrapper's exit, not the inner process's.

**Fix for future:** Never combine shell-level `&` with `run_in_background:
true` for the same command. Use one or the other — a plain foreground call
with `run_in_background: true`, or a detached `nohup cmd > log 2>&1 & disown`
polled by PID via a separate `kill -0` loop.

### 2. `ScheduleWakeup` delays did not reliably advance real wall-clock time

Several `ScheduleWakeup` calls with 300–1200s delays, used to monitor a
long-running `pnpm verify`/`git push`, returned near-instantly across many
turns with minimal actual timestamp advancement — making that mechanism
unreliable for background-process completion tracking.

**Why it happened:** `ScheduleWakeup` is designed for pacing a `/loop`
session between turns, not for blocking on a specific background process's
completion.

**Fix for future:** For "wait until this specific process finishes," use a
synchronous foreground `Bash` call with `timeout <N> bash -c 'until ! kill -0
<pid>; do sleep <k>; done'` instead of `ScheduleWakeup`. This session
switched to that pattern for both `pnpm verify` and `git push` monitoring
and it was reliable both times.

### 3. A disputed "flake" assessment led to a real (but pre-existing) finding

`/triaging-ci`'s initial pass on the `Run skill evals` CI failure diagnosed
it as "Likely flake." The user explicitly pushed back: "skill-eval failed
again; this is not a flake, investigate." Deeper investigation confirmed a
real, reproducible failure pattern specific to `promoting-work-log-insights`'
eval cases #1/#2, but a same-content comparison run on `main` (pre-rename)
showed the identical failure — proving the pattern pre-dates and is
unrelated to this PR. It's a structural gap in the eval harness's `/slug`-
dispatch simulation (case #2 is a `/slug`-invoked prompt; per
`skill-routing.md`, the harness likely never emits an observable `Skill`
tool-use block for that dispatch path the way production interception
would).

**Why it happened:** A CI job re-running and failing identically twice looks
identical whether the cause is transient (flake) or a specific, deterministic
defect — the two are indistinguishable from the pass/fail signal alone and
require actually reading the failure content to disambiguate.

**Fix for future:** Never accept a "likely flake" verdict on a second
identical failure without comparing the exact failure content against a
known-good baseline (here: the same eval content on `main`). This is what
correctly separated "the pattern is real" from "the pattern is caused by my
change" — findings were filed as a comment on the existing tracking issue
(#1087) rather than either disputing the user's correction or opening a
duplicate issue.

### 4. Rebasing onto `main` mid-review produced two `docs/adr/provenance.json` conflicts

Picking up the merged dependency fix required rebasing PR3 onto `main`,
which produced two conflicts in `docs/adr/provenance.json` — a generated
blob-SHA stamp file that is _not_ covered by the `.gitattributes`
`merge=m3l-generated` driver the way `catalog.json`/`symbol-map.json`/
`pnpm-lock.yaml` are. Resolved by keeping HEAD's side per conflict, then
running `pnpm gen:adr-provenance` afterward rather than trusting the manual
resolution — the regeneration changed 37 more lines than the manual pick had
gotten right.

**Why it happened:** `docs/adr/provenance.json` stamps a blob SHA per cited
source file; when both sides of a rebase touch a commonly-cited file (here,
`bin/lib/command-catalog.mjs` and `docs/logs/README.md`, both touched by
this branch and by unrelated `main` commits), the stamps genuinely conflict
textually even though the "correct" answer is always "whatever the final
rebased tree's content actually is" — not resolvable by picking either side.

**Fix for future:** Never hand-resolve a conflict in a generated/derived
file by picking a side and moving on — regenerate it via its own generator
command immediately after the conflicting commit lands, even if the manual
pick looks locally plausible. This applies beyond the `.gitattributes`-
covered files (`catalog.json`, `symbol-map.json`, `pnpm-lock.yaml`) to any
file with a dedicated `pnpm gen:*` regenerator, `docs/adr/provenance.json`
included.

## Insights

- **Regenerate derived files after a conflict, never hand-merge them.** A
  generated file's manual conflict resolution can look plausible and still
  be measurably wrong (37 stale lines here) — if a `pnpm gen:*` command
  exists for the file, run it immediately after resolving the conflict
  rather than trusting the picked side. _(promoted →
  `.claude/skills/creating-prs/SKILL.md`)_
- **Don't combine shell-level `&` with `run_in_background: true`.** Doing
  both backgrounds a command twice — the harness tracks only the outer
  wrapper's exit, producing a false-completion signal while the real process
  keeps running detached.
- **Use `timeout … kill -0` polling, not `ScheduleWakeup`, to wait on a
  specific background process.** `ScheduleWakeup` is for `/loop` pacing
  between turns; it does not reliably block on one process's actual
  completion.
- **A second identical CI failure is not proof of either "flake" or "my
  bug"** — disambiguate by comparing the failure's exact content against a
  known-good baseline (here, the same eval content pre-rename on `main`)
  before accepting either the flake dismissal or a blanket "it's my PR's
  fault" correction. When the finding turns out to be real but unrelated,
  file it on the existing tracking issue as evidence, not as a new issue or
  a fix commitment.
- **A `RENAMED_TARGETS` alias entry is the correct, low-risk mechanism for
  any skill/tool rename that immutable logs cite by path** — it worked
  cleanly here exactly as it did for `sync-docs` → `syncing-docs`, with zero
  stamp breakage across 313 stamps / 107 reverse citations.
