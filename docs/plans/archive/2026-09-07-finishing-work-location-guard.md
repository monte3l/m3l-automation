# Guard finishing-work's worktree-vs-shared-checkout branch-delete path (issue #1004, H11)

**Status: shipped** — branch `fix/finishing-work-location-guard`.

## Context

`docs/ROADMAP.md`'s H11 governance row (synced to GitHub issue #1004)
reported that `finishing-work` Step 3 deletes a merged branch by running
either `pnpm worktree:remove <slug>` (linked worktree) or `pnpm
branch:cleanup <branch>` (shared checkout), with the choice made by the
executor's own situational awareness — the skill text literally said "this
session is running inside `../m3l-automation-<slug>`" — rather than a
scripted check. `starting-work` Step 1 already has a mechanical discriminator
for the same question (`git rev-parse --git-common-dir` vs `--git-dir`); H11
was the asymmetry that the destructive teardown side lacked it.

Two concrete failure modes followed from the gap: deleting a branch from
inside the linked worktree it had since been switched off of orphaned the
worktree directory outright, and `bin/lib/branch-cleanup.mjs` deliberately
declined to check "checked out in another worktree" at all, deferring to
git's own `branch -d` error — which it then swallowed into a non-fatal
"kept" result recommending `git branch -D`, the one command that also
cannot delete a branch checked out elsewhere.

## Approach / Decisions

- **The guard lives in the scripts**, not as docs-only prose, not a
  `PreToolUse` Bash hook string-matching `pnpm branch:cleanup`/`worktree:remove`
  invocations, and not a new unified dispatcher command — confirmed with the
  user up front. `finishing-work`'s skill text still gained the mechanical
  discriminator (mirroring `starting-work` Step 1), but the load-bearing
  enforcement is at the destructive boundary itself.
- **Two narrow conditions, not a blanket "cwd is a linked worktree" refusal.**
  A broad refusal would have broken `check:staleness`'s
  `pnpm branch:cleanup <branch>` advice, which only ever recommends the
  command for a branch already confirmed attached to no worktree — and that
  gate routinely runs from inside a worktree (three were live during this
  work). Deleting an unattached branch from a linked worktree is safe; the
  ref lives in the shared object store regardless of which worktree stands
  in for it. So the new `validateWorktreeSafe()` predicate checks only:
  the target branch attached to a _different_ linked worktree ("attached"),
  or cwd being the worktree named for the branch's own slug even after it's
  been switched to a different branch ("standing-in" — the orphan case
  `worktreeForBranch` structurally cannot see).
- **New `bin/lib/checkout-location.mjs`**, shaped like `bin/lib/claude-home.mjs`
  (injected git seam, pure), consolidating the
  `dirname(git rev-parse --git-common-dir)` idiom duplicated inline in
  `worktree-new.mjs` and `worktree-remove.mjs`. `kind` and `slug` are
  independent fields on its `CheckoutLocation` result — a hand-made
  `git worktree add ../scratch` is still `kind: "worktree"`, just with
  `slug: null`, which the guard's messages handle as a distinct case rather
  than silently misreading as "main checkout."
- **Hard refusal (exit 1), no new escape-hatch flag.** The "attached" case is
  physics — `git branch -d`/`-D` genuinely cannot delete a branch checked out
  elsewhere — and the "standing-in" case's escape hatches are real commands
  the refusal message already names (`pnpm worktree:remove <slug>`, or a bare
  `git branch -d <branch>` to keep the directory).
- Every test file under `bin/tests/**` is a guarded hub-write path
  (`guard-hub-src-writes.mjs`), so both the new `checkout-location.test.ts`
  and the extended `branch-cleanup.test.ts` were pre-verified in the
  scratchpad against the real source (a throwaway `vitest.config.ts`, per
  `.claude/rules/subagent-dispatch.md`) before being handed to `test-author`
  as byte-for-byte placement content. Each of `validateWorktreeSafe`'s three
  decision branches was mutation-tested by hand (deleting the "attached"
  arm, the "standing-in" arm, and loosening the standing-in slug comparison
  to match any worktree location) — each mutation broke a distinct existing
  test before being reverted.

## Outcome

Landed as 5 commits: the `checkout-location` lib + tests, a pure dedupe of
`worktree-new.mjs`'s inline git-common-dir resolution, a message split for
`worktree-remove.mjs`'s previously combined/remedy-free refusal, the
`validateWorktreeSafe` guard wired into `branch-cleanup.mjs` with its tests,
and a docs commit (`finishing-work` Step 3's mechanical discriminator,
`contributing.md`'s previously-undocumented `branch:cleanup` section, the
`command-catalog.mjs` description, and an ADR provenance re-stamp for the
eight ADRs whose cited source files this touched — advisory drift
acknowledgment only, no ADR amendment needed since none of their claims
were invalidated). `pnpm verify` passes clean (66 steps, 10 appropriately
skipped). Live-verified from both a linked worktree and the main checkout:
the "attached" and "standing-in" refusals fire with the correct remedy, an
unattached branch still deletes from inside an unrelated worktree (the
`check:staleness` compatibility case), and `worktree:remove`'s own refusal
now names `ExitWorktree`/`branch:cleanup` instead of a bare message.

Tracker flip (`docs/ROADMAP.md` H11 → `Done`) is a post-merge
`finishing-work` Step 5 action, not part of this PR.
