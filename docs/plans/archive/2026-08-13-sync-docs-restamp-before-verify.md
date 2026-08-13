# `sync:docs` pre-flight step-ordering inversion

**Status: shipped** — `fix/sync-docs-restamp-before-verify` (commit `da0e407`),
closing issue #340.

## Context

`pnpm sync:docs` (`bin/sync-docs.mjs`) ran a fixed 14-step sequence, fail-fast.
Step 1 was a bare `check-doc-provenance.mjs` verify; step 2 was
`check-doc-provenance.mjs --update`. The verifier exits 1 on staleness
warnings alone in its full-verify path, not just on hard errors — so any edit
to a documented source file since the last provenance stamp made step 1 abort
the composite on precisely the staleness that step 2 exists to clear.

This was logged as a recurring divergence across three separate sessions
(`docs/logs/2026-07-23-core-script-log-level-chain.md`,
`docs/logs/2026-07-24-core-script-runscript-adoption.md` — "Now hit in A3,
A4b, and A5") and papered over as a documented "Known gap" in
`.claude/skills/syncing-docs/SKILL.md`, instructing the agent to run the
`--update` workaround by hand before every composite run rather than fixing
the ordering.

## Approach / Decisions

The fix was a deletion, not an inversion: `--update` already performs the
identical structural validation and exits 1 on any hard error **before it
writes a single sidecar** (`bin/check-doc-provenance.mjs`'s `totalErrors > 0`
guard runs ahead of its `isUpdate` block). The pre-flight step therefore
contributed nothing except the staleness hard-fail that caused the bug.

- Removed the redundant pre-flight step from `bin/sync-docs.mjs`'s
  `runSequence()`; the composite is now 13 steps (was 14), re-stamping first
  with the post-stamp provenance verify as the real gate. Renumbered every
  step comment/reference across the file accordingly.
- `.claude/skills/syncing-docs/SKILL.md`: removed the "Known gap" block
  (no longer applicable), deleted the manual pre-flight step, renumbered the
  manual fallback sequence 1–8, and updated the summary-report template.
- `.claude/skills/syncing-docs/evals/evals.json`: updated the two eval
  expectations that asserted pre-flight-before-restamp behavior.
- `bin/check-doc-provenance.mjs` was deliberately left unchanged — its
  full-verify (staleness ⇒ exit 1) and `--affected` advisory-hook contracts
  are both still correct for CI and the `guard-provenance-staleness`
  PostToolUse hook respectively.
- The historical objection to an unscoped `--update` — "it re-stamps all 22
  sidecars" (`docs/logs/2026-07-11-core-script-preset-seam.md`) — no longer
  applies: staleness became content-addressed (git blob SHA per source file),
  so `applyBlobUpdates` already skips writing any sidecar with nothing
  actually stale, and the manual workaround people ran already was an
  unscoped `--update`.

## Outcome

Reproduced the original failure directly (dirtied a sidecar-referenced source
file, confirmed `sync:docs` no longer aborted, confirmed the specific module
was restamped and the run completed 13/13 green), then confirmed the composite
runs clean on an untouched tree. Full `pnpm verify` (36 steps, 3 skipped)
passed. `docs/plans/IMPLEMENTATION.md`'s tracker row flipped `To Do` → `Done`;
`pnpm sync:hub -- --apply` closed GitHub issue #340 and archived its project
board item.
