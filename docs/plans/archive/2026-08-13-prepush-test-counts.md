# Promote `check:test-counts` into the pre-push lefthook lane

**Status: shipped** — `feat/prepush-test-counts` (commit `4dbbd42`),
closing issue #342.

## Context

`pnpm check:test-counts` verifies that the per-submodule test counts recorded
in `docs/implementation-status.md`'s Notes column match the live Vitest
suite. It ran only in CI (`.github/workflows/ci.yml`), so drift surfaced
after a push, in a red CI run, rather than locally at commit time.

`docs/logs/2026-07-23-core-script-run-wrapper.md` logged the same
~8s-catchable drift three times before filing the candidate: move it into
`pre-push`. Issue #342 (tracker row, P2) formalized that follow-up.

## Approach / Decisions

Precedent already existed for exactly this move: `check-agents` was promoted
from CI-only into `pre-push` in commit `e7012dd`, as its own parallel
lefthook command with a `(was CI-only)` comment; `d52c9bc` established the
two-file shape (`lefthook.yml` + the CLAUDE.md cadence row edited in
lockstep, enforced bidirectionally by `check:cadence`).

- Added `check-test-counts` as its **own** parallel `pre-push` command
  (`lefthook.yml`), not folded into the existing `test:` lane — its scoped
  Vitest run (`vitest run packages/m3l-common/tests`, ~4-8s) stays
  wall-clock-hidden behind the slower `test:coverage`/`lint` lanes rather
  than adding to the slowest one. Accepted tradeoff: a third concurrent
  Vitest process during push (more CPU/RAM), the same class of tradeoff the
  stage's own header comment already reasons about.
- Synced `CLAUDE.md`'s `pre-push` cadence row in the same commit — mandatory,
  since `check:cadence` diffs `lefthook.yml`'s tokens against that row both
  ways. The CI `verify` row needed no edit (already reads "every pre-push
  check … plus every `check:*` script"); `ci.yml` itself is unchanged, so CI
  still re-runs the check independently and `check:verify-parity` stays
  green.
- Fixed two stale prose mentions of the prior 7-check lane count
  (`bin/lib/verify-steps.mjs`'s header comment, `.claude/skills/creating-prs/
SKILL.md`'s enumerated push-budget lane list) and extended the
  `command-catalog.mjs` description to note both lanes run it.
- `docs/plans/IMPLEMENTATION.md`'s tracker row flipped `To Do` → `Done`,
  ID cell left byte-identical (the hub-sync key is derived from it).

## Outcome

Verified end-to-end, not just parsed: ran `pnpm exec lefthook run pre-push
--command check-test-counts --force` against a deliberately corrupted test
count in `docs/implementation-status.md` and confirmed the new lane fails
with the expected mismatch message, then reverted and confirmed it passes
clean (4.3s). `check:cadence`, `check:verify-parity`, `check:tracker-coverage`,
`check:command-catalog`, and `lint:md` all green; `pnpm sync:docs` (13/13)
produced no diff. `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm
build` all passed. `check:hub-drift` correctly reports issue #342 as
close-pending — closed by a maintainer-run `pnpm sync:hub -- --apply` after
merge, per ADR-0032's `GITHUB_TOKEN`-cannot-write-Projects constraint.
