# Claude Code hooks reference

The single authoritative inventory of every hook wired into `.claude/settings.json`
(implemented under `.claude/hooks/*.mjs`). CLAUDE.md's "Claude Code hooks" note
is deliberately a one-paragraph pointer to this file — every lifecycle hook
lives here (26 hook files, 26 table rows — every file fires on exactly one
event) so it stays in one place instead of drifting across sections. Three
more files round out `.claude/hooks/` to 29 total but are not table rows:
`statusline-context-pressure.mjs` and `subagent-statusline.mjs` are
`statusLine`/`subagentStatusLine` scripts (documented separately below, not
as lifecycle hooks), and `statusline-layout.mjs` is a pure sibling library
module the former imports — never itself wired into `.claude/settings.json`,
so `pnpm check:hooks` warns on it as an accepted "dead hook?" false positive
rather than an error.
`pnpm check:hooks` validates that every command below resolves to a real file,
every event name is a real Claude Code lifecycle event, every hook carries
an explicit timeout, and this table's Matcher column stays in parity with
each hook's actual `if:`-scoping in `.claude/settings.json` (ADR-0080-driven
drift found and closed 2026-08-31). For `SessionStart`, `PreCompact`, and
`PostCompact` — the three events with a documented, closed `matcher` value
set rather than a free-form tool-name pattern — it additionally rejects any
wired `matcher` token outside that set (`startup`/`resume`/`clear`/`compact`/
`fork` for `SessionStart`; `manual`/`auto` for `PreCompact`/`PostCompact`),
so a typo like `matcher: "compct"` fails the gate instead of silently never
firing (2026-09-01, closing a gap the harness-refresh sweep found in
ADR-0078's `SessionStart`+`compact` re-injection route). This is a separate
check from the `if:`-scoping parity above — the Matcher column here still
reflects the event `matcher`, not the guard-scoping `if:` clause.

CLAUDE.md is advisory only (Claude reads it as context); everything in this
table is deterministic enforcement that runs whether or not Claude "remembers"
the rule.

**`if:` scoping (ADR-0080).** Nine of the guards below whose own internal logic
is scoped to specific paths/extensions — `guard-protected-paths`,
`guard-eslint-disable-red`, `post-edit-md-verify`, `guard-exports-semver`,
`post-edit-verify`, `guard-doc-counts`, `guard-provenance-staleness`,
`guard-index-staleness`, `guard-red-phase-comments` — carry a per-handler `if`
condition (Claude Code's [documented permission-rule filter](https://code.claude.com/docs/en/hooks#the-if-field))
so the process only spawns for a matching edit, instead of spawning on every
`Write`/`Edit` and exiting immediately for a non-matching path. `if` supports
exactly one rule with no `&&`/`||`/list syntax, so a guard needing both tools
and/or several path patterns gets one entry per (tool, pattern) combination —
this is why `.claude/settings.json`'s `PreToolUse`/`PostToolUse` arrays list
more entries than there are distinct guard scripts. The three guards with no
stated backstop elsewhere (`guard-branch-isolation`, `guard-hub-src-writes`)
or with an inherently unscopeable concern (`guard-secret-writes`, which must
inspect any file) are **deliberately left unscoped** — narrowing them risks a
silent gap with no fallback if the `if` glob ever drifts from the guard's own
logic. `guard-js-extension`/`guard-no-commonjs` are also left unscoped: both
match the majority of real edits in a TypeScript codebase already (little
marginal spawn-reduction) and both have a CI/build backstop (see "Known gap"
below), unlike the three above.

| Event            | Matcher                                                                                                                                                  | Hook                                | Purpose                                                                                                                                                                                                                                                     | Mode     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SessionStart     | —                                                                                                                                                        | `guard-worktree-ready.mjs`          | Reminds to run `pnpm worktree:setup` inside an unprovisioned linked worktree (missing `node_modules` / `.worktreeinclude` files).                                                                                                                           | advisory |
| SessionStart     | `compact\|resume\|startup`                                                                                                                               | `reinject-compact-handoff.mjs`      | Reads the `PreCompact`-written handoff artifact back as `additionalContext` after a compaction, a resumed session, or a fresh startup on a dirty branch (ADR-0078); flags a >24h-old handoff as likely stale; one-shot, deletes the artifact once consumed. | advisory |
| SessionStart     | —                                                                                                                                                        | `warn-host-resources.mjs`           | Runs `bin/check-host-resources.mjs` and warns when an OOM-livelock mitigation (earlyoom/oomd, zram, `MemoryMax`, `CLAUDE_CODE_TOOL_MEMORY_LIMIT`) is missing, or another `claude` process is already running (ADR-0080).                                    | advisory |
| SessionStart     | —                                                                                                                                                        | `warn-node-version.mjs`             | Runs `bin/check-node-version.mjs` and warns when `.node-version` has drifted from an `engines.node` floor or a workflow's Node provisioning, or when this machine is on a different Node major than the pin (ADR-0003 amendment).                           | advisory |
| SessionStart     | `startup\|clear`                                                                                                                                         | `rotate-session-incidents.mjs`      | Deletes `tmp/session-incidents.jsonl` if present, so the durable spoke-incident log `detect-spoke-truncation.mjs` writes doesn't accumulate across sessions; scoped away from `compact`/`resume` so it never wipes an in-flight session's own records.      | advisory |
| PreCompact       | —                                                                                                                                                        | `write-compact-handoff.mjs`         | Writes branch/worktree, last commit + signature, uncommitted files, and any `tmp/`-scratch journals to `tmp/compact-handoff.json` before compaction (ADR-0078).                                                                                             | advisory |
| UserPromptSubmit | —                                                                                                                                                        | `inject-decision-gate.mjs`          | Injects a decision-gate reminder (location/branch/PR/push) when a prompt looks like change-work; one of two hooks that inject context rather than blocking (the other is `reinject-compact-handoff.mjs` above).                                             | advisory |
| PreToolUse       | `Bash`                                                                                                                                                   | `guard-git-push-signed.mjs`         | Blocks a `git push` issued via Bash when any outgoing commit is unsigned/invalid — the agent-side layer of the 3-layer signed-commit scheme.                                                                                                                | blocking |
| PreToolUse       | `Bash`                                                                                                                                                   | `guard-readonly-bash.mjs`           | Restricts read-only spokes (Explore + the review agents) to non-mutating shell commands.                                                                                                                                                                    | blocking |
| PreToolUse       | `Agent`                                                                                                                                                  | `guard-writer-dispatch-journal.mjs` | Reminds (non-blocking) when a writer-spoke dispatch (`test-author`/`code-implementer`) omits an explicit journal path in the prompt.                                                                                                                        | advisory |
| PreToolUse       | `Write\|Edit`                                                                                                                                            | `guard-js-extension.mjs`            | Blocks a relative import missing the `.js` extension (ESM runtime-resolution gotcha).                                                                                                                                                                       | blocking |
| PreToolUse       | `Write\|Edit`                                                                                                                                            | `guard-no-commonjs.mjs`             | Blocks CommonJS constructs (`require`, `module.exports`, `__dirname`, `__filename`) — the package is ESM-only.                                                                                                                                              | blocking |
| PreToolUse       | `Write\|Edit` if `**/dist/**`                                                                                                                            | `guard-protected-paths.mjs`         | Blocks hand-edits to tool-owned artifacts (`dist/**`).                                                                                                                                                                                                      | blocking |
| PreToolUse       | `Write\|Edit` if `packages/m3l-common/tests/**`                                                                                                          | `guard-eslint-disable-red.mjs`      | Rejects a test-file write that suppresses RED-phase ESLint noise (`import-x/no-unresolved`, `no-unsafe-*`) instead of letting it self-resolve at GREEN.                                                                                                     | blocking |
| PreToolUse       | `Write\|Edit`                                                                                                                                            | `guard-branch-isolation.mjs`        | Blocks `packages/*/src/**`, `scripts/*/src/**`, `**/tests/**` writes while `HEAD` is `main` (or detached on the main commit).                                                                                                                               | blocking |
| PreToolUse       | `Write\|Edit`                                                                                                                                            | `guard-hub-src-writes.mjs`          | Blocks the hub (no `agent_type`) from writing guarded src/test paths on any branch — spokes (`code-implementer`/`test-author`) are allowed; closes issue #446.                                                                                              | blocking |
| PreToolUse       | `Write\|Edit`                                                                                                                                            | `guard-secret-writes.mjs`           | Refuses to write a real secret/token literal or a `.env` file to disk (CI `gitleaks` is the backstop).                                                                                                                                                      | blocking |
| PostToolUse      | `Write\|Edit` if `*.md`                                                                                                                                  | `post-edit-md-verify.mjs`           | Runs prettier + rumdl on the edited `.md` file for immediate feedback (`post-edit-verify.mjs` skips non-`.ts` files).                                                                                                                                       | advisory |
| PostToolUse      | `Write\|Edit` if `packages/m3l-common/package.json`                                                                                                      | `guard-exports-semver.mjs`          | Reminds that an edit to the `exports` map is a semver event needing a `feat!:` / `BREAKING CHANGE:` commit; does not hard-block.                                                                                                                            | advisory |
| PostToolUse      | `Write\|Edit` if `*.ts`/`*.mts`/`*.cts`                                                                                                                  | `post-edit-verify.mjs`              | Runs prettier, eslint, typecheck, and the related Vitest suite scoped to the edited package, immediately after a `.ts`/`.mts`/`.cts` edit.                                                                                                                  | advisory |
| PostToolUse      | `Write\|Edit` if `docs/reference/**/*.md`, `README.md`                                                                                                   | `guard-doc-counts.mjs`              | Warns when a `docs/reference/**` or README edit leaves a doc-count badge stale vs. the filesystem-derived truth.                                                                                                                                            | advisory |
| PostToolUse      | `Write\|Edit` if `packages/m3l-common/src/**`                                                                                                            | `guard-provenance-staleness.mjs`    | Warns when a `packages/m3l-common/src/**` edit makes a provenance sidecar's recorded commit stale.                                                                                                                                                          | advisory |
| PostToolUse      | `Write\|Edit` if `docs/reference/**/*.provenance.json`, `packages/m3l-common/src/**/index.ts`, `docs/implementation-status.md`, `docs/reference/**/*.md` | `guard-index-staleness.mjs`         | Warns when an edit to a reference-index input causes `catalog.json` / `symbol-map.json` / README to drift.                                                                                                                                                  | advisory |
| PostToolUse      | `Write\|Edit` if `packages/m3l-common/src/**`                                                                                                            | `guard-red-phase-comments.mjs`      | Warns when implementation lands but the paired test file still carries a stale RED-phase header comment.                                                                                                                                                    | advisory |
| SubagentStop     | —                                                                                                                                                        | `detect-spoke-truncation.mjs`       | Flags a finished spoke whose last message looks cut off mid-turn (empty, a trailing ellipsis, or an unclosed intent phrase), reminds the hub to verify before trusting it, and appends a `kind: "truncation"` record to `tmp/session-incidents.jsonl`.      | advisory |
| Stop             | —                                                                                                                                                        | `remind-sync-docs.mjs`              | Session-end reminders: run `/syncing-docs` if `docs/implementation-status.md` changed, run `check:test-counts` if tests changed, delete stray scratch/repro test files.                                                                                     | advisory |

**Blocking** hooks exit 2 and reject the tool call outright. **Advisory**
hooks split by event: the seven `PostToolUse` ones (`post-edit-md-verify`,
`guard-exports-semver`, `post-edit-verify`, `guard-doc-counts`,
`guard-provenance-staleness`, `guard-index-staleness`,
`guard-red-phase-comments`) also exit 2 to print a reminder to stderr — the
edit already landed by the time `PostToolUse` fires, so this never stops it,
only surfaces context back to Claude. The remaining ten advisory hooks
(`guard-worktree-ready`, `reinject-compact-handoff`, `warn-host-resources`,
`warn-node-version`, `rotate-session-incidents`, `write-compact-handoff`,
`inject-decision-gate`, `guard-writer-dispatch-journal`,
`detect-spoke-truncation`, `remind-sync-docs`) exit 0, optionally injecting
a message via stdout/JSON when there is something worth reporting —
`rotate-session-incidents` is silent even on a successful run, since it has
nothing to report. Their events (`SessionStart`, `PreCompact`,
`UserPromptSubmit`, `PreToolUse: Agent`, `SubagentStop`, `Stop`) have no
"already happened" tool call for exit 2 to react to.

**`statusLine` (not a lifecycle hook — a separate `.claude/settings.json` key).**
`statusline-context-pressure.mjs` renders a multi-line statusline: the
session's name (green when it conforms to ADR-0087's `<kind>-<slug>`
convention, yellow-flagged when it doesn't, dim `unnamed` when absent — the
one documented programmatic read of `session_name`, ADR-0087), model,
effort, and a color-coded context-pressure bar/percentage (70%/90% thresholds)
on line 1; session cost, token counts, 5-hour/7-day rate-limit resets, and
prompt-cache warmth on line 2; the current git branch, worktree/PR, active
spoke, origin repo, and free memory on line 3; and, once past the 90%
threshold, a ready-to-run `/compact` suggestion built from `pr.number`/
`workspace.git_worktree` on its own fourth line — mirroring CLAUDE.md's
`## Compact Instructions` preserve-list dynamically instead of leaving it as
prose to remember. (This paragraph describes the pre-#916 layout; the current
five-row rewrite is not yet reflected here — see PR 3 of
`docs/adr/0090-subagent-statusline-supersedes-lifecycle-tracker.md`'s plan of
record.) Per-spoke elapsed-time visibility moved off this line entirely to
the native `subagentStatusLine` setting — see below. This is a project-scoped supersede of the user's own
`ccstatusline` config (`~/.claude/settings.json`, `npx -y ccstatusline@latest`)
— only one `statusLine` command can be active per scope, and project settings
shadow user settings, so working in this repo would otherwise lose that
dashboard's widgets; #879 broadened the script to cover the ones reproducible
from data already available here (deferring the two that need a `/usage` API
call — see the follow-up issue tracked from #879). `statusLine` was confirmed
as the only documented surface exposing live context-window data to a local
script; no hook event carries it (`docs/research/harness-refresh.md`
Outstanding drift #10), so this composes with rather than replaces the
`PreCompact`/`SessionStart(compact)` handoff pair above — the statusline tells
the user _when_, those hooks handle _what survives_ once `/compact` actually
runs. The invariant is **no subprocess, no network** — not "no `git` calls":
the branch segment reads `.git/HEAD` directly (walking up from
`workspace.current_dir`, resolving a linked worktree's `gitdir:` pointer file
where needed) instead of shelling out to `git` the way `ccstatusline` does, and
free memory comes from `os.freemem()`/`os.totalmem()`. Both are synchronous
local syscalls, not a subprocess spawn or a registry hit, so neither
reintroduces the `npx`-resolved third-party-statusline resource cost
`docs/adr/0080-host-resource-budgeting.md` and `docs/contributing/host-resources.md`
warn about — this is a plain local `node` invocation, identical in cost to
every hook row above, run on a `refreshInterval: 30` timer (in addition to its
existing event-driven triggers) so the reset countdowns and free-memory reading
stay live while the session is idle. `pnpm check:hooks` resolves
`statusLine.command` too — so a broken reference errors and a valid one no
longer false-positives as a "dead hook?" warning — though it checks only that
the referenced script exists, not the `type`/`refreshInterval`/other fields of
the `statusLine` config itself; behavioral coverage of the script's own output
is `bin/tests/statusline-context-pressure.test.ts`'s job.

**`subagentStatusLine` (not a lifecycle hook — a separate `.claude/settings.json`
key, sibling to `statusLine` above).** `.claude/hooks/subagent-statusline.mjs`
renders a custom row body for each subagent shown in the agent panel: name,
`effort` (when present), a `tokenCount`/`contextWindowSize` fraction (when
both are present), and an elapsed-time readout color-escalating past 15/30
minutes elapsed — the same thresholds the retired `tmp/spoke-lifecycle.jsonl`
tracker used, now sourced from Claude Code's own per-task `tasks[]` array
instead of a hand-rolled JSONL file (`docs/adr/0090-subagent-statusline-supersedes-lifecycle-tracker.md`).
It supersedes `track-inflight-spokes.mjs` and the `SubagentStart`/
`SubagentStop` wirings that fed it — closing the same gap the retired tracker
closed (nothing surfaced intermediate progress during a review-spoke fan-out
that had stalled 30-60+ min on four recorded occasions:
`docs/logs/2026-07-18-aws-athena.md`, `2026-07-18-aws-s3.md`,
`2026-07-19-subagent-stall-integration.md`, `2026-08-21-core-procedure.md`)
with strictly more per-task detail and no on-disk state to maintain. Same
**no subprocess, no network** invariant as `statusLine`; `pnpm check:hooks`
resolves `subagentStatusLine.command` the same way it resolves
`statusLine.command`. A full glyph/color/threshold legend for both statusline
scripts is deferred to PR 3 of the plan referenced above.

**Known gap (accepted risk, issue #210 retired 2026-08-17):** the write-time
_content_ `Write|Edit` guards (`guard-secret-writes`, `guard-js-extension`,
etc.) are not wired to `Bash`. This is narrower than it sounds:
`guard-readonly-bash.mjs` above already detects Bash-mediated writes
(redirection, `tee`, `sed -i`) via a `PreToolUse: Bash` matcher — it just
restricts read-only subagents rather than gating content for the hub. Wiring
the content guards to it was deliberately not done in the 2026-07-12 hardening
pass; CI `gitleaks` and branch protection are the backstops for
`guard-secret-writes`/`guard-js-extension`/`guard-no-commonjs` specifically.
**`guard-branch-isolation` has no non-hook backstop at all** — branch
protection stops an unsigned/unreviewed push, not a `main`-branch
working-tree write. The feature-branch gap (nothing distinguishing a
hub-authored `Edit` from a spoke-authored one) is closed by the new
`guard-hub-src-writes.mjs` row above (issue #446, 2026-08-17). See
ADR-0016's 2026-08-17 Update and
`docs/plans/archive/2026-08-17-retire-adr-0016-bash-write-trigger.md`.

See also: `bin/check-hooks.mjs` (wiring validator), ADR-0016 (signed-commit
enforcement), `docs/contributing/branch-protection.md`.
