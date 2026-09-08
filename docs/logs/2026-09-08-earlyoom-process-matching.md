# Work log — `earlyoom-process-matching` (2026-09-08)

This log covers a user-requested performance-optimization investigation into
this repo's own heavy local gates on a 4-core/24 GB ARM64 host, which turned
into a defect-fix PR (#1134) once re-deriving ADR-0080's own claims against
the live host — rather than trusting that "applied" means "working" —
surfaced two live bugs in `setup-host-resources.mjs`'s earlyoom tuning plus
a separate, architecture-specific V8 heap crash in `lint:workspace`. It
records what shipped, the review-and-fix cycle the PR went through, and the
durable lessons.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

Merged PR #1134 (`fix: correct earlyoom targeting and lint:workspace heap
ceiling`), squash commit `05728744`, slice P0 of a 4-slice
adaptive-host-budgeting wave (P1-P3 not started).

Files changed: `bin/setup-host-resources.mjs`, `bin/tests/setup-host-resources.test.ts`,
`docs/adr/0080-host-resource-budgeting.md`, `docs/contributing/host-resources.md`,
`package.json`, plus the new `docs/plans/2026-09-08-adaptive-host-budgeting.md`
and its `docs/plans/README.md` index row.

Three defects fixed:

1. **earlyoom's `--prefer`/`--avoid` matched the wrong process names.**
   earlyoom matches `/proc/PID/comm`, not argv (confirmed against `man
earlyoom` and a live `comm` census); Node's main thread always reports
   `MainThread` regardless of script, so the shipped
   `--prefer 'node|claude|vitest|tsc|esbuild'` never matched any real
   toolchain process, while `claude` — the CLI binary's own comm — DID
   match, inverting the guard's intent (boosting the interactive session's
   own kill-priority instead of protecting it). Fixed in two rounds: first
   to `^(MainThread|node-MainThread|esbuild)$` (removing `claude` from
   `--prefer`), then — per a bot review finding — `claude` added to
   `EARLYOOM_AVOID` as well, since removing it from `--prefer` alone only
   returns it to neutral priority rather than actually protecting it.
2. **The `-s` swap-free floor was uncalibrated against this same script's
   own zram provisioning.** earlyoom requires both `-m` and `-s` breached
   before acting; pairing the default `-s 10` with ~50%-of-RAM zram meant
   ~90% of provisioned swap had to be exhausted first. Raised to `-s 50`.
   A related idempotency gap was found and fixed alongside: step 1 of
   `run()` previously only checked "is earlyoom active" and skipped
   unconditionally if so, so a host that had already run `--apply` once
   would never receive an updated drop-in when the tuning changed —
   confirmed live on this very host. New `classifyEarlyoomState()` compares
   on-disk drop-in content against the current constants instead.
3. **`lint:workspace` crashes with a V8 heap OOM on ARM64.** Node's default
   V8 old-space ceiling measured 4288 MB on this host regardless of 23 GB
   system RAM (not a fraction of `totalmem()`); the full-workspace
   typed-lint program crosses it and aborts (exit 134), reproducible alone
   on an idle box. CI's identical job passes on x86_64 `ubuntu-latest`,
   which is why it went unnoticed until run on ARM64. Fixed with
   `NODE_OPTIONS=--max-old-space-size=8192` on `lint:workspace` only
   (`lint:library` does not cross the ceiling). A bot review correctly
   flagged that the literal `NODE_OPTIONS=` assignment replaced rather than
   appended to any inherited value; fixed to
   `"${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=8192"`.

Gates: `pnpm verify` passed twice in full (71 steps, 10 skipped, 0 failed,
both before and after the review-fix round); all 17 PR checks green
including `should-fix-ack`; `claude-pr-review.yml` PASS on both rounds
(second round's Should-fix section empty). `bin/tests/setup-host-resources.test.ts`
grew from 27 to 33 tests, 10 of them new and mutation-tested in this task
(each confirmed to fail against the pre-fix code and pass against the fix).

**Known, deliberately unresolved tension** (documented, not fixed): the
`8192` heap figure is itself a fixed constant of the same class this task
fixed elsewhere. Measured peak RSS at that ceiling is ~5.7 GiB; on the
ADR's documented 16 GiB/2-session floor, `recommendToolMemoryLimitGiB`
derives a 6 GiB `CLAUDE_CODE_TOOL_MEMORY_LIMIT` — thin margin before a local
run risks a silent cgroup kill instead of the loud crash this fix replaces.
Deferred to the wave's P1/P2 slices (deriving `NODE_OPTIONS` from the same
per-host budget), per the `Acknowledged-Should-Fix` commit footer.

Skills used: starting-work, creating-prs, resolving-pr-comments, syncing-docs
(invoked from both creating-prs and resolving-pr-comments), writing-work-logs,
finishing-work.

Spoke incidents: 1 truncation (from `tmp/session-incidents.jsonl`, no visible
effect on any agent's final report) / 0 stalls / 0 resumes.

Compaction events: none.

## What went as planned

- **Re-deriving ADR-0080's claims against the live host, rather than
  trusting "applied" means "working," found real bugs on the first pass.**
  The user explicitly asked for this re-evaluation mid-planning; it
  surfaced both earlyoom defects and, indirectly, the path that led to
  discovering the `lint:workspace` crash.
- **`starting-work` correctly gated the branch decision**, including
  catching that `bin/tests/**` is a guarded path even though `bin/**`
  itself is not — the hub-src-write guard fired exactly as designed when a
  direct test-file edit was attempted, correctly redirecting to the
  `test-author` spoke.
- **Mutation testing caught nothing wrong, twice** — every dispatched
  `test-author` round hand-verified its own new assertions actually fail
  against the pre-fix code before restoring it, and all restorations were
  confirmed byte-identical via `git diff`.
- **Both bounded re-reviews (`code-reviewer` + `security-reviewer`) came
  back clean** on the review-fix round, with only optional Nits — no new
  Must-fix or Should-fix introduced by the fixes themselves.
- **The `should-fix-ack` footer mechanism (ADR-0097) worked exactly as
  documented**: the re-review's Should-fix section came back empty because
  the one deliberately-deferred item was already acknowledged in the prior
  commit's footer, rather than re-flagged.

## What didn't go as planned, and why

### 1. A manual `&`-backgrounded shell command was silently killed and falsely reported complete

Ran `node bin/verify-all.mjs --continue > /tmp/verify-out.log 2>&1 &` inside
a `run_in_background: true` Bash call. The tool reported "completed, exit
code 0" almost immediately — that was the wrapper shell backgrounding and
returning, not the actual verify run finishing. The real process (confirmed
alive via `pgrep` minutes later) was then silently killed with no error in
`dmesg`/`journalctl`, most likely reaped when the harness recycled the
backing shell between tool calls, since it was never `disown`ed.

**Why it happened:** Combining the tool's own background-job tracking with
a manual shell `&` created a process the harness lost track of; the
"completed" notification fired for the outer wrapper, not the inner job.

**Fix for future:** Never combine `run_in_background: true` with a trailing
`&` in the command string. Pass the long-running command directly to
`run_in_background` and let the tool manage backgrounding — it tracks the
actual process and notifies on its real completion.

### 2. `pnpm lint:workspace` crashed with a V8 heap OOM, unrelated to the branch's own diff

Mid-verification, a full `pnpm verify` failed at `lint:workspace` with
`FATAL ERROR: ... JavaScript heap out of memory` (exit 134). Confirmed via
`git diff origin/main -- <path>` that the branch touched zero lint/tsconfig
files, and confirmed via a clean recent CI run that the identical job passes
on `ubuntu-latest` (x86_64). Root-caused to Node's default V8 old-space
ceiling (~4.3 GB on this ARM64 host) not scaling with `totalmem()`, crossed
by the full-workspace typed-lint program's memory footprint.

**Why it happened:** A pure per-architecture/per-host resource ceiling gap,
unrelated to any code change — the workspace had presumably been sitting
near this ceiling for a while, and nobody had run `lint:workspace` alone on
an ARM64 host before.

**Fix for future:** When a gate fails during verification with no
plausible connection to the branch's own diff, check (a) whether it
reproduces alone on an idle box (rules out contention) and (b) whether a
recent CI run passed the identical job on a different architecture/runner
before assuming a code regression. Both checks here took under two minutes
and definitively separated "pre-existing host-specific gap" from "my change
broke something."

### 3. Scope expanded twice mid-task, both times correctly gated behind a user confirmation

The task began as a broad host-tuning investigation; re-deriving
`setup:host-resources`'s own claims (user-requested) reframed it as a
defect-fix; discovering the `lint:workspace` crash mid-verification
introduced a second, unrelated fix. Both expansions were surfaced to the
user via `AskUserQuestion` before proceeding rather than silently folded in.

**Why it happened:** Genuine new information discovered during
verification, not scope creep from over-interpreting the original ask.

**Fix for future:** This is the correct pattern to repeat, not a mistake to
avoid — surface an out-of-scope discovery with the recommended path and a
narrower alternative, and let the user decide whether it's bundled in or
filed separately, rather than unilaterally deciding either way.

## Lessons learned

- **Verify a safety net's own claims before trusting it, not just that it
  was "applied."** `setup-host-resources.mjs` had been run successfully on
  this host, but a live `/proc/*/comm` census showed its earlyoom
  `--prefer` regex matched none of its intended targets. "Applied without
  error" and "does what it says" are different claims — re-derive the
  second one directly rather than inferring it from the first.
- **A regex-based process-priority tool needs its matching semantics
  verified against the actual kernel interface, not assumed from the
  flag name.** `--prefer`/`--avoid` read like they'd match a command line;
  `man earlyoom` and a live census were both needed to establish they
  actually match `/proc/PID/comm`, which Node's own runtime obscures by
  naming every process's main thread `MainThread` regardless of the script.
- **Never combine a tool's own `run_in_background` with a manual shell `&`.**
  It produces a false-positive "completed" notification and an
  untracked, silently-killable process. _(see divergence #1 above)_
- **A gate failure with zero connection to the branch's diff is presumed
  pre-existing until two cheap checks say otherwise: does it reproduce
  alone, and did CI just pass the identical job elsewhere.** Both together
  took under two minutes here and avoided wrongly treating an
  architecture-specific V8 heap ceiling as a regression in this PR.
- **A `classifyEarlyoomState`-style content comparison, not just an
  active/inactive check, is required for any idempotent setup script whose
  target configuration can itself change over time.** An "already active —
  leaving as-is" check that never compares current content against the
  latest intended content means a fix to that script silently never reaches
  a host that already ran it once — confirmed live, not hypothetical, on
  this exact host. _(promoted → .claude/rules/harness-artifacts.md)_
- **A Should-fix finding that requires deriving a value from a not-yet-built
  system (here, a per-host memory budget planned for a later PR in the same
  wave) is a structural change, not a targeted line fix — document the
  tension precisely (with a measured number) and defer it, rather than
  picking an arbitrary tighter constant that doesn't actually resolve the
  underlying collision risk.**
