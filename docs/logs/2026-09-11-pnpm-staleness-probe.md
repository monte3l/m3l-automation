# Work log — pnpm staleness probe (2026-09-11)

This log covers PR 3 of 3 in the pnpm drift-prevention sequence — the
warn-only staleness probe added to `bin/check-deps.mjs`, comparing the pinned
pnpm major against pnpm's true upstream latest. It closes out the sequence
started by PR 1 ([pnpm-pin-gate](./2026-09-11-pnpm-pin-gate.md)) and continued
by PR 2 ([pnpm-12-bump](./2026-09-11-pnpm-12-bump.md)). It records what
shipped, what matched the plan, what diverged, and durable insights —
including the first live application of an insight PR 2's own log recorded
just hours earlier.

Plan of record: `~/.claude/plans/inherited-prancing-dove.md`, archived in this
same PR at
[`docs/plans/archive/2026-09-11-pnpm-12-bump-and-drift-prevention.md`](../plans/archive/2026-09-11-pnpm-12-bump-and-drift-prevention.md).

## Summary

- **PR #1189** (`feat: warn on pnpm packageManager staleness in check:deps`):
  added `findPnpmStaleness(pinnedMajor, latestVersion)`, a pure exported
  helper in `bin/check-deps.mjs`, plus a new "6. pnpm packageManager
  staleness (warn-only)" section in the main-execution block that fetches
  `npm view pnpm version` and warns — never fails — when the pinned major
  trails upstream. Zero new wiring: `check:deps` was already a
  `conditional: true` verify step. Also archived the originating 3-PR plan
  into `docs/plans/archive/` and added its `docs/plans/README.md` row, since
  this PR closes out the full sequence.
- **Same-PR follow-up commit** (`fix: degrade gracefully on unspawnable npm
in check:deps staleness probe`): `claude-pr-review` posted PASS with one
  Should-fix — the new `run("npm", ...)` call had no guard against `run()`'s
  own throw-on-spawn-failure behavior, which would abort the whole script and
  contradict the block's own warn-only contract. Fixed in the same PR (not a
  follow-up PR) by wrapping the call in a try/catch degrading to
  `reporter.warn`, verified against a real `ENOENT` spawn failure. Two
  original Nits plus one new Nit from the bounded security re-review were
  left unaddressed (documented in the commit body and a PR follow-up
  comment), matching `resolving-pr-comments`' opportunistic-only Nit rule.
- Verification: live-ran `node bin/check-deps.mjs` against the repo before
  writing tests (`.claude/rules/harness-artifacts.md`) — correctly silent
  since the pin (12.4.0) and upstream's actual latest (12.4.1, confirmed via
  a direct `npm view`) share a major. A synthetic call confirmed the warn
  path fires for a genuinely newer major. 6 new tests in
  `bin/tests/check-deps.test.ts` (45/45 in file). Full `pnpm verify` green
  twice (once before the Should-fix, once after). `pnpm sync:docs` — 15/15
  steps, twice.
- Skills used: `syncing-docs` (twice), `resolving-pr-comments` (in
  substance — the fix/re-review/commit/push/comment loop — though invoked
  inline rather than as a formal slash-command dispatch), `finishing-work`,
  `writing-work-logs` (this log's own invocation).
- Spoke incidents: none (this task's dispatches — one `test-author`, one
  `docs-consistency-reviewer`, one `code-reviewer`, one `security-reviewer`
  — reported no truncations; the two `kind: "truncation"` entries in
  `tmp/session-incidents.jsonl` predate this task, already attributed to
  PR 1's spokes in PR 2's own work log).
- Compaction events: none.

## What went as planned

- **"No new wiring at all" held exactly as the plan predicted.** No catalog
  row, no ci.yml step, no lefthook token, no CLAUDE.md row — confirmed
  directly by the pre-push `docs-consistency-reviewer` dispatch rather than
  assumed from the plan text.
- **The live-run-before-tests discipline caught nothing wrong, which is
  itself a useful confirmation.** `bin/check-pnpm-version.mjs`'s own header
  explicitly designates this staleness question as its own deliberate
  non-goal, naming `bin/check-deps.mjs` as the intended home — the new code
  landed in exactly the seam the sibling gate had already reserved for it.
- **The warn-only design held under real review pressure.** The one
  Should-fix finding was precisely about the warn-only contract being
  technically violated by an unguarded throw — not about whether the
  contract itself was the right call. The design survived; only the
  implementation needed tightening.
- **Waiting for the bot review before arming auto-merge paid off
  immediately** (see below) — this is the first PR in the sequence where
  that choice was actually tested against a real Should-fix finding, and it
  worked exactly as intended.

## What didn't go as planned, and why

### 1. The Should-fix finding was real, not a false positive

Unlike PR 2's should-fix-ack race (a _process_ problem — the finding itself
was legitimate but the merge outraced the fix), this PR's Should-fix was a
genuine, if narrow, defect: `run()` throws on `res.error` (a spawn failure),
and the new warn-only block called `run("npm", ...)` with no guard against
that throw. A missing `npm` binary — implausible but not impossible in every
CI/dev environment — would have aborted the entire `check:deps` gate,
including its four _blocking_ checks, exactly the failure mode a
non-network-fault-tolerant warn-only addition should never introduce.

