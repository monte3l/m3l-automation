# Work log — statusline-weekly-usage (2026-09-05)

This log covers solving issue #889 (per-model weekly-usage statusline
widgets, deferred from #879), split per ADR-0072 into two PRs: #1030 (the
session row's worktree-icon change, cosmetic) and #1035 (the substantive
out-of-band usage-cache design). It records what shipped, a live API-schema
discovery mid-implementation that overturned a pre-verification guess, three
review rounds that caught a real defect before merge, and a CI gate gap
found and fixed after #1035 opened.

Plan of record: [`docs/plans/archive/2026-09-05-statusline-weekly-usage.md`](../plans/archive/2026-09-05-statusline-weekly-usage.md)

## Summary

**PR 1 (#1030, merged `11dd8712`):** `formatWorktreeSegment` now renders
`🌳 <name>` (blue, no quotes, minWidth 8→6), matching the branch segment's
existing `🌿 <name>` idiom. Two test-author-dispatched edits to
`bin/tests/statusline-context-pressure.test.ts`, one doc-bullet update.

**PR 2 (#1035, merged `26a16eb1`):**

- New `bin/usage-cache.mjs` (`pnpm usage:refresh`) — the only file that
  touches the network. Fetches Anthropic's undocumented `/api/oauth/usage`
  endpoint, resolves a credential from `CLAUDE_CODE_OAUTH_TOKEN` or
  `~/.claude/.credentials.json`, normalizes the response, writes
  `tmp/usage-weekly.json` atomically (temp file + `renameSync`).
- New `.claude/hooks/refresh-usage-cache.mjs` (`Stop` hook): TTL-gates
  (15 min) and spawns the above detached, never awaiting the network.
- `.claude/hooks/statusline-context-pressure.mjs` gained
  `resolveWeeklyUsage`/`formatWeeklyModelSegments`, wired into the `model`
  row (placement decided by measuring real `fitRow` behavior at
  80/100/120/160 columns, not preference).
- New `docs/adr/0092-out-of-band-usage-cache.md`; `docs/contributing/hooks-reference.md`
  gained a `Stop`-table row, an updated `model`-row bullet, a colour-legend
  amendment, and a dedicated subsection; `docs/plans/archive/2026-09-05-statusline-weekly-usage.md`
  archives both PRs' plan.
- Final test counts at merge: `bin/tests/statusline-context-pressure.test.ts`
  184 (unchanged, 3 call-site updates for the `buildModelRow` signature
  change), `bin/tests/statusline-weekly-usage.test.ts` 23 (new),
  `bin/tests/usage-cache.test.ts` 37 (new) — 244 tests total across the
  three files, all passing under `vitest.bin.config.ts`.
- Full `pnpm verify`: 59 steps passed, 10 appropriately skipped, on two
  separate occasions (once before the PR-2 push, once after the
  command-catalog fix).
- Review spokes on PR 2's diff: `code-reviewer` (Pass, 1 should-fix —
  unnecessary `any` cast, fixed), `security-reviewer` (not clean — 1
  must-fix: unsanitized API text reaching a rendered segment, fixed; 2
  should-fix: non-atomic/symlink-following write, fixed; error-identity
  granularity, deferred), `silent-failure-hunter` (not clean — 1 must-fix:
  unguarded cache-write path, fixed; 2 should-fix, one folded into the same
  fix), `docs-consistency-reviewer` (Clean, 6/6 checks).

Skills used: `finishing-work` (twice — PR 1 close-out, PR 2 close-out),
`starting-work` (twice), `creating-prs` (once, for PR 2), `writing-commits`
(implicitly, throughout), `writing-work-logs` (this log), `triaging-ci`
(once, for the post-merge-adjacent command-catalog CI failure).

Spoke incidents: none (`tmp/session-incidents.jsonl` absent this session —
no writer-spoke truncations recalled; no review-spoke stalls >15 min; 1
`SendMessage` resume — the `test-author` agent writing `bin/tests/usage-cache.test.ts`
was resumed mid-flight with the corrected live API schema before it
finished its first pass, avoiding a wasted full re-dispatch).

Compaction events: 1 compaction (this session opened as a continuation from
one), recovered via the `PreCompact`/`SessionStart(compact)` handoff — the
continuation summary correctly carried forward the approved plan, PR 1's
completed state, and the user's explicit "pause and wait for PR 1 to merge"
decision; no state was observably lost.

## What went as planned

- **The plan approved in plan mode held up almost exactly as designed** —
  the three-file architecture (`bin/usage-cache.mjs` / `refresh-usage-cache.mjs`
  Stop hook / statusline read-side), the model-row placement decision, the
  15-minute TTL, and the model-agnostic rendering approach all shipped
  without redesign.
- **PR 1's small-scope-first split (ADR-0072) worked as intended** — the
  cosmetic worktree-icon change landed, reviewed, and merged independently
  well before the riskier network-dependent PR 2 was even branched.
- **The dependency-injection test pattern (`resolveBranch`-style: injected
  `readFile`/`env`/`fetchImpl`) carried over cleanly** to every new function
  (`resolveCredential`, `fetchUsage`, `isCacheFresh`, `resolveWeeklyUsage`),
  and made the `test-author` spoke's job straightforward — no test needed a
  real filesystem, network call, or mocked global.
- **`bin/statusline-preview.mjs`'s existing live-script-probe pattern**
  (spawn the real script against a corrupt/absent state file, assert quiet
  exit-0 output) extended cleanly to `tmp/usage-weekly.json` with almost no
  new code, per `harness-artifacts.md`'s "prove a hook quiet on the failure
  case" rule.
- **Every full `pnpm verify` run this session passed on or after the first
  local attempt** once the command-catalog gap (see divergence #3) was
  found — no flaky test, no coverage-threshold failure, no lint drift.

## What didn't go as planned, and why

### 1. A pre-verification API schema guess was wrong — corrected by a live authenticated call before push, not after

The plan and the initial `bin/usage-cache.mjs` implementation assumed
`/api/oauth/usage` returned a flat top-level `models` array (a reasonable
inference — no documentation exists for this endpoint). Partway through
implementation, a live authenticated call against the real endpoint
(exercised because the plan's own verification section calls for one)
returned a completely different shape: per-model weekly data lives inside a
top-level `limits[]` array shared with session/aggregate entries, keyed by
`group === "weekly"` and a non-null `scope.model` object — with
`scope.model.id` observed `null` for a real model (Fable) even though
`display_name` was present.

`extractModelCandidates`/`normalizeModelEntry` were rewritten to the
confirmed shape immediately, and `docs/adr/0092-out-of-band-usage-cache.md`
was corrected in three separate sections (Decision drivers, Decision,
Consequences) that had each independently asserted "unconfirmed"/"guessed"
language before the live call — a `test-author` agent already mid-flight
writing tests against the old guessed shape was resumed via `SendMessage`
with the corrected shape rather than left to finish and be redone.

**Why it happened:** The endpoint is genuinely undocumented; there was no
way to know the real shape without a live call, and the plan correctly
scheduled that call as a late verification step rather than a design
precondition — but the implementation had already been drafted against the
best available guess before that step ran.

**Fix for future:** When a design depends on an undocumented external
response shape, make the live verification call as early as possible in
implementation — ideally before writing the normalizer's field-mapping
logic — rather than treating it as a final Step-5-style check. Here it
worked out because the guess was isolated behind one pure function with
full test coverage, but a less isolated design could have propagated the
wrong shape further before the correction landed.

### 2. Two review spokes found a real, unrelated-to-#1 security defect: unsanitized model text reaching a rendered terminal segment

`security-reviewer`'s pass on PR 2's diff found that `display_name` (and
`id`) from the API response — and independently, from the on-disk cache
file — reached `formatWeeklyModelSegments`'s rendered segment text with no
sanitization. The reviewer demonstrated this live: a crafted `display_name`
containing an ESC byte, a `[2J` sequence, and an embedded newline produced a
**7-line** `renderStatusLine` output where exactly five is documented as
guaranteed, and injected a raw ANSI escape sequence into the terminal
stream. `silent-failure-hunter`'s pass, run in parallel, separately found
that the cache-write path (`mkdirSync`/`writeFileSync`) had no error
handling at all, unlike every other failure branch in the same file — a
write failure in the detached, `stdio:"ignore"` child would vanish silently
forever, every 15-minute TTL cycle.

Both were fixed before push: a `sanitizeDisplayText` helper (strip C0/C1
control characters, clamp to 40 chars) was added independently in both
`bin/usage-cache.mjs` (write side) and `statusline-context-pressure.mjs`
(read side, deliberately duplicated rather than cross-imported, matching the
file's existing no-`bin/`-dependency convention) — defense in depth, since
the cache file is not itself a trusted channel even if the writer sanitizes
correctly. The cache write was also changed to a temp-file-plus-`renameSync`
atomic write (closing a related non-atomic/symlink-following gap the same
security pass flagged), and the write path gained a `try/catch` that reports
via the CLI's `--json` diagnostic mode and exits non-zero on failure. A
follow-up `test-author` dispatch added regression tests for both fixes
before the branch was pushed.

**Why it happened:** The initial implementation's field-whitelisting
(`normalizeUsageResponse` only emits four named fields, never passes the
raw response through) was correctly designed to prevent a data-exposure
leak, but "whitelist which fields survive" and "sanitize the _content_ of
each surviving field" are distinct concerns, and only the first was applied
during initial implementation. The write-path error-handling gap happened
because every _other_ branch in the same function (missing credential,
fetch failure, malformed body) had an explicit failure path modeled after
existing precedent, but the final success-path write was copied from a
simpler script (`slice-progress.mjs`) that has no equivalent detached/
`stdio:"ignore"` execution context making its own unguarded write safe by
comparison.

**Fix for future:** When a value crosses an untrusted boundary (an external
API response, a file another process could have written or corrupted) and
is destined for a terminal-rendered segment, treat "narrow the field set"
and "sanitize the field content" as two separate, both-required steps —
one whitelists _which_ data survives, the other constrains _what that data
can contain_. And when copying a write pattern from a simpler script as a
starting point, check whether the _execution context_ differs (a normal
foreground CLI vs. a detached, output-discarded child) before assuming the
same level of error handling is still adequate.

### 3. A missing `bin/lib/command-catalog.mjs` entry for `usage:refresh` passed every local quality gate this session ran except the one nobody ran a second time

After PR 2 was pushed and opened, CI's `Governance gates` job failed on
`Check command catalog`: the new `usage:refresh` `package.json` script had
no matching catalog entry. This had been invisible locally because
`creating-prs`'s Step 4 quality-gate sequence (`lint && typecheck && build
&& test:coverage && build && knip`) does not include `check:command-catalog`
— only the full `pnpm verify` does, and that had been run once at the very
start of this session (during PR 1, before `usage:refresh` existed) but not
re-run after `usage:refresh` was added to `package.json` during PR 2. The
`/triaging-ci` skill diagnosed it in one pass (reproduced locally with
`pnpm check:command-catalog`, matched the failing job/step to a stable
local command); the fix was a one-entry addition to
`bin/lib/command-catalog.mjs`, verified with a full `pnpm verify` (59
passed, 10 skipped) before the follow-up push.

**Why it happened:** `creating-prs`'s documented quality-gate command
sequence is a curated subset of `pnpm verify`, not the full command, and
that subset does not include `check:command-catalog`. Nothing in the
session's process re-ran the _full_ `pnpm verify` between adding a new
`package.json` script and pushing.

**Fix for future:** Any change that adds a new `package.json` script during
a `creating-prs` pass should run `pnpm check:command-catalog` (or the full
`pnpm verify`) explicitly before pushing, since it is not covered by the
skill's own quality-gate command list — this is a gap in the skill's
documented sequence itself, worth flagging for `creating-prs` to eventually
close (see promoted lesson below).

## Lessons learned

- **Verify an undocumented external API's response shape as early as
  implementation allows, not only as a final check.** A design depending on
  an unversioned, undocumented endpoint should make its first live call
  before the normalizer's field-mapping is written, not after — isolate the
  guess-dependent logic behind one pure, fully-tested function in the
  meantime so a correction stays cheap regardless of timing.
- **Field whitelisting and field-content sanitization are two separate,
  both-required defenses for untrusted text reaching a rendered surface.**
  Restricting _which_ fields survive normalization does not restrict _what
  those fields can contain_ — a control character or ANSI escape sequence
  needs its own explicit strip-and-clamp step, applied at both the write
  side and (defense in depth) the read side of any on-disk cache that
  isn't itself a fully trusted channel.
- **A write path copied from a simpler script needs its error-handling
  re-evaluated against its actual execution context**, not assumed
  equivalent. An unguarded `writeFileSync` is a minor style choice in a
  foreground CLI a human runs and can see fail; the identical unguarded
  call inside a detached, `stdio:"ignore"` child (as `bin/usage-cache.mjs`
  runs when spawned by its `Stop` hook) turns any write failure into a
  permanent, invisible non-function.
- **`creating-prs`'s quality-gate command subset does not include
  `check:command-catalog`.** Adding a new `package.json` script mid-PR and
  relying on that subset (rather than the full `pnpm verify`, run once
  earlier in the session before the script existed) let this gap reach CI.
  Re-run the full `pnpm verify` — or at minimum `pnpm check:command-catalog`
  — after adding any new `package.json` script, not just before the
  session's first push. _(promoted → .claude/skills/creating-prs/SKILL.md)_
- **`ExitWorktree`'s ownership tracking does not survive a mid-session
  compaction.** Both PR 1's and PR 2's close-out hit "this session is not
  the owner of the worktree" on the first `ExitWorktree(remove)` attempt,
  requiring the `keep`-then-manual-`worktree:remove`-from-`main` fallback
  each time. Treat this as the expected path after any compaction that
  occurred while inside a linked worktree, not a one-off error to debug.
  _(promoted → .claude/skills/finishing-work/SKILL.md)_
