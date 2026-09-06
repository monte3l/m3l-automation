# Work log — adr-governance-tooling (2026-09-06)

This log covers the implementation sequence that followed the `/auditing` session recorded in
[`2026-09-06-adr-corpus-audit.md`](./2026-09-06-adr-corpus-audit.md): four PRs (PR2–PR5 of a
5-PR plan; PR1 shipped ADR-0094 itself and is covered by the audit log) that normalized the
93→95-ADR corpus onto a machine-checkable status schema, built drift-detection tooling for it,
and added a lightweight decision-record tier with a routing gate. It records what shipped per
PR, what matched the plan, what diverged, and the durable lessons — the audit's own corrected
findings (the partial-supersession census, the refuted "contradictory ADRs" theme, the `##
Update` legitimacy question) are not repeated here; see the audit log for those.

Plan of record: `this-has-become-a-sorted-scroll.md`, the hub's plan-mode file (`~/.claude/plans/`,
outside the repo tree — not a `docs/plans/` file, so no repo-relative link applies).

## Summary

Four PRs, each `pnpm verify`-gated and reviewed by `docs-consistency-reviewer` before merge:

- **PR2** (`feat/adr-index-tooling`, #1066): `bin/lib/adr-index.mjs` (parses the new
  Status/`Relations:` schema; `parseRelations()`, `parseAdrEntry()`, `buildAdrIndexTable()`,
  `checkAdrIndex()`), `bin/gen-adr-index.mjs` + `bin/check-adr-index.mjs` generating and
  verifying `docs/adr/README.md`'s index table, and an extension to
  `bin/lib/project-hub.mjs`'s `classifyAdrStatusKind()` to recognize the closed status set —
  fixing the live "(Unknown)" rendering of ADR-0020/ADR-0052 the audit found on the published
  Pages hub. Shipped advisory-only (all findings warned, not blocked).
