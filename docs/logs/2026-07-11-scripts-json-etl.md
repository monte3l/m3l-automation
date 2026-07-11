# Work log — `json-etl` consumer script (2026-07-11)

W1 of the consumer-fleet program — the **first real end-to-end consumer** of
`@m3l-automation/m3l-common`. json-etl reads a JSON/NDJSON file, extracts an
ordered set of fields, filters, optionally sorts and limits, and exports to
json/jsonl/csv/html over the library's streaming importer/exporter. It ran
through the `scaffolding-scripts` → `implementing-scripts` pipeline
(starting-work → scaffold → contract-first → RED → GREEN → 3-spoke review →
smoke run → docs). This log records what shipped, what matched the plan, the
divergences (writer-spoke truncation, a preset gap found late), and — most
importantly, as the **F4-loop's first entry** — the library-friction backlog
this first consumer produced.

Plan of record:
[`docs/plans/2026-07-09-consumer-scripts-implementation-plan.md`](../plans/archive/2026-07-09-consumer-scripts-implementation-plan.md)
(§4).

## Summary

Two signed commits on `feat/script-json-etl`: `95de1fc`
(`chore(scripts)`: scaffold) and `b687675` (`feat(scripts)`: implementation).

- **`scripts/json-etl/`** — 5 injected-deps step modules (`import-records`,
  `extract-fields`, `filter-records`, `export-results`, `run-json-etl`) plus
  `config.ts` (8 `M3LConfigParameter`s), `hooks.ts` (per-run `correlationId`
  capture), and a pure `main.ts` composition root. Pipeline: import →
  extract (core/json `extractAll`, array-index + wildcard paths) → filter (7
  ops, `parseLocaleNumber` numerics) → optional sort + limit → export to
  json/jsonl/csv/html via the streaming `importStream()` / `exportStream()`
  APIs.
- **Hardening from review:** filter-rule values (`gt`/`lt` literal, `regex`)
  validated at parse time; `sort⇒limit` and required-presence guarded at run
  start; `input`/`output` paths contained within their `M3LPaths` base dirs;
  malformed JSONL lines skipped, counted (via the importer's `import:error`
  event), and logged per-line + in the run summary; a malformed whole-document
  array aborts with `ERR_IMPORT_PARSE`.
- **Tests:** 7 files, **65 tests**. All gates green — `lint`, `typecheck`,
  `build`, `knip`, `check:script-scaffold` (1 script conforms), `gen:index` (1
  consumer script), `lint:md`, `format:check`.
- **Two example presets** under `data/config/presets/` (`report.yaml` +
  `report-active.yaml` with `extends`).
- **Review verdicts (3-spoke):** `code-reviewer` — 2 Must-fix (a real lint
  failure in a test; a contract documenting not-yet-existing presets), fixed;
  `security-reviewer` — no Must-fix, 2 Should-fix (path traversal, regex
  compile-at-parse), fixed; `silent-failure-hunter` — 1 HIGH (`gt`/`lt` literal
  validated too late → silent empty output) + 2 MEDIUM, fixed.
- **Smoke-verified live** (not just mocked): a fixture NDJSON with a malformed
  line produced an ordered CSV — archived record filtered out, malformed line
  skipped (`"skipped malformed record at index 2"`), rows sorted by `id`, and
  the run's `correlationId` logged.

## What went as planned

- **The improved template paid off immediately.** The scaffold's `main.ts`
  injected `config` into the starter step out of the box (the §1.6 chore, PR
  #98), so the composition-root shape needed no correction.
- **Contract-first prevented drift.** Authoring `docs/reference/scripts/json-etl.md`
  before RED, then extracting the exact contract, gave the writer spokes an
  unambiguous target across a large library surface.
- **Streaming APIs were all present** — `importStream()`, `exportStream()` →
  `append()`/`close()`, `extractAll`, `parseLocaleNumber` — no library gap
  blocked the pipeline.
- **RED failed for the right reason** (missing step modules; config still the
  1-param stub), and the **live smoke run worked on the first try** after GREEN.
- **The adversarial reviews earned their cost** — the security refute pass and
  silent-failure hunt each found a real, shippable-looking boundary gap.

## What didn't go as planned, and why

### 1. Both writer spokes truncated mid-thought; the test-author wrote nothing on its first pass

The `test-author`'s first run burned its **entire** budget (150k tokens, 55 tool
uses) on exploration + planning and wrote **zero** files, returning a truncated
`"Now the config module —"`. I caught it by checking the tree
(`git status` showed only the unmodified scaffold `config.test.ts`) rather than
trusting the summary, then **resumed the same spoke** via `SendMessage`
("stop exploring, WRITE the 6 files now from your journal plan"). The
`code-implementer` also truncated twice (`"Both green. Now typecheck"`). Every
time, I verified via `git status` + a real `vitest` run before proceeding.

**Why it happened:** a large multi-file script (6 test files, 8 source modules)
over a big library surface tempts a spoke into exhaustive up-front reading; the
budget runs out before any file is written, and the harness returns a
mid-thought.

