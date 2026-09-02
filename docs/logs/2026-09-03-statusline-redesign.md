# Work log — statusline-redesign (2026-09-03)

This log covers PR #916 (`feat/statusline-redesign`, merged 2026-09-02T22:48:53Z,
squash commit `ac07064e`) — PR 1 of a 3-PR sequence rewriting the Claude Code
statusLine after an `/auditing` pass found the previous multi-widget version
(shipped in `2026-09-02-statusline-widgets.md`) wrapped past 80 columns on
every real terminal, under-labelled its values, and never surfaced
`rate_limits.*.used_percentage`. It ran through `/auditing` → clarifying
questions → plan mode → `starting-work` → parallel `test-author`/
`code-implementer` dispatch → review → `pnpm verify` → `creating-prs` →
`resolving-pr-comments` (one bot-review fix-batch round) → merge →
`finishing-work`. Records what shipped, three divergences (a concurrent
unrelated session wiping the worktree mid-task, two real bugs the writer
spokes' contract missed, and the bot review's two genuine Must-fix findings),
and durable lessons.

Plan of record: `~/.claude/plans/the-recently-developed-statusline-cheeky-seal.md`
— a session-local plan-mode file outside this repo, not committed to
`docs/plans/`; archival is deferred until all 3 PRs in the sequence land (per
`docs/plans/README.md`'s own precedent, multi-PR plans are archived once as
"shipped" covering the whole chain, not once per PR).

## Summary

- **Files changed** (final, post fix-batch): `.claude/hooks/statusline-layout.mjs`
  (new, ~250 lines — `displayWidth`/`truncateToWidth`/`fitRow`/`terminalColumns`),
  `.claude/hooks/statusline-context-pressure.mjs` (rewritten, five fixed rows
  replacing the previous 2–4 variable rows), `bin/statusline-preview.mjs` (new
  dev-only preview harness, `pnpm statusline:preview`), `bin/tests/statusline-layout.test.ts`
  (new), `bin/tests/statusline-context-pressure.test.ts` (rewritten),
  `package.json`, `.claude/settings.json` (`statusLine.padding: 1`),
  `bin/lib/command-catalog.mjs`. 8 files across the initial PR, 5 more in the
  fix-batch commit.
- **New exports**: `displayWidth`, `truncateToWidth`, `fitRow`, `terminalColumns`
  (layout module); ~20 `format*Segment` functions each returning
  `{ id, priority, text, minWidth }` instead of a bare string;
  `buildSessionRow`/`buildModelRow`/`buildContextRow`/`buildQuotaRow`/`buildWorkRow`
  replacing the old `buildLine1`–`buildLine4`. `renderStatusLine(payload, env)`
  kept its exact signature.
- **Tests**: 238 new/updated across the two test files in the fix-batch round
  alone (196 + 42); full `bin/**` suite finished at 3141 tests / 86 files, all
  passing.
- **Gates**: `pnpm verify` — 58 passed, 10 skipped (push-only/CI-only), 0
  failed, on the fix-batch's final run (57/57 on the initial PR, before an
  unrelated concurrent commit added a new `check:skill-frontmatter` gate to
  the count).
- **Review-size**: 145,589 reviewable chars — over the 75,000 ADR-0072 soft
  target, under the 300,000 hard ceiling. Not split: documented in the PR
  body that the renderer rewrite and its paired test rewrite (~57% of the
  diff) were authored from one locked contract and already independently
  reviewed; the tool's suggested path-cluster split would have separated a
  behavior change from its own tests.
