# 0024. Deterministic prevention of derived-artifact merge conflicts

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Enrico Lionello

## Context and problem statement

Every merge to `main` forced all open parallel worktree branches to rebase
and re-resolve the **same** conflicts on derived-artifact / tracker /
provenance files, even when the branches touched entirely different
submodules. An audit found five root causes:

1. **Commit-addressed provenance sidecars.** `bin/check-doc-provenance.mjs`
   verified staleness via `git diff --quiet <section.commit> -- <file>`, so
   _any_ rebase invalidated all 22 `*.provenance.json` sidecars even with
   byte-identical sources, and each branch's `--update` re-stamped **every**
   validated sidecar with its own HEAD SHA + date — guaranteed cross-branch
   textual conflicts. CI (`check:provenance`) hard-failed on the resulting
   staleness.
2. **Global derived index** — `catalog.json`, `symbol-map.json`, and the
   generated `docs/reference/README.md` blocks derive from the status table
   plus all sidecars; any branch touching any submodule rewrote the same
   shared files.
3. **Count-prose fan-out** — `check:doc-counts` and `check:impl-counts`
   forced every branch to hand-edit the same badge/prose sites; the checks
   were check-only, with no generator to make the edit deterministic.
4. **Hand-authored aggregate hotspots** — `docs/implementation-status.md`'s
   enumerating sentence, `docs/ROADMAP.md`'s "Status snapshot", and
   `docs/plans/IMPLEMENTATION.md` were aggregated prose rewritten by every
   branch that shipped anything.
5. **Zero git-level machinery** — no `.gitattributes` `merge=` entries, no
   custom merge drivers, no rerere; conflict handling on these files was
   entirely model-driven.

## Decision drivers

- Rebases and cross-branch merges of unrelated submodules must produce zero
  conflicts on derived files.
- Prefer deterministic, local mechanisms (content-hashing, generators, git
  merge drivers) over process discipline that has to be remembered every
  time.
- Don't change GitHub-side merge policy or branch protection — the fix is
  entirely in-repo.
- Land the change in independently reviewable, sequential PRs rather than
  one large one.

## Considered options

1. **Do nothing; rely on skill-guided manual resolution.** Status quo — cheap
   but the conflict count scales with the number of concurrent branches and
   the model-driven resolution is error-prone (wrong side taken, partial
   regeneration).
2. **GitHub merge queue / stricter branch protection.** Addresses merge
   ordering, not the underlying cause: derived files would still textually
   conflict within the queue.
3. **`git rerere`.** Records prior resolutions for replay, but a resolution
   recorded once still has to happen once per file per divergent pair; it
   doesn't stop the conflict, only cuts down re-solving the _same_ one twice.
4. **Content-hash provenance + derivable trackers + custom git merge
   drivers.** Attacks each root cause directly: sidecars stop conflicting
   because they stop encoding commit-relative state; trackers stop
   conflicting because they stop containing hand-merged aggregate prose;
   fully-generated files auto-resolve via a merge driver and regenerate
   post-rewrite.

## Decision

We chose **option 4**, delivered as three sequential, dependency-ordered PRs
(derivability before the git-machinery that leans on it):

1. **`feat/provenance-content-hash` (PR-1).** Provenance sidecars switch from
   commit-SHA to git-blob-SHA (content-hash) addressing. Each
   `sources[].blob` records the file's content hash at last verification;
   `retrieved` bumps only for sections whose source content actually
   changed; `--update` skips writing any sidecar with nothing stale. A
   rebase that leaves sources byte-identical now touches zero sidecars,
   because the check no longer depends on which commit last touched the
   file — only on the file's bytes. Schema (`provenance.schema.json`) drops
   the section-level `commit` field entirely (line-range reproducibility
   moves to `git cat-file blob <blob>`). The verification/update core moves
   to `bin/lib/doc-provenance.mjs` (unit-tested), with `bin/check-doc-provenance.mjs`
   as a thin CLI wrapper — same flags, same exit contract.
2. **`feat/derivable-trackers` (PR-2).** The remaining hand-merged
   aggregate-prose surfaces become regenerate-don't-hand-merge: a
   `pnpm gen:counts` generator (sharing site inventories with the existing
   `check:doc-counts`/`check:impl-counts` checkers via
   `bin/lib/count-sites.mjs`, mirroring the `gen:index`/`check:index`
   gen/check pairing) rewrites every numeric badge/prose site and the
   generated implemented-list block in `docs/implementation-status.md`.
   `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` drop their
   aggregated "Status snapshot" prose in favor of a **one item = one table
   row** convention, so a status change touches only its own row.
   `gen:commit-stats` moves to main-only (never run at branch time), since
   its README badges legitimately differ per branch and regenerating them
   mid-branch is itself a source of churn.
3. **`feat/derived-merge-drivers` (PR-3).** A custom git merge driver
   (`bin/merge-driver-generated.mjs`) is registered (via `prepare` and
   `worktree:setup`, so it's active in every worktree from a fresh clone) for
   the remaining fully-generated files (`catalog.json`, `symbol-map.json`,
   `pnpm-lock.yaml`). On conflict it keeps the current side and exits 0 —
   it deliberately does not regenerate mid-merge, since the working tree is
   half-merged at that point. A `post-rewrite`/`post-merge` lefthook stage
   runs the generators afterward and reports the dirty files for a normal
   `docs:` reconcile commit; it never auto-commits and never blocks. No
   driver is registered for `*.provenance.json` (PR-1 already removes
   cross-module conflicts there; a same-module conflict is real parallel
   work on one module and should be hand-merged) or for hand-edited files
   (`README.md`, `CLAUDE.md`, trackers).

**Explicitly out of scope:** GitHub merge queue / branch-protection changes;
CI gates for `ROADMAP.md`/`IMPLEMENTATION.md` (the row-locality convention is
structural, not gated); `git rerere` (superseded by deterministic
regeneration); PR merge-method documentation.

## Consequences

- **Positive:** two branches touching different submodules can be rebased
  and cross-merged with zero manual conflict resolution on derived files;
  `check:provenance` survives a rebase with zero re-stamps when sources are
  unchanged; the `syncing-docs` skill's re-stamp guidance simplifies (bare
  `--update` is safe; `--affected` becomes an optional optimization, not a
  discipline requirement).
- **Negative / trade-offs:** three new/changed generator scripts
  (`doc-provenance.mjs`, `gen-doc-counts.mjs`, `merge-driver-generated.mjs`,
  `post-integrate-regen.mjs`) to maintain; the merge driver's "keep current
  side, regenerate after" contract requires operators to know a post-merge
  `docs:` commit may be needed — surfaced by the post-rewrite/post-merge hook
  output, not silent.
- **Semver impact:** none — repo tooling, docs metadata, and hooks only; no
  change to `packages/m3l-common/src/**` or the `exports` map. Each PR lands
  as `feat:` (tooling-facing behavior change) or `docs:` (the migration
  commit) as appropriate.

## Links

- Supersedes the commit-SHA provenance model introduced alongside the
  original `docs/reference` scaffolding.
- Related: `bin/lib/doc-provenance.mjs`, `bin/check-doc-provenance.mjs`,
  `docs/reference/provenance.schema.json`,
  `.claude/skills/syncing-docs/SKILL.md`,
  `.claude/skills/resolving-merge-conflicts/SKILL.md` (PR-3 narrows its
  remit), ADR-0013/0014 (worktree isolation, the mechanism that surfaced
  this conflict pattern in the first place).
