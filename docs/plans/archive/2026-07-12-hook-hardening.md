# Hook setup hardening against Anthropic guidance

**Status: shipped** (PR #117, commit `1c45a43`)

## Context

The repo's Claude Code hook setup was audited against Anthropic's official
hooks guidance (the hooks reference and the automate-actions-with-hooks
guide), using three parallel Explore agents to map the official yardstick,
the `.claude/settings.json` wiring, and the 17 `.claude/hooks/*.mjs`
implementations. The setup was already well-aligned — all 17 hooks
correctly wired with valid event names, correct exit-code semantics
(blocking `exit 2` on PreToolUse, advisory `exit 2` on PostToolUse, no hook
using the non-blocking `exit 1`), and every subprocess-spawning guard using
`execFileSync`/`spawnSync` with array args (no shell). Three small alignment
gaps remained, plus a fourth flagged for later.

## Approach / Decisions

- No `src/` or public-API surface touched — a focused hardening pass over
  `.claude/settings.json`, `bin/check-hooks.mjs`, and one hook script.
- **Timeouts:** added an explicit `timeout` to every one of the 17 hooks in
  `.claude/settings.json` (30s for fast guards; 120–180s for the heavy
  PostToolUse verify/CI-engine hooks like `post-edit-verify`, which runs
  prettier + eslint + `tsc` + two `vitest` passes), replacing the implicit
  600s platform default that let a wedged subprocess stall a tool call
  indefinitely.
- **Validator hardening:** extended `bin/check-hooks.mjs` to error on any
  `settings.json` event key outside a documented `KNOWN_EVENTS` set (a
  typo like `PostToolUseX` previously passed silently) and warn (non-fatal)
  on any hook command missing a `timeout`.
- **Exec-form conversion:** rewrote `remind-sync-docs.mjs`'s `execSync`
  string-interpolated calls as `execFileSync("git", [...args])`, the only
  hook that hadn't already followed the safe array-args pattern.
- **Deferred:** the Bash-write bypass (Write/Edit guards can't see files
  written via `Bash`, e.g. `echo > .env`) was recorded as a tracked
  follow-up in `docs/plans/IMPLEMENTATION.md` rather than fixed this pass —
  CI and branch protection remain the authoritative backstops.

## Outcome

All 17 hooks carry an explicit timeout, `bin/check-hooks.mjs` now catches
event-name typos and missing timeouts, and `remind-sync-docs.mjs` matches
the rest of the fleet's injection-proof exec-form pattern. See
[`docs/contributing/hooks-reference.md`](../../contributing/hooks-reference.md)
for the current hook inventory.

## Verification

`pnpm check:hooks` passes (and catches a deliberately mistyped event name /
missing timeout); `.claude/settings.json` stays valid JSON; `pnpm lint`,
`pnpm typecheck`, `pnpm test`, and `pnpm build` all green.
