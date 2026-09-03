---
name: starting-work
description: >-
  The pre-work decision gate: inspects git state, recommends location, branch
  (feat/fix <slug>), session name (ADR-0087/0088), PR requirement, push target, and
  PR sequence (ADR-0072) for multi-unit scope — confirmed before any write.
  Invoke for "implement", "build", "fix", "refactor", even unnamed. Skip for
  research/questions.
---

# starting-work

This skill is the single place the repo answers "where do I do this work?"
before touching anything. That question used to be re-derived independently in
four spots (`guard-branch-isolation.mjs`, `implementing-submodules` Step 0, `auditing`,
`creating-prs`), and the scaffolding skills wrote guarded paths with no isolation
step at all — so they hit `guard-branch-isolation.mjs` mid-run instead of
branching proactively. Centralizing the decision here keeps the answer
consistent and gets it made _before_ the first edit, which is the only time it's
cheap to change.

## Why a gate at all

`guard-branch-isolation.mjs` hard-blocks writes to `packages/*/src/**`,
`scripts/*/src/**`, and `**/tests/**` while `HEAD` is `main`. That's a
backstop, not a plan: if you discover it when a write is rejected, you're
already mid-task with a dirty tree. Building on `main` left the working tree
dirty for a whole run once (`docs/logs/2026-07-01-core-analysis.md`,
divergence 7). This skill is the workflow half — it branches _before_ the block
can fire — and it makes the branch/PR/push choices explicit so nothing silently
lands on `main`.

## The contract

**Infer and recommend all decisions, then confirm every one with the user in a
single round. Do not write files, create a branch, or create a worktree until
the user has confirmed.** The user is always free to override a
recommendation; your job is to make the right default obvious, not to force it.
Location, branch, session name, PR-required, and push target are always
decided. The sixth decision — PR sequence — is decided only when Step 2 finds
the scope spans several independently-landable units; otherwise it is
silently skipped rather than asked about.

## Steps

### 1 — Inspect git state (read-only)

Gather the facts you'll reason from. None of these mutate anything:

```bash
git rev-parse --abbrev-ref HEAD      # branch name; "HEAD" means detached
git rev-parse --git-common-dir       # differs from --git-dir inside a linked worktree
git rev-parse --git-dir
git status --porcelain               # is the tree already dirty?
```

