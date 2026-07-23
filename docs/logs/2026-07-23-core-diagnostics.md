# Work log — `core/diagnostics` submodule (2026-07-23)

Covers ADR-0035 **phase 1** — the `core/diagnostics` submodule plus the
`core/errors` code catalog — built through the `starting-work` →
`implementing-submodules` → `syncing-docs` → `creating-prs` pipeline and landed
as PR #212 (commits `9859868` + `4d51793`). It records what shipped, what
matched the plan, and — the substance of this log — why four consecutive
adversarial security reviews each found new leaks, what that revealed about the
difference between allowlist and denylist redaction, and how the impasse was
resolved by reclassifying the artifact rather than re-patching the redactor.

ADR-0035 is the plan of record; no dated plan file was created (the ADR is the
plan, matching the `aws/cloudwatch-logs-insights` precedent under ADR-0027).

## Summary

**Shipped.** `core/diagnostics` with 27 public exports — `M3L_EXIT_CODES` /
`M3LExitCode` / `M3LErrorExitCode` / `mapErrorToExitCode` / `isM3LErrorOrigin`,
`formatErrorChain` / `serializeErrorChain` / `scrubUrlsInText` /
`M3LSerializedError` / `M3LFormatErrorChainOptions`, `M3LBreadcrumbTrail` and
its five supporting types, `collectDiagnostics` with the structural ports and
snapshot types, and `M3LRunReport` / `M3LRunReporter` with their input and
options types. Plus 6 exports in `core/errors` from the new `catalog.ts`
(`M3LErrorOrigin`, `M3LErrorRetryable`, `M3LErrorClassification`,
`M3L_ERROR_CATALOG`, `classifyErrorCode`, `isM3LErrorCode`). `runScript` is
phase 4 and deliberately absent.

**Verification.** 128 module tests, 4362 workspace-wide; `pnpm test:coverage`
exit 0 with `run-report.ts` at 98.54 % statements / 98.10 % branches / 100 %
functions / 98.9 % lines and the rest of `core/diagnostics` ≥ 96 %. All of
`format:check`, `lint`, `typecheck`, `build`, `check:exports`, `knip`,
`check:api`, `check:zones`, `check:agents`, `check:hooks`, `check:deps`,
`check:doc-exports`, `check:test-counts`, `check:index`, `check:provenance`,
and `lint:md` pass; `sync:docs` green across all 14 steps. The `exports` map is
unchanged — no semver event. `docs/implementation-status.md` moves to **31 of
31** submodules.

**Review verdicts.** Six-spoke fan-out: `code-reviewer` (pure modules) PASS, 0
Must-fix; `code-reviewer` (stateful) PASS, 0 Must-fix; `spec-conformance-reviewer`
conformant, 0 missing / 0 drifted, and it produced the authoritative
27-undocumented-export list the doc work ran on; `security-reviewer` PASS with
reservations, 2 escalated to Must-fix; `silent-failure-hunter` 0 Must-fix by its
own grading, 1 escalated; `type-design-analyzer` **CHANGES REQUESTED**, 1
Must-fix + 7 Should-fix. Then **four** adversarial `security-reviewer` refute
passes, all four of which succeeded — see divergence 1.

**Skills used:** `starting-work`, `implementing-submodules`, `syncing-docs`,
`creating-prs`, `writing-work-logs`.

**Spoke incidents:** 33 spokes dispatched / 13 truncations / 0 stalls / 5
`SendMessage` resumes.

## What went as planned

- **RED failed for the right reason in both halves.** Splitting the test phase
  across two files (`diagnostics.test.ts`, `diagnostics-run-report.test.ts`)
  let two `test-author` spokes run in parallel with no write conflict, and both
  failed on `Cannot find module`, not on test-logic errors.
- **The structural-port design held under review.** Two independent reviewers
  confirmed `M3LConfigSchema` / `M3LConfig` satisfy `M3LConfigSchemaPort` /
  `M3LConfigSourcePort` with zero adaptation and no change to `core/config` —
  the load-bearing assumption of the whole Zone B workaround, confirmed by
  reviewers who were not told the answer.
- **The dependency gate was a genuine no-op.** Everything composed existing
  seams (`core/errors`, `core/logging` redaction, `core/utils`, `node:*`), so
  the module ships dep-free.
