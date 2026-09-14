# Work log — `x8b-bounded-audit-trail` (2026-09-14)

X8b, the X8 follow-up that made the human-action audit trail's growth
_bounded_ rather than merely observed (issue #1057). Thirteen PRs over five
days, all in one linked worktree. The trail could already be measured
(`listSegments()`, X8 slice 5a-ii) but nothing could be removed from it
safely: an archived date, a never-written date and a deleted date were
indistinguishable, and the only production reader never throws by contract, so
the damage was invisible at boot.

Plan of record: `docs/plans/2026-08-20-m3l-console.md` § `### X8`, and
[ADR-0102](../adr/0102-sealed-segment-manifest.md).

## Summary

The writer now seals every segment it rotates away from into one
directory-wide `manifest.jsonl` recording that segment's entry count, byte
length and a plain `sha256` of its raw bytes. Plain, so
`sha256sum <archived-segment>` reproduces the sealed digest with no library
involved — that reproducibility is the whole point, and it is what makes
whole-date archival _provable_ rather than merely tolerated. The sidecar is
deliberately not date-named, so the `rm 2026-09-*` that archives a date cannot
delete the proof along with the segments.

`read()` refuses a sealed segment that is absent (unless `onArchivedSegment`
is supplied) or whose bytes disagree with its seal, verifying inline over the
chunks it already streams — no extra I/O. `verify()` is the reporting half:
re-digests without parsing or yielding entries, never throws, returns a
verdict per segment, and is what an operator reaches for once `read()` is
already throwing.

Shipped as #1199, #1206, #1209, #1213, #1218, #1220, #1224, #1229, #1232, #1247, #1254, #1264 and #1265, plus this close-out.
`m3l-common` 4.7.0 → 4.10.0, additive throughout. Every pre-push ran green
before its push; `pnpm verify` and all six lefthook lanes passed on each
branch.

## What went as planned

- **Splitting on measured size rather than a guess.** Both X8b3 and X8b4
  subdivided mid-wave off `pnpm check:review-size` output, not intuition:
  X8b3 measured 70,771 reviewable chars as one PR, and X8b4c came in at
  259,023 before its final split, against a 75,000 soft target. X8b4d landed
  at 44,072 and X8b5 at ~0 (markdown is ignored). Measuring first was right
  every time it was done.
- **Sequencing hardening ahead of reachability.** X8b3d and X8b3e were
  inserted ahead of the writer wiring specifically so no reachable code path
  ever carried the windows they closed — a pre-seeded-seal window, a
  baseline-poisoning window, and a two-writer rotation window. The same
  principle later moved the console boot handler forward out of X8b5 into
  X8b4c, because making `read()` throw on an archived date would otherwise
  have permanently disabled a rebuild that never throws.
- **Mutation-testing the guards.** Six mutations on X8b4d alone, one at a
  time, each restored and independently checksum-verified against md5
  baselines captured before the run. Three survived and every one was a real
  gap, not an equivalent mutant.
- **Probing instead of reasoning, when the claim was operator-facing.** X8b5's
  archive procedure was written from nine probe scripts run against built
  output. That changed six things in the draft before it shipped.

## What didn't go as planned, and why

- **A hoist claimed to be "the single definition" and was not, twice over.**
  `measurementsMatch`'s TSDoc said it was the only place the three-field
  agreement was computed. The review bot found a second named copy
  (`statesSameMeasurement`); grepping the operand shape then found a **third,
  written inline inside `corroborateClaim` with no helper name at all** —
  invisible to any name-based grep, including the one behind the original
  hoist and the conformance review that had explicitly asked whether the
  sharing was sound and answered yes. Now one definition, four call sites,
  with the count stated in the TSDoc so a fifth makes the sentence visibly
  wrong.
- **Mutation testing could not find a missing assertion about a payload.** Six
  mutations over the read-digest code found three real gaps, and nothing about
  the overrun refusal's `observed` shape — because every mutation perturbs
  _behaviour_, and a field nothing asserts is not a field a mutation can be
  caught changing. The bot found it by reading the TSDoc's promise against the
  tests. Worth keeping as the boundary of the technique, not a criticism of
  it.
- **`toEqual` treats a present-but-`undefined` key as absent**, so the
  end-of-segment path's existing three-key assertion could not catch an
  `observed.sha256 = undefined` leak. Both refusal paths are now pinned by
  exact own-key set. `not.toHaveProperty` was worse than useless here: it
  falls back to `in` and walks the prototype chain.
- **The wave's own capability note predicted a claim nobody re-checked.** This
  plan said from X8b1 that sealing makes intra-date archival _technically
  safe_ — written as a reason to withhold permission. Four live doc sites
  still asserted the opposite ("intra-date deletion breaks the trail"), one of
  them contradicting an accurate paragraph about a hundred lines above it on
  the same page. Found by a `code-reviewer` pass on prose written minutes
  earlier, then settled by probe: a **sealed** segment removed from the middle
  of a date reads clean with a handler, while an **unsealed** one throws with
  or without it. Three slices touched that reader after sealing shipped and
  none of us connected the prediction to the prose.
- **Two spoke briefs I wrote were wrong about a neighbouring package.** One
  named `@monte3l/m3l-console-server`; the package is
  `@m3l-automation/m3l-console-server`, and it has no `test` script at all, so
  the command would have exited 0 having run nothing. The spoke caught both
  and reported rather than reporting vacuous green. Only `m3l-common` carries
  the `@monte3l` scope; the other 21 workspace packages do not.
- **Five spoke truncations at the 40-turn limit.** All recoverable because
  each spoke journalled; one left a genuinely broken tree (a missing
  `ManifestSealRecord` import). One truncation mid-mutation is the reason
  restoration is now verified by value rather than by report.
- **Two of my own gates were vacuous.** A CI monitor reported "0 failing, 0
  passing" and exited, because `jq`'s `all` is vacuously true over the empty
  array `gh pr checks` returns before checks register — it guarded an empty
  string but not an empty list. And a `test:coverage` run of mine collided
  with a spoke's in the same worktree, clobbering a shared `coverage/.tmp`,
  which reads as flake rather than contention.

## Insights

- **Census a duplicate by expression shape, not by helper name.** An inlined
  copy has no name to grep for. Before writing "the single definition of X",
  grep the operand shape across every source tree, count the call sites from
  that output rather than from the brief, and state the number in the doc so a
  future copy makes the sentence visibly wrong.
- **A capability note is a standing instruction, not a record.** "X becomes
  safe the moment this ships" obliges you to grep every sentence claiming X is
  unsafe, on the day it ships. Filed as a reason to withhold permission, such
  a note reads as closed and never gets revisited — which is exactly how four
  contradicting sentences survived three slices.
- **Absence that reads as success is the recurring shape of this whole wave**,
  and it kept appearing in the tools used to verify it, not only in the code
  under test: `sha256sum -c --ignore-missing` exits `0` when a listed file is
  simply gone; `jq`'s `all` is true over an empty array; `pnpm --filter` with a
  wrong name prints nothing and exits 0; a `check:index` that diffs two
  sidecar-derived artifacts passes vacuously when a sidecar entry is missing.
  When a check can return success for "I did not run", it is not yet a check.
- **Mutation testing finds missing assertions about behaviour you thought to
  perturb.** It cannot find a contract nobody wrote an assertion for. Pair it
  with a pass that reads each doc promise against the tests.
- **A TSDoc round that asserts a safety property deserves a code-grade
  review**, because the assertion is the artifact being shipped. Documenting
  one refusal's precedence in this wave surfaced an unvalidated read two lines
  away; reviewing a comment-only change surfaced the four-site claim above.
- **Prefer a structural guarantee to a promise about another module.** The
  archival refusal now reports
  `segmentFileName(parsed.datePrefix, parsed.sequence)` rather than the raw
  map key: `parseSegmentName` accepts a name only when it round-trips through
  `segmentFileName`, so the reported value is built from a calendar-checked
  ASCII date prefix and a `parseInt` integer _by construction_ and cannot
  carry chosen bytes. That is checkable at the call site, unlike a comment
  asserting another module's current strictness.
- **Two killed mutations that could not be expressed were stronger evidence
  than a passing test.** The reader cannot consult the baseline at all —
  `DiscoveredSegment` carries no baseline — so testing the wrong precedence
  required adding the wrong branch upstream. A rule that cannot be written
  wrongly needs no test to defend it.

## Open items

- **Whether the wave should have landed a major** under ADR-0020's
  manual-versioning rule. `read()` now throws for directories that previously
  read clean. No artifact was ever published — no `v4.*` tag, empty
  `gh release list`, both npm listings empty — but #1217 added a real publish
  workflow, so "internal, unpublished package" is now a statement about state
  rather than intent. Left to the maintainer.
- **X8g — intra-date audit archival**, filed `Gated` / `Deferred` by this
  close-out. Capability demonstrated, permission withheld; unblock is an
  archive-custody feature, since no evidence inside the stream directory can
  establish that an archival was authorised.
- **Deleting `manifest.jsonl` still downgrades a sealed trail**, bounded only
  by the directory's `0o700` mode. `verify()`'s `unprovenBefore` makes it
  visible after the fact — but only until a writer re-baselines, after which
  previously sealed segments read `legacy` and `totals.sealed` climbs back
  above zero. Closing it needs state outside the directory, which this
  primitive deliberately does not have (ADR-0102).
- **The rotation-latency figure was never measured** and no number entered
  public TSDoc, which is the outcome the plan required. The manifest's size
  growth _was_ measured (~208 bytes per seal line) and is stated as an
  observation.
- **`docs/implementation-status.md`'s storage Symbols column still reads 24**
  (ungated prose), and `errors.test.ts` is 69,517 bytes against a 60,000
  ceiling, grandfathered, with a Set-based source-scan guard blind to tuple
  order and duplicates.
