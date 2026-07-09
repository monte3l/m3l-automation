---
name: starting-work
description: >-
  The pre-work decision gate for m3l-automation. Before any change-work begins,
  it inspects git state, infers and recommends four decisions — where to work
  (shared checkout vs an opt-in linked worktree), the branch (feat/<slug> or
  fix/<slug> off main), whether the change must land via PR, and the push target
  — then confirms every one with the user before a single file is written or a
  branch is created. Invoke this whenever a task will edit code, tests, or
  scripts: the user says "implement", "build", "add", "fix", "edit", "refactor",
  "scaffold", "write the code for", or otherwise starts real work — even when
  they don't name a branch or say "starting-work". It is the mandatory Step 0 that
  implementing-submodules, scaffolding-submodules, scaffolding-scripts, and auditing all run first, so
  isolation is decided up front instead of discovered when guard-branch-isolation
  blocks a write mid-run. Skip it only for pure research, reads, or questions.
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

**Infer and recommend all four decisions, then confirm every one with the user
in a single round. Do not write files, create a branch, or create a worktree
until the user has confirmed.** The user is always free to override a
recommendation; your job is to make the right default obvious, not to force it.

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

### 2 — Infer the change scope

From the task in front of you, work out **which paths will be edited** and
whether any are _guarded_ — under `packages/*/src/**`, `scripts/*/src/**`, or
any `tests/` tree. This drives the PR decision and whether isolation is even
required. A docs-only or `.claude/`-only change touches no guarded path, so the
guard won't fire and a PR may be optional; a change under `src/` or `tests/`
always needs isolation and a PR.

### 3 — Recommend each decision

Derive a concrete default for all four from steps 1–2. Alongside them, surface
(advisory, not a confirmed decision — the hub model is user-selected via
`/model`) the recommended model tier for this task category from the matrix in
`docs/contributing/model-selection.md`:

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

### 4 — Confirm with the user (blocking)

Ask all four in **one** `AskUserQuestion` call, one question per decision, with
your inferred recommendation listed **first** and labelled "(Recommended)". For
the branch, offer the inferred `feat/<slug>` plus an "Other" path for a custom
slug. Make it explicit in your framing that **nothing is written and no
branch/worktree is created until they confirm** — this is the whole point of the
gate.

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

### 6 — Hand back

Report a one-line summary of the confirmed decisions — location, branch, PR
(yes/no), push target — so the calling skill or the user proceeds with the
context recorded. The enforcement backdrop (why this matters) lives in
`guard-branch-isolation.mjs` and ADR-0013/0014.

## Notes for callers

`implementing-submodules`, `scaffolding-submodules`, `scaffolding-scripts`, and `auditing` should run this
as their first step instead of re-deriving isolation inline — it's the single
source of truth for the decision. When one of them calls it, the "infer scope"
step is easy: the caller already knows it will write `src/`/`tests/`, so the PR
answer is yes and isolation is required.
