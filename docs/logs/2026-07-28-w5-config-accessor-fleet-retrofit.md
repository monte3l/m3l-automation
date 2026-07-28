# Work log — W5 config-accessor fleet retrofit (2026-07-28)

This log covers PR 2 of a 2-PR W5 promotion: retrofitting six consumer scripts
onto `Core.M3LConfigAccessor` (`core/config`) and `Core.M3LInputFileReader`
(`core/files`), the library classes PR 1 (`c2777ac`, #260) shipped without any
adopting consumer and without updating either tracker. It records what shipped,
a real defect the hub caught by independently re-reading a spoke's diff rather
than trusting its report, and the durable lessons from both.

Plan of record: the session's approved plan file (W5 promotion PR 2 — fleet
retrofit onto `M3LConfigAccessor`/`M3LInputFileReader`), mirroring the 2-PR
chain precedent in
[`2026-07-26-w5-promote-checkpoint-store.md`](./2026-07-26-w5-promote-checkpoint-store.md).

## Summary

`docs/ROADMAP.md` § W5 and `docs/plans/IMPLEMENTATION.md` § W5 still read "no
further W5 candidate named yet" at session start, despite PR 1 (#260) having
already landed the library half three commits earlier. Auditing the actual
duplication surface found `pnpm check:dup` at 3.95%/124 clones (up from a
3.93% pre-PR-1 baseline — PR 1 only added code) across three distinct
clusters, of which the config-read/input-file-read helper family was one.

Retrofitted 6 of 13 duplicate sites — the clean 1:1 fits, verified by exact
call-site/message comparison before dispatch:

- **`eks-ops`** — `steps/config-helpers.ts` (204 lines, the file the library
  classes were promoted _from_) deleted outright.
- **`ecs-ops`**, **`cloudformation-stacks`**, **`lambda-ops`** — local helper
  functions replaced with `M3LConfigAccessor`/`M3LInputFileReader` calls,
  threaded through each file's existing `DispatchDeps`-shaped dependency
  interface (matching the pattern already used for `paths`/`logger`).
- **`codepipeline-ops`** — same, with one preserved deviation: this script
  alone carries two documented error codes
  (`ERR_CODEPIPELINE_OPS_CONFIG`/`ERR_CODEPIPELINE_OPS_INPUT`); the reader was
  constructed with the `INPUT` code specifically.
- **`s3-objects`** — partial adoption (3 of 5 local helpers; its two
  required-variant readers have no library equivalent, kept local). No
  `M3LInputFileReader` involvement — this script never reads a JSON input file.

Closed fleet-wide finding **F10** (a `JSON.parse` `SyntaxError` chained as
`cause`, leaking up to ~10 characters of malformed file content into a
persisted `run-report.json`) at all 4 confirmed sites —
`M3LInputFileReader.readJSON` deliberately never chains that cause. Also
picked up `M3LInputFileReader.asRecord`'s new prototype-pollution guard
(`isDangerousKey` screening on top-level JSON keys) at every adopting site
with a JSON input file. Explicitly left 7 sites out of scope (the `write-*.ts`
record-field reader cluster, `dynamodb-crud`/`api-gateway-client`/`sqs-etl`'s
required-variant partial fit, `athena-query`/`cloudwatch-logs-insights`/
`json-etl`'s different-shaped `as*` narrowers, and `eventbridge-schedules`'s
non-adoption) and filed each as a `Deferred` row in
`docs/plans/IMPLEMENTATION.md` § Gated library modules, rather than silently
dropping the survey work.

Tests: 10 new (2 per adopting script with a reader — F10 no-cause-chain
regression lock + prototype-pollution guard coverage — `s3-objects` needed
none, fully behavior-preserving). Full suite 5695/5695 passing (up from
5685). `pnpm check:dup` dropped from 3.95%/124 clones to **3.32%/99 clones**.
Gates clean: `typecheck`, `lint`, `build`, `check:script-deps`,
`check:script-scaffold`, `knip`, `check:doc-exports`, `check:test-counts`,
`/syncing-docs`'s full 14-step composite, `lint:md`.