- **PR**: [#916](https://github.com/monte3l/m3l-automation/pull/916) —
  merged (squash, `ac07064e`).
- **Skills used**: auditing, starting-work, syncing-docs, writing-commits,
  creating-prs, resolving-pr-comments, finishing-work, writing-work-logs.
- **Spoke incidents**: none attributable to this task's 8 dispatched spokes
  (2× `code-implementer`, 4× `test-author`, 2× `code-reviewer`,
  1× `silent-failure-hunter`). `tmp/session-incidents.jsonl` in the shared
  main checkout recorded one truncation during this window, but its
  `agentId` matches none of the 8 agent IDs this session dispatched —
  attributed to a different concurrent session sharing the host, not this
  task.
- **Compaction events**: none.

## What went as planned

- **A locked, algorithm-level contract let parallel `test-author`/
  `code-implementer` spokes converge with zero drift**, exactly repeating the
  lesson from the original statusline-widgets PR (#892) this redesign
  replaces. Every constant, every formatter's exact return shape, every
  color/threshold, and the row-builder composition were specified in the
  dispatch prompt before either spoke wrote a line — both landed independently
  and their outputs (implementation vs. tests) matched on first contact.
- **The `/auditing` skill's live-render verification caught the real problem
  before any code was written.** Rendering the _existing_ statusline script
  against a realistic payload at the actual terminal width (measured 106 and
  127 characters on an 80-column terminal) turned a vague "it looks bad"
  complaint into concrete, falsifiable findings, and rendering three candidate
  layouts the same way before asking the user to pick one avoided designing
  blind.
- **Verifying every claimed Nerd Font glyph before committing to it caught a
  real risk early.** An early terminal probe of Nerd Font codepoints came back
  mojibake'd when copy-pasted into the plan file — rather than trust unverified
  Private-Use-Area codepoints, the contract restricted the glyph vocabulary to
  plain ASCII labels plus one Anthropic-example-precedented emoji (🌿), which
  eliminated an entire class of rendering risk the plan's own mockups hadn't
  accounted for.
- **`code-reviewer` + `silent-failure-hunter`'s pre-push findings were all real
  and cheap to fix** — no false positives, no wasted round-trips fixing a
  misdiagnosis.
- **`pnpm sync:docs` was a true no-op both times it ran** (initial PR and
  fix-batch) — zero working-tree diff, since this PR touches no
  `docs/reference` page or exported-symbol surface.

## What didn't go as planned, and why

### 1. An unrelated concurrent session wiped the worktree mid-task via a git history rewrite

After `starting-work` created the `feat/statusline-redesign` worktree (branched
off `origin/main`) but before any file was written, the user asked to "rebase
on main." Re-inspecting git state found the worktree directory and its branch
had both vanished — from disk, from `git worktree list`, and from the remote.
Investigation traced it to a large, unrelated effort running concurrently on
the same host's shared main checkout: a filter-branch rewrite (backed by a
`m3l-automation-prerewrite-*.bundle` safety bundle) that stripped
`Claude-Session:` trailers from the entire repo's commit history across PRs
909–912, which invalidated every old SHA and evidently pruned worktrees keyed
to them.

**Why it happened:** Multiple Claude Code sessions were operating against the
same repository concurrently — one doing the statusline work, another running
a full-history rewrite. Neither session's local git state (worktree
membership, branch pointers) is isolated from the other's destructive
operations on shared refs.

**Fix for future:** No commit had been made yet, so recovery was simply
`pnpm worktree:new` again off the now-current `origin/main` — cheap because
nothing was lost. The durable lesson is procedural: after any gap in an
otherwise-continuous session (a user instruction implying elapsed time, a
resumed conversation), re-verify worktree/branch existence with `git worktree
list` before assuming prior state still holds, rather than proceeding on the
assumption that nothing external touched the repo.

### 2. The locked contract still missed two behavioral edge cases, caught only by the paired writer spokes' own test coverage

`test-author`'s tests, written independently from the same contract as
`code-implementer`'s source, surfaced two real bugs before either spoke even
reported back: `fitRow`'s drop-loop condition (`kept.size > 0`) let the
"truncate the sole surviving segment" branch go unreachable — it always
emptied `kept` to `0` instead of stopping at `1` — and `formatPrSegment`
wrapped an unstyled PR reference in a no-op `RESET`/`RESET` pair instead of
leaving it unwrapped as the contract specified. Both were fixed directly by
the hub (neither file is a guarded path) in a few minutes once flagged.

