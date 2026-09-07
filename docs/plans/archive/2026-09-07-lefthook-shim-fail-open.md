# Make the lefthook `pre-push` shim fail closed (H14, issue #1097)

**Status: shipped** — branch `fix/lefthook-shim-fail-open`.

## Context

`docs/ROADMAP.md`'s H14 governance row (synced to GitHub issue #1097)
reported that the generated `.git/hooks/pre-push` shim's final
unresolved-binary branch echoes `"Can't find lefthook in PATH"` with no
`exit 1`, so a push on a machine where no lefthook binary resolves at all
exits 0 and proceeds with every gate — `format:check`, `lint`, `typecheck`,
`test:coverage`, and ADR-0016 layer 2's `verify-signed-range` — silently
skipped. The issue's own note read: "No script has yet inspected
`.git/hooks/pre-push`'s content; the available lever is a warn-only
`check:*` gate reading it (H2/#1044 shape), not editing the shim itself."

## Approach / Decisions

- **Corrected the issue's premise before planning around it.** lefthook
  ships a first-class `assert_lefthook_installed: true` config key; the
  installed `lefthook@2.1.12` binary's own embedded shim template (read via
  `strings`) branches on it to add the missing `exit 1`. The "not editing the
  shim itself" framing was wrong — the shim is generated from a template
  this repo already controls the inputs to.
- **Three layers, not one**, confirmed with the user up front:
  1. `assert_lefthook_installed: true` in `lefthook.yml` — the actual fix;
     every future `lefthook install` regenerates a fail-closed shim.
  2. `pnpm check:lefthook-shim` (`bin/check-lefthook-shim.mjs`, H2/#1044
     warn-only shape) — detects a shim that predates the fix.
  3. `.claude/hooks/guard-lefthook-shim.mjs` — a `PreToolUse: Bash` guard,
     sibling to `guard-git-push-signed.mjs`, blocking an agent-driven
     `git push` when the shim is confirmed fail-open right now.
- **The circularity that shaped layer 2's scope**: a gate wired only into
  the `pre-push` chain cannot catch the defect it warns about — if the shim
  fails open, `pre-push` never runs, so nothing inside it runs either. It
  only catches the precursor (a stale shim found on some other push); layer
  3 is the one that fires in the actual failure case, since it runs before
  the push, in the agent's own tool-call path.
- **`bin/lib/lefthook-shim.mjs`** is the shared pure/injectable classifier
  both layers 2 and 3 import — `shimsDir`, `isLefthookShim`,
  `shimFailsOpen` (branch-bounded: only counts an `exit 1` inside the
  specific unresolved-binary branch, not anywhere in the file),
  `classifyShim`, `scanShims`. Correctly scoped to the shared
  `--git-common-dir`'s `hooks/`, never `<worktree>/.git/hooks` (doesn't
  exist in a linked worktree).
- **A live smoke test against this repo's own `.git/hooks/` (per
  `.claude/rules/harness-artifacts.md`'s "run before writing the test
  suite" rule) surfaced a real self-referential bug before it shipped**: a
  stale `post-rewrite.old` backup from an earlier `lefthook install` was
  still lefthook-shaped and still fail-open, but never invoked by git —
  `scanShims` would have false-positived on it. Fixed by excluding any
  dotted filename (no real git hook name contains a `.`), not just
  `.sample`.
- **Both load-bearing detection functions mutation-tested by hand**:
  inverting `shimFailsOpen`'s `exit 1` check, and removing the
  dotted-filename filter. Each mutation broke a distinct, pre-existing
  assertion in the test suite before being reverted.
- Tests dispatched to `test-author` (hub-and-spoke — `bin/tests/**` is a
  guarded write path); the hub verified them afterward with its own
  mutation-testing pass rather than trusting the spoke's self-report alone.

## Outcome

Landed as two commits plus a doc-reconciliation commit: `fix(hooks): make
the lefthook shim fail closed` (the `assert_lefthook_installed` config line
alone, verified live against the regenerated shim before anything else was
built) and `feat(bin): add check:lefthook-shim and its push guard` (the lib,
both gates, and every registration point — `package.json`,
`command-catalog.mjs`, the `lefthook.yml` pre-push chain, `ci.yml`,
`verify-steps.mjs`, `CLAUDE.md`'s cadence table, `.claude/settings.json`,
`hooks-reference.md`). `pnpm verify` passes clean (67 steps, 10
appropriately skipped). ADR-0016's claim ("`guard-git-push-signed.mjs` — the
repo's first `Bash`-matcher PreToolUse hook") re-derived and confirmed still
true — the new guard was inserted second, not before it — so no ADR
amendment was needed despite `check:adr-claims` flagging the file for
re-derivation.

Tracker flip (`docs/ROADMAP.md` H14 → `Done`) lands in this same PR (see the
commit history) rather than deferred to a post-merge `finishing-work` step,
since the PR number was known before push.
