# 0014. Symmetric worktree tooling and corrected prune semantics

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** Enrico Lionello

## Context and problem statement

ADR-0013 formalized git worktrees for task isolation with two scripts:
`worktree:setup` (provision a manually-created worktree) and `worktree:prune`
(batch-remove stale worktrees). A follow-up review of the `core/json` run
(`docs/logs/2026-07-01-core-json.md`) surfaced two problems with the resulting
day-to-day flow:

- **Asymmetric lifecycle.** Creating a manual worktree was two commands
  (`git worktree add …` then `pnpm worktree:setup`), but there was no symmetric
  teardown — the operator had to remember `git worktree remove` + `git worktree
prune` + a manual branch delete. The work log reached for `worktree:prune` and
  it reported "nothing to prune", leaving the worktree in place.
- **A wrong mental model, encoded in docs.** The log — and CLAUDE.md's cleanup
  line — implied `worktree:prune` is location-scoped (only reaps
  `.claude/worktrees/`). It is not: `bin/worktree-prune.mjs` reaps **any**
  worktree whose branch is merged into `main` or that git marks `prunable`,
  regardless of directory. The manual worktree was skipped only because its
  branch was **not yet merged**. The doc framing would mislead the next operator.

## Decision drivers

- Make the safe path the easy path; keep create/teardown **symmetric**.
- Minimal tooling; reuse the existing `bin/*.mjs` + `package.json` script style
  (same driver as ADR-0013).
- Documentation must match the tools' actual behavior.
- No breaking change to the public contract or the release pipeline.

## Considered options

1. Documentation-only fix (correct the prune framing, add a manual-teardown note).
2. Documentation fix **plus** two thin lifecycle scripts (`worktree:new`,
   `worktree:remove`) that wrap the existing primitives.
3. A larger overhaul (glob-aware `.worktreeinclude` copy, per-worktree `.claude/`
   config, auto-install SessionStart hook, age-based sweep of manual worktrees).

## Decision

We chose **option 2**. Option 1 leaves the ergonomic asymmetry that caused the
incident; option 3 is a broad change whose parts (glob copy, per-worktree config,
auto-install) are independent and not yet justified by need. Concretely:

