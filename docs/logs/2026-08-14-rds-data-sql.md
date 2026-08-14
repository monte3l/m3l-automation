# Work log — `rds-data-sql` consumer script (2026-08-14)

This log covers PR 2 of the issue #204 two-PR chain (`aws/rds-data` wrapper +
the `rds-data-sql` consumer script): the fleet's first relational-store sink
and first transactional consumer, from scaffolding through the full
`scaffolding-scripts` → self-composed `implementing-scripts` pipeline. PR 1
(the `aws/rds-data` wrapper) merged as #424 before this session started. It
records what shipped, a 4-round post-review fix saga that is the log's main
content, and the tracker/doc-drift repair done alongside the build.

Plan of record: `/home/enri3l/.claude/plans/issue-204-this-is-tidy-taco.md`
(outside the repo — a Claude Code plan-mode artifact, not a `docs/plans/`
file, so it is not linked here)

## Summary

Shipped `scripts/rds-data-sql/` — 9 `src/steps/*.ts` modules
(`resolve-settings`, `preflight-secret`, `export-results`,
`build-operation-deps`, `run-query`, `run-load`, `run-execute`, `run-migrate`,
`run-rds-data-sql`) plus a shared `src/lib/identifiers.ts` helper module,
`config.ts` (21 parameters + 3 ordered `configValidators`), and a pure
composition-root `main.ts`. Four operations dispatched by `operation`:
`query` (paged `SELECT`, streamed to a file), `load` (chunked transactional
bulk insert with column inference/validation and per-chunk failure
isolation), `execute` (single statement behind a destructive-op confirmation
gate), `migrate` (ordered `.sql` files applied inside one transaction,
tracked in a migrations table).

