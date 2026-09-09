# Work log — issue #1146 exporter atomic write + logger flush() (2026-09-09)

This log covers resolving GitHub issue #1146 — a flaky test in
`packages/m3l-common/tests/logging.test.ts` (`M3LFileLoggerHandler` →
"after emitting N events, the file eventually contains a JSON array of N
events in emit order") that intermittently failed only under `pnpm
verify`/pre-push contention. It records the two-root-cause diagnosis, the
fix and its TDD pipeline, a post-push should-fix resolution round, a real
rebase conflict against a concurrently-landed PR touching the same files,
and durable insights.

## Summary

One PR (#1151, `feat/exporter-atomic-write`), merged via squash as
`ed27a448`, closing issue #1146.

Two root causes diagnosed:

1. **Torn read.** `M3LFileListExporter.export()` used a non-atomic
   `fsp.writeFile` (truncate-then-write), so a concurrent reader could
   observe an empty/partial file — `SyntaxError: Unexpected end of JSON
input`.
2. **Latency guess.** Five `vi.waitFor` calls in the test file inherited
   Vitest's 1000ms default timeout, but `M3LFileLoggerHandler.handle()` gave
   callers no way to await its internal write queue — `toHaveLength(3)`
   timeouts under real contention.

Fix:

- `M3LFileListExporter.export()` now routes through the existing internal
  `writeFileAtomic` helper (temp-sibling write + rename), closing the
  torn-read race. TSDoc scoped the atomicity guarantee to POSIX `rename(2)`
  semantics.
- Added a new public `M3LFileLoggerHandler.flush(): Promise<void>` — a
  loop-until-stable await of the internal write queue (a naive single
  `await` can return stale if `handle()` enqueues during the await). Never
  rejects (failures are already caught-and-reported to `process.stderr` by
  `#writeSnapshot`). TSDoc documents an unbounded-wait caveat: intended to
  be called once emission has stopped, since a `handle()` call at least once
  per settled write keeps the promise from ever resolving.
- All 5 `vi.waitFor` polling blocks in `logging.test.ts` replaced with
  `await handler.flush()` + direct assertion, removing the latency guess.
- New tests (atomicity round-trip; `flush()` semantics including a
  mutation-tested do/while guard) were split into sibling files
  (`exporters-atomic-write.test.ts`, `logging-flush.test.ts`) after growth
  pushed the parent files past their ADR-0072 baselined byte ceilings —
  confirmed behavior-preserving (total test count unchanged) via a tagged
  `git stash` comparison.
- Docs updated: `docs/reference/core/exporters.md` (new atomicity
  subsection), `docs/reference/core/logging.md` (`flush()` documented),
  `docs/reference/core/checkpoint.md` (updated `writeFileAtomic`
  "second caller" framing), `docs/implementation-status.md` test counts.

Post-push, `claude-pr-review` returned PASS with 5 Should-fix findings. 4
were fixed (an overclaimed EPIPE-coverage TSDoc/comment claim narrowed to
what the guard actually catches; the `flush()` unbounded-loop caveat
documented; missing `fsp.rm` spies added to two failure-path tests that were
making real, unmocked filesystem calls; `logging-flush.test.ts` reworked to
a per-test `mkdtemp` sandbox instead of bare `tmpdir()`); 1 was explicitly
left as a deliberate design decision (`flush()` resolving identically on
success/failure is the documented "never rejects" guarantee, not an
oversight) and acknowledged via an `Acknowledged-Should-Fix:` commit footer
(ADR-0097's `should-fix-ack` gate). A bounded `code-reviewer` re-review of
just the fix-round diff caught 2 more small self-introduced inconsistencies,
both fixed in a follow-up round. Final `claude-pr-review` verdict: PASS,
zero Must-fix/Should-fix/Nits.

All quality gates green: `pnpm verify` (72 runnable steps + 10 skipped),
full CI (17 checks including `CodeQL`, `should-fix-ack`, `review`), all 6
pre-push lefthook lanes on every push.

Skills used: `starting-work`, `syncing-docs` (×3), `resolving-pr-comments`,
`finishing-work`, `writing-work-logs`.

Spoke incidents: 0 truncations / 0 stalls / 2 resumes (a `test-author` agent
hit its 40-turn limit twice across the session — once during the initial
file-budget split, once during the should-fix test-fix round — both resumed
via `SendMessage` to completion).

Compaction events: 1 compaction, partially recovered. The harness's own
conversation-summary handoff was accurate and let the session resume
precisely; the `SessionStart` hook's ADR-0078 handoff artifact, by contrast,
was stale — it reported branch `main` at an old commit rather than the
actual in-flight worktree/branch/PR state, so it was not the mechanism that
carried continuity here.

## What went as planned

- **RED/GREEN TDD pipeline was clean.** `test-author` and `code-implementer`
  spokes produced the atomicity fix and `flush()` seam with no re-dispatch
  needed for the core logic; the initial review round (code-reviewer +
  type-design-analyzer + silent-failure-hunter) found only should-fix-level
  polish (POSIX TSDoc scoping, a flush() example overclaim), not defects.
- **The file-budget split preserved behavior exactly.** Extracting new tests
  into sibling files, verified via a tagged `git stash`/`stash apply`
  byte-for-byte test-count comparison (373 tests, unchanged), matched the
  repo's own established `<mod>-<facet>.test.ts` convention with no friction.
- **CodeQL and dependency-review gates were clean throughout** — no alerts
  ever touched a changed file.
- **The pre-push rebase-conflict auto-resolution (ADR-0024 merge driver)
  worked exactly as documented** for every derived artifact
  (`catalog.json`, `symbol-map.json`, provenance sidecars) — the only real
  conflict that reached a human/spoke was the one genuine prose collision
  described below.

## What didn't go as planned, and why

### 1. A should-fix line fix (adding `fsp.rm` spies) itself broke the file-budget gate

Fixing claude-pr-review's Should-fix #3 (unmocked real `fsp.rm` calls in two
failure-path tests) pushed `exporters.test.ts` from 68,503 to 68,970 bytes,
past its 68,575-byte ADR-0072 ceiling — discovered only when the resulting
push failed at the `check-file-budget` pre-push lane. A second, targeted
`test-author` pass trimmed comment prose only (no assertion changes) back
to 68,357 bytes.

**Why it happened:** The should-fix fix was verified in isolation (typecheck,
lint, vitest on the two touched files) but `pnpm check:file-budget` was never
part of that spoke's own verification scope, and the file was already close
to its ceiling from the original PR's growth.

**Fix for future:** Any edit to a file already near its `check-file-budget`
ceiling should run that check directly (`node bin/check-file-budget.mjs`) as
part of the edit's own verification, not defer to the next full `pnpm
verify`/push — especially for a should-fix/reviewer-driven edit added after
the file was already sized close to its ratchet.

### 2. Double-backgrounding caused duplicate concurrent pushes and host contention

Wrapping `nohup git push ... &` inside a harness `run_in_background: true`
Bash call meant the harness's own "command completed" notification fired the
instant the `nohup` launch returned — not when the actual push finished. This
was done twice in a row without noticing, producing two concurrent `git
push` processes (and their parallel pre-push `pnpm verify` fan-outs) racing
against each other, plus a completely unrelated worktree's own `pnpm verify`
run, all contending for the same host. Recovery required identifying and
killing the stray processes by PID (checking each one's `cwd` against the
worktree before killing, to avoid touching another concurrent session's
work), then switching to a single, correctly-tracked push.

**Why it happened:** `nohup cmd &` inside an already-backgrounded Bash call
double-detaches: the outer harness tracking sees only the trivial
"launched a background shell" step complete, not the actual long-running
command inside it.

**Fix for future:** Never nest `nohup ... &` inside a `run_in_background:
true` Bash call — pick one detachment mechanism, not both. Use plain
`run_in_background: true` for anything the harness's own tracking should
own; reserve `nohup ... & disown` (foreground-launched, then polled via a
`kill -0` loop) specifically for the case the harness itself warns about —
a push likely to hit a low-memory kill on a contended host.

### 3. A harness low-memory kill hit the detached push's own monitor loop, not just the push itself

After switching to `nohup ... & disown`, the _polling loop checking the
detached process_ was itself killed by the harness's low-memory watchdog
twice in a row (the underlying `git push`/lefthook process, being truly
detached, survived both kills and eventually completed on its own). Recovery
was to poll the detached PID directly (`kill -0`) and tail its log file
rather than trust harness task-notifications for a monitor loop.

**Why it happened:** The harness's low-memory kill targets its own tracked
background jobs as a set, including a lightweight polling loop, regardless
of how little work that specific loop does — matching a pattern already
documented in this repo (`docs/logs/2026-09-07-lefthook-shim-fail-open.md`).

**Fix for future:** When detaching a long push with `nohup ... & disown` on
a host under memory pressure, expect the poll loop itself to need re-launch
one or more times; check the detached PID and its log file directly rather
than treating a "task killed: low memory" notification as evidence the
underlying command also died.

### 4. A concurrently-merged PR touching the same core files produced a real rebase conflict

While PR #1151's should-fix round was in flight, `origin/main` advanced 3
commits, including issue #862's fix (widening the test-I/O sandbox rule,
adding `check:test-fs-isolation`, ADR-0100) — which touched the exact same
core files this PR did (`M3LFileListExporter.ts`, `M3LFileLoggerHandler.ts`,
`atomicWrite.ts`, and their tests/docs). `gh pr view` reported the PR as
`CONFLICTING` after a routine push. A rebase produced exactly one conflict:
a comment-prose collision in `exporters.test.ts`'s import-block header, both
sides re-explaining the same mkdtemp/test-I/O-policy fact in slightly
different words. Resolved by keeping the already-landed, now-canonical
wording from `origin/main`'s side (it already matched the just-updated
`.claude/rules/tests.md`). Re-verified (full `pnpm verify`) and re-pushed
with `--force-with-lease` (safe on this own feature branch, per CLAUDE.md).

**Why it happened:** Two independent PRs happened to touch the identical
core-library files in the same session window — not preventable by either
PR in isolation, and not caught earlier because the routine
`HEAD..origin/feat/exporter-atomic-write` staleness check before the
should-fix-round push didn't also check `HEAD..origin/main`.

**Fix for future:** Before any push in `resolving-pr-comments` or a similar
post-review fix round (not just at `creating-prs` Step 2's initial resync),
check `git rev-list --count HEAD..origin/main` too, not only the feature
branch's own remote ref — a PR that's been open through a should-fix round
can silently fall behind `main` in ways a same-branch check won't catch.

### 5. A `pnpm verify` run failed on a test file this branch never touched

One full `pnpm verify` run hit 5 test timeouts (30000ms) in
`scripts/agent-operator/tests/command-description.test.ts` — a file with an
empty `git diff origin/main --` against this branch. Re-run in isolation, it
passed cleanly in 4.94s.

**Why it happened:** Pure host-contention flakiness (the same host was
running multiple concurrent `pnpm verify`/push processes at the time, per
item 2 above) on tests with a fixed 30s timeout reading `package.json` and
classifying an error — nothing computationally heavy, exactly the profile of
a contention-induced timeout rather than a real regression.

**Fix for future:** `.claude/rules/tests.md`'s existing rule already covers
this ("a gate failing outside your change's blast radius is presumed
pre-existing until disambiguated" / "a suite failing while a spoke fan-out
is running may be contention, not a regression — re-run it alone first") —
this run is one more confirming data point, not a new insight. Worth noting
this occurrence coincided directly with the double-backgrounding host
contention in item 2, reinforcing that the two rules compound: contention
you cause yourself produces exactly this failure signature.

## Insights

- **Verify a file-budget-adjacent edit against `check-file-budget` directly,
  not the next full gate run.** A should-fix/reviewer-driven line fix to a
  file already close to its ADR-0072 ceiling can tip it over; that spoke's
  own verification scope should include the specific gate its edit is most
  likely to trip, not just typecheck/lint/vitest on the touched files.
- **Never nest `nohup cmd &` inside a `run_in_background: true` Bash call.**
  Double-detachment makes the harness report "completed" the instant the
  outer launch returns, not when the real command finishes — producing
  duplicate concurrent invocations of the same long-running command if
  retried. Pick one detachment mechanism per command.
- **A harness low-memory kill can take out a lightweight polling loop, not
  just the heavy command it's watching.** When detaching with `nohup ...
& disown` on a contended host, expect the _poll loop itself_ — not only the
  underlying command — to need re-launching; the underlying detached process
  usually survives and its log file is the authoritative source of truth.
- **Check `HEAD..origin/main`, not just the feature branch's own remote
  ref, before any post-review re-push.** A PR open through a should-fix
  round can silently fall behind `main` — especially likely when the fix
  touches core library files another concurrently-landing PR also touches —
  in ways a same-branch staleness check won't surface until GitHub reports
  `CONFLICTING`.
- **Confirmed: a gate failure with an empty `git diff origin/main --
<path>` is presumed contention/pre-existing, not a regression** — this
  session's own host-contention episode (item 2) produced exactly the
  timeout-under-load signature `.claude/rules/tests.md` already describes,
  reinforcing rather than revising that existing rule.

## Follow-ups not filed

Two follow-ups named in the original plan remain unfiled as tracker items
(neither was in scope for this session, and per this skill's own guidance a
follow-up living only in a work log does not exist as actionable — noted
here for visibility, not as a substitute for filing):

- A GitHub issue for the three sibling whole-file exporters
  (`M3LJSONFileExporter.ts`, `M3LFileExporter.ts`, `M3LBinaryFileExporter.ts`)
  sharing the same non-atomic-write pattern this PR fixed for
  `M3LFileListExporter` only.
- A test for the EPIPE-on-`process.stderr.write` edge case, deliberately
  deferred during the should-fix round (out of scope for that pass).