- **PR3** (`feat/adr-corpus-sweep`, #1067): the mechanical normalization sweep — 37 ADR files
  plus `docs/adr/README.md` rewritten onto the Status/`Relations:` schema, zero prose or
  decision changes. Flipped `bin/check-adr-index.mjs`'s structural checks from warn to blocking
  once the corpus was clean.
- **PR4** (`feat/adr-drift-detection`, #1068): `bin/lib/adr-claims.mjs` + `bin/check-adr-claims.mjs`
  — 9 mechanically-probeable claims from load-bearing ADRs (blocking); `bin/lib/adr-provenance.mjs`
  - `bin/gen-adr-provenance.mjs` + `bin/check-adr-provenance.mjs` — a git-blob-SHA sidecar
    (`docs/adr/provenance.json`, ~89–90 ADRs) giving an advisory "this ADR's cited files moved,
    go re-read it" signal, generalizing the `INTEGRATION_DESCRIPTORS` pattern for a third time.
- **PR5** (`feat/adr-lightweight-tier`, #1069, merged as `c82929dc`): ADR-0095 (the reversibility
  test, the harness-cluster criterion, the decision-note tier, the worthiness gate);
  `docs/decision-notes/` (README, template, and its first real entry,
  `0001-deferral-review-by-dates.md`, applying `Review by:` dates to ADR-0023/ADR-0043);
  `bin/lib/adr-index.mjs`'s `Review by:` field and `review-by-passed` finding; `bin/lib/adr-worthiness.mjs`
  - `bin/check-adr-worthiness.mjs`, an advisory nudge flagging a new ADR as a decision-note
    candidate. This PR failed automated review once and was fixed and re-reviewed — see divergence
    #2 below.

Skills used: `starting-work` (once per PR, worktree entry), `finishing-work` (this close-out),
`writing-work-logs` (this log). `test-author` and `docs-consistency-reviewer` spokes dispatched
per hub-and-spoke rule for every guarded test file and every docs-only diff.

Spoke incidents: 2 truncations (`docs-consistency-reviewer`, once each on PR4 and PR5) / 0
stalls / 2 resumes — both recovered via the documented `SendMessage`-resume-the-same-spoke
procedure, no fresh dispatch needed either time. `tmp/session-incidents.jsonl` was not present
at write time (rotated), so these counts are drawn from session recollection, not the
mechanically-recorded file.

Compaction events: 2 compactions / 2 recovered via handoff. One mid-sequence (around PR4's
push, coinciding with an unrelated exit-code-137 session hiccup) and one at this session's own
continuation boundary; both resumed with the correct branch, PR number, and in-progress step
intact, with no loss of decision state.

Final state: all four PRs merged into `main` (#1066, #1067, #1068, #1069 — squash merges), the
corpus stands at 95 ADRs with `check:adr-index` reporting zero findings in blocking mode, and
`check:adr-worthiness`, `check:adr-claims`, `check:adr-provenance` are registered across all six
gate-registration surfaces (`package.json`, `lefthook.yml`, `CLAUDE.md`'s cadence table,
`.github/workflows/ci.yml`, `bin/lib/verify-steps.mjs`, `bin/lib/command-catalog.mjs`).

## What went as planned

- **The `docs/reference` generate+check pattern transplanted cleanly to ADRs.** `gen-adr-index.mjs`
  / `check-adr-index.mjs` mirrored `gen-reference-index.mjs`'s shape almost exactly (pure
  derivation in `bin/lib/`, thin I/O + `createReporter()` in `bin/`), including reusing
  `displayWidth`/`padToDisplay` from `bin/lib/reference-index.mjs` for the generated table's
  column padding rather than reinventing it.
- **The `INTEGRATION_DESCRIPTORS` pattern generalized to a third use (`adr-claims.mjs`) with no
  friction.** Already proven twice (0030 → 0093 per the audit), the descriptor-table shape
  needed no rework to fit "one entry per probeable ADR assertion."
- **PR2–PR4 all passed `docs-consistency-reviewer` and `pnpm verify` on the first real attempt**
  (aside from the two truncation recoveries, which are process incidents, not defects found).
- **The advisory-then-blocking two-phase rollout (PR2 warns, PR3 sweeps, PR3 flips to blocking)
  worked exactly as planned** — `check:adr-index` shipped green against an admittedly-dirty
  corpus in PR2, then the corpus was cleaned mechanically in PR3 with no schema surprises.
- **Live-run verification caught what synthetic fixtures alone would have missed**, per
  `harness-artifacts.md`'s own rule: running `check:adr-index` against the real 95-ADR corpus
  (not just unit fixtures) was what actually proved the schema normalization was complete, and
  running `check-adr-worthiness.mjs` against the real corpus (not just synthetic cases) is what
  surfaced both the 52%-false-positive problem in PR5's first design and confirmed the
  redesign's precision.

## What didn't go as planned, and why

### 1. A session mid-push crash (exit 137) required manual remote-state verification before re-pushing

During PR4, `git push` returned exit code 137 (SIGKILL, consistent with an OOM or session
interruption) partway through. Rather than assuming the push had failed or blindly retrying, the
commit's presence was checked locally (it was there — `git` had already committed before the
push started) and then the remote state was checked via `git ls-remote origin
feat/adr-drift-detection`, which came back empty, proving the commit had not reached the remote.
`git push` was re-run synchronously in the foreground and succeeded.

**Why it happened:** An external interruption (resource pressure or a session restart) killed
the backgrounded push process mid-transfer. The commit itself was never at risk — it was already
in the local object database — but the push's completion state was ambiguous from the exit code
alone.

**Fix for future:** Treat SIGKILL/137 on a `git push` as "unknown push state," not "push failed" —
verify via `git ls-remote origin <branch>` before retrying, and never re-push blindly on the
assumption that a nonzero exit means nothing landed.

### 2. PR5 failed automated review once — the only PR in the sequence to do so — with one real Must-fix and two real Should-fixes

`claude-pr-review.yml` returned a FAIL verdict on PR #1069's first push. All three findings were
genuine, not false positives:

- **Must-fix:** `bin/check-adr-worthiness.mjs`'s `newAdrFiles()` swallowed any `git diff`
  resolution failure (no `origin/main`, a shallow clone) as a silent `catch { return []; }`,
  which the caller then reported as `"No new ADRs on this branch to evaluate."` — a false
  success indistinguishable from a genuinely clean branch. Fixed by threading a `resolved: boolean`
  flag through `newAdrFiles()`'s return value and printing an explicit skip message
  (`reporter.info` + a distinct `skipped: true` summary field) when the range can't be
  resolved, mirroring `bin/check-review-size.mjs:247`'s existing precedent for the identical
  failure class.
- **Should-fix (scoping):** the semver-impact check ran against the whole ADR document instead
  of just its own `## Consequences` section, so a quoted `- **Semver impact:** none` appearing
  in another section (e.g. discussing a different ADR in Context) could false-positive. This
  is the exact false-positive class `bin/lib/adr-index.mjs`'s `headerBlock()` scoping already
  fixed once for `Relations:` parsing in PR2 — recurring in a sibling module built afterward.
  Fixed via a new private `section(content, heading)` helper scoping the check to the
  `## Consequences` body only.
- **Should-fix (noise rate):** the original worthiness heuristic flagged any ADR whose
  Consequences declared `Semver impact: none`, exempting only ADRs mentioning one of a short
  "worthy" keyword list (public contract, harness-wide, etc.). Measured live against the real
  95-ADR corpus, this flagged **49 of them (~52%)** — legitimate, foundational ADRs (the Node
  version floor, the license choice, the Podman migration) simply don't share any finite
  keyword vocabulary, because the topics an ADR can legitimately cover are far more diverse
  than any such list can enumerate. This is exactly the "cries wolf" failure mode
  `.claude/rules/harness-artifacts.md` warns an advisory check must never exhibit. Fixed by a
  full redesign inverting the polarity — flag narrowly on a small set of _specific_ low-value
  shapes named literally in ADR-0095's own Context section (a label/milestone retitle; widening
  one lint/type-check zone by a single module) rather than broadly with keyword exemptions.
  Verified against the real corpus post-redesign: **exactly one** flag (ADR-0074, a genuine
  milestone-label retitle and one of ADR-0095's own cited examples), zero noise elsewhere.

While implementing the Should-fix (scoping) fix, a self-introduced regression briefly broke the
whole heuristic: the new `section()` helper's regex used the `/m` (multiline) flag, under which
`$` matches before _every_ line break in the document, not just end-of-string — so the
non-greedy `[\s\S]*?` lookahead inside it always matched at the very first newline, and
`section()` always returned `""`. This silently made `SEMVER_NONE_RE` never match anything,
flagging _zero_ ADRs (including ones that should have been flagged) rather than the intended
narrow set. Caught immediately by testing synthetic fixtures against the freshly-written
function before shipping it (`deriveWorthinessCandidates` returned `[]` when it should have
returned filenames), traced with an isolated `node -e` regex trace, and fixed by dropping the
`/m` flag and anchoring the heading match via `(?:^|\n)` instead, which needs no multiline
semantics to mean "start of the document or right after a newline."

**Why it happened:** Two independent factors compounded. First, the initial worthiness design
extrapolated a small set of illustrative keywords into a general exemption list without
measuring it against the actual corpus before shipping — the audit's own worked examples were
treated as a starting vocabulary rather than the complete positive-match set they turned out to
be. Second, the section-scoping fix introduced a regex flag (`/m`) whose interaction with a
non-greedy end-of-string anchor is a well-known but easy-to-miss JavaScript regex gotcha —
`$` under `/m` is "before any newline," not "before the final newline."

**Fix for future:** For any advisory heuristic gated on natural-language pattern matching,
measure its true-positive/false-positive rate against the real corpus _before_ it ships, not
after a review round catches the noise — this repo's own corpus was sitting right there the
whole time. Separately, treat a non-greedy `[\s\S]*?…$` pattern as fragile the moment `/m` is
added to the same regex; prefer an explicit `(?:^|\n)`/`(?=\n##|$)` boundary pair (as landed
here) over relying on flag semantics to mean "end of string" — write a synthetic test for the
new pattern's happy path _before_ trusting a scoping fix that touches a regex, and run it
before the fix is considered done.

### 3. Two `docs-consistency-reviewer` dispatches hit their 40-turn limit before reporting

On both PR4 and PR5, the docs-consistency-reviewer spoke ran out of its turn budget mid-review,
before producing a final report. Per `.claude/rules/subagent-dispatch.md`'s truncation-recovery
procedure, the same spoke was resumed via `SendMessage` (never a fresh dispatch) with an
explicit instruction to stop running further checks and report findings based on what it had
already verified. Both resumed successfully with complete findings on the first resume attempt;
PR5's resumed review caught one real finding (a missing index row in the new
`docs/decision-notes/README.md`).