- **Two reviewers converged independently** on the unchecked
  `as Record<string, unknown>` in `M3LSerializedError.context` and on the
  anonymous `{ getOutputDir(): string }` port duplicating `M3LPathsPort`.
  Convergence from differently-scoped reviewers raised confidence in both.
- **Doc reconciliation was mechanical once the export list was final.**
  Deliberately deferring all reference-page writing until after the fix rounds
  avoided rewriting the 27-export list twice — the fix rounds added five more
  public exports and reshaped `M3LRunReport`.

## What didn't go as planned, and why

### 1. Four consecutive adversarial reviews each found new secret leaks; six confirmatory reviewers had found none

The six-spoke review fan-out returned PASS or near-PASS across the board. Four
subsequent `security-reviewer` runs in **refute mode** — each told to assume the
surface was unsafe and to _execute_ rather than read — found ten confirmed
secret leaks into `run-report.json`, every one demonstrated by reading bytes
back off disk: cyclic values bypassing redaction entirely through a `RangeError`
fallback; raw URLs in error `message` / `stack` / `context`; `errorMessage`
reinstating the very URL its sibling `url` field had just sanitized; own-property
`toJSON` output never reaching the redactor; uppercase `HTTPS://` bypassing a
case-sensitive scrubber; `Map` / `Set` contents losing their key names; an
unterminated quote stranding a secret outside the match; a presigned S3 URL
untouched in `archive`; and object **keys** never scrubbed at all while the same
URL as a _value_ scrubbed correctly.

**Why it happened:** a confirmatory reviewer checks whether the code does what
it claims. Every one of these leaks required constructing an input the author
had not imagined and running it. The first security pass earned its two findings
by empirically exercising the redactor rather than reading its regexes — which
is exactly why it found anything at all — but even it reasoned about the code
under review rather than attacking it.

**Fix for future:** for any surface whose job is to prevent something (secrets
reaching a sink, traversal, injection), a confirmatory PASS is not evidence.
Budget an adversarial refute pass that must produce a working exploit or admit
failure, and require it to execute against built output. The
`implementing-submodules` skill already mandates this for `aws/**` and
redaction surfaces; this run is the evidence for why it is not optional.

### 2. Denylist redaction over free text never converged — and three of four fix rounds introduced regressions

Round 1 fixed four leaks; round 2 found two more, one of which was a
**regression created by round 1** (the cycle-breaking pre-pass converted `Map`
to `[[k,v]]`, so `apiKey` became an array element and `isSensitiveKey` stopped
firing — the old order had leaked nothing). Round 3 found two more plus an
uncatchable OOM. Round 4's regex rewrite **reopened** `?X-Amz-Signature=<value>`
by removing a branch, and made an unterminated quote swallow a following URL to
end-of-string. Each rewrite of `URL_PATTERN` broke a case its predecessor
handled.

**Why it happened:** a regex plus heuristic key-name matching is a denylist
against an unbounded input space. Patching individual bypasses cannot converge,
and each patch changed behavior the previous tests did not pin.

**Fix for future:** classify a redaction surface before building it. If the
input is bounded and enumerable, allowlist it. If it is free text, do not
promise a guarantee — change the artifact's classification instead. Never
iterate a regex toward a security guarantee.

### 3. A `code-implementer` spoke burned 106 k tokens and wrote nothing

The first consolidated fix round handed one spoke ten findings across four
files. It truncated mid-exploration; its journal read `Status: starting,
reading files` and `git status` showed zero source changes.

**Why it happened:** dispatch sized by _finding count_ rather than by _file_.
Ten items across four files meant the spoke had to load four files' full
context before it could safely edit any of them.

**Fix for future:** size fix-round dispatches by file, not by finding count —
one spoke per file (or tight file group), every item for that file in one
prompt. Re-dispatched that way, the same ten findings landed across three
parallel spokes with no truncation loss.

### 4. A missing barrel export survived a fully green test suite

`GREEN part A` updated `core/index.ts`'s `@packageDocumentation` comment to
mention `diagnostics` but never added
`export * from "./diagnostics/index.js";`. All 80 of its tests passed. Nothing
in `core/diagnostics` was reachable as `Core.*` from the package entry point.

**Why it happened:** every test in the repo imports source files by direct path
(`../src/core/diagnostics/exit-codes.js`), so no test can observe that the
_namespace_ re-export is broken. `tests/index.test.ts` asserted only
`typeof m3l.Core === "object"` — a proxy assertion.

