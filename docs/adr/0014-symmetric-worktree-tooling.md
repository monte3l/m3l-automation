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

## Links

- Supersedes / superseded by: none. **Extends ADR-0013** (git worktrees for task
  isolation); ADR-0013 stays `Accepted` — its decisions are unchanged, this ADR
  adds the missing teardown half and corrects the prune framing.
- Related: `docs/logs/2026-07-01-core-json.md` (addendum + correction);
  `bin/worktree-new.mjs`, `bin/worktree-remove.mjs`, `bin/worktree-setup.mjs`,
  `bin/worktree-prune.mjs`.
