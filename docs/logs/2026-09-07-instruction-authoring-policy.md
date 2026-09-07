# Work log — `instruction-authoring-policy` (2026-09-07)

This log covers resolving issue #1001 (ROADMAP row H8): the repo had no
documented policy for where a new Claude Code instruction belongs — CLAUDE.md
vs a path-scoped `.claude/rules/*.md` vs a skill vs an agent vs a hook. It
records what shipped, the two decisions the task turned on, three genuine
divergences, and durable lessons for a repo this concurrent.

Plan of record: [`docs/plans/archive/2026-09-07-instruction-authoring-policy.md`](../plans/archive/2026-09-07-instruction-authoring-policy.md)

## Summary

- Re-derived the issue's premise before touching anything, and found the
  policy already existed — invisibly. CLAUDE.md's own maintainer comment
  carried an `EVICTION RULES` block naming the same six-tier decision
  sequence this task ended up documenting, but it lives inside an HTML
  comment stripped by `stripBlockComments` before injection: neither Claude
  nor a contributor browsing `docs/` could ever read it.
- Shipped `docs/contributing/instruction-authoring.md` — the canonical
  six-tier policy page (CLAUDE.md / `.claude/rules` / `.claude/agents` /
  `.claude/skills` / hooks / `docs/contributing`), backed by decision note
  `docs/decision-notes/0005-instruction-tier-placement.md` (ADR-0095's
  lightweight tier, not a full ADR).
- Collapsed `promoting-work-log-lessons` Step 3's five inline destination
  bullets to a citation of the new page, which also silently fixed Step 3's
  omission of hooks as a destination.
- Assessed enforcement options and found a real, previously unguarded gap:
  `.claude/rules` was the only harness artifact class (vs. skills, agents,
  hooks) with no bidirectional registration-completeness gate. Closed it
  with `deriveRuleRegistrationGaps` in `bin/check-context-budget.mjs`,
  mirroring `check-agents.mjs`'s agent-vs-MODEL-MATRIX shape — detects
  orphans (a rule file with no CLAUDE.md bullet), phantoms (a CLAUDE.md
  bullet naming a rule file that doesn't exist), and pathless rules (empty
  `paths:` frontmatter, so the rule can never load).
- CLAUDE.md's `## Agent Operating Model` paragraph swapped for a pointer to
  the new page (net −59 chars), paying for the addition against the
  file's context-budget ceiling (2999/3000 tokens at the time) rather than
  needing a separate trim.
- Landed as PR #1104 (policy + gate), then a separate tracker-flip PR #1113
  (ROADMAP H8 → Done, `sync:hub --apply` run, issue #1001 closed and its
  project-board item archived) — matching the established H1/H2/H4/H9/H11
  precedent of a small standalone close-out PR.
- `bin/tests/check-context-budget.test.ts` grew from ~105 to 117 tests.
- Skills used: `starting-work`, `creating-prs`, `syncing-docs`,
  `finishing-work`, `writing-work-logs`.
- Spoke incidents: none.
- Compaction events: 1 compaction (mid-`finishing-work` tracker-flip
  sub-task) / 1 recovered via handoff — the `tmp/compact-handoff.json` +
  summary round-trip preserved the branch, the in-flight PR context, and
  the pending next steps cleanly; the one loss was session-local
  (`ExitWorktree` ownership tracking, a documented expected failure mode,
  not a state loss the handoff was ever meant to cover).

## What went as planned

- **The gate design was additive, not a contract change.** A pre-existing
  test asserted `diffRuleGlobParity`'s deliberate "unregistered rule is
  skipped, not flagged" contract; `deriveRuleRegistrationGaps` was added
  alongside it as a new, separate check rather than inverting that
  contract, so no existing test needed to change meaning.
- **The negative-path proof worked on the first try.** A scratch
  `.claude/rules/zzz-probe.md` with no `paths:` and no CLAUDE.md bullet
  correctly hard-failed the gate, naming it, on the first run.
- **CLAUDE.md's token budget was exactly tight enough to be a real
  constraint, and the self-funding swap worked as planned** — replacing the
  hooks/skills prose paragraph with a pointer covered the new addition with
  room to spare (headroom went from 7 to 66 tokens), no separate trim
  needed.
