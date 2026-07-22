# Failure reporting & diagnostics architecture — audit and design (ADR-0035)

**Status: shipped** — landed on `feat/failure-diagnostics-docs` (single docs
PR; commit `962d59a`).

## Context

An exploration/audit task: map how the library and the nine consumer scripts
log errors, crashes, failures, unexpected statuses, and exit codes — then
design a mechanism for on-demand runtime debugging, post-mortem
troubleshooting, detailed failure reporting, and graceful error handling, with
a clear library-vs-script issue separation. Deliverables were deliberately
docs-only: the design is the contract for later implementation phases.

The audit ran as a five-facet `audit-fanout` workflow (error hierarchy,
logging, script lifecycle/exit codes, retry-poll surfacing, troubleshooting
docs — 20 agents, adversarial verify pass) plus three hub-dispatched
verification spokes for the findings past the verify budget. Headline
confirmed gaps: no fault-origin classification on `M3LError` (the 64-code
vocabulary hints at origin only by naming convention); no error→exit-code
mapping (everything exits 1 via Node's default); `installProcessGuards()`
exported but called by nothing; failed runs leave no artifact (stage-9
archival is success-path only); no log levels or debug toggle; retry/poll
attempt history observable only through events, never the thrown error; no
troubleshooting guide, no code catalog, and pre-issue-forms templates.

## Approach / Decisions

Three interview rounds settled the design space; ADR-0035 records the result:

- **Additive origin metadata over class tiers**: `origin: caller | library |
external` + `retryable` on `M3LErrorOptions`, defaulted per subclass, with a
  normative 64-code catalog in `docs/reference/core/errors.md` — this axis IS
  the library-vs-script separation, driving triage, exit codes, and the issue
  form.
- **Strictly additive semver stance**: new fields/options/helpers/wrappers
  only; existing thrown shapes and `run()` behavior untouched; phased as
  minors.
- **New `core/diagnostics` submodule** (spec-only page shipped now; counts
  read 30 of 31): run reports (`data/output/<timestamp>/run-report.json`,
  failure path mandatory), exit-code registry (0/1/2/3/4/5) +
  `mapErrorToExitCode`, `formatErrorChain`, `M3LBreadcrumbTrail` over the
  existing event fabric, `collectDiagnostics`, and the `runScript()`
  composition-root wrapper (guards + top-level catch + report +
  `process.exitCode`, `dryRun` mode).
- **Debug control via the existing config chain**: `--debug`/`--log-level` >
  `M3L_DEBUG`/`M3L_LOG_LEVEL` > config file > default; new `DEBUG` category +
  `minLevel` floors on logger/handlers.
- **One umbrella ADR, single docs PR, no tracking issues** (rollout section is
  the sequencing record); GitHub issue templates migrated to issue forms
  (`failure_report.yml` new, `bug_report.yml` migrated).

## Outcome

Shipped: ADR-0035; new `docs/reference/core/diagnostics.md` spec;
fault-origin + catalog sections in `errors.md`; level/debug spec in
`logging.md`; exit-code/archival/guard-responsibility sections in `script.md`;
event-vs-error history clarification in `polling.md`; new
`docs/guides/troubleshooting.md` (triage tree, exit codes, post-mortem,
CloudWatch Insights queries, `--inspect` workflow, filing checklist); guide
updates (`writing-a-script.md` §6, `lambda-handlers.md` §4); two issue forms;
Boy-Scout fixes (architecture-doc `M3LLogEventCategory` typo, missing ADR-0034
index row). Implementation phases 1–5 are specified in the ADR's rollout
section and intentionally not started here.