**Fix for future:** instruct writer spokes on large scripts to **write all files
first (even terse), then refine**, and to cap exploration — a written-but-terse
file beats an unwritten perfect one. And always verify the tree + run tests
yourself; never trust a truncated spoke summary.

### 2. The preset mechanism doesn't work, discovered only at doc-writing time

`code-reviewer` flagged the contract page documenting preset files that didn't
exist. I created `report.yaml`/`report-active.yaml` — then, writing the README
`--preset` example, discovered `M3LScript` **cannot load them**:
`M3LScriptConfigLoader` wires only the CLI and environment providers, and
`M3LScriptOptions` exposes no seam to inject a loaded preset. So the plan's §1.4
"job definitions = presets + CLI overrides" design does not actually function.
I removed the `--preset` examples and reframed both the README and contract to
state the gap, keeping the presets as format/inheritance examples.

**Why it happened:** the preset **loader** (`M3LScriptPresetLoader`) ships and is
documented, so it looked wired; nobody had run a preset end-to-end through a
real script before (json-etl is the first consumer).

**Fix for future:** verify a documented runtime flag/mechanism works
**end-to-end** before shipping the doc that describes it — don't infer "wired"
from "the utility exists." This is exactly the class of gap the F4 loop exists
to surface.

## Lessons learned

- **Write-first for large multi-file spokes.** Tell a `test-author` /
  `code-implementer` handling many files to write every file (terse) before
  refining, and to cap exploration; a truncated spoke that wrote nothing costs a
  full resume round. Always verify with `git status` + `vitest`, never the
  summary. _(reinforces verify-spoke-completion; promoted → `.claude/agents/test-author.md`)_
- **The contract-extraction spoke earns its cost on library-heavy scripts.**
  Front-loading an exhaustive API-signature contract (it also surfaced 7 of the 8
  friction items up front) kept the implementer from drifting on each API
  mismatch. Worth running whenever a script consumes a wide library surface.
- **Verify a documented mechanism end-to-end before documenting it.** "The
  utility exists and is exported" ≠ "the feature is wired." Run it once; the
  preset gap proves a loader can ship fully documented yet be unreachable from
  the surface that's supposed to use it.
- **First-consumer smoke runs are the real acceptance.** The mocked step tests
  were all green, but only the live CLI run confirmed extraction + filter + sort
  - CSV column order + skip-counting + correlationId compose correctly.

## Library friction (the F4 backlog)

The core deliverable of the first consumer. Each item is tagged **1.x additive**
(a backward-compatible library addition), **2.0 evidence** (a design change that
would break the API — collect, don't act), or **D4** (a new module candidate).

- **F1 — no cross-parameter validator (1.x additive).** `M3LConfigValidators`
  are per-parameter, single-value; `sort⇒limit` and required-presence had to be
  imperative run-start guards in `run-json-etl`. Candidate: a cross-field
  validation seam, or a `required: true` flag on `M3LConfigParameter`.
- **F2 — no `nonEmpty` validator (1.x additive).** Only `range`/`regex`/`oneOf`
  ship; `input`/`fields`/`output` non-emptiness are hand-written inline
  validators. Candidate: add `nonEmpty` / `minLength` to `M3LConfigValidators`.
- **F3 — `run(mainFn)` passes no context (2.0 evidence).** `correlationId` is
  reachable only via an `onBeforeRun` hook captured into a holder. Passing a
  `ctx` to `mainFn` would break the signature — collect as 2.0 evidence.
- **F4 — `M3LScript` hides its `M3LPaths` (1.x additive).** `paths` is private
  with no getter, so every script constructs its own `new M3LPaths()`.
  Candidate: a public `script.paths` / `getPaths()`.
- **F5 — `M3LPaths` has no file-resolve helper (1.x additive).** Only directory
  getters exist; the script joins names itself and must add its own containment
  check. Candidate: `resolveInput(name)` / `resolveOutput(name)` that join
  **and** contain within the base dir.
- **F6 — skip count only via events (1.x additive).** `importStream()` doesn't
  return a skip count; it comes only through the `import:error` event
  (`skipped = processed − yielded`). Candidate: surface a running/final skip
  count from the stream.
- **F7 — malformed array aborts, only JSONL is tolerant (ties to deferred
  W0-L1).** A corrupt whole-document JSON array throws `ERR_IMPORT_PARSE`; the
  `onUnknownFormat: "skip"` mode deferred in W0-L1 would let an irregular array
  degrade per-record. A second consumer demanding it schedules that work.
- **F8 — presets can't drive a run (1.x additive / D4, HIGH).**
  `M3LScriptPresetLoader` loads YAML/JSON presets with `extends` inheritance,
  but `M3LScriptConfigLoader` wires only CLI + environment providers and
  `M3LScriptOptions` has no seam to inject a loaded preset. So a named preset
  cannot drive a script's config end-to-end — the §1.4 preset design is
  non-functional. **Highest-priority item:** every later script wants presets,
  so this satisfies the ADR-0021 D4 intake gate by construction (a named
  consumer call-site already exists).
