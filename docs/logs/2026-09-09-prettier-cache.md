# Work log — `prettier-cache` (P3.1, adaptive-host-budgeting) (2026-09-09)

Covers P3.1 of the adaptive-host-budgeting wave's Phase 2 tuning backlog:
adding `--cache --cache-strategy content` to Prettier's `format`/`format:check`
scripts, plus the `bin/bench-gates.mjs` harness change needed so the `format`
lane's cold/warm benchmark still measures a true cold run. Shipped as PR #1145.
This log also records two tooling defects surfaced along the way — one already
tracked (issue #862), one newly filed (issue #1150) — since neither was safe
to fix inside this PR's scope.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

- **Change:** `package.json`'s `format`/`format:check` scripts gained
  `--cache --cache-strategy content` (content strategy, not the default
  `metadata`, because worktrees rewrite mtimes on checkout — the plan's own
  stated reasoning, reverified live). Measured: cold `format:check` 64.13s →
  warm 7.18s (~9x). Cache correctness verified by deliberately breaking
  formatting under a warm cache and confirming `prettier --check` still
  exits 1.
- **Harness change:** `bin/bench-gates.mjs` gained a `Lane.cacheDir` field
  (`node_modules/.cache/prettier` for the `format` lane, Prettier's own
  default `--cache-location`, already `.gitignore`d) and a new
  `clearLaneCacheDir(lane, mode, cwd, remove)` function, called as the first,
  untimed step of `runLaneOnce` — so a `--cold` run's cache wipe never counts
  toward the lane's measured `wallSeconds`/`userSeconds`/`peakRssKiB`.
  `remove` is an injectable seam (defaults to `rmSync`) purely for testing
  the swallowed-error branch without real filesystem permission games.
- **Tests:** `bin/tests/bench-gates.test.ts` grew a
  `describe("clearLaneCacheDir", ...)` block, fully mock-based (no real `fs`
  I/O) — final count 60/60 passing, mutation-tested.
- **Gates:** `pnpm verify` green. Final PR check line: every check passed
  except `review` (FAIL — see divergence #4), `should-fix-ack` (skipping,
  gated behind `review`).
- **Merge:** squash-merged as `31340293` by the maintainer (@enri3l), past
  the `review` FAIL, per `docs/contributing/branch-protection.md`'s override
  procedure — evidence posted at PR #1145 comment
  [5606735642](https://github.com/monte3l/m3l-automation/pull/1145#issuecomment-5606735642).
- Skills used: `starting-work`, `resolving-pr-comments` (invoked implicitly
  across three bot-review rounds), `finishing-work`, `writing-work-logs`.
- Spoke incidents: none recorded (`tmp/session-incidents.jsonl` absent in
  this worktree; from recollection, 0 truncations / 0 stalls / 1 resume — a
  follow-up `SendMessage` to the first `test-author` dispatch to fix a
  TS4111/TS18048 dot-access error against the `LANES` index-signature type).
- Compaction events: 3 — two mid-task session interruptions (each resumed
  cleanly, worktree and uncommitted changes verified byte-for-byte intact)
  plus the `/compact` that produced this segment's summary. All three
  recovered fully via the handoff mechanism; no state was lost.

## What went as planned

- **The cache strategy choice was right on the first try.** `content` over
  `metadata` was chosen up front (worktree mtime instability) and never
  needed revisiting.
- **`pnpm verify` caught the only real defect in the harness redesign**
  (a Markdown table alignment issue after editing the plan doc) — a single
  `prettier --write` fixed it, no logic bug.
- **The bounded re-review (Step 7 of `resolving-pr-comments`) earned its
  keep.** A dispatched `code-reviewer` found a real, small Should-fix
  (`clearLaneCacheDir` could throw and break `runLaneOnce`'s "always
  resolves" contract) that the bot's own review round hadn't flagged —
  fixed immediately since it was well within targeted-line-fix effort
  despite its Should-fix tag.
- **Cross-session coordination worked as designed.** Multiple `ListAgents`/
  `SendMessage` checks during the task correctly identified peer sessions
  (one on an unrelated branch/issue) without any duplicate push or commit.

## What didn't go as planned, and why

### 1. First bot review round flagged a measurement-purity bug

The initial `clearLaneCacheDir` design composed the cache wipe into the same
`bash -lc` string `/usr/bin/time` wraps inside `runLaneOnce`'s timed
execution — so a `--cold` run's cache-directory removal was itself counted
toward the lane's reported wall/user/system time and peak RSS, silently
inflating the "cold" numbers relative to a real cold run.

**Why it happened:** the first pass treated cache-clearing as "just another
step the cold-mode command needs," conflating command _construction_ with
command _execution_ — everything inside the timed string counts, regardless
of whether it's the thing actually being measured.

**Fix for future:** extracted `clearLaneCacheDir` as an explicit, untimed
pre-step called before `wallStart` is captured, leaving `buildLaneCommand`
untouched (it still only applies the turbo `--force` transform).

### 2. Second bot review round (Must-fix): new tests mutated the real filesystem

The tests added for `clearLaneCacheDir`'s error-swallowing branch used real
`mkdtempSync`/`rmSync` calls to force an `EACCES`-style failure, violating
this repo's unit-only test policy
(`docs/contributing/style-guide.md`, `[enforced]`). Verified the claim
directly against the raw test file and the ESLint selector before accepting
it — the selector only matches namespaced calls (`fs.mkdtempSync(...)`), not
bare named imports (`mkdtempSync(...)`), which is exactly how the violation
passed `pnpm lint` cleanly.

**Why it happened:** the injectable `remove` parameter already existed
specifically to avoid this, but the test-author dispatch that added the
error-branch tests didn't use it — it reached for real fs setup instead,
and the ESLint gate has a blind spot for bare named imports (this is not
new — see `docs/contributing/style-guide.md:379` / issue #862, filed
independently by another PR's review, and reconfirmed here by a second,
unrelated occurrence of the same hole).

**Fix for future:** the fix here was a full rewrite to the already-existing
injectable seam (`vi.fn()` for `remove`), not a new mechanism. The
underlying ESLint gap is tracked at issue #862 and deliberately **not**
fixed in this PR — widening that selector is out of scope for a
`feat/prettier-cache` change and would ripple into unrelated test suites.

### 3. `should-fix-ack` failed despite documenting the fix in prose

After resolving divergence #1's Should-fix, the commit body described the
resolution in prose ("Should-fix: ...") but never added the literal
`Acknowledged-Should-Fix:` trailer footer `should-fix-ack` (`docs/adr/0097`)
requires whenever any Should-fix was ever posted.

**Why it happened:** the gate checks for a specific trailer line, not
prose intent — a natural-language "I addressed this" reads as satisfying
the requirement but mechanically doesn't.

**Fix for future:** added the footer via an empty commit
(`git commit --allow-empty -S`) once the gap was noticed. `resolving-pr-comments`
already documents this exact remedy (Step 9) — worth internalizing the
footer as a checklist item the moment _any_ Should-fix is posted, not just
when the ack gate fails.

### 4. The `should-fix-ack` empty commit triggered a genuine tooling bug: false round-limit escalation

The trailer-only empty commit (divergence #3's fix) changes zero files by
definition. `claude-pr-review.yml`'s post-PASS guard treats a genuinely-empty
compare-API result identically to an ambiguous/error case (`[ -z "$files"
]`), and since the round count was already at `MAX_REVIEW_ROUNDS` (3, from
two earlier genuine re-review rounds), this escalated to a permanent
`review` FAIL requiring a human override — even though `reviewed_sha` still
pointed at a valid, current PASS.

**Why it happened:** a real bug in the workflow's guard logic, not a review
finding about this PR's own content — traced to the exact branch at
`.github/workflows/claude-pr-review.yml:328-331`, confirmed by reading the
source directly rather than assuming the FAIL was legitimate.

**Fix for future:** not fixed here — `.github/workflows/claude-pr-review.yml`
is out of scope for a `feat/prettier-cache` PR, and the correct procedure
per `docs/contributing/branch-protection.md` is to post evidence to the PR
thread and let a human with admin rights decide, not to patch a sensitive
CI file mid-task. Evidence posted at PR #1145 comment 5606735642; the bug
itself is now tracked at issue #1150. Filing the issue immediately (rather
than leaving it only as a PR comment) closes the gap `writing-work-logs`
flags explicitly: "a follow-up that lives only in a work log does not
exist."

## Insights

- **Cache-strategy choice must account for the actual filesystem
  environment, not just Prettier's default.** `--cache-strategy content`
  over the default `metadata` is the correct call whenever the working tree
  can have mtimes rewritten independent of content (worktree checkouts,
  CI cache restores) — the default strategy would silently under-invalidate
  in exactly those environments.
- **Anything inside a benchmark harness's timed shell string counts toward
  the measurement, including setup/teardown you didn't think of as "the
  thing being measured."** Extract non-measured steps (cache clears,
  fixture setup) as explicit pre/post steps outside the timed block, not
  shell-composed into the timed command.
- **An ESLint selector scoped to a specific call _shape_ (namespaced
  member access) has a blind spot for the same call via a different import
  style (bare named import) — and that blind spot is exactly where a
  repo's prevailing convention (named imports here) is most likely to land
  a violation undetected.** This recurred as an independent finding
  against issue #862's already-documented hole — corroborating evidence
  that the gap is a live, recurring risk, not a one-off. _(Not promoted
  here — the fix belongs in issue #862's own resolution, not duplicated
  into a rule file from a second occurrence.)_
- **A trailer-requiring gate (`should-fix-ack`) needs the footer the moment
  the finding is acknowledged, not deferred to "when I remember."** Treat
  `Acknowledged-Should-Fix:` as part of the same commit that resolves or
  documents a Should-fix, not a separate cleanup step — an empty commit
  after the fact works but costs an extra push/CI cycle, and here it also
  triggered divergence #4.
- **A CI gate's FAIL is not automatically a finding about your PR's
  content.** Read the gate's own source before assuming a review-bot
  verdict reflects a real defect — the round-limit escalation here was a
  guard-logic bug triggered by an intentionally-empty, zero-file commit,
  not anything wrong with the diff. The documented override procedure
  (investigate → post evidence → human merges past the FAIL) exists
  precisely for this case and worked as designed.
- **File the follow-up issue in the same session that found the bug, not
  as a note-to-self in a PR comment.** A PR comment thread doesn't project
  into the tracker on its own; issue #1150 exists only because this
  close-out re-derived and filed it rather than trusting the earlier
  "worth its own follow-up issue" comment to have already done so.
