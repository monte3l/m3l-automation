# Work log — X8e slice 2: consumer conversions and close-out (2026-09-14)

This log covers slice 2 of X8e (issue #1251), the second and final half of a
two-PR wave consolidating every hand-rolled errno-code check in the
workspace onto `Core.errnoCodeOf`/`Core.isEnoentError` (the guard slice 1,
PR #1252, promoted to a public export). Slice 2 converted every remaining
consumer — `m3l-cli`, `m3l-console-server`, `bin/` tooling, and one
`scripts/agent-operator` site found only during pre-push review — and closed
out the X8e tracker row, filing X8f for a related but out-of-scope
disagreement the re-derivation surfaced.

Plan of record: `/Users/enri3l/.claude/plans/investigate-and-resolve-issue-ethereal-glacier.md`

## Summary

- Re-derived the plan's site claims against the live repo (via an `Explore`
  agent) before implementing, per CLAUDE.md's re-derivation rule. All six
  named `m3l-cli` sites were confirmed accurate; the `flow/record.ts` site
  had drifted from "a local helper" to inline code (same conversion target,
  different starting shape).
- Converted six `m3l-cli` sites (`discovery/cache.ts`, `run/report-lookup.ts`,
  `presets/store.ts`, `discovery/discover.ts`, `commands/doctor.ts`,
  `flow/record.ts`), collapsed `m3l-console-server`'s independent
  `errnoCodeOf` copy to a one-line delegate, and added a new
  `bin/lib/errno.mjs` (a plain-`.mjs` mirror, since `.mjs` tooling cannot
  import the TypeScript guard) routing four `bin/` call sites through it.
- A test-author spoke found a genuine, previously-undocumented double-read
  defect while writing a characterization test for `presets/store.ts`'s
  `hasErrnoCode`: the pre-conversion code read `.code` twice (once via
  `typeof`, once via `.has()`), so a flip-flopping own getter could
  misclassify a permission error — the same shape X8d fixed once already in
  the library. Pinned with a mutation test before the conversion landed.
- The pre-push review fan-out (`code-reviewer`, `spec-conformance-reviewer`,
  `silent-failure-hunter`) found **2 Must-fix** from the conformance
  reviewer: a broken ADR heading (a stray literal newline split it across
  two lines) and, more significantly, a real surviving hand-rolled errno
  check outside the original census — `scripts/agent-operator/src/lib/
cli-process.ts`'s `readFailureCode`, using the same prototype-chain-
  reachable `"code" in error"` presence check the rest of this wave had
  already eliminated. Converted in-scope rather than narrowing the ADR's
  "every remaining" claim to exclude it.
- `code-reviewer` additionally found a Should-fix: two test files still
  carried TDD-cycle narration comments (RED-state framing, a
  `test.fails`-workflow description) describing a not-yet-converted state
  that no longer existed in the same diff — trimmed to describe the pinned
  behavior instead of the migration history.
- Reconstructed all five commits via `git reset --soft` + re-commit (the
  same pattern slice 1 used) after folding in the review-round fixes — see
  divergence #1 below for why the first attempt swept every file into one
  commit.
- Pushed; `pnpm verify` 73/73 green at every checkpoint. `claude-pr-review`
  verdict: **PASS**, 0 Must-fix, 3 Should-fix, 3 Nits. 2 Should-fix resolved
  (a stale TSDoc paragraph in `guards.ts`, three new characterization tests
  pinning the Error-instance-only narrowing at previously-unpinned sites);
  1 Should-fix left as a structural follow-up (an automated drift guard
  between `bin/lib/errno.mjs` and `guards.ts` — no targeted-line fix exists);
  3 Nits left unaddressed (outside any region this round's fixes touched).
  Resolved via `/resolving-pr-comments`, `Acknowledged-Should-Fix` footer.
- Merged via squash (`gh pr merge --squash`) as `9ff62434` (PR #1259).
  `pnpm sync:hub --apply` closed issue #1251 and filed #1260 for X8f.
- Skills used: `starting-work` (implicit, continuing from slice 1's
  approved plan), `creating-prs`, `syncing-docs` (twice),
  `resolving-pr-comments`, `finishing-work`, `writing-work-logs`.
- Spoke incidents: 1 truncation (`tmp/session-incidents.jsonl`), 0 stalls
  observed, 0 `SendMessage` resumes needed.
- Compaction events: 1 (mid-session, before slice 2 began) — the
  `PreCompact`/`SessionStart(compact)` handoff (ADR-0078) recovered cleanly;
  no state was lost (confirmed by the handoff's branch/commit pointer
  matching `git status` on resume, and by `ExitWorktree`'s "not the owner"
  refusal later in the session being the _expected_, documented recovery
  path for exactly this scenario, not a sign of lost state).

## What went as planned

- **The re-derivation pass caught a real drift before implementation
  started** — `flow/record.ts`'s site had moved from "a local helper" to
  inline code since the plan was written, with no change to the actual
  conversion target. Cheap insurance that paid off exactly once.
- **TDD was unnecessary and correctly skipped for five of six `m3l-cli`
  sites** — existing tests already pinned real-`Error`-with-own-`code`
  fixtures, so they served as the regression signal per the plan's own
  design; only two sites (`flow/record.ts`, `presets/store.ts`) needed new
  characterization tests for a genuine behavior tightening, both written
  correctly on the first pass.
- **`bin/` conversions were low-risk and verified live** — each of the four
  touched scripts was run directly (`pnpm check:file-budget`,
  `pnpm gen:project-hub`, a `resolve-verdict` smoke call) per
  `harness-artifacts.md`'s "run it before wiring it" rule, and all four
  passed on the first try.
- **The bounded re-review after the Should-fix fixes reported clean** — no
  new Must-fix, confirming the three characterization tests and the TSDoc
  fix were correctly scoped.

## What didn't go as planned, and why

### 1. The first commit-reconstruction attempt swept every review-round file into one commit

After the pre-push fan-out found the `agent-operator` Must-fix and the
comment-narration Should-fix, I reset the branch with `git reset --soft` to
the merge base to fold the fixes into the right original commits (matching
slice 1's precedent). The reset correctly unstaged nothing — `git reset
--soft` keeps the index fully staged — so when I ran `git add
<files-for-commit-1>` and committed, the commit picked up every file already
staged from the reset, not just the ones I'd explicitly added. The result
was one 18-file commit instead of the intended five-commit structure.

**Why it happened:** `git reset --soft <ref>` moves `HEAD` but leaves the
index exactly as it was — every file from the commits being un-done stays
staged. A subsequent `git add <subset>` is a no-op on files that are already
staged; it does not narrow the index to just that subset. I conflated "stage
these files" with "stage only these files."

**Fix for future:** After a `git reset --soft` intended to re-split commits,
run a bare `git reset` (no ref) immediately after to unstage everything,
_then_ build up each commit's staging set with explicit `git add` calls.
Verify with `git status --porcelain --short | grep '^M '` before each commit
that only the intended files are staged, not just that the intended files
are _among_ the staged files.

### 2. A pre-push review found a real hand-rolled errno site the original plan never scoped

`spec-conformance-reviewer` flagged that `scripts/agent-operator/src/lib/
cli-process.ts`'s `readFailureCode` used the same forgeable `"code" in
error"` presence check as every `bin/` site this wave had just hardened —
and the ADR-0070 Update's own "every remaining hand-rolled errno spelling in
the workspace" heading was, as a result, false the moment it was written.

**Why it happened:** The original X8d/X8e census (filed in ADR-0070's
2026-09-13 (second) Update) scoped only `m3l-common`, `m3l-cli`,
`m3l-console-server`, and `bin/` — `scripts/**` was never enumerated at all,
not because it was considered and excluded, but because it was outside the
four packages the original audit happened to look at.

**Fix for future:** A "consolidate every hand-rolled X" census should
explicitly state its search scope (which directories were grepped) rather
than implying completeness by omission. A claim like "every remaining
spelling" is itself an authored claim subject to CLAUDE.md's re-derivation
rule — re-run the search at PR time, not just plan time, especially when a
pre-push review has direct access to grep the whole tree the planning phase
may not have covered as thoroughly.

## Insights

- **`git reset --soft` followed by a narrow `git add` does not narrow the
  commit — it stages everything from the reset commits, silently.** Always
  follow a re-splitting `git reset --soft` with a bare `git reset` to clear
  the index first, and verify each commit's staged-file list before
  committing, not after. _(see divergence 1 above)_
- **A "consolidate every X" claim needs an explicit search-scope statement,
  not just a list of what was found.** Re-run the search at merge time
  against the whole tree, not just the packages the original audit
  happened to enumerate — a pre-push review with full repo access is a
  cheap second pass that caught exactly this gap. _(see divergence 2
  above)_
- **A double-read defect can hide inside a function a plan describes as
  "just needs its body swapped."** The `presets/store.ts` conversion looked
  mechanical from the plan's description, but writing the characterization
  test first (per TDD) surfaced that the _existing_ code already had the
  double-read defect X8d had fixed elsewhere — never assume a "trivial"
  conversion site has no independent defect of its own; write the
  characterization test before assuming the old code is a safe baseline.
- **A structural Should-fix (no targeted-line fix exists) is worth stating
  precisely in the acknowledgment footer, not just marking "left."** Naming
  _why_ it's structural (a new cross-package test dependency, or a
  hand-authored parity fixture, both nontrivial design decisions) in the
  commit body and the follow-up PR comment gives a future maintainer enough
  to actually pick it up, rather than re-deriving the same analysis.
- **Squash-merge branch-deletion refusal and worktree-ownership loss after
  compaction are both expected, not signals to investigate** — this session
  hit both again (as slice 1 did) and both resolved via their documented
  recovery paths (`git branch -D` after confirming content landed;
  `ExitWorktree({action: "keep"})` then manual `worktree:remove`) without
  incident.