Final state: 10 test files / 138 tests in `scripts/rds-data-sql/tests/`;
full workspace typecheck/lint/build/`knip`/`check:dup` all green; `pnpm
verify` 36/36 applicable steps passed (3 correctly skipped: gitleaks,
frozen-lockfile install, push-only hub-drift). `/syncing-docs` 13/13 clean.
Review verdict: `code-reviewer` 1 Must-fix + 4 Should-fix → all fixed →
confirmation PASS; `security-reviewer` 2 Should-fix → both fixed → 1 residual
Should-fix found on confirmation (CSV-path limitation, non-security,
documented) → closed with a doc note + regression tests;
`silent-failure-hunter` 1 Must-fix (same as code-reviewer's) + 1 Should-fix →
both fixed.

**Known limitations, not yet closed:**

1. Carried over from PR 1 — no live Data-API-enabled Aurora cluster was
   reachable in this session either, so no verb was smoke-run end-to-end
   against real infrastructure, only against mocked `aws/rds-data` responses
   (138 tests, including adversarial security probes). This verification is
   still owed before/alongside merge.
2. New, script-specific — `output.format: csv` silently drops the value of
   any result column literally named `__proto__`/`constructor`/`prototype`.
   This is a `packages/m3l-common`-level limitation
   (`M3LCSVListExporter.resolveRow` re-materializes each row into a plain
   `{}` internally) that this script's own `Object.create(null)` fix cannot
   reach — documented in the contract page's Notes section, not fixed here.
   Confirmed non-security: RDS Data API values coerce to primitives only,
   never objects, so no re-parenting to caller-controlled data is reachable.

Skills used: starting-work, scaffolding-scripts, implementing-scripts
(self-composed — no dedicated skill file exists yet for the script pipeline
in this repo at time of writing, so the hub followed the equivalent
contract→RED→GREEN→review loop manually: `spec-conformance-reviewer` in
contract mode, `test-author`, `code-implementer`, then a
`code-reviewer`/`security-reviewer`/`silent-failure-hunter` fan-out),
syncing-docs. `creating-prs` not yet run at the time this log was written —
next step.

Spoke incidents: 3 truncations / 0 stalls / 2 resumes. Two research/contract
agents and one fix-round `code-implementer` returned mid-thought instead of
a completion report; the two writer-spoke truncations were resumed via
`SendMessage` rather than re-dispatched fresh (their exploration/edit
context was still loaded). The third truncation was a read-only research
agent with no state to lose, so it was simply re-verified against the live
repo rather than resumed.

## What went as planned

- **The contract-verification pass earned its keep at nearly PR-1 scale.**
  Dispatching `spec-conformance-reviewer` in contract mode against the
  hub-drafted contract page, before any test was written, surfaced 11
  distinct blocking ambiguities in one pass (paging offset progression, load
  column-inference identifier injection, value-coercion direction, a missing
  `input.format` parameter, `execute`'s missing `yes`/abort-code, the
  SELECT-detection heuristic's exact normalization rules, four separate
  `migrate` gaps, a wrong `withTransaction`-chaining claim, a missing
  `schema`-never-forwarded note, and an unspecified non-zero-exit
  mechanism). All 11 were closed in the doc before `test-author` ever ran —
  none surfaced later as a Phase 4 review finding, mirroring PR 1's finding
  that front-loaded contract verification prevents whole review rounds.
- **Bounded, dependency-ordered GREEN dispatches avoided the truncation
  failure mode this pipeline is documented to be vulnerable to.** The
  settings/preflight/export layer was dispatched and confirmed complete
  before the four operation steps were dispatched (since their injected-deps
  shapes depend on `RdsDataSqlSettings`'s final fields), and `run-query` +`run-load` / `run-execute`+`run-migrate` were split into two parallel,
  disjoint-file dispatches rather than one combined turn. No writer spoke in
  the RED/GREEN phases exhausted its budget before finishing its file set.
- **The hub caught its own missing-coverage gap without a reviewer flagging
  it first.** `code-implementer` correctly declined to write tests for the
  newly-introduced `build-operation-deps.ts` (a module the contract page
  never named — see divergence 1 below) per its writer-only role boundary;
  the hub noticed the resulting test-file gap directly (`10` step files vs.
  `9` test files) before dispatching review, and closed it with a dedicated
  `test-author` backfill dispatch rather than letting it reach Phase 4
  undetected.
- **Writer-role boundaries held under the same pressure PR 1 documented.**
  Across 8 separate spoke dispatches in this session, no `code-implementer`
  wrote a test file and no `test-author` wrote `src/`, even when a single
  dispatch's scope implicitly touched both (e.g. the `build-operation-deps`
  fix round explicitly told the implementer the hub was handling the doc
  fix, and it did not attempt it).

## What didn't go as planned, and why

### 1. The contract page didn't name a 9th, load-bearing step module

`resolve-settings.ts` was deliberately scoped to resolve/validate config
values only — reading `sql.file`/`migrations.dir`/`parameters.file` file
_contents_, parsing JSON, constructing `M3LCheckpointStore`/exporter/importer
ports, and schema-qualifying identifiers was explicitly left to "a later
step's job" per its own TSDoc. But the original contract page's Steps table
never named that later step. When GREEN reached the composition layer, the
hub had to design `build-operation-deps.ts` — a new, ~500-line module — on
the fly, then retroactively add it to both the contract page's Steps table
(caught by `code-reviewer`, see divergence 2) and dispatch a backfill test
suite for it.

**Why it happened:** The contract-verification pass checked per-operation
behavioral ambiguities exhaustively but didn't ask "which module does file
I/O and dependency composition, concretely?" — a question that only becomes
sharp once `resolve-settings.ts`'s narrow scope is fixed in code, not while
the page is still prose.

**Fix for future:** When a settings-resolution step is deliberately scoped to
avoid file I/O (a good pattern — keeps it synchronous/pure/easily testable),
name the composition step that performs the deferred I/O explicitly in the
contract page's Steps table from the start, even if its exact shape isn't
settled yet. A stub row ("`build-operation-deps` — TBD: composes file reads,
checkpoint/exporter/importer construction into each `run-*` step's deps
bag") would have avoided the later doc-drift correction.

### 2. Four review rounds were needed to close all Phase 4 findings, the last two adversarial

The 3-reviewer fan-out (`code-reviewer`, `security-reviewer`,
`silent-failure-hunter`) converged independently on the same Must-fix (bare
`Error` throws in `export-results.ts`'s exhaustive-switch defaults) and
raised 8 distinct Should-fix items. A single consolidated fix-round dispatch
closed all 9, but a bounded confirmation re-review (scoped only to the
changed files, per the pipeline's standard practice) found the `__proto__`
fix was incomplete: `Object.create(null)` fixed JSON/JSONL output but not
CSV, because `M3LCSVListExporter` re-materializes each row into a plain `{}`
internally — a library-level detail invisible from the script's own source.
The security-reviewer's confirmation pass executed 20+ adversarial probes
against real `dist/` output (not just read the diff) to establish this
precisely, and to rule out an actual prototype-pollution escalation. A
fourth, final round fixed the now-overclaiming code comment and added the
two missing regression tests the confirmation pass flagged (neither original
fix had one).

**Why it happened:** The `__proto__` fix was designed and verified against
the object `build-operation-deps.ts` itself constructs, which is correct —
but the fix's implicit claim ("this makes output safe") silently generalized
to a downstream consumer (`M3LCSVListExporter`) the fixing dispatch never
inspected. The security-reviewer's confirmation pass caught it only because
it re-verified the claim by executing real code against both output formats,
not by re-reading the diff.

**Fix for future:** When a fix's safety claim depends on how a _downstream_
library function consumes the fixed value (not just the value's own shape),
verify the claim against that downstream function's actual implementation,
not just against the immediate call site — the same "verify against real
dist-types before treating a contract as settled" discipline PR 1's Phase 1
step already applies to SDK behavior should extend to in-repo library
internals a fix implicitly depends on.

### 3. A fix-round dispatch's return truncated mid-list and needed a resume

The consolidated 9-item fix-round dispatch to `code-implementer` returned
after 51 tool calls with only "Item 1 done. Now item 6..." as its summary —
a mid-thought snapshot, not a completion report. The hub verified the real
state directly (`git diff` per file) rather than trusting the summary,
confirmed items 1, 4, and 6 had actually landed cleanly but items 2, 3, 5,
and 7 had not, and resumed the same spoke via `SendMessage` with the precise
gap list rather than re-dispatching fresh.

**Why it happened:** A 7-item, multi-file fix round is exactly the "size the
dispatch" scenario `implementing-scripts`/`implementing-submodules` warn
about — a large enough turn that a spoke can report progress mid-list
without ever reaching a natural stopping point to summarize from.

**Fix for future:** Nothing new here beyond re-confirming the pipeline's own
established practice: verify a writer spoke's state via `git diff`/`git
status` before trusting its return, and resume via `SendMessage` on a
concrete, itemized gap rather than re-dispatching. This session's mid-fix
truncation cost one extra round-trip, not a wasted dispatch.

## Lessons learned

- **Contract-mode verification catches ambiguity, not missing modules.** A
  spec-conformance-reviewer pass run against prose excels at finding
  under-specified _behavior_ (11 real gaps closed before RED in this
  session) but won't surface a _structural_ gap like a missing composition
  step until the settings-resolution step's own scope decision (deliberately
  deferring file I/O) is made concrete in code. Name every deferred
  responsibility's eventual home explicitly in the contract page, even as a
  placeholder, so the Steps table stays complete through implementation.
- **A fix's safety claim can implicitly depend on a downstream library
  function's internals — verify against real code, not just the immediate
  diff.** The `__proto__` fix's incomplete CSV coverage would not have
  surfaced from reading `build-operation-deps.ts` in isolation; it took
  executing both output paths against the real `M3LCSVListExporter`
  implementation. _(This generalizes PR 1's "verify against SDK dist-types"
  lesson to in-repo library internals — not promoted to a rule file this
  session since it's a single occurrence; worth promoting if it recurs.)_
- **Every fix needs a regression test, even a one-line comment/behavior
  change — a reviewer will ask for it on the confirmation pass if you
  don't.** Both the SQL-in-log-sink fix and the `__proto__` fix shipped
  without tests in their first fix round; the confirmation re-review
  flagged both gaps explicitly ("both fixes are untested, so both can
  regress silently") before the hub closed them. Building the regression
  test into the same dispatch as the fix itself, rather than treating it as
  a follow-up, would have saved one round-trip.
- **Bounded, dependency-ordered dispatch sizing continues to prevent
  truncation in RED/GREEN.** Splitting GREEN into settings-layer-first, then
  two parallel operation-step dispatches, then a final composition dispatch
  — mirroring `implementing-submodules`' "size the dispatch now" guidance —
  produced zero writer-spoke truncations across 5 RED/GREEN dispatches on a
  fairly large surface (9 step modules, 138 tests). The one truncation that
  did occur was in a later, single large 7-item fix-round dispatch, which
  reinforces rather than contradicts the lesson: split by item count as well
  as by file group when a fix round crosses roughly 5+ distinct findings.
- **Tracker status flips for a not-yet-numbered PR belong in a later,
  separate `docs:` commit, not the feature PR itself.** Investigated via
  `git log -S` rather than assumed: this repo's actual practice for prior
  2-PR chains (e.g. `eks-ops`) is to land the Deferred→Done tracker flip in
  a follow-up reconciliation commit once both PRs' real numbers are known,
  not inside the second PR (which cannot cite its own not-yet-assigned
  number). This session updated status to an honest intermediate state
  ("In review") with the wrapper's real PR number, deferring the final flip
  — matching the plan's own explicit design ("Deferred until BOTH PR1 and
  PR2 land") once the precedent was confirmed rather than guessed.
