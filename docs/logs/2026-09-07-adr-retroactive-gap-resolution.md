# Work log — ADR retroactive-gap resolution (2026-09-07)

This log covers a follow-up `/auditing` pass scoped specifically to what
ADR-0094/ADR-0095's own tooling does not apply retroactively — the two ADRs
that shipped a status/relations schema, a worthiness-routing gate, and a
provenance sidecar over the preceding session
(`docs/logs/2026-09-06-adr-corpus-audit.md`,
`docs/logs/2026-09-06-adr-governance-tooling.md`). It records what the
4-facet audit found, the two PRs that closed the gaps, and a divergence in
PR2 caught by pre-push review that is itself an instance of the audit's own
central lesson recurring one level down.

Plan of record: `/home/enri3l/.claude/plans/run-auditing-over-docs-adr-compressed-quokka.md`

## Summary

Ran the `auditing` skill's `audit-fanout` workflow (4 facets, 19 agents: 4
Explore finders + 15 `audit-refuter` verifiers, 10 confirmed / 5 refuted / 11
hub-verified) against `docs/adr/`, scoped to four questions the prior
session's tooling doesn't answer for the pre-existing corpus:

1. **Retroactive `check:adr-worthiness` matches** — running
   `deriveWorthinessCandidates()` over all 95 live ADRs (not just
   branch-added ones) flags exactly `0074-milestone-major-tier-title.md`.
   Confirmed the "never re-flag an already-Accepted ADR" policy is
   deliberate and already enforced (`check-adr-worthiness.mjs`'s branch-diff
   scoping, ADR-0095's rejected option 3) — **no corpus change needed.**
2. **Deferral ADRs with an unfired trigger and no `Review by:` date** —
   found 4 genuine gaps after independent verification (ADR-0015, ADR-0018,
   ADR-0081, and — only in an early draft, corrected before push, see
   Divergence 1 — ADR-0037) plus one ADR (ADR-0043) carrying the field after
   its trigger had already fired.
3. **`docs/adr/provenance.json` drift** — 9 warnings on clean `main`, root
   cause: `gen-adr-provenance.mjs`'s `isTrackableFile()` only checked
   `existsSync`+`isFile()`, so gitignored `tmp/*` and an
   unignored-by-repo-but-personally-ignored `.claude/settings.local.json`
   became provenance sources, making the sidecar non-deterministic per
   machine/CI.
4. **One-sided partial-supersession clause lists** — already fully closed by
   the prior session's normalization sweep (0 findings, all 8 pairs
   two-sided), but `missing-clause-list` was advisory-only despite
   ADR-0094:93-94 stating the rule in absolute terms ("no longer
   permitted").

Shipped as two sequenced PRs (ADR-0072 reviewable-slice discipline: tooling
first, corpus content second):

- **PR1 (#1071, `fix:`, bin/** tooling)** — `gen-adr-provenance.mjs` and
  `check-adr-provenance.mjs` now share one git-tracked-path filter
  (`bin/lib/doc-provenance.mjs`'s new `trackedFiles()`, batched
  `git ls-files`; `bin/lib/adr-provenance.mjs`'s new `filterToTracked()`);
  `missing-clause-list` moved into `STRUCTURAL_FINDING_KINDS` (now
  blocking) alongside a new sibling `placeholder-clause-list` check
  rejecting `(clauses: TBD)`-style non-answers; a `BLOCKING=false`
  self-misreport in `check-adr-index.mjs`'s success message fixed;
  `bin/tests/adr-worthiness.test.ts`'s live-corpus assertion decoupled from
  an inline snapshot into a documented `KNOWN_ACCEPTED_MATCHES` allowlist.
  101 tests added/passing across 4 test files. Two follow-up commits
  addressed a Should-fix and two Nits from the automated PR review (a
  `@param` doc overclaiming directory support; a placeholder-regex
  narrowness note) before merge — final review verdict PASS, zero
  outstanding findings.
- **PR2 (#1073, `docs:`, docs/adr/** + docs/decision-notes/** content)** —
  `Review by:` dates added to ADR-0015/0018/0081, removed from ADR-0043;
  `docs/adr/template.md` gained the field (omit-if-none) and a corrected
  Relations-verb comment; `docs/adr/README.md` § Conventions documents the
  field and fixes a doubly-stale "status block is two lines" claim;
  decision-note 0001 extended in place (permitted per ADR-0095) with a
  dated `Extended (2026-09-06)` callout. `docs/adr/provenance.json`
  re-stamped, 0 drift.

Both merged squash, both `pnpm verify`-clean, both reviewed by
`docs-consistency-reviewer` (no `src/**` in either diff).

Skills used: `auditing` (via `audit-fanout` workflow), `starting-work`,
`writing-commits` (implicit, manual), `creating-prs`, `syncing-docs`,
`finishing-work`, `writing-work-logs`.

Spoke incidents: none (no `tmp/session-incidents.jsonl`; no truncations,
stalls, or `SendMessage` resumes observed across 19 audit agents, 2
test-author dispatches, and 2 `docs-consistency-reviewer` dispatches).

Compaction events: none.

## What went as planned

- **The audit-fanout workflow's verify pass earned its keep.** 5 of 15
  verified findings were refuted — three "gap" claims about ADR-0074's
  worthiness match were refutations of a policy that turned out to already
  be deliberate and documented (ADR-0095's rejected option 3,
  `check-adr-worthiness.mjs`'s own header comment) — catching what would
  otherwise have been unnecessary corpus/doc changes before they reached
  the plan.
- **Live mutation testing on the two blocking-gate changes worked exactly
  as `.claude/rules/harness-artifacts.md` prescribes.** Before writing any
  test fixtures, a placeholder clause, a bare clause, and a passed
  `Review by:` date were injected directly into real ADR files, the gate
  re-run, and the files restored byte-identical — confirming
  `placeholder-clause-list`/`missing-clause-list` promotion to blocking
  actually blocks, and the `BLOCKING=${String(BLOCKING)}` fix reports
  correctly, before any test-author dispatch.
- **The provenance-filter fix was independently confirmed by
  `syncing-docs`'s own regen.** Running `pnpm gen:adr-provenance` after the
  fix, and again after the PR1→PR2 rebase, both times produced "already
  reflects N ADR(s) — no changes" on the second pass — the filter is
  idempotent and the fix is complete, not a partial patch that still needs
  a human to notice residual drift.
- **The squash-merge rebase sequencing (PR2 depends on PR1) worked
  cleanly.** `git rebase --onto origin/main fix/adr-provenance-determinism
docs/adr-deferral-review-dates` replayed exactly PR2's one own commit onto
  the newly-merged `main`, with zero conflicts — confirms the "two PRs,
  sequenced" plan decision held up in practice, not just on paper.

## What didn't go as planned, and why

### 1. PR2 initially carried a miscategorized ADR, inherited from the audit's own facet finding without independent re-verification

The audit's "Unfired deferral triggers" facet (an Explore agent, not a
verified finding — this ADR wasn't in the 15-item verify budget) listed
ADR-0037 alongside ADR-0015/0018/0081 as a deferral with an unfired trigger.
The plan and the first PR2 draft both carried this forward. During PR2's own
pre-push review, `docs-consistency-reviewer` read ADR-0037's full Decision
section and found it is a planning/prioritization ADR (supersedes ADR-0021,
sets a wave's priority order, settles two narrow semver/tooling questions)
whose two "Revisit if…" clauses are ordinary hedges on already-decided,
already-implemented choices — not a declined-for-now decision awaiting a
trigger the way ADR-0015's per-PR-scanning question or ADR-0018's
event-source seam are. The fix: `Review by:` removed from ADR-0037,
decision-note 0001's Extended callout and Links corrected to name three
ADRs (not four) and record why ADR-0037 was excluded, before the commit was
amended and re-pushed.

**Why it happened:** The facet-finder's categorization ("any ADR mentioning
an unfired revisit trigger") was broader than decision-note 0001's actual
criterion ("a deferral ADR with no fired trigger"), and that gap was carried
into the plan and the first implementation pass without re-reading
ADR-0037's full Decision text against the narrower criterion. This is the
same failure mode the audit's own method notes warn about — "a report's own
cited examples are a claim to verify, not ground truth" — recurring one
level down, inside this session's own fix rather than in the source report
being audited.

**Fix for future:** When a plan lists specific instances a fix will touch
(ADRs, files, config entries), re-read each instance's own primary text
against the stated criterion immediately before implementing it — not just
at plan-review time, and not by trusting an earlier pass's categorization
even when that pass came from a verified audit workflow. A pre-push review
dispatch (already mandatory per `creating-prs`) is the last opportunity to
catch this before merge; treat any INCONSISTENCY it raises about a content
selection, not just a wording issue, as a Must-fix-equivalent worth a second
read of the primary source before dismissing.

### 2. Repeatedly combining a manual `&`/`nohup` background wrapper with the Bash tool's own `run_in_background: true` caused false-early completion notifications

Several long-running commands (`pnpm verify`, `git push`) were launched with
both a trailing `&` (or `nohup … &`) inside the command string _and_
`run_in_background: true` on the tool call. The harness reported the
wrapper shell's own near-instant exit as task completion, while the actual
backgrounded command (visible via `ps aux`) kept running for minutes
afterward — discovered only by cross-checking process state and switching
to a `Monitor` watching the log for the command's own real completion
marker, three separate times before the pattern was corrected.

**Why it happened:** `run_in_background: true` already detaches the command
from the foreground; adding a second, manual backgrounding layer inside the
command string creates a race between the (near-instant) wrapper exit and
the (slow) actual work, and the harness's completion signal fires on the
former.

**Fix for future:** Never combine a manual `&`/`nohup … &` with
`run_in_background: true` — pick one. Trust `run_in_background: true`
alone; if a genuine detach-from-session-restart concern exists (per
`creating-prs`'s own push-step guidance), use `nohup cmd > log 2>&1` _without_
setting `run_in_background` on the tool call, so exactly one backgrounding
mechanism is in effect. When in doubt after a "completed" notification for a
long-running command, verify via `ps aux` or a tight `Monitor` filter on the
command's own real terminal marker before proceeding.

### 3. `gh pr create` inferred the wrong head branch when run from a different worktree than the target

With two linked worktrees open (one per PR), running `gh pr create` from a
Bash call whose `cd` targeted the second worktree still failed with a
confusing GraphQL error ("No commits between main and
fix/adr-provenance-determinism") — because the session's harness-tracked
current directory (the first worktree, entered via `EnterWorktree`) is what
`gh` actually read local git state from, not the `cd` prefix in that one
command. Passing `--base main --head docs/adr-deferral-review-dates`
explicitly, run again from an explicit `cd` into the correct worktree,
succeeded.

**Why it happened:** `gh pr create` infers `--head` from the current
branch of the git repository state it resolves at the CWD it actually runs
in; a multi-worktree session where the harness's own tracked location
differs from a command's `cd` prefix is exactly the ambiguous case that
produces a wrong inference silently.

**Fix for future:** With more than one worktree in play in a single
session, always pass `--base`/`--head` explicitly to `gh pr create` (or any
other `gh` command that infers branch context) rather than relying on
inference — cheap insurance against a confusing, hard-to-diagnose GraphQL
error.

### 4. An unrelated `.claude/settings.json` drift appeared during `git pull`'s post-merge hook

After merging both PRs and running `git pull` on `main` in the shared
checkout, `.claude/settings.json` showed as locally modified — with
`statusLine`, `subagentStatusLine`, and `preferredNotifChannel` keys
stripped out, plus a re-formatted `availableModels` array. This is unrelated
to either PR's content (neither touched that file) and reads as content
loss rather than a legitimate regeneration. Reverted via `git checkout --
.claude/settings.json` rather than committed, and flagged rather than
investigated further (out of scope for this task).

**Why it happened:** Unknown — some part of the `post-merge`/
`post-integrate-regen` hook chain appears to rewrite this file under some
condition this session didn't isolate. Not reproduced deliberately; noted
as-observed.

**Fix for future:** Worth a dedicated, narrow investigation (not folded
into an unrelated task) into what in the `post-merge` hook chain touches
`.claude/settings.json` and under what trigger condition — before it lands
on `main` for a session that doesn't notice and commits it.

## Lessons learned

- **A verified audit finding and an unverified Explore-agent finding are not
  the same confidence level, and a plan must not treat them as
  interchangeable.** The `audit-fanout` workflow's 15-item verify budget
  covers only some of what a finder returns; anything past that budget (or,
  as here, folded into a hub-authored table built from finder output before
  verification) needs the same "re-derive against the primary source, don't
  trust the categorization" discipline the audit's own method notes already
  require of a _cited example_ — apply it to every instance a plan lists,
  not just the report as a whole.
- **`run_in_background: true` and a manual `&`/`nohup` wrapper are mutually
  exclusive, not additive.** Pick exactly one backgrounding mechanism per
  command; combining them produces a false-early completion signal that
  costs real debugging time to diagnose (three occurrences this session).
- **`gh` commands infer branch context from the harness's tracked CWD, not
  a `cd` prefix inside one Bash call, in a multi-worktree session.** Pass
  `--base`/`--head` explicitly whenever more than one worktree is open.
- **A gate whose absolute-wording source ADR (`"no longer permitted"`) is
  enforced only advisorily is worth promoting to blocking the moment the
  corpus is confirmed clean of violations** — waiting for a violation to
  justify the promotion means the promotion never happens, since a clean
  corpus produces no pressure to fix anything. `missing-clause-list`/
  `placeholder-clause-list` moving to `STRUCTURAL_FINDING_KINDS` here is
  regression-prevention, applied while the corpus was already correct, not
  a reaction to a defect.
- **Squash-merged branch cleanup needs a content diff, not an ancestry
  check, before force-deleting.** `git log <branch> ^origin/main --oneline`
  always shows the branch's own commits as "unmerged" after a squash merge
  — the real question is `git diff origin/main <branch> -- <path>` == empty,
  which is what actually licenses a `git branch -D`.