- **`pnpm verify`'s full local gate chain passed clean on both PRs** apart
  from the known host-contention flake (see divergence 3) — lint,
  typecheck, build, `test:coverage` (all 4 vitest configs), `knip`, and
  `check:command-catalog` all green.

## What didn't go as planned, and why

### 1. Decision-note number collisions, twice, from concurrent sessions

The decision note was first numbered `0003`. Before the first push landed,
a concurrent session's own note claimed `0003`. After renumbering to `0004`
and rebasing again, `0004` was _also_ claimed by a different concurrent
session's note before that push landed. The note settled at `0005` only
after a second renumbering.

**Why it happened:** Decision-note numbers are provisional until pushed —
several Claude Code sessions were working in this repo simultaneously, each
picking the next free number from its own local view of `main`, with no
reservation mechanism between them.

**Fix for future:** Treat a decision-note (or ADR) number as unconfirmed
until the branch is rebased onto the latest `origin/main` immediately before
push — re-derive the next free number at that point, not at task start.
Expect at least one renumbering in a fast-moving repo and don't be surprised
by a second.

### 2. `docs/adr/provenance.json` and `docs/plans/README.md` table-append conflicts recurred across rebases

`docs/adr/provenance.json` conflicted on every rebase during this task (4
times total); `docs/plans/README.md`'s archive table conflicted on rebase 3
times, always because two concurrent sessions inserted distinct rows at the
same point.

**Why it happened:** Both files are append-heavy and hand-maintained (or
regenerated) in a repo with many concurrent sessions landing PRs during this
session's own lifetime — every rebase against a moving `main` had new
entries to reconcile.

**Fix for future:** Established a reliable pattern for each: for
`provenance.json`, `git checkout HEAD -- docs/adr/provenance.json` (take the
destination side) then `pnpm gen:adr-provenance` to regenerate fresh against
the fully-merged tree, then `pnpm check:adr-provenance` to verify — never
hand-merge the JSON. For a table-append conflict, keep both concurrent rows
in chronological order (no data loss) rather than picking one side.

### 3. Repeated pre-push `test` lane flakes traced to host CPU oversubscription

The same test (`scripts/agent-operator/tests/command-description.test.ts`)
hit its 30-second timeout under the parallel `pre-push` lanes four or more
times across both PR pushes, always correlating with host load averages of
8.75 up to 24.85 on a 4-core box.

**Why it happened:** Many concurrent Claude Code sessions on the same host
oversubscribed the CPU during this session's lifetime; isolated reruns of
the same test passed cleanly every time (13/13, ~5.5s), confirming this was
never a real regression in the code under test.

**Fix for future:** When a pre-push test lane times out under known high
host load, verify with an isolated rerun before assuming a real regression,
and keep retrying the plain, verified push (per `check:host-resources`,
ADR-0080) rather than reaching for `--no-verify` to route around it.

## Lessons learned

- **An "obvious gap" issue is worth re-deriving before writing anything.**
  This issue's stated premise ("no documented policy") was literally false —
  the policy existed in an HTML comment. Re-deriving the premise changed the
  shape of the fix from "invent a policy" to "promote and complete an
  existing one," which is a materially different (and smaller, more
  defensible) change.
- **Gating a judgment call is often impossible, but a related deterministic
  gap usually is guardable.** No glob can adjudicate "rule tier vs. skill
  tier," but comparing this task's artifact class (rules) against the other
  three (skills, agents, hooks) surfaced that rules alone had no
  registration-completeness gate — a real, closeable, and previously
  unguarded hole. _(promoted → bin/check-context-budget.mjs)_
- **Treat provisional numbering (decision notes, ADRs) as unconfirmed until
  the final pre-push rebase**, not as settled at task start — a
  fast-moving, concurrent repo will claim a number out from under a
  long-running task more than once. _(promoted → docs/decision-notes/README.md)_
- **A flaky pre-push test lane under known high host load is not
  automatically a real regression** — an isolated rerun is cheap and
  conclusive; retry the plain push rather than bypassing the gate.

Sweep-cadence check: 2 logs (`2026-09-07-skill-evals-pass-rate-floor.md`,
`2026-09-07-m3l-mcp-server-rebuild.md`) landed since the most recent
`_(promoted → …)_` stamp (`2026-09-07-lefthook-shim-fail-open.md`), plus this
one — well under the 5-log `/promoting-work-log-lessons` trigger.
