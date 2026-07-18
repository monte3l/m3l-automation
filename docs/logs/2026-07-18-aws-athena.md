# Work log — `aws/athena` submodule (2026-07-18)

This log covers building the `aws/athena` submodule (`M3LAthenaClient`) end to
end — scaffold, TDD implementation, 5-spoke review, and doc reconciliation —
through the `starting-work` → `scaffolding-submodules` →
`implementing-submodules` → `syncing-docs` → `creating-prs` pipeline. It
records what shipped, what matched the plan, what diverged, and the durable
lessons for the next AWS submodule.

Plan of record: [`docs/plans/archive/2026-07-18-aws-athena-wrapper-and-athena-query-script.md`](../plans/archive/2026-07-18-aws-athena-wrapper-and-athena-query-script.md)

## Summary

Shipped `M3LAthenaClient`, a typed wrapper over Amazon Athena query execution
(`StartQueryExecution`/`GetQueryExecution`/`GetQueryResults`), as the ADR-0029
W4 library prerequisite for the future `athena-query` consumer script —
scripts are banned from importing `@aws-sdk/*` directly (T6, ESLint-enforced),
and the existing `athena` getter on `AWSClientProvider` returns only a raw
`AthenaClient`. Mirrors the finished `aws/cloudwatch-logs-insights` wrapper's
async start/await decomposition (`startQuery`/`awaitResults`/`runQuery`), so a
future resumable script can checkpoint an in-flight `QueryExecutionId` before
polling.

10 public exports: `M3LAthenaClient`, `AthenaAwaitOptions`,
`StartAthenaQueryInput`, `AthenaQueryResult`, `AthenaQueryStatistics`,
`AthenaQueryStatus`, `AthenaRow`, `AthenaColumnInfo`,
`M3LAthenaStartQueryError`, `M3LAthenaQueryFailedError`. 20 tests (expanded
from 6 RED seeds); `client.ts` 100% stmts/functions/lines, 88.88% branches.
Full workspace suite post-rebase: 3416 tests passing (99 files),
build/typecheck/lint/format all green.

Review verdicts (5-spoke fan-out, all against the `aws/cloudwatch-logs-insights`
precedent): `code-reviewer` — 1 should-fix (converged with silent-failure-hunter);
`spec-conformance-reviewer` — conformant, no missing/extra/drifted symbols, all
four row-normalization contract points verified; `security-reviewer` — PASS, no
findings, credentials strictly injected, no SQL string-building;
`type-design-analyzer` — PASS, no must/should-fix, precedent-consistent nits
only; `silent-failure-hunter` — 1 should-fix (same finding as `code-reviewer`).
The one should-fix (a `GetQueryResults` page with rows but no `ColumnInfo`
silently normalizing to `{}` instead of throwing) was fixed and re-verified.

No new runtime dependency — `@aws-sdk/client-athena` was already a hard
library dependency (W0-L2).

Skills used: starting-work, scaffolding-submodules, implementing-submodules,
syncing-docs, resolving-merge-conflicts, creating-prs, writing-work-logs.

## What went as planned

- **RED failed for the right reason** — all placeholder `M3LAthenaClient`
  methods threw immediately without ever calling `send`, and every seed/
  expanded test asserted `send` was invoked, so a coincidental error-type
  match could never mask an unexercised path.
- **GREEN was clean on the core contract** — `code-implementer` correctly
  reconciled the scaffold-stage TS parameter-property constructor
  (`private readonly client`) to the project's hard-private `#client` field
  convention once the field became genuinely read, matching
  `.claude/rules/library-src.md` without being told the exact target shape.
- **The Athena-specific pagination hazard was implemented correctly on the
  first pass** — columns keyed from `ResultSetMetadata.ColumnInfo` (never
  header text), the header row skipped only on the first `GetQueryResults`
  page, rows accumulated correctly across `NextToken` pages. `spec-conformance-reviewer`
  verified all four contract points directly against the code with no drift.
- **Security review was clean on the first bounded pass** — credentials
  strictly injected via constructor, no SQL string-concatenation, error
  context limited to exactly the declared fields (`queryString` /
  `queryExecutionId` + `status`), no query-text logging.
- **The merge driver auto-resolved the derived-artifact conflicts** —
  `docs/reference/catalog.json` and `docs/reference/symbol-map.json` both
  conflicted during the rebase and were silently auto-resolved by the
  registered `m3l-generated` merge driver (ADR-0024), regenerated cleanly by
  the `post-rewrite` hook immediately after.

