---
name: resolving-merge-conflicts
description: >-
  Check for and resolve Git merge or rebase conflicts in this repo. Detects an
  in-progress rebase/merge, lists the conflicted paths, and resolves the safe,
  derived-artifact conflicts by regeneration (lockfile, dependency block, "N of
  22" count prose, reference index, provenance) while handing back any real
  src/** or tests/** logic conflict for the user to resolve. Reconciles docs via
  /syncing-docs, re-runs the quality gates, and finishes the operation with
  signed commits. Use this skill whenever the user says /resolving-merge-conflicts,
  "resolve the merge conflicts", "fix the rebase conflict", "the rebase is
  conflicting", "the merge is conflicting", "I have conflict markers", "git says
  CONFLICT", "help me finish this rebase", or when creating-prs / resolving-pr-comments
  hands back because a rebase hit conflicts. Skip for: diagnosing a failed CI run
  (use triaging-ci), fixing review-bot findings (use resolving-pr-comments), and
  code-scanning alerts (use triaging-scan-alerts).
---

# resolving-merge-conflicts

Resolves an in-progress `git rebase` or `git merge` that stopped on conflicts.
The safe, derived-or-metadata conflicts (lockfile, `dependencies`, count prose,
reference index, provenance sidecars) are resolved **by regeneration, never by
hand-merge** — mirroring the derived-artifact exception in `creating-prs` Step 2.
Any conflict in real `src/**` / `tests/**` logic is **handed back**: the skill
aborts the operation and tells the user to resolve it manually, so it never
mechanically picks a stale side and reintroduces a banned pattern (`any`, a
missing `.js` extension, CommonJS) that a PreToolUse hook would then block.

## Boundary rules

- Never `git push --force` to a shared branch. On your own feature branch, at
  most `git push --force-with-lease`.
- Never resolve conflicts while `HEAD` is `main` (or detached on the `main`
  commit) — `guard-branch-isolation` blocks the `src/`/`tests/` edits, and `main`
  is only updated via merged PRs. Abort and hand back instead.
- Never hand-merge `pnpm-lock.yaml`, generated `dist/`,
  `docs/reference/catalog.json`, or provenance sidecars — regenerate them or let
  their owner (the generators, `/syncing-docs`) produce them.
- Never auto-pick ours/theirs for a `src/**` / `tests/**` logic conflict. Hand it
  back.
- Pushed commits must be signed — preserve signing across the resolution.

## Steps

### 1 — Detect the in-progress operation

Determine whether a rebase or a merge is underway and capture the conflicted
paths:

```bash
git status --short
ls .git/REBASE_HEAD .git/MERGE_HEAD 2>/dev/null   # which operation is live
git diff --name-only --diff-filter=U               # conflicted (unmerged) paths
```

- `.git/REBASE_HEAD` present → a **rebase** is in progress (continue/abort with
  `git rebase`).
- `.git/MERGE_HEAD` present → a **merge** is in progress (continue/abort with
  `git merge`).
- If `git diff --diff-filter=U` is empty and neither marker file exists, there
  are no conflicts to resolve — report "no merge/rebase in progress, nothing to
  resolve" and stop.

### 2 — Isolation preflight

Confirm the working tree is on an isolated feature branch, not `main`:

```bash
git rev-parse --abbrev-ref HEAD
```

If the branch is `main` (or a detached `HEAD` sitting on the `main` commit),
**abort and hand back** — resolving `src/`/`tests/` edits there is blocked by
`guard-branch-isolation`, and this repo updates `main` only through merged PRs:

```bash
git rebase --abort   # or: git merge --abort
```

Tell the user to perform the merge/rebase from their feature branch (rebase the
feature branch onto `main`, not the reverse), then re-run this skill.

### 3 — Classify each conflicted path

Split the conflicted paths from Step 1 into **derived-artifact** vs **logic**.

**Derived / metadata — resolve by regeneration (safe for this skill):**

| Conflicted path                                                                                   | Resolution                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                                                  | Take `main`'s version, then `pnpm install` to regenerate against the merged `package.json`.                                                                                                                                                                                                                                                         |
| `package.json` → `dependencies` block                                                             | Union the two dependency sets, then `pnpm install`. **Never** touch the `version` field (see below).                                                                                                                                                                                                                                                |
| `README.md`, `packages/m3l-common/README.md`, `docs/README.md` — the "N of 22" count badges/prose | Take either side, then run `pnpm gen:counts` (Step 5) — it rewrites every site from the filesystem-derived counts, so which side you took doesn't matter.                                                                                                                                                                                           |
| `docs/implementation-status.md` — the `<!-- BEGIN/END GENERATED IMPLEMENTED-LIST -->` block       | Take either side, then run `pnpm gen:counts` (Step 5) — regenerated from the ✅ rows, same as the count badges above. A conflict on the ✅ **table rows themselves** (two branches flipping the _same_ row) is a real status conflict, not derived — resolve it by hand (pick the row that reflects the true post-merge state) before regenerating. |
| `docs/reference/catalog.json` (reference index)                                                   | Do **not** hand-merge. Leave it; `/syncing-docs` regenerates it via `pnpm gen:index` in Step 5.                                                                                                                                                                                                                                                     |
| `*.provenance.json` sidecars                                                                      | Do **not** hand-merge. `/syncing-docs` re-stamps them to the live post-resolution commit in Step 5.                                                                                                                                                                                                                                                 |

**Never hand-resolve — abort if these are the only way forward:**

- `package.json` `version` — hand-managed (the package is internal, not
  published). If it conflicts, take `main`'s value verbatim (never invent a
  version); reconcile it intentionally later, not mid-conflict.
- `dist/` — generated output; regenerate with `pnpm build`, never hand-merge.

**Logic — hand back (`src/**`, `tests/**`, or any real hand-authored code):**

Capture the conflicted logic paths, abort the operation, and stop:

```bash
git diff --name-only --diff-filter=U   # re-capture for the report
git rebase --abort                     # or: git merge --abort
```

Tell the user exactly which files carry logic conflicts and that they must
resolve them manually (`git rebase origin/main` / `git merge`, edit, `git add`,
`git rebase --continue` / `git merge --continue`), then re-run this skill.
Do **not** auto-pick a side — a stale hunk can reintroduce `any`, a missing
`.js` extension, or CommonJS, which the PreToolUse hooks will then block.

### 4 — Resolve the derived conflicts and continue

Apply the regenerations from Step 3 (take-main + `pnpm install` for the
lockfile/deps; flip the status row for count prose), then stage and continue:

```bash
git add <resolved-derived-paths>
git rebase --continue   # or: git merge --continue
```

**Preserve signing.** Pushes are signature-gated. If the user's
`commit.gpgsign` is unset, re-sign the resulting commits using the same recovery
pattern `verify-signed-range` documents:

```bash
# rebase: re-sign each replayed commit
git rebase --exec 'git commit --amend --no-edit -S' origin/main
# merge: sign the merge commit
git commit --amend --no-edit -S
```

If a further conflict surfaces mid-continue, return to Step 3 for the newly
conflicted paths.

### 5 — Reconcile docs, then re-run the quality gates

The resolution touched derived files, so reconcile doc metadata **before**
committing anything further. Invoke `/syncing-docs` — it re-stamps provenance to
the live post-resolution commit, runs `pnpm gen:counts` to reconcile the
"N of 22" counts and the implemented-list block, and regenerates
`catalog.json`. It only mutates working-tree files; it never commits.

`/syncing-docs` runs `pnpm lint:md`, which can fail — surface a `lint:md` failure
like any other gate (fail fast, hand back). Then run the full pipeline:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

Stop on the first failure and show the exact output — a merge can introduce a
type error or a broken test even when every hunk merged cleanly.

### 6 — Commit the reconciliation and push

If `/syncing-docs` produced working-tree changes, stage and commit them as a
standalone reconciliation commit (this repo's "reconcile counts and index after
rebasing onto main" pattern):

```bash
git add -A
git commit -S -m "docs: reconcile doc metadata after conflict resolution"
```

Then push. Never `--force`; a rebased feature branch may need
`--force-with-lease`, which is safe only on your own branch:

```bash
git push               # or, if the rebase rewrote already-pushed history:
git push --force-with-lease
```

### 7 — Report

Summarise for the user:

```text
## /resolving-merge-conflicts summary

- Operation:        rebase | merge (onto <base>)
- Auto-resolved:    <derived paths regenerated>
- Handed back:      <logic paths, or "none">
- Docs reconciled:  <N sidecars re-stamped, index regenerated> (via /syncing-docs)
- Quality gates:    ✓ / ✗
- Result:           <short SHA pushed> | aborted and handed back
```

If any logic conflict was handed back, the operation was aborted and nothing was
pushed — make that unambiguous so the user knows to resolve and re-run.