**Why it happened:** A docs-consistency review spanning a five-PR sequence's cumulative
documentation surface (by PR5, dozens of interlinked ADR/README/decision-note files) is enough
verification work to exceed a single dispatch's turn budget, independent of anything going
wrong in the review itself.

**Fix for future:** No change needed — the existing resume procedure worked as designed both
times, with zero lost findings. This confirms the procedure rather than surfacing a gap in it.

### 4. A `CLAUDE.md` context-budget near-miss required prose trims to land a one-line cadence-table addition

Registering `check:adr-worthiness` in `CLAUDE.md`'s cadence table (PR5) pushed the file's
always-loaded token estimate from ~3000 to 3015, over `check:context-budget`'s
`MAX_APPROX_TOKENS = 3000` cap. Widening a single existing table row to add the new check
alongside an existing one was measured and rejected — column-width padding propagation across
every row in the table would have cost _more_ than a new row. The fix landed as: a new,
separate cadence-table row for the two new ADR gates, plus several small prose trims elsewhere
in the file (a duplicated "pnpm commands lists every script" mention, a few no-information
qualifiers), netting −16 tokens and landing at 2999/3000.

**Why it happened:** This is not a new defect — the original audit had already found the
always-loaded budget was down to 17 tokens (0.57%) of headroom before this PR touched it at
all. Any further growth to a near-full fixed-size budget was always going to require trimming
something else to make room, unless the budget itself grows.

