# Byte-offset streaming resume for list exporters — closing issue #427 (F11)

**Status: shipped** — branch `feat/exporter-resume-seam`; closes issue #427
and reconciles the corresponding `docs/plans/IMPLEMENTATION.md` F11 tracker
row and ADR-0045.

## Context

F11 was filed resolving a `claude-pr-review` Must-fix on PR #425: the
resume-checkpoint pattern in `cloudwatch-logs-insights` and (newly, in that
same PR) `rds-data-sql` buffered a run's entire accumulated output/result set
inside the checkpoint file on every write, so a resumed run's
freshly-truncated output writer could be fully re-populated before new work
continued. Correct, but it reintroduced unbounded memory/checkpoint-file
growth proportional to result size — exactly the growth per-page/per-chunk
streaming exists to avoid, and the tracker accepted it as a known, documented
tradeoff rather than a blocker.

Auditing the four affected scripts before planning the fix surfaced a second,
independent finding: `dynamodb-crud`'s checkpoint was already cursor-only (no
row buffer, unlike the other two), but its `dispatchScan` step still reopened
the same exporter at the same output path on `--resume`. Since the exporter
truncates on open, a resumed scan/query/export was silently destroying
everything a prior interrupted run had already written, with no checkpoint
data to recover it. A live, previously-shipped data-loss bug, not a
documented tradeoff — found while planning this fix, not by the original
issue.

## Approach / Decisions

- **A byte-offset resume seam on the library's list exporters**, not a
  script-local workaround. `M3LJSONListExporter`/`M3LCSVListExporter` gained
  `resumeFromByte?: number` (CSV also `columns?: readonly string[]`, required
  when `resumeFromByte > 0`); `M3LListExporterStreamWriter` gained
  `readonly bytesWritten: number`. Rejected a plain `flags: "a"` append
  option: a crash mid-write leaves a torn partial line an append would
  corrupt further, whereas truncate-to-offset-then-append is exactly safe
  against that case. Full rationale in ADR-0045.
- **Per-script adoption scope tracked the real cost of a fixed CSV column
  set, not a uniform template.** `dynamodb-crud` (jsonl-only) and
  `rds-data-sql`'s `load` (`failed.jsonl`, always jsonl) needed no bootstrap
  logic. `rds-data-sql`'s `query` CSV output could bootstrap cleanly — the
  SQL result's column metadata is known from the very first page, before any
  row is written — so `RunQueryDeps.writer` became a
  `createWriter({ resumeFromByte, columns })` factory the step calls itself
  after fetching page one on a fresh run. `cloudwatch-logs-insights` CSV
  output could not: log rows carry no upfront schema, only inferable from row
  content, which would need an unbounded bootstrap buffer this change does
  not attempt — so CSV there deliberately keeps the original full-buffering
  design, documented as a scope boundary in ADR-0045 rather than silently
  left half-fixed.
- **Checkpoint field co-occurrence, not independent-optional validation.** A
  numeric offset/index field and its byte-length correlate (`offset`⟺
  `outputBytes` in `rds-data-sql`; `rows`⟺`outputBytes` in
  `cloudwatch-logs-insights`) must be required together — a checkpoint
  carrying one without the other (most realistically, one written by the
  pre-fix code) is rejected loud rather than silently resumed from the wrong
  point. Found independently by two review spokes across two different
  scripts in the same effort; promoted into `.claude/rules/scripts.md` as a
  standing rule rather than left as a one-off fix.
- **A close()-failure attribution pattern, reused three times.** A writer's
  `close()` can carry the ONLY signal of a deferred resume-integrity failure
  (the library's own size-mismatch guard defers its rejection to the first
  `append()`/`close()` call) whenever `append()` is never called this
  run — a resumed page/chunk/window that happens to add zero new rows. Fixed
  in `rds-data-sql`'s `run-query.ts`/`run-load.ts` and
  `cloudwatch-logs-insights`'s orchestrator: track whether the surrounding
  work already threw; log-only if so (genuinely secondary), otherwise
  propagate the close failure as a real typed error.
- **Every fix round went through independent, adversarial review** — three
  review spokes in parallel per script adoption (code-reviewer plus two of
  silent-failure-hunter/type-design-analyzer/security-reviewer, chosen by
  diff shape), each catching at least one genuine correctness or
  data-safety bug the implementation pass had missed, none of the four
  commits landing on first pass. One review round (rds-data-sql's) itself
  surfaced a second bug — a resumed run's writer invisible to its own
  `finally` block on a throw path the fix round hadn't asked about — caught
  by a `test-author` writing the proving test rather than trusting the fix
  description.

## Outcome

`m3l-common` 3.0.0 → 3.1.0 (minor — `resumeFromByte`/`columns` additive;
`bytesWritten` a new required member on `M3LListExporterStreamWriter`, an
interface confirmed to have no hand-constructing callers in this repo).
`pnpm verify` 37/37 applicable steps pass; full workspace suite green
throughout (m3l-common 4377, `dynamodb-crud` 107, `rds-data-sql` 189,
`cloudwatch-logs-insights` 109 tests). ADR-0045 records the design and its
per-script scope; `docs/plans/IMPLEMENTATION.md`'s F11 row flipped
Deferred → Done (its Source cell also corrected — it had cited a work log
that never actually discussed this tradeoff). Two lessons promoted into
durable rules: checkpoint field co-occurrence
(`.claude/rules/scripts.md`) and `test.fails()` as the tool for a bug a
test-author finds outside its `src/`-only write scope
(`.claude/agents/test-author.md`). Full narrative:
`docs/logs/2026-08-15-exporter-resume-seam.md`.