**Why it happened:** The two pre-existing `run()` calls in this file
(`pnpm outdated`, `pnpm list`) are equally unguarded against this failure
mode, and were used as the implicit template when writing the new call —
but those two are load-bearing (their own outer JSON-parse try/catch exists
for a different reason, malformed output, not spawn failure), so an
unspawnable `pnpm` failing the whole gate is arguably correct there. Copying
the shape without re-deriving why it was safe in the original context missed
that the new call's correctness requirement (warn-only, must never abort)
was different from its neighbors'.

**Fix for future:** When a new gate check is explicitly warn-only, guard
_every_ spawn call it makes against a spawn failure specifically, even when
neighboring load-bearing calls in the same file don't — the "must never
abort" contract applies to failure modes the neighbors don't share, and a
structurally-similar-looking call is not automatically held to the same
correctness bar.

### 2. Deciding the merge path required checking live branch-protection state again, not trusting the prior session's finding

PR 2's own work log recorded, as an insight, "check the live
branch-protection/ruleset config before arming auto-merge on a PR where a
Should-fix finding is plausible — don't assume ADR-0097's existence means the
enforcement mechanism is fully wired." This PR re-ran that exact check
(`gh api repos/.../branches/main/protection --jq '.required_status_checks.contexts'`)
rather than trusting the just-recorded conclusion from a few hours earlier,
and got the identical answer: `should-fix-ack` still absent from
`["Dependency Review","CodeQL","verify"]`. Based on that, auto-merge was
deliberately not armed, and the PR was merged manually only after the
Should-fix fix round completed and the bot review's PASS verdict was
re-confirmed.

**Why it happened:** Not a divergence in the "what went wrong" sense — this
is recorded here because it's the first time an insight from _this same
session's_ immediately-preceding task was put into practice on a live
decision, rather than staying a written observation. Re-checking rather than
trusting the log was deliberate: branch-protection settings are exactly the
kind of live state that can change between two PRs in the same afternoon
(a maintainer could enable the ruleset mid-session), so the insight's own
instruction ("check the live config") was followed literally rather than
its cached conclusion.

**Fix for future:** None needed — this is confirmation the insight
generalizes and is cheap enough (`gh api`, one endpoint) to re-check on every
bot-reviewed PR rather than caching the answer across PRs in the same
session.

## Insights

- **A warn-only check's every spawn call needs its own failure-mode
  audit, independent of neighboring load-bearing calls in the same file.**
  Structural similarity to an existing `run()` call is not evidence of
  matching correctness requirements — the neighbor may tolerate a throw
  precisely because it isn't warn-only. Generalizes to any future addition
  of a genuinely-optional check inside a file whose other checks are
  blocking.
- **Re-check live branch-protection state per bot-reviewed PR, not once
  per session.** PR 2's insight ("check the live required-checks list
  before arming auto-merge") was re-verified from scratch on this PR rather
  than trusted from memory, confirming it was cheap enough to repeat and
  that the underlying state (still no `should-fix-ack` enforcement) hadn't
  changed in the intervening hours. _(confirms [[pnpm-12-bump]]'s
  should-fix-ack insight, no new promotion needed — already actionable as
  written)_
- **A same-PR Should-fix fix round is strictly better than the same-day
  follow-up-PR pattern PR 2 needed**, when auto-merge is deliberately held
  rather than armed: no branch-recovery maneuver, no second PR/review/merge
  cycle, just the fix/re-review/commit/push loop against the still-open PR.
  The two approaches aren't interchangeable by choice, though — PR 2's
  follow-up-PR path was forced by an already-fired auto-merge, not chosen;
  this PR's single-PR path was only available because auto-merge was never
  armed in the first place.