## What didn't go as planned, and why

### 1. Three of five review spokes stalled past an hour with zero output

The Phase-4 review fan-out dispatched `code-reviewer`, `spec-conformance-reviewer`,
`security-reviewer`, `type-design-analyzer`, and `silent-failure-hunter` in
parallel. `spec-conformance-reviewer` (~7.5 min) and `type-design-analyzer`
(~9.5 min) returned clean, complete reports. `code-reviewer`,
`security-reviewer`, and `silent-failure-hunter` were still marked `running`
by the harness over an hour later, with no completion notification. A
non-blocking `TaskOutput` check confirmed the harness still considered them
alive (not crashed), but gave no visibility into internal progress beyond
that. All three were stopped via `TaskStop`; the `security-reviewer`'s final
snapshot ("Let me verify the polling/retry code... confirm no secrets exist in
the diff's fixtures") showed it was still actively reasoning on-topic, not
frozen — it had simply never converged to a final report. All three were
redispatched with tightly bounded prompts: an explicit, small file list (2–5
files, no "explore the repo" latitude), an explicit checklist of exactly what
to answer, and an instruction to stop and report rather than "double-check"
something already confirmed. All three converged within roughly 60–90 seconds
on the retry, each surfacing genuine, on-topic findings — `code-reviewer` and
`silent-failure-hunter` independently converged on the same should-fix.

**Why it happened:** The original prompts, while precise about what to check,
gave each reviewer open-ended latitude ("read these files", implicit license
to explore further "to be thorough") on a module with several genuine cross-
file precedent comparisons available (the finished `aws/cloudwatch-logs-insights`
peer, the doc spec, the test file). Without an explicit "stop and report"
instruction, a reviewer optimizing for thoroughness can keep re-verifying
indefinitely rather than converging — especially when multiple plausible next
things to check exist and none is individually wrong to check.

**Fix for future:** Scope every review-spoke dispatch with an explicit, small,
enumerated file list and an explicit checklist of what to answer — not just
"here are the relevant files, review them." Add an explicit convergence
instruction ("if you feel the urge to explore further to be thorough, stop and
report what you have instead") to every review prompt, not just retries after
a stall. A stall isn't necessarily wasted work (the security-reviewer was
still doing real, on-topic reasoning), but it costs real wall-clock and forces
a kill/redispatch cycle that bounded scoping avoids entirely.

### 2. A same-file, non-overlapping rebase conflict (`aws/s3` landing mid-session) required explicit user authorization

Mid-session, `aws/s3` (PR #160) merged to `origin/main`, independently adding
its own new AWS submodule. Both branches touched the same shared files by
purely _adding_ their own independent content — a barrel-export line in
`packages/m3l-common/src/aws/index.ts` (`s3` vs `athena`), a new row each in
`docs/implementation-status.md`'s AWS table, and doc-count prose across
`README.md`/`docs/README.md`/`docs/ROADMAP.md`/`packages/m3l-common/README.md`.
Every hunk was a trivially-safe union (both additions needed to survive; no
overlapping logic edit). `resolving-merge-conflicts`'s Step 3 rule is
unconditional, though: any `src/**`/`tests/**` conflict is handed back
("Never auto-pick ours/theirs... Hand it back") with no carve-out for
mechanically-obvious cases. The rebase was aborted twice, and the specific,
pre-diagnosed resolution (keep both barrel-export lines) was presented to the
user via `AskUserQuestion`; only after explicit authorization was the
conflict resolved. Separately, `docs/reference/core/errors.provenance.json`
also conflicted — a genuine same-module provenance conflict, since both
`aws/s3` and `aws/athena` independently modified `M3LError.ts` to register
their own new error codes, giving each branch a different recorded blob hash
for the same source file/section.

**Why it happened:** `resolving-merge-conflicts` deliberately treats every
`src/**` conflict as unconditional hand-back to prevent a stale hunk from
silently reintroducing a banned pattern (`any`, a missing `.js` extension,
CommonJS) that a PreToolUse hook would then have to catch after the fact. The
skill has no risk-tiering for a conflict that is provably a pure two-line
independent addition versus one that overlaps real logic.

**Fix for future:** This is working as designed, not a defect — the rule
exists precisely so a "this one's obviously safe" judgment call is never made
silently. The pattern is durable: two branches concurrently scaffolding
sibling AWS/Core submodules will always collide on the barrel file, the
implementation-status.md table, and the four doc-count prose sites; expect it,
diagnose the exact resolution before asking, and get explicit authorization
before touching any `src/**` hunk even when the fix is obviously a union.

### 3. New error codes were forgotten in the `M3L_ERROR_CODES` completeness vocabulary until the full-suite run caught it

`errors.ts` defined `M3LAthenaStartQueryError` (`ERR_ATHENA_START_QUERY`) and
`M3LAthenaQueryFailedError` (`ERR_ATHENA_QUERY_FAILED`) correctly, but neither
code was added to the `M3L_ERROR_CODES` tuple in
`packages/m3l-common/src/core/errors/M3LError.ts` — the source-scan
completeness guard (`core/errors`, WS-9/SF-9) that diffs every literal `code`
actually emitted under `src/**/*.ts` against the tuple. The module's own test
suite (`athena.test.ts`) passed cleanly throughout implementation and review;
the gap was invisible until the full-workspace `pnpm test:coverage` run
(`errors.test.ts`'s "every emitted code in src/**/*.ts is exactly
M3L_ERROR_CODES" test) failed with `In src but not in M3L_ERROR_CODES:
["ERR_ATHENA_START_QUERY","ERR_ATHENA_QUERY_FAILED"]`.

**Why it happened:** The completeness guard lives in a different module
(`core/errors`) than the one being implemented, and its test only runs as part
of the whole-workspace suite, not the target module's own test file — so
`pnpm exec vitest run packages/m3l-common/tests/athena.test.ts` in isolation
gave no signal that anything was missing.

**Fix for future:** Any new `M3LError` subclass's `code` literal must be added
to `M3L_ERROR_CODES` in `packages/m3l-common/src/core/errors/M3LError.ts`
(alphabetically sorted) in the same commit that defines the error class — this
is a mechanical step, not a judgment call, so it belongs in the
`code-implementer` or `implementing-submodules` checklist rather than relying
on the full-suite run to catch a repo-wide-only test.

## Lessons learned

- **Scope review-spoke dispatches narrowly and explicitly, every time.**
  Enumerate a small, exact file list and an exact checklist rather than
  "review these files" — and add an explicit convergence instruction ("stop
  and report rather than keep double-checking") to every review prompt, not
  just after a stall is observed. This is what turned a 60+ minute stall into
  a ~90-second bounded pass on retry.
- **A stalled background agent isn't necessarily frozen — check before
  assuming failure, but don't wait indefinitely either.** The killed
  `security-reviewer`'s final snapshot showed genuine, on-topic reasoning
  in progress. `TaskOutput` with `block: false` is the only available
  visibility into a live `local_agent` task without risking a context
  overflow from its raw transcript; use it to confirm the harness still
  considers the task alive before deciding to intervene, but a large,
  sustained duration gap versus sibling agents on the same task is still
  the right signal to act on.
- **Concurrent sibling-submodule scaffolding will collide on the same shared
  files — diagnose the exact union resolution before asking, and always get
  explicit authorization before touching a `src/**` conflict hunk.** The
  barrel file, `implementation-status.md`'s per-namespace table, and the
  doc-count prose sites are the recurring collision points; the fix is almost
  always "keep both independent additions," but `resolving-merge-conflicts`'s
  hand-back rule for `src/**` is unconditional by design and should stay that
  way — pre-diagnose, then ask, don't silently override it even when
  confident.
- **Register every new `M3LError` subclass's `code` in `M3L_ERROR_CODES`
  (`core/errors/M3LError.ts`) in the same commit that defines the error
  class.** The completeness guard that catches an omission lives in a
  different module and only runs as part of the full-workspace suite — a new
  submodule's own isolated test run gives no signal that this step was
  skipped. _(promoted → .claude/rules/library-src.md)_
- **A same-module provenance-sidecar conflict from two independent
  submodules editing one shared source file (here, `M3LError.ts`) resolves
  cheaply: pick either stale blob hash, then let `check-doc-provenance.mjs
--update` re-stamp to the actual merged content afterward.** The symbol set
  itself rarely changes in this scenario (no rename/add/remove), so there is
  nothing to hand-merge beyond the blob placeholder.