- If the branch is `HEAD` (detached), compare `git rev-parse HEAD` against
  `git rev-parse main` — a detached HEAD sitting on the `main` commit is treated
  as `main` for isolation purposes (it's the same tree state the guard protects).
- If `--git-common-dir` and `--git-dir` resolve differently, you're already in a
  linked worktree — note it; the location decision is likely settled.
- **Re-run this inspection after any conversational gap, not just at the
  start.** A worktree is not a stable fact: a concurrent session rewriting
  history, or its own `finishing-work` close-out, can delete the directory or
  the branch out from under an in-flight task — and a `cd` into a path that no
  longer exists silently lands you back in the shared checkout, where a peer
  session's branch switching has discarded uncommitted edits. Four logs record
  this (`2026-09-03-statusline-redesign.md`,
  `2026-09-03-skill-invocation-and-listing-budget.md`,
  `2026-09-03-worktree-new-lib-extract.md`,
  `2026-09-03-x12-container-stance-and-loopback-refactor.md`). Confirm the
  location still holds before writing, including for a work log or a rule
  promotion — a close-out resets the location decision, not just the branch.
- **Resume check.** If the tree is dirty (a non-empty `git status --porcelain`)
  AND `tmp/compact-handoff.json` exists with a `branch` field matching the
  current branch, this looks like a resume of interrupted work rather than a
  fresh task — read the handoff's `branch`, `lastCommit`, `uncommittedFiles`,
  `journals`, and `capturedAt` so Steps 3–4 can offer a resume path instead of
  defaulting to greenfield. A handoff naming a _different_ branch is not a
  resume signal for the current task — ignore it.

### 2 — Infer the change scope

From the task in front of you, work out **which paths will be edited** and
whether any are _guarded_ — under `packages/*/src/**`, `scripts/*/src/**`, or
any `tests/` tree. This drives the PR decision and whether isolation is even
required. A docs-only or `.claude/`-only change touches no guarded path, so the
guard won't fire and a PR may be optional; a change under `src/` or `tests/`
always needs isolation and a PR.

Also decide whether the scope is **one landable unit or several.** It spans
several when the task already implies independently mergeable slices — a
process/tooling change with a docs-only part and a code part (ADR-0072's
docs-vs-code split, which measures ~0 reviewable chars and should default to
splitting), a submodule whose seam plan (`implementing-submodules`) projects
more than one PR, or a batch of same-shaped changes across unrelated paths. A
single bug fix or a small, cohesive feature is one unit — most tasks are.

### 3 — Recommend each decision

Derive a concrete default for all decisions from steps 1–2:

- **Resume** — when Step 1 found a resume signal, the right default is to
  **stay** on the current branch/location and pick the interrupted work back
  up, not create a new branch or worktree. Surface this as the first option
  in Step 4 rather than silently overriding the other decisions — the user
  may still prefer to abandon the dirty state and start fresh.
- **Location** — default to the **shared checkout**. Recommend a linked worktree
  (`pnpm worktree:new <slug>`) only when the user signalled concurrent/parallel
  work (e.g. running two pipelines at once); worktrees exist for that, and forcing
  one otherwise just adds churn (ADR-0013).
- **Branch** — recommend `feat/<slug>` (or `fix/<slug>` for a bug fix), with the
  slug derived from the task (kebab-case, short). If the repo is already on a
  suitable non-`main` branch, recommend **staying** on it. Never recommend `main`
  or a detached-on-`main` HEAD for guarded work.
- **PR required?** — **yes** whenever a guarded path is in scope: land via PR,
  never a direct commit to `main` (this matches the require-PR / no-bypass rule in
  `docs/contributing/branch-protection.md`). For docs/config-only changes, note
  that a PR is optional but still recommended.
- **Push target** — `origin <the recommended branch>`. Never `origin main`.
- **Session name** — recommend `<kind>-<slug>` for the _Claude Code session_
  itself (ADR-0087/ADR-0088, `docs/contributing/contributing.md` § Session
  naming), reusing the same slug just decided for the branch so the two
  cannot disagree: `kind` is `feat`/`fix` when a branch was recommended
  (mirroring its prefix), or `audit`/`research`/`docs`/`review`/`ci`/`merge`
  for `main`-resident work with no branch to mirror. No hook can apply this
  for the user, so the recommendation must give the literal command to
  run — `pnpm session:launch` (no arguments) when a new session/worktree is
  about to open on a `feat/<slug>`/`fix/<slug>` branch, since the branch
  alone determines the name; `pnpm session:launch --kind <kind> <slug>` for
  `main`-resident work with no branch to derive from. A session already
  running (continuing the current one) has no launch-time hook left to use —
  that residual case still needs `/rename <kind>-<slug>` by hand.
- **PR sequence** — only surfaced when Step 2 found several landable units.
  Recommend the order (docs-first when the scope mixes docs and code — that
  slice is free to review and unblocks the rest; otherwise by path cluster or
  by the seam plan's projected order) and name each slice's branch. This is
  the ADR-0072 discipline applied at plan time, before the first commit exists
  to split.
- **Model tier (advisory only)** — name the recommended model + effort for this
  task category from the matrix in `docs/contributing/model-selection.md`
  (e.g. "matrix row 2: Opus 5 at `xhigh` for a single-sitting implementation").
  For a plan-then-implement task (rows 1–2 — an audit/plan skill like
  `/auditing` followed by implementation in the same or a later session),
  recommend `/model opusplan` instead of a single fixed tier: Opus during
  plan mode, Sonnet once execution starts. State it alongside the other
  decisions in your summary; do **not** add it to the Step-4 confirmation
  questions — the hub model is user-selected via `/model`, so this is a
  recommendation the user may act on, not a decision to confirm.

### 4 — Confirm with the user (blocking)

When Step 1 found a resume signal, ask a **resume-or-fresh** question first,
in the same `AskUserQuestion` call as the rest: "Resume the in-flight work on
`<branch>` (recommended)" vs "Start fresh — treat this as a new task". If the
user picks resume, skip the Location/Branch/PR-required/push-target questions
entirely (staying put is implied) and go straight to Step 5's "Staying put"
path — but still ask the session-name question, since it names the current
Claude Code session rather than the git state Step 5 is settling. If they
pick fresh, proceed with the normal confirmation below as if no resume signal
had been found.

Ask every decision that applies in **one** `AskUserQuestion` call — always
location, branch, session name, PR-required, and push target; PR sequence only
when Step 2 found several landable units — one question per decision, with
your inferred recommendation listed **first** and labelled "(Recommended)".
For the branch, offer the inferred `feat/<slug>` plus an "Other" path for a
custom slug; for the session name, offer the inferred `<kind>-<slug>` plus an
"Other" path for a custom name. Make it explicit in your framing that
**nothing is written and no branch/worktree is created until they confirm**
— this is the whole point of the gate.

If the user has _already_ told you the branch/worktree to use (e.g. "do it on
`fix/foo`"), don't re-ask that dimension — treat it as confirmed and only
surface the decisions still open.

### 5 — Act on the confirmed decisions

Once confirmed:

- **New worktree:** `pnpm worktree:new <slug>` — creates the sibling worktree
  branched from `origin/main` and provisions it. Continue work inside it.
- **New branch in place:** `git switch -c feat/<slug>` (or `fix/<slug>`).
- **Staying put:** verify `HEAD` is neither `main` nor detached-on-`main` before
  handing back; if it is, loop back to step 4 rather than proceeding into a write
  that the guard will reject. When **resuming an existing feature branch** that
  may have fallen behind, resync it with `origin/main` before working (or defer
  to the resync step in `creating-prs`) so the branch does not drift from the
  base over multiple sessions.
- **Session name:** state the confirmed `pnpm session:launch` (or
  `pnpm session:launch --kind <kind> <slug>` for `main`-resident work) command
  to open a new session/worktree already named — this skill cannot invoke it
  on the user's behalf (ADR-0087/ADR-0088: no hook or skill step can set a
  Claude Code session name; the launcher wrapper applies it at process start
  instead). Continuing an already-open session still needs `/rename
<kind>-<slug>` by hand — no launch-time hook is left to use for it.

### 6 — Hand back

Report a one-line summary of the confirmed decisions — location, branch,
session name, PR (yes/no), push target, and the PR sequence when one was
confirmed — so the calling skill or the user proceeds with the context
recorded. The enforcement backdrop (why this matters) lives in
`guard-branch-isolation.mjs` and ADR-0013/0014; the PR-sequence rationale
lives in ADR-0072; the session-naming rationale lives in ADR-0087/ADR-0088.

## Notes for callers

`implementing-submodules`, `scaffolding-submodules`, `scaffolding-scripts`, and `auditing` should run this
as their first step instead of re-deriving isolation inline — it's the single
source of truth for the decision. When one of them calls it, the "infer scope"
step is easy: the caller already knows it will write `src/`/`tests/`, so the PR
answer is yes and isolation is required. `implementing-submodules` also feeds
its own seam plan (its "Seam plan" step, ADR-0072) into the PR-sequence
recommendation when that plan projects more than one PR.
