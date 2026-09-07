# A durable slice record for non-submodule multi-PR work (issue #998, H5)

**Status: shipped** — PRs #1121, #1123, #1126.

## Context

`docs/ROADMAP.md`'s H5 governance row (synced to GitHub issue #998) recorded
a gap ADR-0072's 2026-09-04 amendment had itself named but deliberately not
closed: a submodule landing across several PRs has a durable, machine-checked
slice-sequence record (a `## Landing plan` heading on its reference page,
gated by `bin/check-scaffold-seam.mjs`), but a non-submodule multi-PR wave —
X8 shipped as sixteen PRs, X7d as seven, the 2026-09-04 lifecycle remediation
as five — has no equivalent; the sequence lived in conversation, an ad-hoc
`~/.claude/plans/` file, or a prose section no gate reads.

Re-deriving the premise before acting on it found the gap narrower than
filed: `docs/plans/2026-09-01-orchestration-engine.md` and
`docs/plans/2026-09-02-u11-retry-resume-cancellation.md` already carried a
`## Slice sequence` table (`| # | Branch | Contents | Semver |`) — the right
shape in the right place, missing only a `Status` column, so nothing could
tell which slice was next or mark one shipped.

## Approach / Decisions

- **Reuse `## Landing plan` verbatim, sited on a live dated plan doc.** One
  heading, one parser, one contract — not a second `## Slice sequence`
  vocabulary. `pnpm slice:set -- --page docs/plans/<plan>.md` needed zero CLI
  change, since `parseSetArgs` never constrained its argument to a
  `docs/reference/` path — concrete evidence the two sitings were always one
  mechanism, not two.
- **Require a parseable `## Landing plan` on every live dated plan doc,
  blocking.** A finished plan moves to `docs/plans/archive/` instead of being
  retrofitted with a table — "finished" and "must carry a Landing plan"
  become the same statement by construction of the scan predicate.
- **Generalize the shared parser two ways**: prefix-match terminal statuses
  (fixing a real latent bug — `docs/reference/core/procedure.md`'s seven
  `Landed (PR #NNN)` rows parsed as "1 of 7, in flight" under the old
  exact-match `Set`) and read an optional `Branch` column, ref-name-validated
  before use since the value can end up interpolated into a shell command.
- **Record the decision as a third dated Amendment on ADR-0072**, not a new
  ADR — this executes the revisit trigger the 2026-09-04 amendments
  themselves named, the house pattern for amending an Accepted ADR.

## Outcome

Three PRs, each independently reviewed and merged:

- **#1121** — generalized `parseLandingPlanProgress` (prefix-status matching,
  the `Branch` column, a `normalizeBranchCell` ref-name guard), extracted as
  a behavior-preserving `.claude/hooks/statusline-context-pressure.mjs`
  refactor. Two `claude-pr-review` rounds, both resolved (a bold-status
  matching gap and untested branch-rejection edge cases in round one; a
  `branch`-on-fully-landed leak in round two). Narrative:
  `docs/logs/2026-09-07-landing-plan-parser-generalization.md`.
- **#1123** — `pnpm check:landing-plans` (`bin/check-landing-plans.mjs` +
  `bin/lib/landing-plans.mjs`), the non-submodule counterpart to
  `check:scaffold-seam`, plus the docs backfill needed to pass it on `main`:
  archived three plan docs confirmed fully shipped against real PR evidence,
  and — discovered mid-task, not anticipated — fixed a real
  `docs/ROADMAP.md`/`docs/plans/IMPLEMENTATION.md` status drift on U11 and V9
  (both already `Done` in the detailed tracker; the coarse one still read
  `To Do`, and V9's own close-out commit message claimed a tracker flip its
  diff never made). One `claude-pr-review` FAIL round (a silently-swallowed
  `readdirSync` failure, an untested new export, plus two Should-fix design
  gaps) resolved via `/resolving-pr-comments`; a second round's minor
  diagnostic-quality Should-fix also fixed; third round clean. Narrative:
  `docs/logs/2026-09-07-check-landing-plans-gate.md`.
- **#1126** — the ADR-0072 fourth Amendment (with two inline
  `[**Stale (2026-09-07):**...]` retractions on the now-superseded
  2026-09-04 scope-limit sentences), `starting-work`/`finishing-work`/
  `creating-prs` rewired to read either siting, `docs/contributing/filing-work.md`
  gained a cross-reference distinguishing filing-time tracker-row slicing
  from pickup-time seam planning, and the H5 row flipped to `Done`. Reviewed
  clean (docs-only diff, Gate 0 short-circuit). Narrative:
  `docs/logs/2026-09-07-h5-close-out.md`.

Post-merge `pnpm sync:hub -- --apply` closed issue #998 and its now-emptied
parent governance epic (#606) in a single run. A recurring host-specific V8
heap-ceiling artifact on the workspace lint lane surfaced repeatedly across
all three PRs' push attempts; `NODE_OPTIONS="--max-old-space-size=8192"`
confirmed as a reliable fix and promoted to the `eslint-concurrency-crashes-wsl`
durable memory. No `src/`, test, or `exports`-map changes across the
sequence beyond `bin/`/`.claude/hooks/` tooling — zero semver impact on the
published package.