**Fix for future:** `tests/index.test.ts` now carries a table-driven
reachability check naming one load-bearing symbol per submodule barrel, so a
dropped `export *` line fails loudly. Caught here only by a manual `grep`
during disk verification.

### 5. A fix silently neutered two regression tests, and the spoke caught the hub's error

Projecting `archive` to the `M3LFileCopyReport` shape meant non-conforming data
is dropped before `sanitizeValue` ever runs. The hub instructed a `test-author`
to "keep the two round-4 lock-ins that still apply to `archive`". The spoke
determined that the OOM and cycle-detection lock-ins would be silently disabled
there — a fan-out shape has no `results` / `summary`, so it never reaches the
traversal those tests guard — moved them to `environment`, and flagged the
discrepancy rather than complying.

**Why it happened:** the hub reasoned about which tests still _passed_ rather
than which still _could fail_.

**Fix for future:** when a fix narrows what a field accepts, audit every test
that used that field as a vehicle. A test that can no longer fail is worse than
no test, because it reads as coverage.

### 6. Three fix rounds shipped TSDoc claims that were false

Round 3's `sanitizeValue` doc claimed the pre-pass "materializes any own- or
prototype-level `toJSON` output … so a `toJSON` that would otherwise return an
unredacted secret cannot survive". `safeJsonStringify` never invokes `toJSON`;
the real effect is the inverse — it expands a class that uses `toJSON()` as its
redaction boundary. Round 4's doc certified that a stranded-value defect "cannot
recur"; it recurred immediately via unterminated quotes. `scrubUrlsInText`'s own
TSDoc instructed callers into the ordering the same file documented as "strictly
worse".

**Why it happened:** the claims were written from the _fix instruction_, not
from probing the resulting behavior. The hub repeated one of them to the user
for the same reason — the observation (no leak) was correct, the mechanism given
for it was not.

**Fix for future:** a TSDoc sentence asserting a security property is a claim
that needs the same verification as a test. Probe the built output before
writing it, and prefer under-claiming.

## Lessons learned

- **Adversarial beats confirmatory for prevention surfaces** — six specialist
  reviewers found zero of ten leaks; four refute-mode reviewers found all ten by
  executing against built `dist/`. For any code whose purpose is to _prevent_
  something, a PASS from a reviewer checking "does it do what it claims" carries
  almost no information. _(promoted → `.claude/agents/security-reviewer.md`)_

- **Allowlist, never denylist, for a security boundary** — across four
  adversarial rounds every allowlisted surface (breadcrumb summarizers, source
  labels, set cardinality, the projected archive) leaked nothing, while the
  denylist (URL regex + key-name heuristics) failed every round and regressed
  three times. If the input is enumerable, enumerate it; if it is free text,
  do not promise a guarantee. _(promoted → `.claude/rules/library-src.md`)_

- **Reclassify the artifact when the guarantee can't be met** — the impasse
  broke by recognizing `run-report.json` as a crash dump. Crash dumps are
  sensitive by nature; the error was the sharing contract in
  `troubleshooting.md`, not the redaction quality. Reclassifying dropped the
  redactor's job from "must be perfect" to "defense in depth", which is what it
  actually is.

- **Verify spoke output on disk; never trust the report** — 13 of 33 spokes
  truncated mid-sentence. In every case the disk state differed from the
  report: usually further along, once catastrophically behind (zero files
  written), and once _wrong in a way the passing suite could not see_. Read
  `git status`, `grep` for the specific symbol, and run the gate yourself.

- **Size fix dispatches by file, not by finding count** — ten findings across
  four files produced a spoke that wrote nothing across 106 k tokens; the same
  ten split one-spoke-per-file landed cleanly in parallel.

- **A green suite can hide a broken public surface** — tests importing `src/`
  paths directly cannot observe a broken namespace barrel. Assert reachability
  through the package entry point explicitly. _(promoted → `.claude/rules/tests.md`)_

- **Every fix round needs a full regression sweep, not just its own cases** —
  three of four rounds broke something a previous round had fixed. Re-probe all
  prior vectors after each round; two regressions were caught only that way.

- **TSDoc asserting a security property is a claim, not prose** — three rounds
  shipped false ones, and a false mechanism in a doc propagates into the next
  round's reasoning. Probe before writing; under-claim by default.