**Why it happened:** An algorithm-level contract specified in prose (however
precise) is still prose — a genuine off-by-one in a loop boundary condition
and a subtle "no color" vs. "wrap in a neutral reset" distinction are exactly
the class of defect that survives careful specification but not independent
adversarial testing.

**Fix for future:** This is the argument _for_ the parallel test-author/
code-implementer pattern working as designed, not evidence against it — the
tests existing independently of the implementation is what surfaced both bugs
immediately rather than only at PR-review time. No process change; the
pattern did its job.

### 3. The `claude-pr-review` bot's FAIL verdict found two Must-fix issues neither spoke pair nor the hub's own pre-push review caught

The bot flagged a shallow-spread aliasing bug in the new preview harness
(`noGitPayload = { ...fullPayload }; delete noGitPayload.workspace.git_worktree`
mutated the _shared_ `workspace` object also referenced by three other
fixtures, silently breaking them all) and ~22 regression tests for six
unchanged, still-exported functions that the test-file rewrite had dropped
along the way (a scope violation per `.claude/rules/refactoring.md:35`, which
only permits removing a test that no longer asserts a live contract). Both
were confirmed by direct inspection before fixing — not taken on faith.

**Why it happened:** The preview-harness bug is a classic JS shallow-copy
footgun that neither `code-implementer` (writing it, focused on the render
output being correct) nor `code-reviewer`'s pre-push pass (reviewing the whole
diff, not stress-testing every fixture's object graph) caught. The dropped
regression tests happened because `test-author`'s contract instruction ("write
tests directly against this contract's specified behavior... don't
gratuitously rewrite passing tests") was necessary but not sufficient — a full
test-file rewrite is easy to under-scope when the new tests for changed
functions are extensive and the old tests for unchanged functions are easy to
lose track of amid the diff.

**Fix for future:** When a spoke prompt asks for a test-file _rewrite_ (as
opposed to additions), explicitly enumerate every function the rewrite must
NOT touch test coverage for, not just state the general "don't remove
still-live contract tests" rule — a general instruction is easy to satisfy
partially without anyone noticing which specific cases got dropped. The
`claude-pr-review` bot's diff-aware review is a genuine second line of defense
here and caught what two rounds of spoke work and one hub-dispatched review
round both missed — worth treating its FAIL verdicts as informative rather
than a formality to clear.

## Lessons learned

- **Re-verify worktree/branch existence after any conversational gap, not just
  at task start.** A concurrent, unrelated session's destructive git operation
  on shared refs can invalidate local state silently between turns — `git
worktree list` is cheap insurance the moment prior state is assumed rather
  than freshly confirmed. See divergence #1.
- **An algorithm-level contract eliminates _coordination_ drift between
  parallel spokes, not _correctness_ drift within either one.** Both spokes
  converging byte-for-byte on structure is not the same as both being bug-free
  — the tests still need to independently exercise the contract's edge cases,
  which is exactly what caught the `fitRow`/`formatPrSegment` bugs in
  divergence #2.
- **Enumerate what a test-file rewrite must preserve, don't just state the
  rule.** "Don't drop tests for unchanged functions" as a general instruction
  in a rewrite-scale spoke prompt is not enough to prevent it happening
  anyway — name the specific functions and cases when the rewrite is large
  enough that under-scoping is easy. See divergence #3.
  _(promoted → `.claude/rules/refactoring.md`)_
- **A shallow spread of an object with nested fields you intend to mutate is
  always a bug waiting to happen.** `{ ...obj }` only copies top-level keys;
  deleting/mutating a nested property (`copy.nested.field`) mutates the
  original's shared reference. This is generic JS knowledge, but worth a
  specific instruction in any spoke prompt building multiple payload variants
  from one base object with nested `delete`s, per divergence #3.
- **Treat a `claude-pr-review` FAIL verdict as a genuine second review pass,
  not a formality.** Both of its Must-fix findings in this PR were real and
  had survived a full hub-dispatched `code-reviewer`/`silent-failure-hunter`
  round untouched — the bot's diff-aware, whole-file-context review caught a
  class of bug (shallow-copy aliasing, scope-creeping test deletion) that a
  fresh-context spoke review did not.
