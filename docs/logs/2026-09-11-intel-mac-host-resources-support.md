# Work log — Intel Mac host-resources support (2026-09-11)

This log covers a 2-PR sequence adding real Intel Mac (darwin x64) support to
this repo's host-profiling and host-resource tooling — investigated and
implemented live on a real Intel Mac, the first time this project had one
available. It records what shipped, the hub-and-spoke pipeline that produced
it, two `claude-pr-review` rounds (one genuine Must-fix, one genuine security
finding raised by a re-review), and the insights worth carrying forward.

Plan of record: [`docs/plans/archive/2026-09-11-intel-mac-host-resources-support.md`](../plans/archive/2026-09-11-intel-mac-host-resources-support.md)

## Summary

**PR 1 — `fix/darwin-host-profile` (#1196).** `bin/lib/host-profile.mjs`'s
Darwin collector carried a doc comment admitting it was "unproven on real
hardware (no Mac available to this project yet)." Running it live on this
machine (darwin x64, i9-9980HK, 8 physical/16 logical cores, 64 GiB RAM)
reproduced four defects, not hypothetically:

- `ps -eo comm --no-headers` — GNU/procps-only; BSD `ps` rejects it,
  leaking stderr noise into every `pnpm build`/`typecheck`/`lint:*:fast` and
  silently zeroing the live session count. Fixed to the portable
  `ps -eo comm=` form (both `host-profile.mjs` and the duplicated copy in
  `check-host-resources.mjs`), plus a leading-path strip for BSD's
  full-path `comm` rendering of daemons.
- `hw.perflevel0.logicalcpu` reported all 16 logical cores as "performance
  cores" on this non-hybrid CPU — macOS 12+ exposes the sysctl uniformly
  even on Intel. Gated on `hw.nperflevels > 1`, correcting a doc comment
  that had the exact opposite (and root-cause) claim.
- `parseDarwinSwapUsage` broke under `LC_NUMERIC=it_IT` (comma decimal
  separator); `DEFAULT_IO.run` now forces `LC_ALL=C` on every child process.
- `detectHostProfile` read `process.platform` directly with no injection
  seam — 2 existing Linux-fixture tests silently took the Darwin branch on
  this machine. Added an optional `platform` override, which is what made
  the Darwin path testable at all (it had zero coverage before this PR).

Also fixed two previously-deferred approximations now that real hardware
existed to validate against: `availableMemGiB` (was defaulting to total
memory; now `vm_stat`-derived) and `smt` (was hardcoded `false`; now
`logicalCores > physicalCores`). Folded in an unrelated pending
`pnpm-workspace.yaml` fix (`better-sqlite3` build-skip) at the user's
request. A `claude-pr-review` Should-fix caught a real follow-on bug in the
same area (`if (!vmStat)` is falsy for the legitimate value `0`) — fixed
with a mutation-tested regression test in the same PR.

Suite grew from 70/72 passing on this machine (2 failing pre-fix) to 82/82,
then 104/104 after the Should-fix pass added a Darwin end-to-end fixture and
a null-vs-zero boundary test.

**PR 2 — `feat/macos-host-resources` (#1201).** `bin/check-host-resources.mjs`/
`bin/setup-host-resources.mjs` (ADR-0080) were Linux-only, printing a single
generic "nothing to do" line on any other platform — including
`setup`'s step 7 (`lefthook-local.yml` serial-pre-push override), which has
no Linux dependency at all. Replaced the blanket gate with real behavior:
`evaluateDarwinHostResources` reports jetsam pressure/swap/`vm_stat`
available memory and names each Linux-only mitigation's macOS analogue
explicitly; `platformStepSkips(platform)` gates each of `setup`'s 7 steps
individually so step 7 now actually runs on macOS. `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
is deliberately skipped/informational-only on macOS — it's enforced via a
Linux cgroup the CLI cannot apply there.

Went through two `claude-pr-review` rounds:

- Round 1 (FAIL): a genuine Must-fix — the `settings.local.json` parse-error
  `catch` reported "leaving it untouched" but didn't actually stop
  execution, so a malformed-but-recoverable file could be silently
  overwritten with a single-key object under `--apply`. Fixed with a
  `parseFailed` bail flag. Also fixed a Should-fix (the swap-usage warning
  firing on normal macOS operation, since `dynamic_pager` grows the swap
  file on demand) with an absolute-GiB floor alongside the percentage check.
- A bounded `security-reviewer` re-review of the Must-fix fix (dispatched
  proactively during the same pass, before re-pushing) found a genuinely
  new issue the Must-fix itself introduced: the new warning could echo file
  content into stderr/`--json`/a GitHub Actions annotation, since Node's
  `JSON.parse` `SyntaxError` embeds a snippet of the surrounding text and
  `settings.local.json`'s `env` block is exactly where a host-local secret
  would live. Fixed to report `error.name` only, never `error.message`.
- Round 2: PASS, `should-fix-ack` passed on the `Acknowledged-Should-Fix`
  footer (2 fixed with tests, 2 pre-existing structural gaps explicitly
  left for a follow-up, 3 nits left untouched as outside the region this
  pass edited).

`pnpm verify` passed clean on every push across both PRs (73 passed / 10
skipped each time). Test suite: 105/105 across both host-resources test
files after the fixes landed. Both PRs' close-out ran `finishing-work` in
full; the originating plan is archived at
`docs/plans/archive/2026-09-11-intel-mac-host-resources-support.md`.

**Skills used:** starting-work, creating-prs (×2), resolving-pr-comments
(×2), syncing-docs (×4), finishing-work (×2), writing-work-logs.

**Spoke incidents:** 2 truncations / 0 stalls / 0 resumes (per
`tmp/session-incidents.jsonl`; both truncations occurred mid-session on
long-running review/test-author dispatches and were transparently retried
by the harness with no loss of findings — neither is discussed further
above because the retried output was the one actually used).

**Compaction events:** none.

## What went as planned

- **Live-first investigation caught real bugs synthetic fixtures never
  would have.** Every defect in PR 1 was found by running the actual code
  on the actual machine before writing a single test — matching
  `.claude/rules/harness-artifacts.md`'s "run a new check live before
  writing its test suite" guidance, applied here to a `bin/lib/*.mjs`
  module rather than a `check:*` gate for the first time this repo has done
  so on real non-Linux hardware.
- **Mutation testing caught two additional real bugs during test-authoring,
  not just proved coverage.** Two separate `test-author` dispatches, while
  mutation-testing their own new regression tests, independently found and
  fixed genuine defects the hub hadn't spotted: `parseDarwinMemoryPressureLevel("")`
  returning `0` instead of the documented `null` (`Number("")` is `0` in JS,
  not `NaN`), and confirmed the `!vmStat` null-vs-zero fix (PR 1's
  Should-fix) with a targeted end-to-end fixture.
- **Both PRs' `pnpm verify` and pre-push hooks were clean on every push** —
  no lint/format/typecheck churn, no CI-only surprise.
- **The worktree ownership fallback (`ExitWorktree({action: "keep"})` after
  a refused `"remove"`) worked exactly as documented** in both close-outs —
  this long a session predictably lost tracked ownership across the gap
  between entering the worktree and finishing the work, and the documented
  fallback path in `finishing-work`'s own Step 3 handled it without
  incident either time.
- **The docs-consistency and bounded re-review spokes stayed genuinely
  scoped** — each pass reviewed only the actual diff of the fix at hand,
  not a full-file re-audit, and returned specific, actionable findings
  rather than re-litigating already-settled code.

## What didn't go as planned, and why

### 1. A stray uncommitted `pnpm-workspace.yaml` WIP conflicted with `main` after PR 1's squash merge

After PR 1 merged, `git pull` on the shared checkout failed with "local
changes would be overwritten" — the user's own uncommitted
`better-sqlite3: true → false` edit, which PR 1 had folded in and merged,
was still sitting uncommitted in the shared checkout's working tree.

**Why it happened:** The user had started that edit in the shared checkout
before this session began; folding it into PR 1's worktree branch (per the
user's own mid-task request) created a second, independent copy of the
identical change rather than moving the original.

**Fix for future:** Before pulling `main` post-merge, diff any suspicious
pre-existing uncommitted change against what's now on `origin/main` for
that file — if byte-identical, it's safe to discard with a plain
`git checkout -- <file>` rather than treating it as a conflict to resolve.

### 2. `commitlint` rejected the first PR-2 fix-round commit on a footer line-length rule

The `Acknowledged-Should-Fix:` trailer, written as one long descriptive
sentence, exceeded commitlint's 100-character footer-line limit and the
commit was rejected outright (nothing landed, no partial state).

**Why it happened:** The trailer's guidance (`resolving-pr-comments`
Step 9) shows a short example but doesn't state the hard length limit
explicitly, so a genuinely full account of "what was fixed vs. left" ran
long.

**Fix for future:** Keep every `Acknowledged-Should-Fix:` trailer to a
short summary phrase (well under 100 chars) — the "Not addressed" bullets
in the commit body already carry the full detail; the trailer only needs
to point at them.

## Insights

- **Run the actual code on the actual target hardware before writing any
  test for it.** Every one of PR 1's four defects was found this way, not
  by imagining edge cases — a Darwin-specific module with a "no Mac
  available" doc comment is exactly the class of code where synthetic
  fixtures can only test what their author already imagined correctly.
- **A bounded security/code re-review of a bug _fix_ is worth dispatching
  even when the original review only flagged one line.** The Must-fix fix
  in PR 2 introduced its own new issue (echoing file content into a log
  sink) that no one asked to be reviewed — proactively re-reviewing the fix
  itself, not just trusting it closed the loop, caught a genuine security
  regression before it reached `main`.
- **Mutation-testing a new regression test is not a formality — it
  regularly surfaces bugs the hub itself missed.** Twice in this sequence a
  `test-author` dispatch, following through on the mutation-test
  instruction literally, found a real defect (the `parseDarwinMemoryPressureLevel("")`
  bug) that wasn't in the original bug report at all.
- **A commit-message trailer with a hard length limit needs the limit
  stated, not just an example.** `resolving-pr-comments`'s
  `Acknowledged-Should-Fix:` guidance should show the 100-char ceiling
  explicitly rather than relying on the example staying short by
  convention — this cost one rejected commit attempt in this sequence.
  _(promoted → .claude/skills/resolving-pr-comments/SKILL.md)_
- **When a squash-merged PR's changes overlap a pre-existing uncommitted
  edit elsewhere in the repo, diff before discarding, never assume.** The
  stray `pnpm-workspace.yaml` edit turned out to be byte-identical to what
  had merged, but that has to be verified with `git diff origin/main --`,
  never assumed from context.
