# Work-log lesson promotion — the first full-corpus cross-log sweep

**Status: shipped** — PR on `docs/promote-work-log-lessons` (`fe73099`).

## Context

`/writing-work-logs` Step 4 promotes lessons at write time, but the decision is
discretionary and single-log: the agent that just wrote one log judges, in the
moment, whether a lesson generalises. Nothing looks _across_ logs, so a lesson
skipped once as "too specific" can recur three logs later and still never reach
a durable home. `/promoting-work-log-lessons` exists to close that leak; this
was its first run over the whole corpus rather than a recent slice.

Scope read in full: 90 logs, ~17,400 lines, via three parallel `Explore`
agents splitting the corpus by date. 162 lessons already carried a
`_(promoted → …)_` marker across 68 logs and were excluded at extraction,
leaving ~330 unmarked lessons that clustered by meaning into roughly 20
candidate themes.

## Approach / Decisions

The recurrence filter (≥2 distinct logs) turned out to be the weak filter; the
**already-captured** filter did the real work. Fourteen heavily-recurring
themes were dropped because the loop was already closed for them — including
the three largest: re-derive an authored claim before acting (13 logs, in
`CLAUDE.md` § Task Workflow), verify an SDK's shape against its installed
`dist-types` before drafting the contract (8 logs, in
`implementing-submodules/SKILL.md`), and the whole spoke-truncation family (in
`.claude/rules/subagent-dispatch.md`).

Four themes survived and were routed to the file the relevant agent actually
reads while doing that work, rather than to `CLAUDE.md`:

- **`.claude/agents/code-implementer.md`** — a fix to one member of a
  structurally identical family is not complete until the family is grepped.
  Placed next to the existing "grep for the stale design-rationale phrase"
  rule, widening it from comments to code.
- **`.claude/rules/tests.md`** — never mock the behaviour the test exists to
  validate (the third member of the proxy-assertion / unreachable-arm family,
  and the only one with no rule); and a suite failing under a live fan-out may
  be contention rather than a regression.
- **`.claude/rules/subagent-dispatch.md`** — barrel wiring gets its own
  numbered, separately-verified dispatch step. The existing guidance covered
  _detecting_ a missing barrel during truncation recovery, not _preventing_ it.
- **`.claude/skills/writing-work-logs/SKILL.md`** — a follow-up that lives only
  in a work log does not exist, generalised past library friction, with
  re-derivation required at filing time.

Two candidates were dropped mid-apply rather than shipped, both caught by
verifying against repo state instead of trusting the extraction:

- The "`index.ts` is coverage-invisible" rule was already carried by
  `scaffolding-submodules/SKILL.md` step 2, and its second source log was
  already stamped — the extraction pass had missed the marker. Reverted.
- A citation to `2026-08-24-w8-sqs-dead-letter-triage.md` was removed: that log
  exists only on the unmerged `docs/w8-work-log` branch, so the reference would
  have dangled on `main`. The rule still stands on its two remaining sources.

The `check:test-counts` contention bullet was also rewritten after reading the
cited log properly: that log's own conclusion was that the flake was **redundant
work**, not contention, and it failed sequentially too — so the rule now warns
against stopping at "contention" as the diagnosis.

## Outcome

Four rules across four files, 65 insertions. 11 `_(promoted → …)_` stamps land
across 9 source logs so the next sweep skips these themes (168 markers → 179).
No `src/`, test, or `exports`-map changes; zero semver impact.

The durable finding for the sweep itself: an extraction agent's "unmarked"
verdict is a claim, not a fact — two of six candidates fell to a marker or a
rule the extraction pass had missed, and both were only caught by grepping the
target files during apply. Confirm each candidate's filter-2 and filter-3 status
against the repo immediately before writing, not only at report time.
