# Work log — should-fix-ack-gate-wave (2026-09-07)

This log covers the 4-PR wave that implemented the Should-fix acknowledgment gate
(`docs/adr/0097`): #1075 (parser groundwork), #1082 (enforcement job + branch-protection
wiring), #1110 (REVIEW.md/skills/docs policy + the ADR itself), and #1119 (a historical
backfill measurement against all 831 merged PRs). It is distinct from
[`2026-09-07-should-fix-backfill.md`](./2026-09-07-should-fix-backfill.md), which is the
generated audit/measurement _output_ itself (`bin/backfill-should-fix.mjs`'s own report),
not a narrative retrospective of the implementation session.

Plan of record: `all-the-should-fix-findings-glittery-locket.md`, the hub's plan-mode file
(`~/.claude/plans/`, outside the repo tree — not linkable).

## Summary

Ran a `/auditing` session against a 4-part request: re-derive facts about Should-fix
disposition rather than assume them, separate unresolved cases into auto-merge vs.
manual-override failure modes, check the gate surface, and plan a deterministic fix. The
audit **corrected its own starting hypothesis**: neither auto-merge (already mitigated —
`creating-prs` defaults to plain `gh pr merge --squash`, never `--auto`) nor manual
override (no bypass exists; `--admin` is forbidden) was the real driver. The actual
mechanism was structural silence — no gate anywhere read the Should-fix tier at all, and
`resolving-pr-comments` stopped unconditionally on a PASS verdict, the majority case, so a
posted Should-fix finding left no local trace on most reviewed PRs regardless of how they
merged.

The approved plan shipped as 4 independently reviewable PRs:

1. **#1075** — `parseShouldFixSection`/`countShouldFixFindings`/`hasShouldFixAcknowledgment`
   added to `bin/lib/pr-review-gate.mjs`, mirroring the existing Must-fix parser exactly. 19
   new tests, 69/69 passing in that suite.
2. **#1082** — `selectShouldFixComment` (max-Should-fix-count selection across review
   rounds) plus `bin/check-should-fix-ack.mjs`, wired as a new `should-fix-ack` job in
   `claude-pr-review.yml` (dogfooding, not yet a required check). 11 new tests, 80/80
   passing in the bin suite.
3. **#1110** — REVIEW.md's Should-fix tier text + the matching `claude-pr-review.yml`
   prompt text (coupled by `check:review-policy`), `resolving-pr-comments`'s PASS-branch
   split, `creating-prs` Step 15's precondition, and `docs/adr/0097` itself (originally
   drafted as ADR-0096 — renumbered mid-wave, see divergence #4). Docs-only; no new tests.