- **`pnpm worktree:new <slug>` (`bin/worktree-new.mjs`)** — one command that
  runs `git worktree add ../m3l-automation-<slug> -b feat/<slug>` (branched fresh
  from `origin/main`, matching ADR-0013's `worktree.baseRef = "fresh"`) and then
  provisions it via the existing `worktree-setup.mjs`. `--fix` selects a
  `fix/<slug>` branch.
- **`pnpm worktree:remove <slug>` (`bin/worktree-remove.mjs`)** — the symmetric
  teardown: `git worktree remove` + `git worktree prune` + delete the branch when
  it is safely merged (`git branch -d`; unmerged branches are kept with a note).
  Refuses to touch the main or current checkout.
- **Corrected docs** — CLAUDE.md now states the accurate `worktree:prune`
  semantics (merged-or-prunable, any location; will not reap an unmerged
  worktree), and the `core/json` log carries an annotated correction.
- **SessionStart hook left advisory.** We considered having
  `guard-worktree-ready.mjs` auto-run `pnpm install`, but a SessionStart hook
  that silently runs a multi-second install is surprising and slow; it keeps
  printing the exact `worktree:setup` command instead. Auto-provisioning belongs
  in `worktree:new`, which the operator invokes deliberately.

Option 3's ideas are recorded here as explicitly deferred, to be revisited if the
manual flow's glob/config gaps bite in practice.

## Consequences

- **Positive:** create and teardown are now single, symmetric commands; the
  documented prune behavior matches the script; the branch-delete step no longer
  relies on operator memory.
- **Negative / trade-offs:** two more maintenance scripts; `worktree:new` assumes
  the `../m3l-automation-<slug>` sibling convention; the deferred option-3 gaps
  (literal-only include copy, no per-worktree `.claude/` config, no auto-install
  for native worktrees) remain.
- **Semver impact:** none — repo tooling and docs only; no change to
  `packages/m3l-common/src/**` or the `exports` map (`chore:` / `docs:`).

## Amendment (2026-07-16)

Three corrections/additions to the tooling described above, surfaced by a
documentation audit:

- **Branch-point fallback.** `worktree:new` branches from `origin/main` when
  available, but falls back to the local `main` branch if `origin/main` is
  absent (erroring only when neither exists) — not the unconditional
  `origin/main` this ADR originally described.
- **Slug validation.** `worktree:new <slug>` validates the slug against
  `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case) and exits with an error on a
  non-conforming slug.
- **`worktree:remove --force`.** `worktree:remove <slug> --force` discards
  uncommitted/untracked changes before removing the worktree, in addition to
  the merged-branch teardown described above.

## Amendment (2026-08-25)

Issue #578 (F25), filed from the F23 field test
(`docs/logs/2026-08-21-f23-field-test-b2.md`): investigating an
existing/abandoned branch (`origin/feat/core-procedure-engine`) had no
supported path through `worktree:new` — it always branches fresh from main
— and the field test fell back to a raw `git worktree add --detach <path>
<ref>`. `worktree:new <slug> --from <ref>` makes that workaround a first-class
command:

- **Detached HEAD, not a new branch.** `--from <ref>` runs
  `git worktree add --detach <worktreePath> <ref>` instead of branching
  `feat/<slug>`/`fix/<slug>` from main. The use case is investigation/audit of
  a branch you don't want to develop on; a detached checkout also sidesteps
  git's refusal to check out a branch that's already checked out elsewhere.
  Because no new branch is created, `--from` and `--fix` are mutually
  exclusive — there's no branch prefix to choose between.
- **Validated the same way as `<slug>`.** `<ref>` must resolve via
  `git rev-parse --verify --quiet` before any worktree is created; a missing
  or unfetched ref errors out with a suggestion to `git fetch` or check the
  spelling, rather than failing deep inside `git worktree add`.
- **`worktree:remove` needed no changes.** Its branch-delete step reads the
  branch from `git worktree list --porcelain` and already skips deletion
  when none is reported — a detached worktree tears down cleanly with the
  existing symmetric command.
- **The MCP wrapper (`worktreeManage` in `bin/lib/mcp-tools.mjs`) grew the
  matching `from` parameter** on `action: "create"`, since it's the interface
  AI agents actually use to drive worktree lifecycle, with the same
  mutual-exclusivity and flag-injection validation as the CLI.

## Amendment (2026-08-25) — squash-merge-aware staleness

`pnpm worktree:prune` was reporting "No stale worktrees to prune." for
worktrees whose branch had already landed and whose `git worktree list` entry
was still present. Root cause: the original prune predicate above (`branch
--merged main` or `prunable`) is an **ancestry** test, and this repo lands
PRs by squash merge — verified against PRs #650/#649/#647, whose head commits
are not ancestors of `main` after merge (`main` carries only the squashed
replacement commit). `git branch --merged main` therefore never contains a
squash- or rebase-merged branch's tip, so `merged` was permanently `false`
for the common case and `prunable` only fires once the directory is already
gone by hand. The prune script was doing exactly what this ADR originally
specified; the specification itself was blind to the repo's actual merge
style.

The staleness predicate (`bin/lib/worktree-prune.mjs`, consumed by
`bin/worktree-prune.mjs`) now checks four signals, any one of which makes a
worktree a candidate:

- **`merged`** — unchanged: `git branch --merged main` (still catches a true
  merge-commit or fast-forward landing).
- **`upstream gone`** — the branch's upstream tracking ref reports `[gone]`,
  the marker GitHub's `deleteBranchOnMerge` leaves behind after **any** merge
  style once the local remote-tracking refs are current. A branch that was
  never pushed has no upstream and can never report `[gone]`, so this cannot
  misfire on in-progress work.
- **`detached at merged commit`** — a `--from <ref>` detached worktree (see
  the `--from` amendment above) whose HEAD is itself an ancestor of `main`.
  The original predicate could never match a detached worktree at all
  (`branch` is `null` for one), so this closes that gap too.
- **`prunable`** — unchanged: git's own directory-gone signal.

Because `[gone]` only updates on a pruning fetch, `worktree:prune` now runs
`git fetch --prune` **by default** (both for a real run and `--dry-run`, so
the preview matches reality) before classifying. `--no-fetch` skips it for
offline use; a failed fetch is a warning, not a hard failure — classification
continues against whatever remote-tracking state is already on disk rather
than blocking a local cleanup tool on network access. Removal behavior is
unchanged: `git worktree remove` (without `--force`) still refuses a dirty
tree, and prune never deletes branches — an `upstream gone` false positive
costs a directory, not commits.

`worktreeManage` (`bin/lib/mcp-tools.mjs`) gained the matching `noFetch`
boolean on `action: "prune"`, validated the same way `dryRun` is (rejected
for any other action).

## Links

- Supersedes / superseded by: none. **Extends ADR-0013** (git worktrees for task
  isolation); ADR-0013 stays `Accepted` — its decisions are unchanged, this ADR
  adds the missing teardown half and corrects the prune framing.
- Related: `docs/logs/2026-07-01-core-json.md` (addendum + correction);
  `bin/worktree-new.mjs`, `bin/worktree-remove.mjs`, `bin/worktree-setup.mjs`,
  `bin/worktree-prune.mjs`, `bin/lib/worktree-prune.mjs`;
  `docs/logs/2026-08-21-f23-field-test-b2.md` and issue #578 (the `--from
<ref>` amendment above).
