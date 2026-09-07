# 0002. Extend the session-telemetry adapter with a per-tool usage scan, recursively

- **Date:** 2026-09-06
- **Decider:** repo maintainer

An audit for "how do we track harness tool-usage metrics" found no per-tool
metric anywhere: `analyze-sessions.mjs` (the ADR-0084 telemetry source) only
branches on `tool_use` blocks named `Skill`/`Agent`/`Task` to populate
`by_skill`/`by_subagent_type`; every other tool name — `Read`, `Edit`,
`Bash`, `Grep`, `mcp__m3l__*`, etc. — fell through uncounted. ADR-0084 already
decided the two obvious alternatives against this repo's shape: OpenTelemetry
and the Analytics Admin API were rejected as "organisation-scale instruments
… with no collector to ship to," and a PostToolUse-hook capture layer was
retired with the `remember` plugin. Its own decision driver — "prefer
extending an existing instrument to adding one" — points at
`bin/session-telemetry.mjs`, which already holds a precedent for a second
direct in-repo transcript scan (the ADR-0087 naming-compliance pass). We
extended it with a third scan computing per-tool counts, rather than adding
a new store, hook, or gate.

The one decision worth recording rather than just making: this new scan
reads **recursively**, unlike every existing scan in this file, which reads
only top-level transcripts. A live measurement against this project's own
store (2026-09-06) found a top-level-only scan of the 30-day window saw 412
`tool_use`-bearing lines, while a recursive scan (including nested
`<session>/subagents/**/*.jsonl` transcripts) saw 1,731 — about 76% of tool
calls happen inside subagent transcripts, invisible to every prior scan.
In a hub-and-spoke repo, a tool-usage metric that only reads top-level
transcripts would be systematically wrong, undercounting exactly the calls
spokes make (`Read`, `WebFetch`, `WebSearch` in particular). This is a
deliberate widening of ADR-0084's grant to this adapter — it was scoped to
"the transcript store" without specifying depth — justified by that
measurement, not a silent scope creep.

A second finding surfaced during verification, out of scope for this note:
`bin/lib/claude-home.mjs`'s `resolveClaudeProjectDir` (both this scan's own
`dir` and the existing naming/analyzer scans') assumes one project directory
is "the one store every worktree shares," resolved via `--git-common-dir`.
Live verification during this change found that assumption does not hold for
a session that itself enters a worktree mid-session (via `EnterWorktree`):
Claude Code appears to key a session's own transcript-store directory by
current working directory at write time, not by the git-common-dir — so a
session's transcript can relocate to a worktree-specific
`~/.claude/projects/<cwd-slug>/` partway through its own life, orphaned from
the slug `resolveClaudeProjectDir` computes. This affects both existing
ADR-0084 consumers identically (`bin/check-retrospective.mjs` and
`bin/session-telemetry.mjs` itself) and predates this change; fixing it is a
separate decision, not folded in here.

Wall-clock for the new scan over this repo's actual 30-day window (6.2 MB
across ~30 files): well under a second — the ADR-0080 unscoped-scan concern
(1,759 files / 932 MB at the time ADR-0084 was written) does not apply at
this `--dir`/`--since`-bounded scope.

## Links

- Related: ADR-0084 (the scan this extends and the constraints it must
  satisfy), ADR-0087 (the sibling naming-compliance scan this mirrors),
  ADR-0080 (the scan-cost budget this stays well under),
  `bin/session-telemetry.mjs`, `bin/lib/claude-home.mjs` (the
  `resolveClaudeProjectDir` limitation noted above, left unfixed here)
