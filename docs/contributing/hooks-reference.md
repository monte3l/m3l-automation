# Claude Code hooks reference

The single authoritative inventory of every hook wired into `.claude/settings.json`
(implemented under `.claude/hooks/*.mjs`). CLAUDE.md's "Claude Code hooks" note
is deliberately a one-paragraph pointer to this file — the full 20-hook list
lives here so it stays in one place instead of drifting across sections.
`pnpm check:hooks` validates that every command below resolves to a real file,
every event name is a real Claude Code lifecycle event, and every hook carries
an explicit timeout.

CLAUDE.md is advisory only (Claude reads it as context); everything in this
table is deterministic enforcement that runs whether or not Claude "remembers"
the rule.

| Event            | Matcher       | Hook                                | Purpose                                                                                                                                                                       | Mode     |
| ---------------- | ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SessionStart     | —             | `guard-worktree-ready.mjs`          | Reminds to run `pnpm worktree:setup` inside an unprovisioned linked worktree (missing `node_modules` / `.worktreeinclude` files).                                             | advisory |
| UserPromptSubmit | —             | `inject-decision-gate.mjs`          | Injects a decision-gate reminder (location/branch/PR/push) when a prompt looks like change-work; the only hook that injects context rather than blocking.                     | advisory |
| PreToolUse       | `Bash`        | `guard-git-push-signed.mjs`         | Blocks a `git push` issued via Bash when any outgoing commit is unsigned/invalid — the agent-side layer of the 3-layer signed-commit scheme.                                  | blocking |
| PreToolUse       | `Bash`        | `guard-readonly-bash.mjs`           | Restricts read-only spokes (Explore + the review agents) to non-mutating shell commands.                                                                                      | blocking |
| PreToolUse       | `Agent`       | `guard-writer-dispatch-journal.mjs` | Reminds (non-blocking) when a writer-spoke dispatch (`test-author`/`code-implementer`) omits an explicit journal path in the prompt.                                          | advisory |
| PreToolUse       | `Write\|Edit` | `guard-js-extension.mjs`            | Blocks a relative import missing the `.js` extension (ESM runtime-resolution gotcha).                                                                                         | blocking |
| PreToolUse       | `Write\|Edit` | `guard-no-commonjs.mjs`             | Blocks CommonJS constructs (`require`, `module.exports`, `__dirname`, `__filename`) — the package is ESM-only.                                                                | blocking |
| PreToolUse       | `Write\|Edit` | `guard-protected-paths.mjs`         | Blocks hand-edits to tool-owned artifacts (`dist/**`).                                                                                                                        | blocking |
| PreToolUse       | `Write\|Edit` | `guard-eslint-disable-red.mjs`      | Rejects a test-file write that suppresses RED-phase ESLint noise (`import-x/no-unresolved`, `no-unsafe-*`) instead of letting it self-resolve at GREEN.                       | blocking |
| PreToolUse       | `Write\|Edit` | `guard-branch-isolation.mjs`        | Blocks `packages/*/src/**`, `scripts/*/src/**`, `**/tests/**` writes while `HEAD` is `main` (or detached on the main commit).                                                 | blocking |
| PreToolUse       | `Write\|Edit` | `guard-secret-writes.mjs`           | Refuses to write a real secret/token literal or a `.env` file to disk (CI `gitleaks` is the backstop).                                                                        | blocking |
| PostToolUse      | `Write\|Edit` | `post-edit-md-verify.mjs`           | Runs prettier + rumdl on the edited `.md` file for immediate feedback (`post-edit-verify.mjs` skips non-`.ts` files).                                                         | advisory |
| PostToolUse      | `Write\|Edit` | `guard-exports-semver.mjs`          | Reminds that an edit to the `exports` map is a semver event needing a `feat!:` / `BREAKING CHANGE:` commit; does not hard-block.                                              | advisory |
| PostToolUse      | `Write\|Edit` | `post-edit-verify.mjs`              | Runs prettier, eslint, typecheck, and the related Vitest suite scoped to the edited package, immediately after a `.ts`/`.mts`/`.cts` edit.                                    | advisory |
| PostToolUse      | `Write\|Edit` | `guard-doc-counts.mjs`              | Warns when a `docs/reference/**` or README edit leaves a doc-count badge stale vs. the filesystem-derived truth.                                                              | advisory |
| PostToolUse      | `Write\|Edit` | `guard-provenance-staleness.mjs`    | Warns when a `packages/m3l-common/src/**` edit makes a provenance sidecar's recorded commit stale.                                                                            | advisory |
| PostToolUse      | `Write\|Edit` | `guard-index-staleness.mjs`         | Warns when an edit to a reference-index input causes `catalog.json` / `symbol-map.json` / README to drift.                                                                    | advisory |
| PostToolUse      | `Write\|Edit` | `guard-red-phase-comments.mjs`      | Warns when implementation lands but the paired test file still carries a stale RED-phase header comment.                                                                      | advisory |
| SubagentStop     | —             | `detect-spoke-truncation.mjs`       | Flags a finished spoke whose last message looks cut off mid-turn (empty, a trailing ellipsis, or an unclosed intent phrase) and reminds the hub to verify before trusting it. | advisory |
| Stop             | —             | `remind-sync-docs.mjs`              | Session-end reminders: run `/syncing-docs` if `docs/implementation-status.md` changed, run `check:test-counts` if tests changed, delete stray scratch/repro test files.       | advisory |

**Blocking** hooks exit 2 and reject the tool call outright. **Advisory** hooks
also exit 2 but only print a reminder to stderr — they never stop the edit.

**Known gap (accepted risk):** the `Write|Edit` PreToolUse guards cannot see
file writes made through `Bash` (`echo > .env`, heredocs, `tee`). This was
deliberately not closed at the hook layer in the 2026-07-12 hardening pass; CI
`gitleaks` and branch protection are the backstops. Tracked in
`docs/plans/IMPLEMENTATION.md` (P2 table).

See also: `bin/check-hooks.mjs` (wiring validator), ADR-0016 (signed-commit
enforcement), `docs/contributing/branch-protection.md`.
