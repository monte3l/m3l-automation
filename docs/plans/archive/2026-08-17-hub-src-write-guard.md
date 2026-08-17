# Hub src-write guard — close issue #446

**Status: shipped** — PR feat/hub-src-write-guard (commit `adc62b2`).

## Context

Issue #446 was filed by the 2026-08-17 ADR-0016 revisit-trigger retirement
(`archive/2026-08-17-retire-adr-0016-bash-write-trigger.md`) to preserve the
thrice-observed guard gap that was at risk of being silently buried with the
never-observed Bash-write hole. The gap: `guard-branch-isolation.mjs` only
fires while `HEAD` is `main`; on a feature branch nothing in the hook layer
prevented the hub from writing directly to guarded paths. Observed three times,
escalating in severity — one TSDoc line (`docs/logs/2026-07-24-…`), two
one-liners (`docs/logs/2026-07-26-…`), and an entire script package's `src/`
(`docs/logs/2026-07-27-…`). The CLAUDE.md § Agent Operating Model paragraph on
this recurring violation was already written; the enforcement was missing.

The unblock condition from the IMPLEMENTATION.md row: a proposed guard design
using the `agent_type` hook-payload seam, reviewed for false-positive risk
against legitimate hub docs/config edits.

## Approach / Decisions

**Seam:** the PreToolUse payload's top-level `agent_type` field — absent/empty
for hub-level calls, the subagent's name string for spoke calls. Already used
this way by `guard-readonly-bash.mjs`; `guard-hub-src-writes.mjs` follows the
same pattern.

**False-positive review:** the hub's sanctioned write surface (docs, config,
`.claude/`, `bin/`) has zero overlap with the protected path set
(`packages/*/src/**`, `scripts/*/src/**`, `**/tests/**`). No escape hatch
needed; `docs/contributing/agent-operating-model.md:5-6` confirms there is no
sanctioned exception.

**Roster-restrict (not allow-any):** a non-writer subagent carrying a non-empty
`agent_type` (e.g. `"fork"`, `"general-purpose"`) would pass a simple
allow-any check — a laundering hole. Restricting to `WRITER_SPOKES`
(`{code-implementer, test-author}`, from `bin/lib/agent-roster.mjs`) closes
it at zero extra cost and single-sources the writer roster with `check:agents`.

**`isProtectedPath` extracted to `bin/lib/protected-paths.mjs`:** mirrors the
`bin/lib/agent-roster.mjs` precedent. Both `Write|Edit` guards now import the
three-glob regex from one place; `guard-branch-isolation.mjs` re-exports it so
its existing test stays green.

**No CI backstop:** commits are authorship-blind — a hub-authored and a
spoke-authored src change produce byte-identical commits. `guard-writer-dispatch-journal.mjs`
is advisory and exits 0 (writes nothing committed). The PreToolUse hook is the
only moment the hub-vs-spoke signal exists; a provenance-sidecar system would
be over-engineering.

## Outcome

- `bin/lib/protected-paths.mjs` — new shared lib; `isProtectedPath` single-sourced
- `.claude/hooks/guard-hub-src-writes.mjs` — new blocking `PreToolUse: Write|Edit`
  hook; exports `shouldBlockHubSrcWrite(filePath, agentType)`
- `.claude/hooks/guard-branch-isolation.mjs` — rewired to import from the new lib
- `.claude/settings.json` — hook wired into the `Write|Edit` matcher (21 hooks total)
- `docs/contributing/hooks-reference.md` — new row + count bump 20→21 + Known gap updated
- `CLAUDE.md` — count bump 20→21
- `docs/plans/IMPLEMENTATION.md` row 268 — Status `Deferred → Done`; closes issue #446
  on the next `pnpm sync:hub -- --apply`
- `bin/tests/guard-hub-src-writes.test.ts` — 23 unit tests; all 7668 repo tests pass
