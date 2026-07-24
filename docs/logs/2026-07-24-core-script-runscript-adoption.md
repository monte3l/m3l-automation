# Work log — `core/script` runScript adoption + per-run output (2026-07-24)

This log covers ADR-0035 phase 5 (A5): migrating the scaffold template and all
nine consumer scripts to `runScript()`, adding a `--dry-run` flag, and
reconciling the archival-vs-report output-directory split so a run's inputs,
configs, and report co-locate under one `data/output/<timestamp>/`. It is the
final item of the ADR-0035 rollout. It ran the full hub-and-spoke pipeline
(`starting-work` → an A4b-docs pre-step PR → RED → GREEN ×2 → three-spoke review
→ two-fix round → confirmation re-review → PR-gate security review →
`syncing-docs` → `writing-commits` → `creating-prs` → this log) and records what
shipped, what matched the plan, what diverged, and the durable lessons.

Plan of record: an in-session plan file (not tracked in the repo). Shipped as
[ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) phase 5 via PR
[#220](https://github.com/monte3l/m3l-automation/pull/220); the A4b work log +
rule promotions shipped first as PR
[#219](https://github.com/monte3l/m3l-automation/pull/219).

## Summary

**Library — co-location.** `M3LScript` now owns a per-run `runStartedAt: Date`
(resolved at the top of `runPipeline`, reset per run) exposed via `get
runStartedAt()`. Stage-9 archival injects a run-scoped output port into
`M3LFileCopier` (`getOutputDir() → <outputDir>/<runDirectoryName(runStartedAt)>`)
and `runScript` feeds the same `runStartedAt` to `M3LRunReporter`, so archive and
report land in one `data/output/<timestamp>/` **by construction**. A new internal
`runDirectoryName`/`safeToISOString` (`internal/diagnostics/`) is the single
source of truth for the per-run dir name, extracted from `run-report.ts`.

**Migration.** `templates/script/src/main.ts.tmpl` + all nine
`scripts/*/src/main.ts` moved from bare `script.run(fn)` to
`Core.runScript(script, fn, { dryRun })` (`--dry-run` via `process.argv`), so
every script surfaces origin-specific exit codes and a run report.

- **Zero new exported symbols** — `runStartedAt` is a getter on the existing
  class; the `runDirectoryName` seam is `internal/`. `check:api`,
  `check:doc-exports`, `gen:index`, provenance were all non-events.
- **Tests:** `script.test.ts` 226 (+ `runStartedAt`, per-run archival,
  co-location), `diagnostics.test.ts` 135 (+ `runDirectoryName`); full suite
  green.
- **Coverage:** per-file ≥80% — `runDirectoryName.ts` 100%, `run-report.ts`
  98.1%, `M3LScript.ts` 95.9%, `run-script.ts` 82.1% branches.
- **Gates:** typecheck, lint, build, `check:api` (no exports change),
  `check:exports`, `knip`, `check:zones`, `check:script-scaffold`, `sync:docs`
  (14/14), `check:test-counts`, `lint:md` all green.
- **Review verdicts:** `code-reviewer` PASS, `spec-conformance` CONFORMANT,
  `silent-failure-hunter` PASS, confirmation re-review CONFIRMED-clean,
  PR-gate `security-reviewer` clean (empirical hostile-input probe).
- **End-to-end:** 12+ built-`dist/` child-process probes on the migrated
  `json-etl` — success co-locates `inputs/` + `run-report.json`; `--dry-run`
  writes only the report (`outcome: dry-run`, exit 0); a missing input exits
  **3** with the report and no archival; `M3L_LOG_LEVEL=error`/invalid still gate
  (A4b intact).
- **Behavioral delta:** archival moved from flat/overwriting
  `data/output/{inputs,configs}` to the per-run timestamped directory.

Skills used: starting-work, syncing-docs, writing-commits, creating-prs,
writing-work-logs.

Spoke incidents: 2 truncations / 0 stalls / 3 resumes. The `test-author`'s RED
report and the `code-implementer`'s Part-1 GREEN report were both cut
mid-sentence; disk state was verified directly in each case (the test-author had
actually completed all four test groups — the journal's TODO was stale). Three
`SendMessage` resumes: the two should-fix rounds and one to recover the
`code-reviewer`'s truncated verdict.

## What went as planned

- **The shared-timestamp seam held under adversarial tracing.** Every reviewer
  independently traced that archival and the report derive from the same
  `runStartedAt` (set as the first statement of `runPipeline`, read by stage 9
  and by `runScript` after `run()` settles), so the two `??` fallbacks are
  provably unreachable and co-location cannot silently split. Designing it as
  "one owner holds the `Date`, both derive via a shared helper" made the
  guarantee checkable rather than hopeful.
- **`check:api` was a non-event, by design.** Keeping `runDirectoryName` in
  `internal/` (the A4b payoff, re-applied) meant no new public symbol, so the
  whole doc-metadata gate stack (`check:doc-exports`, `gen:index`, provenance
  `sources[]`) was untouched — the A3/A4a "new symbol missing from the sidecar"
  trap was designed out again.
- **The scaffold check is presence-based**, so migrating nine `main.ts` bodies
  didn't trip `check:script-scaffold` — verified before dispatching the
  mechanical migration rather than discovering it after.
- **RED failed for the right reason** — both test files failed at import on the
  missing `runDirectoryName.js` module, not a test-logic error.
- **Splitting the phase into a library part (TDD) and a mechanical migration
  part** kept the two `code-implementer` dispatches bounded and let the review
  focus its depth on the library reconciliation.

## What didn't go as planned, and why

### 1. The helper extraction left a private method with two contradictory contracts

The code-reviewer flagged that `#buildReportPathWithOutputDir` was being called
two ways after the extraction: `write()` passed a raw ISO string (the method
sanitized it internally), while `resolveReportPath` passed an
already-sanitized `runDirectoryName(...)` into the same method, which re-applied
`.replaceAll(":", "-")` — a harmless no-op, but the parameter now meant two
different things. Fixed by making the method take an already-final
`reportDirSegment` (one sanitization point at the call sites) and confirming the
path-traversal guards still fire on that segment.

**Why it happened:** wiring one caller (`resolveReportPath`) to the new shared
helper without also moving the _other_ caller (`write()`) onto the same contract
left the sanitization half-migrated — the method sanitized for one caller and
double-sanitized for the other.

**Fix for future:** when a refactor relocates a transform (sanitize, normalize,
coerce) to call sites, move **every** call site in the same change and delete the
old in-callee transform — a half-migrated transform leaves the callee trusting
some callers and re-doing others, and the param name silently lies about its
contract.

### 2. Per-run state on a reusable instance isn't concurrent-run-safe — and A5 raised the stakes

The silent-failure-hunter flagged that `M3LScript`'s per-run `current*` fields
(now including `currentRunStartedAt`) are instance-scoped mutable state with no
reentrancy guard. Before A5 a concurrent second run on the _same_ instance would
cross-talk logged metadata; after A5 it would silently redirect the earlier
run's archived files into the later run's directory. Resolved with a TSDoc
callout on `run()`/`runStartedAt` documenting the one-in-flight-run-per-instance
contract — not a runtime guard, which would be a behavior change out of A5's
scope.

**Why it happened:** the pre-existing "one instance per process" assumption was
only documented in the narrow context of signal-handler registration, not as a
blanket reentrancy contract — and A5 added another field that rides on it, with
a worse failure mode.

**Fix for future:** when you add per-run mutable state to a _reusable_ object,
state its reentrancy contract at the same time (one in-flight operation per
instance, or a guard) — the assumption that made the previous field safe is not
automatically visible to the next one, and the consequence can escalate silently.

### 3. Two writer-spoke reports truncated mid-sentence (again)

The `test-author` (RED) and the `code-implementer` (Part-1 GREEN) both returned
a mid-thought instead of a completion summary. In both cases direct disk
verification told the true story: the test-author had in fact completed all four
test groups (its journal's TODO list was stale, written before it finished), and
the implementer's edits were all present and gates green.

**Why it happened:** exploration- and edit-heavy turns against a large existing
suite run long; the final report is the first thing cut when the turn limit
hits.

**Fix for future:** unchanged from prior logs — never trust a truncated report;
`git status` + grep the expected symbols + run the gates yourself. Treat the
spoke's journal as a hint about _intent_, not a record of _completion_ (a stale
TODO can under-report what actually landed).

### 4. `sync:docs` step 1 tripped on staleness its own step 2 clears (recurring)

`pnpm sync:docs` again failed at step 1 (`check:doc-provenance`) on the two
sidecars (`script`, `diagnostics`) whose source files this change touched; the
manual `node bin/check-doc-provenance.mjs --update` before re-running cleared it
(14/14). This is the third rollout phase (A3, A4b, A5) to hit it.

**Why it happened:** the composite runs the pre-flight verifier fail-fast before
its own re-stamp step, so any source edit since the last stamp aborts it.

**Fix for future:** run `check-doc-provenance.mjs --update` before `pnpm
sync:docs` whenever a documented source file changed. (This has now recurred
across three phases — it is the strongest candidate yet for inverting the
composite's step order, tracked as an unfiled follow-up in the A4b log.)

## Lessons learned

- **Co-locate by a shared value, not by shared code.** When two independent
  mechanisms must agree on a derived path or id, give one owner the raw value and
  have both derive the result through a single shared helper — never let each
  capture its own copy of the value. Here `M3LScript.runStartedAt` is the one
  `Date`; archival and the reporter both run it through `runDirectoryName`, so
  they cannot disagree. _(promoted → .claude/rules/library-src.md)_
- **Migrate a transform at every call site, or not at all.** Relocating a
  sanitize/normalize step to call sites is only safe when _all_ callers move and
  the in-callee version is deleted — a half-migrated transform leaves the callee
  double-processing some inputs and trusting others, and the parameter name lies.
  _(promoted → .claude/rules/library-src.md)_
- **State the reentrancy contract when you add per-run state to a reusable
  object.** Instance-scoped `current*` fields are safe only for one in-flight
  operation per instance; each new field rides on that unstated assumption and
  can escalate the failure mode (here: metadata cross-talk → misplaced files).
  Document (or guard) it in the same change.
- **`internal/` placement is the cheapest way to dodge the doc-metadata gates.**
  A capability that needs no new public symbol should add none — keeping the
  seam `internal/` made `check:api`/`check:doc-exports`/`gen:index`/provenance
  all non-events, for the third phase running.
- **A truncated spoke report under-reports as often as it over-reports.** The
  test-author's stale journal TODO made it look unfinished when all four test
  groups were done. Verify disk state directly; read the journal for intent, not
  as proof of completion.
- **Executed hostile-input probes are the acceptance test for a path-resolution
  refactor.** The security reviewer confirmed the traversal/symlink guards held
  by running `"../../../../OUTSIDE"`, absolute paths, NUL, and a planted symlink
  against rebuilt `dist/` and checking the sibling dir stayed empty — a
  read-through of the guard order would not have proven the sibling never
  received bytes.

## Follow-ups filed

- **Candidate (unfiled, recurring):** invert `sync:docs`'s pre-flight ordering to
  re-stamp-then-verify (or make step 1 non-fatal on staleness step 2 clears).
  Now hit in A3, A4b, and A5 — the strongest case yet for the change; flagged
  here and in the A4b log for the next tooling pass.
- **ADR-0035 rollout complete.** A1–A5 all shipped; the ADR's Rollout section is
  fully realized. No further phases pending.
