# Work log — adaptive-concurrency (2026-09-09)

Covers slice P2 of the adaptive-host-budgeting wave: switching `vitest.*.config.ts`, `turbo.json`, and the `build`/`typecheck` `package.json` scripts over to the derived host-profile budget shipped in P1, retiring the fixed `50%` constants. Records what shipped, a real pre-existing bug found and fixed along the way, one `claude-pr-review.yml` fix round, and the lessons from both.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

Two PRs landed this slice:

- **PR #1143** (`refactor/adaptive-concurrency`) — the P2 switch-over itself, in two commits:
  1. `fix(bench-gates): resolve turbo-backed lanes via pnpm exec, not bare turbo` — `bin/bench-gates.mjs`'s `turbo:typecheck`/`build` lanes invoked bare `turbo run <task>`, which `runLaneOnce`'s `bash -lc` spawn never resolves (pnpm's shell env is only sourced by `pnpm <script>`/`pnpm exec`). Both lanes have failed with "command not found" on every invocation since they shipped in P1 and never measured anything — found live while gathering this slice's own baseline.
  2. `refactor: switch vitest/turbo concurrency to the derived host budget` — `deriveBudget` gains a `concurrentLaneWorkers` field (half of the per-session `workers` budget outside CI, preserving ADR-0080's ratio for the several CPU-fanout lanes `pre-push` runs concurrently; the full `workers` budget in CI, where each gate is its own job with no sibling-lane contention). The four vitest configs and a new `bin/print-concurrency.mjs` (feeding `turbo run <task> --concurrency=$(...)`) consume it; `turbo.json`'s static `"concurrency": "50%"` is removed.
- **PR #1144** (this log, `docs/adaptive-concurrency-log`) — this work log.

One `claude-pr-review.yml` round on #1143 came back FAIL with a real Must-fix: removing `turbo.json`'s static concurrency left the bench-gates lanes (now fixed to use `pnpm exec turbo run`, but still with no `--concurrency` flag) and two pre-existing Containerfile `turbo run build --filter=...` invocations falling back to turbo's built-in default of 10 concurrent tasks — the exact oversubscription this whole mechanism exists to prevent. All findings resolved in one fix commit; bounded re-review came back PASS.

`pnpm verify` green on both PRs (71 passed / 10 skipped each time); `pnpm check:host-resources` clean; memory PSI zero throughout. Squash-merged both.

Skills used: starting-work, resolving-pr-comments, finishing-work, writing-work-logs.

Spoke incidents: none (0 truncations, 0 stalls, 0 resumes — three `test-author` dispatches this session, all completed cleanly in one turn each).

Compaction events: 1 compaction, recovered via the ADR-0078 handoff (branch/last-commit re-verified against live `git status` at session start per the handoff's own instruction, found accurate).

## What went as planned

- **Host-profile detection and `--print-budget` needed no changes** — P1's `detectHostProfile`/`deriveBudget` (shipped and merged the same day) worked correctly on the first call; only a new field (`concurrentLaneWorkers`) needed adding, not a redesign.
- **The "preserve the ratio" design decision held up under review.** Halving `workers` outside CI (mirroring ADR-0080's original 50%, now computed from real cores/memory) was confirmed by the user up front rather than guessed, and no reviewer round questioned the underlying policy — only the CLI-plumbing gaps that followed from it.
- **`pnpm typecheck`/`pnpm lint`/`pnpm test:coverage`/`pnpm verify` were all clean on the first full pass** after the consumer switch-over, before any review round — no gate caught a defect in the actual `deriveBudget`/vitest-config/turbo.json changes themselves.
- **A live container-build attempt correctly surfaced its own limitation rather than a false pass.** `podman build` on the two edited Containerfiles failed immediately with a clear, unrelated sandbox error (`newuidmap` missing for rootless mode) rather than silently skipping validation — the failure was informative, not misleading.

## What didn't go as planned, and why

### 1. `turbo.json`'s `TURBO_CONCURRENCY` environment variable, named in the original plan-mode design doc, does not exist

The wave's plan-mode transcript (quoted in `docs/plans/2026-09-08-adaptive-host-budgeting.md`'s own text as something to "re-derive fresh... rather than trusting a paraphrase") specified: _"`turbo.json`'s literal `"concurrency": "50%"` is removed — `TURBO_CONCURRENCY` supersedes it."_ Before writing any code, a direct check (`grep -rn "TURBO_CONCURRENCY" node_modules/turbo*`, `turbo run build --help`) found no such environment variable — turbo only exposes concurrency via the `--concurrency` CLI flag or the static `turbo.json` field. Building the design around a variable that doesn't exist would have shipped code that silently did nothing.

**Why it happened:** The plan-mode design was written before any live verification against turbo's actual CLI surface — a plausible-sounding mechanism (an env var mirroring a CLI flag, a common pattern in other tools) that was never checked against this specific tool's real behavior.

**Fix for future:** This is exactly the standing instruction the plan doc's own header already states ("re-derive it fresh... rather than trusting a paraphrase to still be accurate") — followed correctly here, but worth restating as the generalizable lesson: a plan-mode design's claim about a specific third-party tool's flag/env-var surface needs a `--help`/source check before code is written around it, not after a bug report.

### 2. Removing `turbo.json`'s static concurrency field silently regressed callers outside the ones being fixed

The consumer switch-over updated `build`/`typecheck` in `package.json` to pass a computed `--concurrency`, but `bin/bench-gates.mjs`'s own two turbo-backed lanes and two pre-existing Containerfile `turbo run build --filter=...` invocations were not part of that update — and once `turbo.json`'s field was removed, all of them silently fell back to turbo's built-in default of 10 concurrent tasks. Caught by `claude-pr-review.yml`, not by any local check or the pre-push review fan-out.

**Why it happened:** The mental model going in was "add `--concurrency` to the callers I'm touching"; the actual invariant `turbo.json`'s own new header comment states — "a direct `turbo run <task>` invocation bypassing these scripts falls back to turbo's own default" — implies every `turbo run` call site in the repo needed auditing, not just the two explicitly in scope. Removing a repo-wide static default and replacing it with a per-call-site opt-in is a change whose blast radius is every call site, not just the ones a task description names.

**Fix for future:** When retiring a static config field in favor of a per-invocation flag, grep the whole repo for other direct invocations of the same underlying command (`grep -rn "turbo run" --include="*.mjs" --include="Containerfile"` here) as part of the change itself, before opening the PR — not as something a review round has to catch.

### 3. A regex-anchoring fix (a review Nit) had no test that actually distinguished it from the unanchored version

When a bot-flagged Nit asked to anchor `buildLaneCommand`'s `--force`-insertion regex on the real `pnpm exec turbo run` prefix instead of a bare `turbo run`, the test-author's first pass updated the existing fixtures to the new command shape and confirmed they still passed — but none of those fixtures contained a competing `"turbo run"` substring elsewhere in the string, so they would have passed identically against the old unanchored regex too. The test-author caught this itself during its own mutation-testing pass (reverting to the unanchored regex and finding nothing failed) and added a fixture with a decoy `"turbo run"` occurrence, which does discriminate.

**Why it happened:** A test fixture that merely reflects the new code's shape isn't automatically a test of the specific behavior change that motivated it — those are different questions, and it's easy to conflate "the test passes against the fix" with "the test would fail against the bug."

**Fix for future:** This generalizes an existing rule rather than promoting a new one — the mutation-testing convention already in force (revert the fix, confirm the new test fails) is precisely the mechanism that caught this; the lesson is to keep applying it even to a change that looks too small to need it (a one-line regex anchor), since exactly this kind of small change is where a fixture can silently fail to discriminate.

## Lessons learned

- **Verify a third-party tool's exact CLI/env surface before designing around it, even when the design comes from an earlier plan-mode session.** A named environment variable that sounds plausible for a well-known tool (turbo) can simply not exist; a two-minute `--help`/`grep node_modules` check is cheaper than writing code around it.
- **Retiring a shared static default in favor of a per-call-site flag has a blast radius of every call site using that default, not just the ones the task names.** Grep for other direct invocations of the same command as part of the change, before review has to find them.
- **A test fixture updated to match new code isn't automatically a test of the behavior that changed.** Keep the mutation-testing convention (revert the fix, confirm the new/updated test fails for the right reason) even on small changes like a regex anchor — it's exactly the case a "the test still passes" check would miss.
- **`turbo run <task> --concurrency=` (empty) fails loudly, not silently.** Verified directly (`turbo run build --concurrency=` exits 1 with "Invalid value for `--concurrency` flag"). This meant a `$(...)`-command-substitution failure mode a reviewer worried about as "silent" turned out to already be well-guarded by the downstream tool's own strict validation — worth checking empirically before adding defensive code for a failure mode that may not actually be silent.