**Fix for future:** This is explicitly out of scope for this sequence per the audit's own
findings (a durable fix means changing what's always-loaded, not indefinitely trimming prose)
and was flagged plainly in PR5's own description: the very next `CLAUDE.md` line addition will
need another trim to land. No action taken beyond documenting it — a structural fix (splitting
the cadence table into an on-demand reference, for instance) is a separate, larger decision.

## Lessons learned

- **Measure a natural-language advisory heuristic against the real corpus before shipping, not
  after review catches the noise rate.** A keyword-exemption design that "sounds right" from a
  handful of illustrative examples can silently generalize into a ~50% false-positive rate the
  moment it's run against a real, diverse document set — and the corpus to test against was
  already sitting in the repo the whole time.
- **`/m` plus a non-greedy `[\s\S]*?…$` is a regex trap specific to this project's section-scoping
  pattern, and it will recur.** `$` under `/m` means "before any newline," not "before the final
  newline" — the second time this exact `headerBlock()`/`section()` scoping idiom got written in
  this sequence, it broke this way. Prefer `(?:^|\n)…(?=\n<marker>|$)` boundaries without the
  `/m` flag whenever writing a new section-extraction regex, and write a synthetic happy-path
  test for it before trusting the fix.
  _(promoted → .claude/rules/harness-artifacts.md)_
- **The `SendMessage`-resume-the-same-spoke truncation procedure is proven, not just documented.**
  Two independent 40-turn-limit truncations across this sequence both resumed cleanly with zero
  lost findings — this is worth treating as settled practice rather than re-litigating on the
  next occurrence.
- **A fixed-size always-loaded budget with single-digit-percent headroom turns every future
  addition into a forced trade-off, not just this one.** `CLAUDE.md`'s cadence table is now at
  2999/3000 tokens after this sequence's one-row addition — the next team that needs to register
  a new pre-push check here will hit the same wall immediately, with less margin than this
  sequence had.
- **`git ls-remote origin <branch>` is the right disambiguator for an ambiguous push exit code**
  (SIGKILL/137, a session interruption) — cheaper and more certain than assuming either success
  or failure and either skipping or blindly retrying the push.