4. **#1119** — `bin/backfill-should-fix.mjs` + `bin/lib/should-fix-backfill.mjs`, the
   historical measurement the original audit couldn't run live (GitHub access was down at
   the time). 50 new tests across two files (26 for the pure classification lib, 24 for the
   CLI's own exports, added in a review-fix round — see divergence #2). Live run against
   this repo's real 831 merged PRs is the actual audit record,
   [`docs/logs/2026-09-07-should-fix-backfill.md`](./2026-09-07-should-fix-backfill.md):
   361 PRs posted a Should-fix finding with no `Acknowledged-Should-Fix:` footer (206
   `merged-unresolved`, 154 `multi-round-suppressed`/indeterminate, 1
   `resolve-commit-heuristic`) against only 10 `acknowledged-footer` PRs, all landed after
   ADR-0097 itself — directly corroborating the audit's corrected live-code finding:
   structural silence, not auto-merge or override, was the dominant historical failure
   mode.

**Skills used:** auditing, starting-work, creating-prs, resolving-pr-comments,
resolving-merge-conflicts, finishing-work, writing-work-logs.
**Spoke incidents:** 1 truncation / 0 stalls / 1 resume (`tmp/session-incidents.jsonl`
records one `test-author` dispatch hitting its 40-turn limit mid-task on PR 4's CLI test
suite; resumed via `SendMessage` to the same agent per `.claude/rules/subagent-dispatch.md`,
which completed cleanly on resume — not a failure, the documented continuation pattern).
**Compaction events:** the hub session itself was replaced mid-wave (a session-boundary
reset occurred while retrying PR 4's push, changing the session id) rather than compacting
in place; state survived via the linked worktree persisting on disk and
`ExitWorktree(keep)`/`EnterWorktree` re-entry recovering it cleanly on the new session,
with no lost decisions — the equivalent of a successful handoff, though via worktree
persistence rather than the `PreCompact`/`SessionStart` handoff artifact.

## What went as planned

- **The parser/enforcement split (PRs 1–2) landed exactly as planned**, mirroring the
  existing Must-fix machinery symbol-for-symbol — no design surprises, no re-review rounds
  beyond routine Should-fix folding.
- **`check:review-policy`'s coupling caught what it was built to catch.** Editing
  REVIEW.md's Should-fix tier text in #1110 without also updating `claude-pr-review.yml`'s
  prompt would have failed that gate immediately — it never needed to fire because both
  were edited together, but its presence shaped the PR from the start.
- **Reusing `bin/lib/pr-review-gate.mjs`'s parsers unchanged in the PR 4 backfill script**
  meant the historical measurement could never disagree with the live gate about what
  counts as a finding — a design constraint stated up front in the plan, validated by the
  measurement's own live run producing sane, spot-checkable numbers (the #951/#955
  deferred-then-followed-up pair classified exactly as the plan's own narrative predicted:
  `merged-unresolved` then `resolve-commit-heuristic`).
- **The should-fix-ack job dogfooded correctly on its own PRs.** #1082's own Should-fix
  finding was later acknowledged via footer in a follow-up commit within the same PR; #1119
  hit a real FAIL from missing tests and cleared it the same way once fixed — the gate
  behaved on live traffic exactly as the design predicted before any of it was a required
  check.

## What didn't go as planned, and why

### 1. `selectShouldFixComment` needed a max-selection design, not a "read the latest comment" one

Mid-implementation on PR 2, re-reading REVIEW.md's own "Re-review convergence" rule
surfaced a design gap: it instructs the reviewer to suppress fresh Should-fix bullets on
every round after the first, reporting only a free-text count. A naive gate reading only
the most recent `claude[bot]` comment would silently stop enforcing acknowledgment the
moment any PR reached a second review round, even though round 1's findings were still
outstanding.

**Why it happened:** The original design assumed each review comment fully restates
current Should-fix status, which is only true for round 1. REVIEW.md's own convergence
rule was written before this gate existed and was never audited against a Should-fix
consumer's needs.

**Fix for future:** `selectShouldFixComment` takes the maximum Should-fix count across
every parseable review round instead of the latest one. This is provably correct (no later
round ever posts more bullets than round 1, only the same or fewer per the suppression
rule) but has a known, accepted trade-off: once round 1 posts N > 0 findings, the
acknowledgment footer becomes the only path this gate — or the PR 4 backfill measurement
built on the same primitive — can ever recognize, even for a finding genuinely fixed in a
later round with no footer. Closing that gap needs REVIEW.md's convergence rule itself to
restate current status on every round, not a smarter parser.

### 2. The live PR review caught a genuine gap the pre-push review missed: zero tests for the CLI's own exports

PR 4's pre-push fan-out dispatched `docs-consistency-reviewer` (correctly, since the diff
was docs/automation-only) and got a clean PASS. The post-push `claude-pr-review.yml` run
then FAILed with a real Must-fix: `bin/backfill-should-fix.mjs`'s four top-level exports
(`fetchMergedPrNodes`, `readMergeCommitBody`, `renderReport`, `toBackfillInput`) had zero
tests despite an injected `runGhFn` seam built specifically to make them testable. The
existing `bin/tests/should-fix-backfill.test.ts` only ever covered the pure `bin/lib/`
classification module.

