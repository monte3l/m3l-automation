---
name: resolving-merge-conflicts
description: >-
  Check for and resolve Git merge or rebase conflicts in this repo. Detects an
  in-progress rebase/merge and lists the conflicted paths. Most derived-artifact
  conflicts (catalog.json, symbol-map.json, pnpm-lock.yaml) never reach this
  skill at all — a registered git merge driver (ADR-0024) auto-resolves them and
  a post-rewrite/post-merge hook regenerates them. The remaining scope is real
  src/** or tests/** logic conflicts (handed back), same-module provenance-sidecar
  conflicts, the package.json dependencies block, and same-row tracker/count
  collisions — resolved here, then quality-gated and pushed with signed commits.
  Use this skill whenever the user says /resolving-merge-conflicts, "resolve the
  merge conflicts", "fix the rebase conflict", "the rebase is conflicting", "the
  merge is conflicting", "I have conflict markers", "git says CONFLICT", "help me
  finish this rebase", or when creating-prs / resolving-pr-comments hands back
  because a rebase hit conflicts. Skip for: diagnosing a failed CI run (use
  triaging-ci), fixing review-bot findings (use resolving-pr-comments), and
  code-scanning alerts (use triaging-scan-alerts).
---

# resolving-merge-conflicts

Resolves an in-progress `git rebase` or `git merge` that stopped on conflicts.

**Most derived-artifact conflicts never reach this skill any more (ADR-0024,
PR-3).** `docs/reference/catalog.json`, `docs/reference/symbol-map.json`, and
`pnpm-lock.yaml` are tagged `merge=m3l-generated` in `.gitattributes`; git's
registered custom driver (`bin/merge-driver-generated.mjs`) auto-resolves any
conflict on them by keeping the current side and exiting 0 — no stop, no
manual step — and the `post-rewrite`/`post-merge` lefthook hook
(`bin/post-integrate-regen.mjs`) regenerates them immediately afterward,
reporting dirty files for a `docs: reconcile doc metadata` commit. If the
driver is unregistered (a fresh clone before `pnpm install`), git falls back
to a normal conflict on these files and they land in Step 3's table below
like everything else.

What's left for this skill: real `src/**`/`tests/**` logic conflicts (always
**handed back** — the skill aborts and tells the user to resolve manually, so
it never mechanically picks a stale side and reintroduces a banned pattern
that a PreToolUse hook would then block), same-_module_ `*.provenance.json`
sidecar conflicts (genuine parallel work on one module, not driver-covered),
the `package.json` `dependencies` block (not driver-covered — `pnpm-lock.yaml`
is, but the source-of-truth block itself still needs a union), and a same-_row_
collision in the hand-edited trackers (two branches touching the identical
table row or count site — everything else there is `take-either-side + pnpm
gen:counts`, not a real conflict).

## Boundary rules

- Never `git push --force` to a shared branch. On your own feature branch, at
  most `git push --force-with-lease`.
- Never resolve conflicts while `HEAD` is `main` (or detached on the `main`
  commit) — `guard-branch-isolation` blocks the `src/`/`tests/` edits, and `main`
  is only updated via merged PRs. Abort and hand back instead.
- Never hand-merge generated `dist/`, or a `pnpm-lock.yaml`/`catalog.json`/
  `symbol-map.json` conflict that somehow reaches this skill (driver
  unregistered) — regenerate, don't hand-merge (see Step 3).
- Never auto-pick ours/theirs for a `src/**` / `tests/**` logic conflict, or for
  a same-module provenance conflict, or a same-row tracker collision. Hand it
  back / resolve deliberately, never mechanically.
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

Split the conflicted paths from Step 1 into **driver-missed derived**,
**not-driver-covered**, and **logic**.

`catalog.json`/`symbol-map.json`/`pnpm-lock.yaml` conflicting here at all
means the merge driver is unregistered — run `node bin/install-merge-drivers.mjs`
(or `pnpm install`, which runs it via `prepare`) so the _next_ rebase doesn't
hit this again, then resolve the current one by hand below.

**Driver-missed derived / metadata — resolve by regeneration, never hand-merge:**

| Conflicted path                                                 | Resolution                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                | Take `main`'s version, then `pnpm install` to regenerate against the merged `package.json`.                         |
| `docs/reference/catalog.json`, `docs/reference/symbol-map.json` | Do **not** hand-merge. Leave as-is; `pnpm gen:index` (Step 5) regenerates both from the merged provenance sidecars. |

**Not driver-covered — still needs a deliberate resolution:**

| Conflicted path                                                                                                                               | Resolution                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` → `dependencies` block                                                                                                         | Union the two dependency sets, then `pnpm install`. **Never** touch the `version` field (see below). (`pnpm-lock.yaml` itself is driver-covered; the `dependencies` source block is not.)                                                   |
| `README.md`, `packages/m3l-common/README.md`, `docs/README.md`, `docs/implementation-status.md` — a _different_ count site/table row per side | Not a real conflict — take either side, then `pnpm gen:counts` (Step 5) reconciles every site and the generated implemented-list block from the filesystem-derived counts.                                                                  |
| Same file, but the **identical** count site or `docs/ROADMAP.md`/`docs/plans/IMPLEMENTATION.md` table **row** was edited by both sides        | A real status conflict — two branches disagree about the same item's state. Hand-resolve by picking (or merging the prose of) the row that reflects the true post-merge state, then run `pnpm gen:counts` to reconcile the derived numbers. |
| `*.provenance.json` sidecar — **different** source files/sections per side                                                                    | Not a real conflict — take either side; `node bin/check-doc-provenance.mjs --update` (Step 5) re-stamps blobs for whatever actually changed.                                                                                                |
| `*.provenance.json` sidecar — the **same** source/section edited by both sides                                                                | Real parallel work on one module. Hand-merge the section (keep the union of both sides' true symbol set), then let `--update` re-stamp the blob.                                                                                            |

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

### 4 — Resolve the remaining conflicts and continue

Apply the resolutions from Step 3 (take-main + `pnpm install` for a
driver-missed lockfile; union + `pnpm install` for `dependencies`; the
deliberate pick for a same-row tracker collision or same-module provenance
conflict), then stage and continue:

```bash
git add <resolved-paths>
git rebase --continue   # or: git merge --continue
```

This fires the `post-rewrite`/`post-merge` lefthook hook
(`bin/post-integrate-regen.mjs`, ADR-0024), which regenerates
`catalog.json`/`symbol-map.json` (`gen:index`), the count sites and
implemented-list block (`gen:counts`), and re-stamps provenance blobs
(`check-doc-provenance.mjs --update`) automatically — it never blocks and
never commits, only reports dirty files. Step 5 below folds its output into
the broader `/syncing-docs` pass rather than trusting it alone, since
`/syncing-docs` also catches `check:doc-exports`, test counts, and
`lint:md`, which the hook doesn't run.

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

- Operation:          rebase | merge (onto <base>)
- Driver-auto-resolved: <count of catalog.json/symbol-map.json/pnpm-lock.yaml conflicts git resolved silently, or "none seen (none conflicted)">
- Resolved here:      <package.json deps / same-row tracker / same-module provenance paths, or "none">
- Handed back:        <logic paths, or "none">
- Docs reconciled:    <N sidecars re-stamped, index + counts regenerated> (via /syncing-docs)
- Quality gates:      ✓ / ✗
- Result:             <short SHA pushed> | aborted and handed back
```

If any logic conflict was handed back, the operation was aborted and nothing was
pushed — make that unambiguous so the user knows to resolve and re-run.
