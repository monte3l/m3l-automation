# Work log — `tmp-tmpfs-measurement` (2026-09-11)

P3.7 of the adaptive-host-budgeting wave (Stage 3, Phase 2 tuning candidate
7): "`/tmp` → tmpfs". The plan doc's row carries no recoverable rationale —
its "full design detail" note points at a plan-mode transcript that no
longer exists in the repo, and no ADR or prior log documents a hypothesis
for what tmpfs was expected to fix. Rather than implement a mechanism
against an unrecoverable premise, this task re-derived the premise first
using Stage 1's own measurement harness (`bin/bench-gates.mjs`), per this
repo's standing instruction to re-verify an authored claim before acting on
it. The measurement closed the row with a negative result — no code was
written.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

- **Pre-work scoping** (`AskUserQuestion`, two rounds): confirmed measuring
  before implementing, and — if a tmpfs change were to proceed — scoping it
  to a repo-local `tmp/` working directory rather than the host's actual
  `/tmp`, given ADR-0080's core premise (this host is memory-constrained)
  makes trading disk I/O for RAM pressure the same risk class as P3.6's
  `issue #734` OOM history.
- **Measurement**: `node bin/bench-gates.mjs --lane=test:unit --json --out=...`
  — `test:unit` chosen because it is the heaviest lane (489.29s wall-clock)
  and the one most dependent on `os.tmpdir()` sandbox I/O (~83 test files
  using the `mkdtemp`/`rm` pattern `check:test-fs-isolation` enforces, per
  ADR-0100).
- **Result**: `pressureDeltaMs.io: 821` against a 489,290ms wall-clock — I/O
  pressure stall is **0.17%** of the lane's duration. `pressureDeltaMs.cpu:
5501` and `budget.limitedBy: "cpu"` confirm this 4-core ARM64 host is
  CPU-bound, not I/O-bound, for this lane. `pressureDeltaMs.memory: 0`.
- **Decision**: tmpfs (system-wide or repo-scoped) would trade a
  ~0.17%-of-wall-time I/O cost for real RAM pressure on a host ADR-0080
  already treats as memory-constrained — negative expected value. No
  implementation was written; the plan-doc row is flipped to a closed,
  not-pursued status citing this measurement rather than left `To Do`
  against a premise that no longer holds.
- `pnpm verify`: run clean on the docs-only push (no `src/`/`tests/`
  changes in scope).
- No PR to review beyond this log-landing PR itself — there is no code
  diff.

**Skills used:** starting-work, writing-work-logs, creating-prs,
finishing-work.

**Spoke incidents:** none — no spoke was dispatched (no `src/`/test code
was written; hub-and-spoke isolation applies to code changes, not a
measurement-only docs task).

**Compaction events:** none during this task.

## What went as planned

- **Re-deriving the premise before implementing caught a stale hypothesis
  cheaply.** A single `bench-gates.mjs` run (already-built Stage-1 tooling,
  no new code) settled the question in one measurement instead of shipping
  a tmpfs mechanism, discovering post-hoc that it didn't help, and having to
  revert it — the same "measure before implementing" discipline the wave's
  own Stage 1 was built to enable, applied here to decide whether to build
  at all rather than only to tune what was already decided.
- **The scoping questions correctly identified the risk class before any
  measurement ran.** Framing tmpfs as "trade disk I/O for RAM pressure on a
  memory-constrained host" up front meant the negative measurement result
  was immediately actionable — the risk that would have blocked a
  real-hardware `--concurrency` bump in P3.6 was recognized here even
  though it turned out to be moot once I/O showed as negligible.

## What didn't go as planned, and why

### 1. The plan-mode transcript referenced by the plan doc was not recoverable

`docs/plans/2026-09-08-adaptive-host-budgeting.md`'s "Full design detail"
note names a source of truth — "the plan-mode transcript this wave started
from" — that turned out to be unavailable to this task; no follow-up
research turned up the original hypothesis (what specifically tmpfs was
expected to improve, by how much, under what load). P3.1–P3.6 never hit
this because their rows carried enough detail in the row text itself or in
`docs/plans/archive/2026-08-19-ci-performance-optimization.md`'s prior
research to proceed without the transcript; P3.7 is the first row in this
wave where the cited source had actually gone stale.

**Why it happened:** a plan doc's own claim about where supporting detail
lives is itself an authored claim that can rot, same as any other — a
transcript reference has no persistence guarantee the way a committed file
does, and nothing in this wave's process previously exercised that gap.

**Fix for future:** when a plan-doc row points at an external or
conversational source ("see the plan-mode transcript", "see the design
discussion") rather than a committed file, treat that pointer itself as
unverified until confirmed present — and if it turns out to be gone, that
is a reason to re-derive the row's premise from first principles (as done
here) rather than either skip the row silently or implement blind.

## Insights

- **A Phase-2 tuning candidate row with no committed rationale is a
  measurement task before it is an implementation task.** This wave's
  pattern up to P3.6 always paired "flip the row" with "ship a mechanism";
  P3.7 shows the pattern also has to support "flip the row" paired with "ship
  a negative-result log" when the premise doesn't survive re-derivation.
  Closing a plan-doc row with a citation to a disproving measurement is a
  valid, complete disposition — not a deferred or incomplete one.
- **`bin/bench-gates.mjs`'s `pressureDeltaMs` output is the right instrument
  for exactly this kind of before-you-build question**, not just for
  before/after comparisons on a change already decided. Running it against
  the heaviest, most tmp-sandbox-dependent lane (`test:unit`) before writing
  any tmpfs code answered "is this worth building" directly, at the cost of
  one ~8-minute measurement run instead of an implementation-then-measure
  cycle.
- **A memory-safety framing (P3.6's issue #734 pattern) is worth applying
  even to a candidate that turns out not to need it.** The scoping
  questions here assumed a tmpfs implementation might proceed and pre-bound
  its risk (repo-scoped `tmp/`, not system `/tmp`) before the measurement
  came back negative — cheap insurance that would have mattered had the I/O
  pressure numbers come back differently.

No insight from this task needed promotion into a `.claude/rules/*.md` file
or agent instructions — the findings are specific to this task's own
plan-doc row and measurement result, not a recurring process gap.