**Why it happened:** `docs-consistency-reviewer` checks cross-file consistency, not test
coverage completeness — the pre-push routing rule (docs-only diff → consistency reviewer
only) has no test-coverage-scoped spoke to fall back to, unlike the `src/**` path which
always includes `code-reviewer`. A CLI script under `bin/` sits in a gap: it's not
`src/**`/`tests/**` (so `creating-prs`' full review fan-out doesn't trigger), but it has
real, testable logic the same way library code does.

**Fix for future:** This is exactly what the two-phase review design (`creating-prs`'
pre-push spokes, then `claude-pr-review.yml`'s post-push bot) is for — treat a live FAIL on
a `bin/`-only PR as expected coverage the pre-push routing table structurally can't provide
for that path class, not as a process failure. `resolving-pr-comments` handled the fix
loop end-to-end (dispatched `test-author` for the guarded `bin/tests/**` write, added 24
new tests, a bounded `code-reviewer` re-review found no further Must-fix, and the PASS
verdict + `should-fix-ack` both went green on the next round).

### 3. GitHub's GraphQL API silently misclassified every real review during backfill smoke-testing

Every early smoke-test run of `bin/backfill-should-fix.mjs` against real PRs (including
ones known to carry Should-fix findings) reported `no-review-posted` for all of them. The
root cause: GraphQL's `author.login` on a bot comment returns `"claude"`
(`author.__typename == "Bot"`), while the REST API's `user.login` for the identical comment
returns `"claude[bot]"` — the value `bin/check-should-fix-ack.mjs` (a REST consumer)
correctly matches on. The backfill script's first draft copied that same `"claude[bot]"`
literal into a GraphQL-sourced filter, where it never matched anything.

**Why it happened:** Two different GitHub API surfaces expose the same bot identity under
different string representations, and nothing in this repo had previously needed to read a
bot's login via GraphQL — every prior consumer (`check-should-fix-ack.mjs`,
`pr-review-gate.mjs`'s own doc comments) used REST.

**Fix for future:** Confirmed live and now documented directly in
`bin/lib/should-fix-backfill.mjs`'s `BackfillPrComment` JSDoc, with an `isBot` boolean
(`author.__typename === "Bot"`) added alongside the login string as a defense against a
hypothetical human account literally named "claude." This is the `harness-artifacts.md`
rule about running a new script against known-good live input before trusting it, applying
to a GitHub API consumer, not just a workflow script — a synthetic fixture would have
happily encoded the wrong literal and never caught it.

### 4. ADR-0096 was claimed by a concurrent, unrelated wave before this one landed

The plan and PR 3's first draft cited `docs/adr/0096-should-fix-acknowledgment-gate.md` as
the target filename, correct at plan time (corpus was 97 files; ADR-0094/0095 had just
landed). By the time PR 3 was ready to land, an unrelated concurrent session had already
claimed ADR-0096 for the m3l MCP server rebuild wave. Caught before merge; fixed via `sed`
across 5 files (7 occurrences) to renumber to ADR-0097, verified with a clean
`grep -rn "0096"`.

**Why it happened:** This repo runs multiple concurrent Claude Code sessions against the
same `main`, and ADR numbering has no reservation mechanism — the "next free number" is
only accurate at the instant it's checked, and this wave's own multi-hour, multi-PR span
gave a concurrent session time to land first.

**Fix for future:** Re-derive the next free ADR number immediately before writing the
file that claims it (not once at plan time), the same "re-derive any authored claim"
discipline CLAUDE.md's Task Workflow already states for a tracker's scope or a census — ADR
numbers are exactly this kind of claim that rots between authoring and use.

### 5. A calibrated host-resource threshold didn't hold under real concurrent load

PR 4's `git push --force-with-lease` failed 3 consecutive times with the _exact_ same
failure: the pre-push hook's parallel `lint` lane OOM-killed (`JavaScript heap out of
memory`, exit 134), even though `free -h` showed 20+ GiB free immediately before and after
each attempt, and this host (23.4 GiB total) sits _above_
`bin/setup-host-resources.mjs`'s 20 GiB auto-serialize threshold — the tool itself reported
"parallel pre-push is fine, nothing to write" on a dry run taken between failures.

**Why it happened:** The threshold is a static total-RAM heuristic; the actual failure mode
is transient _peak concurrent demand_ from lefthook's parallel pre-push fan-out (typecheck +
build-exports + checks + format + `test:coverage` + `lint` all running at once, each a
separate Node process with its own heap ceiling) exceeding available memory for the
seconds it takes eslint to peak, then releasing it — invisible to a `free -h` snapshot taken
before or after the run, only visible mid-run.

**Fix for future:** Manually wrote the same gitignored `lefthook-local.yml` override
`setup-host-resources.mjs --apply` would write below its threshold
(`pre-push: parallel: false`), forcing that one push's heavy lanes serial; it passed
cleanly on the first attempt afterward (835s serial vs. repeated OOM failures in parallel
mode) and the override file was deleted immediately after. This is a real calibration gap
in `SERIAL_PREPUSH_MEM_THRESHOLD_GIB` (20 GiB) worth a follow-up look — a 4-core host with
23 GiB can apparently still starve under this specific fan-out shape, which the static
threshold doesn't model. Filed here as observed evidence, not as a tracked issue (a
`docs/plans/IMPLEMENTATION.md` friction item is a separate, deliberate follow-up step; see
Lessons below for why this one is left as a lesson rather than filed).

## Lessons learned

- **A per-round-suppression rule anywhere in a review pipeline poisons any consumer that
  reads "the latest comment."** REVIEW.md's re-review convergence rule was written for a
  human reviewer's ergonomics (don't repeat noise), not for a machine consumer counting
  findings — any future gate reading posted review comments needs to ask explicitly
  whether a suppression rule like this exists upstream before assuming the latest comment
  is authoritative.
- **A REST-vs-GraphQL API surface can expose the identical bot identity under two different
  string literals with no warning.** Never copy an actor-identity literal (a bot login, a
  service-account name) between a REST-sourced constant and a GraphQL-sourced one without
  verifying live against both APIs first — the two representations silently diverging is
  not documented anywhere in GitHub's own API docs and was only caught by a live smoke test
  producing suspiciously uniform "no review found" results.
- **Re-derive a claimed identifier (an ADR number, a tracker id) right before the commit
  that uses it, not once at plan time**, on any repo running concurrent sessions against
  the same `main` — a multi-PR wave's own span is enough time for a collision _(promoted →
  this is already the general form of a lesson stated in CLAUDE.md's Task Workflow —
  "Re-derive any authored claim you're about to act on" — so no separate promotion needed
  here; this wave is additional lived evidence the existing rule already covers)_.
- **A static host-resource-contention threshold calibrated on total RAM doesn't model
  transient peak demand from a specific parallel fan-out shape.** Three consecutive
  identical OOM failures on a host reported as "above threshold, parallel is fine" is
  strong evidence the threshold needs recalibrating for this repo's actual pre-push lane
  count, not evidence to keep blindly retrying — check `lefthook-local.yml`'s escape hatch
  (`pre-push: parallel: false`) manually the moment a _second_ consecutive OOM shows the
  identical signature, rather than after a third.
- **A CLI script's pre-push review routing has a real coverage gap for `bin/`-only diffs.**
  `creating-prs`' docs-vs-src routing sends a `bin/`-only, non-`src/`/`tests/` diff to
  `docs-consistency-reviewer` alone, which has no mandate to check test coverage the way
  `code-reviewer` does on the `src/**` path — the post-push bot review is what actually
  catches a missing-test gap on this path class today, which is fine as a design (two-phase
  review is deliberate) but worth knowing going in rather than reading a live FAIL as a
  process surprise.