Skills used: `starting-work` (plan-mode gate), `syncing-docs`,
`writing-work-logs` (this log). `/auditing` was not invoked as a slash
command — the hub ran its own fan-out survey (grep + `check:dup` + per-script
call-site reads) inline during plan mode instead, since the scope was already
narrow (one library promotion's adoption surface) rather than an open-ended
topic audit.

Spoke incidents: 1 real defect caught by independent hub re-review (not a
truncation — see divergence #1) / 0 stalls / 1 resume (`SendMessage` to the
same `code-implementer` for the fix, per the resume-don't-refork rule) / 0
truncations.

## What went as planned

- **All 6 code-implementer dispatches ran in parallel with zero file
  conflicts** — each scoped to exactly one `run-<script>.ts` (plus `eks-ops`'s
  `config-helpers.ts` deletion), verified disjoint from the write-*.ts/other
  step files before dispatch. No stray `.js`/`.js.map` artifacts landed under
  any touched `src/` tree (the exact incident PR 1's log recorded) —
  confirmed via `git status --porcelain --ignored=matching` after all 6
  completed.
- **Pre-dispatch call-site verification paid for itself.** Reading every
  script's exact `requireString`/`readJSONFile`/`asInputRecord` call sites and
  their enclosing `DispatchDeps`-threading pattern before writing the 6
  dispatch prompts meant each prompt could give exact line numbers and a
  concrete threading instruction ("add `accessor`/`reader` to the file's own
  existing dependency interface, exactly like `paths`/`logger` already are")
  instead of leaving the spoke to invent a threading approach — all 6 landed
  clean typecheck/build/lint on the first pass, no re-dispatch needed for
  structure.
- **A one-line TypeScript check upfront avoided speculative type-widening
  instructions.** Verified via an isolated `tsc --strict` scratch file that
  `Readonly<Record<string, unknown>>` structurally assigns to
  `Record<string, unknown>` in this project's compiler settings _before_
  writing the dispatch prompts — meaning the untouched `write-*.ts` files'
  `input: Record<string, unknown> | undefined` fields would accept
  `M3LInputFileReader.asRecord`'s readonly return with no changes needed. This
  held for 5 of 6 scripts exactly as predicted; one spoke (`ecs-ops`) added an
  unnecessary defensive `{ ...parsed }` copy anyway, which is harmless
  (extra allocation, not a bug) and not worth a second dispatch round to
  remove.
- **All 5 test-author dispatches were pure backfill, not fixes.** Running the
  full affected-script test suite before dispatching test-authors revealed
  every existing test already passed unchanged (the "must be valid JSON"
  assertions were substring matches tolerant of the new `(SyntaxError)`
  suffix, and `.cause` assertions only existed for the read-failure path,
  which still legitimately chains). This let every test-author prompt be
  scoped to "add 2 missing regression-coverage tests" instead of "fix N
  failing assertions" — smaller, safer, more precisely bounded dispatches.
- **The `/syncing-docs` composite entry point (`pnpm sync:docs`) passed clean
  in one run**, all 14 steps, with no manual sidecar re-stamping needed (the
  script doc pages this PR touched carry no provenance sidecars — only
  `docs/reference/{core,aws}/*.md` do).

## What didn't go as planned, and why

### 1. A dispatch instruction told a spoke to collapse a documented two-code split into one code

The hub's dispatch prompt for `codepipeline-ops` said "reuse the file's
existing error code, don't invent a new one" — correct guidance for the other
4 scripts, each of which uses exactly one `ERR_<NAME>_CONFIG` code throughout.
`codepipeline-ops` is the one script in this retrofit with **two** documented,
distinct codes (`ERR_CODEPIPELINE_OPS_CONFIG` for general config guards,
`ERR_CODEPIPELINE_OPS_INPUT` specifically for `create-pipeline`/
`update-pipeline`'s input-file failures — still used by the untouched
`write-pipeline.ts` and asserted by 8+ existing tests). The spoke followed the
instruction literally and constructed the new `M3LInputFileReader` with the
`CONFIG` code, collapsing the split: every input-file failure would have
surfaced under the wrong code, inconsistent with `write-pipeline.ts`'s own
`INPUT`-coded throws for the same operations' other input problems.

The hub caught this during a post-dispatch diff review (`git diff` +
`grep -oE "ERR_[A-Z_]+_(INPUT|CONFIG)" docs/reference/scripts/*.md`, run across
all 6 scripts specifically to check whether any other script also had a
CONFIG/INPUT split before trusting the "single code" pattern) — not from a
test failure, since no test in this retrofit exercised both codes together in
a way that would have caught the collapse (the existing tests only assert
`code` for their own operation's path, which still resolved to a plausible,
just-wrong, code). Fixed by resuming the same spoke via `SendMessage` with the
exact line and the one-line fix, rather than re-dispatching fresh or
patching it directly from the hub.

**Why it happened:** The hub wrote one shared dispatch-prompt template (5 of 6
scripts fit a single-code pattern) and applied it to the 6th without
re-verifying the assumption held for that specific script — the codebase
survey that found the CONFIG/INPUT split (via `docs/reference/scripts/*.md`)
happened only _after_ dispatch, as part of the standard post-dispatch review,
not before.

**Fix for future:** When templating N near-identical dispatch prompts from one
pattern, explicitly re-verify the pattern's key assumption (here: "one error
code per script") against each individual target's docs/tests _before_
dispatch, not just after — a per-script one-line grep
(`grep -oE "ERR_<PREFIX>_[A-Z_]+" docs/reference/scripts/<name>.md`) would have
caught this before the spoke ever ran. Absent that, independently re-reading
every spoke's diff against its own script's documented contract (not just
running the gates) remains the backstop that actually caught it here.

## Lessons learned

- **A shared dispatch-prompt pattern needs a per-target assumption check, not
  just a per-target file-list check.** Templating prompts across N similar
  targets is efficient, but the template's implicit assumptions (here: "one
  error code per script") can be false for one target even when true for the
  rest — verify the assumption itself against each target's own docs/tests
  before dispatch, the same rigor already applied to file scoping.
  _(promoted → .claude/rules/subagent-dispatch.md)_
- **Independently re-reading a spoke's diff against the _documented contract_
  (not just the gates) catches defects gates can't.** `typecheck`/`lint`/
  `build` all passed clean on the codepipeline-ops error-code collapse — it
  was a semantically wrong but syntactically valid code string. Only a
  targeted `grep` against the reference docs' documented error-code inventory
  surfaced it. This is a concrete instance of the general "never trust a
  spoke's report at face value" rule — here applied to _correctness_, not
  truncation.
- **Running the affected test suite before dispatching test-authors turns "fix
  broken tests" into "add missing coverage."** Confirming all existing tests
  already passed (substring/partial assertions tolerant of the message-format
  delta) let every test-author dispatch be scoped to pure backfill instead of
  repair — smaller diffs, lower risk, and no ambiguity about whether a
  changed assertion was intentional or accidental.
- **A quick isolated `tsc --strict` scratch check on a specific type-assignability
  question is cheap insurance before writing N dispatch prompts that all
  depend on the answer.** One 30-second check (`Readonly<Record<string,
unknown>>` → `Record<string, unknown>` assignability) let every dispatch
  prompt state a settled fact ("no downstream type-widening needed") instead
  of hedging with "widen if the compiler complains," which would have invited
  6 independent, possibly-inconsistent workarounds.
- **Surveying out-of-scope duplication clusters and filing them as tracker
  rows — instead of silently dropping the survey — keeps a future promotion
  pass from re-deriving the same scope analysis.** The 4 new `Deferred` rows
  in `IMPLEMENTATION.md` (write-*.ts record-field readers, Tier B required
  variants, Tier C narrowers, `eventbridge-schedules`'s non-adoption reason)
  convert one session's `check:dup`/grep survey into durable, actionable
  backlog rather than conversation-only context that evaporates at session
  end.
