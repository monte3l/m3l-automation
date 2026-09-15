# Should-fix backlog sweep

## Context

`docs/logs/2026-09-07-should-fix-backfill.md` recorded the historical measurement taken
when ADR-0097's Should-fix acknowledgment gate shipped: of 831 merged PRs, **361** posted a
`claude[bot]` Should-fix finding and carry no `Acknowledged-Should-Fix:` footer (206
`merged-unresolved`, 154 `multi-round-suppressed`, 1 `resolve-commit-heuristic`, #955). That
log recorded PR numbers only — the finding text itself was never persisted, so nobody knew
_what_ those 361 PRs were told to fix, only _that_ they were told something.

This document is the resolution of that backlog. Since the PRs are already merged and
squashed, a retroactive `Acknowledged-Should-Fix:` footer is impossible — the gate only runs
on open PRs. "Resolution" here means: re-fetch every finding from GitHub, re-assess each one
against the current state of the codebase (HEAD, not the PR's diff), record every
disposition durably, and fix what is still genuinely open. This document **is** the bulk
acknowledgment the footer mechanism cannot express retroactively.

## Methodology

**Extraction (Stage 1).** A throwaway scratchpad script (`extract-findings.mjs`, not
committed — see "Method limits" below for why) read the 361 PR numbers directly out of the
backfill log, then for each PR fetched every `claude[bot]` review comment over the REST API
with pagination (`gh api repos/monte3l/m3l-automation/issues/<N>/comments --paginate`,
6-worker pool with retry/backoff). REST's bot login (`claude[bot]`) differs from GraphQL's
(`claude`) — a documented trap from `docs/logs/2026-09-07-should-fix-ack-gate-wave.md` § 3.

Each PR's comments were walked round-by-round by hand, reusing `bin/lib/pr-review-gate.mjs`'s
primitives (`parseVerdict`, `parseShouldFixSection`, `countShouldFixFindings`,
`parseReviewedSha`) as building blocks rather than relying solely on its
`collectShouldFixRounds` helper, which silently drops any round whose section parses to
`count === 0` (a suppressed-round comment with no column-zero bullet to count). Walking every
round by hand — including suppressed rounds — was necessary because the convergence-
suppression rule (post Must-fix only, count fresh Should-fix without re-posting them) means a
PR's _first_ round rarely holds all its Should-fix content; PR #425's rounds 1–4, for
example, each posted distinct fresh bullets (2, 3, 3, 5), several explicitly marked "carried
forward from rounds 1–3, unchanged."

Each bullet's anchor was extracted from its bold lead (``- **`path:line`** — prose``) with
a fallback scan of the full bullet body, requiring a `/` in any candidate path to avoid
mistaking a bare prose filename (e.g. `orchestrator-cancel.ts` mid-sentence) for a real
anchor. Bullets with no path-shaped match at all were kept as **class findings** (prose names
multiple instances/locations, or the finding is about the merged commit's message/type
itself) rather than discarded.

Merge-commit resolution tried both eras (squash: `git log --grep="(#<N>)"`; older
merge-commit: `git log --grep="^Merge pull request #<N> from"`), and re-ran the
acknowledgment check against the _merged_ commits' messages for merge-commit-era PRs — a
correction the original backfill's classification could only run one way.

**Deduplication and clustering (Stage 2).** Three collapse passes:

- **L1 — intra-PR carry-forward collapse.** Key: `${pr}::${anchorPath}` (or a
  class-finding's token-set key). Bullets from the _same round_ never merge — verified
  against a real counterexample: PR #25 round 1 posted three genuinely distinct findings all
  anchored at `packages/m3l-common/tests/environment.test.ts` (an EACCES path, a `CI === "1"`
  equality gap, a legacy env-var signal), which a naive same-round `pr::path` key would have
  silently collapsed into one. Bullets from _different_ rounds merge when token-Jaccard ≥
  0.45 or the bullet claims to carry forward from a prior round.
- **L2 — cross-PR exact duplicate.** Key: `${anchorPath}::${hash(sortedTokens)}` — the same
  defect flagged independently on two different PRs touching the same file.
- **L3 — theme cluster**, matched against an 11-pattern rubric (`missing-test-coverage`,
  `doc-comment-inaccuracy`, `silent-cap-truncation`, `unvalidated-input`, `weak-type`,
  `error-swallowed`, `drift-hardcoded-count`, `export-untested`, `unreachable-arg`,
  `live-repo-pinned-test`, `other`) — the unit this ledger's Landing plan slices by.

A mechanical pre-filter then ran per L1-collapsed finding: anchor-dead-at-HEAD detection
(with rename-following via `git log --name-status -M90% --diff-filter=RD`), whole-unit-
removed check, and line-region survival (`git log -L<line>,<line>:<path>`) to flag whether a
finding's line number is still trustworthy. This pruned very little (12 of 884, 1.4% —
see "Method limits") but repaired several anchors and flagged ~19% of survivors as
line-drifted.

935 raw bullets across 361 PRs collapsed to **884 distinct findings**.

**Verification (Stage 3).** 851 of the 884 findings (everything with a real anchor) were
batched by directory/unit into 66 groups of ≤14 findings / ≤8 files each, and each batch was
handed to a read-only Explore agent with a fixed prompt contract: read-only, no fixes, cite
`file:line` at HEAD for every `still-open`/`resolved` verdict, and — for the dominant
`missing-test-coverage` theme specifically — treat "no test covers X" as `still-open` unless
a specific covering test can be cited, never as `cannot-determine` by default. Every batch's
report was validated against the dispatch manifest (every id returned, every claim cited) via
a small parser before being accepted; batches that hit their turn budget or dropped/
misattributed an id were re-dispatched with the same finding set until clean.

The remaining 21 anchor-less **class findings** (prose naming several instances, or
describing a merged commit's message-type mislabeling) were hand-triaged by the hub directly
against HEAD, since batching by anchor doesn't apply to them.

**Slicing (Stage 5 basis).** Still-open findings were grouped by `(unit, theme)`, then each
group over the ADR-0072 cap (≤8 findings per PR) was further split by anchor path, keeping
same-file findings together to minimize files touched per PR. This produced the 146-row
Landing plan below.

## Backfill corrections

**None found.** The Stage 1 extraction recorded zero parse anomalies and zero PRs where the
merge-commit-era acknowledgment recheck flipped a PR's classification (`ackFooterNowFound`
was false for all 361). The original backfill's classification of these 361 PRs as
unacknowledged stands unchanged; the `†`-truncation flag in the original log (95 of 361, from
the GraphQL 100-item cap) did not produce any classification errors once re-fetched over
paginated REST — every truncated PR's full comment history was consistent with its original
category.

## Results

| Metric                                                   | Count   |
| -------------------------------------------------------- | ------- |
| PRs swept                                                | 361     |
| Raw bullets extracted (Stage 1)                          | 935     |
| Distinct findings after dedup (Stage 2)                  | 884     |
| — mechanically moot (pre-filter)                         | 12      |
| — sent to Explore verification fan-out                   | 851     |
| — hand-triaged by hub (anchor-less class findings)       | 21      |
| **Still-open**                                           | **614** |
| Resolved (HEAD no longer exhibits it)                    | 193     |
| Moot (construct/commit no longer exists or is unfixable) | 45      |
| Cannot-determine (declared unknown)                      | 32      |

**Cross-tab by the finding's originating round verdict** (PASS = no Must-fix that round, FAIL
= a Must-fix was also posted that round) — testing the "PASS-branch structural silence"
hypothesis from `docs/logs/2026-09-07-should-fix-ack-gate-wave.md` against real data:

| Round verdict | Still-open | Resolved | Moot | Cannot-determine | Still-open rate |
| ------------- | ---------- | -------- | ---- | ---------------- | --------------- |
| PASS          | 486        | 114      | 33   | 26               | 74%             |
| FAIL          | 128        | 79       | 12   | 6                | 57%             |

The hypothesis holds: a Should-fix posted alongside a passing verdict (nothing forcing the
author back into the code before merge) is meaningfully _more_ likely to still be open today
than one posted alongside a Must-fix that blocked the same round.

## Theme ledger

Full disposition breakdown by theme:

| Theme                  | Total | Still-open | Resolved | Moot | Cannot-determine |
| ---------------------- | ----- | ---------- | -------- | ---- | ---------------- |
| missing-test-coverage  | 329   | 221        | 75       | 16   | 17               |
| other                  | 196   | 136        | 43       | 12   | 5                |
| doc-comment-inaccuracy | 129   | 92         | 30       | 6    | 1                |
| silent-cap-truncation  | 100   | 68         | 23       | 6    | 3                |
| unvalidated-input      | 51    | 39         | 9        | 2    | 1                |
| weak-type              | 28    | 22         | 5        | 1    | 0                |
| error-swallowed        | 20    | 17         | 2        | 1    | 0                |
| drift-hardcoded-count  | 17    | 14         | 1        | 1    | 1                |
| export-untested        | 11    | 4          | 4        | 0    | 3                |
| unreachable-arg        | 1     | 1          | 0        | 0    | 0                |
| live-repo-pinned-test  | 2     | 0          | 1        | 0    | 1                |

## Unit distribution (still-open only)

Still-open findings by top-level unit — this is what Stage 5's ordering follows (`bin/` and
`bin/lib/` first, smallest blast radius, then `packages/m3l-common/src`, then `scripts/*/src`,
then everything else):

| Unit                               | Still-open findings |
| ---------------------------------- | ------------------- |
| `bin`                              | 191                 |
| `packages/m3l-common`              | 113                 |
| `packages/m3l-console-server`      | 70                  |
| `.claude`                          | 46                  |
| `packages/m3l-cli`                 | 43                  |
| `docs`                             | 42                  |
| `packages/m3l-console-web`         | 21                  |
| `.github`                          | 13                  |
| `scripts/agent-operator`           | 10                  |
| `scripts/eks-ops`                  | 8                   |
| `scripts/rds-data-sql`             | 7                   |
| `scripts/sqs-dead-letter-triage`   | 7                   |
| `scripts/cloudwatch-logs-insights` | 6                   |
| `scripts/cloudformation-stacks`    | 4                   |
| `CLASS`                            | 4                   |
| `scripts/cloudwatch-logs-analysis` | 4                   |
| `scripts/dynamodb-crud`            | 4                   |
| `scripts/json-etl`                 | 3                   |
| `scripts/sqs-etl`                  | 3                   |
| `scripts/api-gateway-client`       | 3                   |
| `scripts/ecs-ops`                  | 3                   |
| `scripts/eventbridge-schedules`    | 2                   |
| `scripts/athena-query`             | 2                   |
| `templates`                        | 2                   |
| `scripts/s3-objects`               | 1                   |
| `scripts/lambda-ops`               | 1                   |
| `scripts/codepipeline-ops`         | 1                   |

## Findings ledger

The full 884-row findings ledger — one row per distinct finding with its id, source PR(s)
and round(s), anchor, theme, verdict, confidence, current location, evidence, and (for
still-open findings) an assigned fix slice — lives as a sibling data file rather than inline,
per this document's own size-note precedent (`docs/logs/README.md`'s ~53 KB is the current
largest-doc precedent; this table alone would run several times that):

- [`data/2026-09-15-should-fix-backlog-sweep-findings.json`](./data/2026-09-15-should-fix-backlog-sweep-findings.json) —
  the 884-row findings ledger.
- [`data/2026-09-15-should-fix-backlog-sweep-slices.json`](./data/2026-09-15-should-fix-backlog-sweep-slices.json) —
  the 146-row slice-to-finding-id mapping backing the Landing plan table below.

Both files are `docs/**` and therefore outside the automated PR reviewer's remit
(`bin/lib/pr-diff-filter.mjs`'s gate rule) — they do not count against any PR's reviewable
size.

Each still-open finding's row is updated to `Fixed (PR #N)` as its assigned slice's fix PR
merges (see Landing plan).

## Declared unknowns

32 findings are genuinely indeterminate from the repository alone — never guessed away, kept
as declared unknowns rather than forced into a verdict. Most are cases where the original
finding's own line-number anchor had drifted enough (or referenced content since restructured
under a different name) that a verifying agent could not confidently relocate the exact claim
within its turn budget, and a second independent read was not run mainly because it does not
change what to do next (no fix is proposed here — these need a human or a fresh dedicated
read if this backlog is ever revisited):

| Finding | Source PR | Anchor | Why indeterminate                                                                                                                                       |
| ------- | --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SF-0130 | 288       |        | Located the file and line, but without reading the full TSDoc blocks and comparing against the other script files mentioned (cloudformation-stacks, co  |
| SF-0134 | 289       |        | Finding references documentation about shell-expanded placeholders and $API_BASE_URL examples, but would require reading the full README sections to v  |
| SF-0164 | 316       |        | Finding references TSDoc claims about rmSync cleanup behavior and M3LHttpClient error events, plus unspecified "four documented-but-untested branches"  |
| SF-0167 | 317       |        | Finding references config row export bookkeeping for M3LConfigHelpFormatter, M3LUnknownParameterSuggestion, M3LUnknownParameterSuggestOptions, but wou  |
| SF-0176 | 323       |        | Finding describes concatenated narratives in the clients row but would require reading the full row text to verify whether it still contains two conse  |
| SF-0186 | 330       |        | Finding references coverage claims on isCheckpointEnvelope and specific uncovered branches, but would require reading the full row and examining the a  |
| SF-0240 | 463       |        | The finding describes hardcoded wait literals at run-cloudformation-stacks.ts:504-509, but the current code structure shows operation names only in th  |
| SF-0244 | 464       |        | The finding references a broken cross-reference from "`{ processed, failed }` (see Error codes)" but the current documentation at docs/reference/scrip  |
| SF-0269 | 499       |        | The finding references a performance trial comparing control (ubuntu-latest) vs arm (ubuntu-24.04-arm) legs. However, comments at lines 190-194 on the  |
| SF-0321 | 595       |        | The usage comment at lines 20-27 documents `--retype-closed` and the runClosedRetype function is exported (line 792), but the main CLI dispatcher (pro  |
| SF-0328 | 599       |        | The finding references line 234 (which is in viewColumns function), but describes a "no board with this title" path that should be in resolveBoardId.   |
| SF-0331 | 599       |        | The finding references line 283 in check-hub-views.mjs, but my reading ends at line 300. The specific "no board with this title" path and its scope-er  |
| SF-0335 | 604       |        | listTrackedFiles is exported at line 53-55 but the test file (bin/tests/control-char-scan.test.ts) was not provided for review. Cannot verify whether   |
| SF-0346 | 633       |        | Finding's anchorLine 231 is marked lineIntact: false, indicating the line region is stale. The file at packages/m3l-common/tests/run-report-secrets.te  |
| SF-0359 | 649       |        | The finding references a test at line 154 using `execFileSync` to test check-review-size.mjs, but no such test exists in the current file at that line  |
| SF-0360 | 650       |        | Finding's anchorLine 538 does not exist in the current file (total 391 lines), and lineIntact: null indicates the line may have drifted. The finding d  |
| SF-0372 | 657       |        | The finding references a TSDoc claiming `requires("yesSensitive", "yes")` is used, but the actual source file was not read to verify the misdescriptio  |
| SF-0506 | 719       |        | ERR_CONSOLE_RUN_TRANSITION_INVALID is classified as origin: "library", fault: true, but the error code itself is never raised anywhere in the producti  |
| SF-0507 | 719       |        | Same as SF-0506: ERR_CONSOLE_RUN_TRANSITION_INVALID is never raised in the codebase, only defined. The classification's correctness cannot be determin  |
| SF-0573 | 743       |        | The write at line 347 `parameters[binding.parameterName] = ...` still uses a plain object literal with a caller-controlled key. The finding cites rout  |
| SF-0615 | 778       |        | The finding references `readDecisionLogEntries` at line 291, but this function does not exist in the current codebase. A search across all agent-opera  |
| SF-0616 | 778       |        | The finding references health-check tests at run-agent-operator.test.ts:320 claiming real filesystem I/O through `mkdtemp`/`readdir`/`readFile`, but t  |
| SF-0676 | 851       |        | Line 149 splits entry.matcher by "\|", so an empty string matcher would produce [""], which is not in knownMatchers. However, I did not locate or run a |
| SF-0677 | 853       |        | resolveAuditPort function exists and has the wrapping branch (options.audit !== undefined → indexHumanActionAuditPort), but would require reading test  |
| SF-0678 | 853       |        | Finding references composition-root wiring at audit: store.audit and options.auditPort precedence, but would require reading the full test files to ve  |
| SF-0713 | 892       |        | The finding references `formatWeeklyReset` at line 306, but searching the current codebase shows no function with that name. The function exists as `f  |
| SF-0727 | 905       |        | Finding references @example blocks that import validateResumeRecord and readFlowRunRecord from "@m3l-automation/m3l-common/core", but would require re  |
| SF-0728 | 905       |        | Finding references validateResumeRecord as a new exported function and claims it lacks direct happy/failure tests in flow-record.test.ts, gaining only  |
| SF-0779 | 951       |        | The finding references line 583 and claims the file header contains contradictory comments about "RED phase: `retryAttempts` does not exist yet" (line  |
| SF-0797 | 971       |        | The finding references line 920 containing a `describe` header stating modules "do not exist yet — every import below is expected to fail to resolve",  |
| SF-0818 | 992       |        | The SIDECAR_CASES array at lines 476-505 has four rows varying sidecar existence. Row 1 and 2 distinguish `EIO` from `ESTALE` but comment notes that `  |
| SF-0874 | 1071      |        | The finding references line 329 of bin/lib/doc-provenance.mjs, but the anchored file is beyond the scope I read (lines 1-231). The parallel `trackedFi  |

## Method limits

- **The mechanical pre-filter's pruning power is near zero.** 12 of 884 findings (1.4%) were
  mechanically moot — far below what an initial sample suggested. `bin/`-heavy content
  churns constantly; a finding's anchor file being touched since merge is the norm, not the
  exception. The pre-filter's real value was anchor-rename repair and line-drift flagging,
  not volume reduction.
- **Line numbers were already unreliable at authoring time.** Several findings' own anchors
  moved across their own PR's rounds (one sampled finding moved `:90 → :108 → :91` within a
  single PR). Every verifying agent was instructed to treat the line as a hint, never ground
  truth, and to locate by symbol/prose when `lineIntact` was false.
- **Symbol-grep is structurally blind to the dominant theme.** A "no test covers X" finding
  has no symbol to search for at all — the absence of code is the point. This is why the
  Explore prompt contract explicitly forbade defaulting to `cannot-determine` for that theme;
  absence of a covering test is itself the evidence.
- **The extraction script is not committed.** `extract-findings.mjs`,
  `dedup-cluster.mjs`, and the batch-building scripts were scratchpad throwaways per the
  maintainer's own scoping decision for this sweep — the _recipe_ above is the durable
  artifact, not the code. Re-running this sweep against a later backfill would need the
  recipe re-implemented, not a stored script re-run.
- **This sweep does not re-scan the other 470 merged PRs** the original backfill classified
  as `no-should-fix` or `review-excluded`. If those categories later prove to have their own
  error rate, a symmetric re-scan is a legitimate follow-up, not something folded in here.

## Landing plan

146 fix-PR slices, grouped by `(unit, theme)` and split further where a group exceeded the
ADR-0072 cap (≤8 findings per PR), sorted `bin/` → `packages/m3l-common/src` → `scripts/*/src`
→ everything else. Each slice's finding-id list is in
[`data/2026-09-15-should-fix-backlog-sweep-slices.json`](./data/2026-09-15-should-fix-backlog-sweep-slices.json).
Routing follows `bin/lib/protected-paths.mjs`: `packages/*/src/**` and `scripts/*/src/**`
go through the `code-implementer` spoke, any `tests/**` segment through `test-author`;
`bin/**`, `docs/**`, `.claude/**`, `.github/**`, and root config are hub-direct (though
`bin/**` routes through `code-implementer` anyway for review consistency).

| Slice  | Branch                                                                   | Scope                                                                       | Status |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------ |
| SL-001 | `fix/should-fix-bin-doc-comment-inaccuracy-1`                            | bin — doc-comment-inaccuracy (7 findings, part 1/4)                         | To Do  |
| SL-002 | `fix/should-fix-bin-doc-comment-inaccuracy-2`                            | bin — doc-comment-inaccuracy (7 findings, part 2/4)                         | To Do  |
| SL-003 | `fix/should-fix-bin-doc-comment-inaccuracy-3`                            | bin — doc-comment-inaccuracy (7 findings, part 3/4)                         | To Do  |
| SL-004 | `fix/should-fix-bin-doc-comment-inaccuracy-4`                            | bin — doc-comment-inaccuracy (5 findings, part 4/4)                         | To Do  |
| SL-005 | `fix/should-fix-bin-drift-hardcoded-count`                               | bin — drift-hardcoded-count (4 findings)                                    | To Do  |
| SL-006 | `fix/should-fix-bin-error-swallowed-1`                                   | bin — error-swallowed (5 findings, part 1/2)                                | To Do  |
| SL-007 | `fix/should-fix-bin-error-swallowed-2`                                   | bin — error-swallowed (5 findings, part 2/2)                                | To Do  |
| SL-008 | `fix/should-fix-bin-export-untested`                                     | bin — export-untested (1 finding)                                           | To Do  |
| SL-009 | `fix/should-fix-bin-missing-test-coverage-1`                             | bin — missing-test-coverage (8 findings, part 1/8)                          | To Do  |
| SL-010 | `fix/should-fix-bin-missing-test-coverage-2`                             | bin — missing-test-coverage (8 findings, part 2/8)                          | To Do  |
| SL-011 | `fix/should-fix-bin-missing-test-coverage-3`                             | bin — missing-test-coverage (8 findings, part 3/8)                          | To Do  |
| SL-012 | `fix/should-fix-bin-missing-test-coverage-4`                             | bin — missing-test-coverage (8 findings, part 4/8)                          | To Do  |
| SL-013 | `fix/should-fix-bin-missing-test-coverage-5`                             | bin — missing-test-coverage (8 findings, part 5/8)                          | To Do  |
| SL-014 | `fix/should-fix-bin-missing-test-coverage-6`                             | bin — missing-test-coverage (8 findings, part 6/8)                          | To Do  |
| SL-015 | `fix/should-fix-bin-missing-test-coverage-7`                             | bin — missing-test-coverage (8 findings, part 7/8)                          | To Do  |
| SL-016 | `fix/should-fix-bin-missing-test-coverage-8`                             | bin — missing-test-coverage (1 finding, part 8/8)                           | To Do  |
| SL-017 | `fix/should-fix-bin-other-1`                                             | bin — other (7 findings, part 1/7)                                          | To Do  |
| SL-018 | `fix/should-fix-bin-other-2`                                             | bin — other (7 findings, part 2/7)                                          | To Do  |
| SL-019 | `fix/should-fix-bin-other-3`                                             | bin — other (7 findings, part 3/7)                                          | To Do  |
| SL-020 | `fix/should-fix-bin-other-4`                                             | bin — other (7 findings, part 4/7)                                          | To Do  |
| SL-021 | `fix/should-fix-bin-other-5`                                             | bin — other (7 findings, part 5/7)                                          | To Do  |
| SL-022 | `fix/should-fix-bin-other-6`                                             | bin — other (7 findings, part 6/7)                                          | To Do  |
| SL-023 | `fix/should-fix-bin-other-7`                                             | bin — other (7 findings, part 7/7)                                          | To Do  |
| SL-024 | `fix/should-fix-bin-silent-cap-truncation-1`                             | bin — silent-cap-truncation (7 findings, part 1/4)                          | To Do  |
| SL-025 | `fix/should-fix-bin-silent-cap-truncation-2`                             | bin — silent-cap-truncation (7 findings, part 2/4)                          | To Do  |
| SL-026 | `fix/should-fix-bin-silent-cap-truncation-3`                             | bin — silent-cap-truncation (7 findings, part 3/4)                          | To Do  |
| SL-027 | `fix/should-fix-bin-silent-cap-truncation-4`                             | bin — silent-cap-truncation (5 findings, part 4/4)                          | To Do  |
| SL-028 | `fix/should-fix-bin-unvalidated-input-1`                                 | bin — unvalidated-input (6 findings, part 1/2)                              | To Do  |
| SL-029 | `fix/should-fix-bin-unvalidated-input-2`                                 | bin — unvalidated-input (5 findings, part 2/2)                              | To Do  |
| SL-030 | `fix/should-fix-bin-weak-type`                                           | bin — weak-type (7 findings)                                                | To Do  |
| SL-031 | `fix/should-fix-packages-m3l-common-doc-comment-inaccuracy-1`            | packages/m3l-common — doc-comment-inaccuracy (7 findings, part 1/2)         | To Do  |
| SL-032 | `fix/should-fix-packages-m3l-common-doc-comment-inaccuracy-2`            | packages/m3l-common — doc-comment-inaccuracy (6 findings, part 2/2)         | To Do  |
| SL-033 | `fix/should-fix-packages-m3l-common-error-swallowed`                     | packages/m3l-common — error-swallowed (4 findings)                          | To Do  |
| SL-034 | `fix/should-fix-packages-m3l-common-export-untested`                     | packages/m3l-common — export-untested (2 findings)                          | To Do  |
| SL-035 | `fix/should-fix-packages-m3l-common-missing-test-coverage-1`             | packages/m3l-common — missing-test-coverage (8 findings, part 1/7)          | To Do  |
| SL-036 | `fix/should-fix-packages-m3l-common-missing-test-coverage-2`             | packages/m3l-common — missing-test-coverage (8 findings, part 2/7)          | To Do  |
| SL-037 | `fix/should-fix-packages-m3l-common-missing-test-coverage-3`             | packages/m3l-common — missing-test-coverage (8 findings, part 3/7)          | To Do  |
| SL-038 | `fix/should-fix-packages-m3l-common-missing-test-coverage-4`             | packages/m3l-common — missing-test-coverage (8 findings, part 4/7)          | To Do  |
| SL-039 | `fix/should-fix-packages-m3l-common-missing-test-coverage-5`             | packages/m3l-common — missing-test-coverage (8 findings, part 5/7)          | To Do  |
| SL-040 | `fix/should-fix-packages-m3l-common-missing-test-coverage-6`             | packages/m3l-common — missing-test-coverage (8 findings, part 6/7)          | To Do  |
| SL-041 | `fix/should-fix-packages-m3l-common-missing-test-coverage-7`             | packages/m3l-common — missing-test-coverage (6 findings, part 7/7)          | To Do  |
| SL-042 | `fix/should-fix-packages-m3l-common-other-1`                             | packages/m3l-common — other (6 findings, part 1/2)                          | To Do  |
| SL-043 | `fix/should-fix-packages-m3l-common-other-2`                             | packages/m3l-common — other (5 findings, part 2/2)                          | To Do  |
| SL-044 | `fix/should-fix-packages-m3l-common-silent-cap-truncation-1`             | packages/m3l-common — silent-cap-truncation (7 findings, part 1/2)          | To Do  |
| SL-045 | `fix/should-fix-packages-m3l-common-silent-cap-truncation-2`             | packages/m3l-common — silent-cap-truncation (7 findings, part 2/2)          | To Do  |
| SL-046 | `fix/should-fix-packages-m3l-common-unvalidated-input-1`                 | packages/m3l-common — unvalidated-input (5 findings, part 1/2)              | To Do  |
| SL-047 | `fix/should-fix-packages-m3l-common-unvalidated-input-2`                 | packages/m3l-common — unvalidated-input (5 findings, part 2/2)              | To Do  |
| SL-048 | `fix/should-fix-packages-m3l-common-weak-type`                           | packages/m3l-common — weak-type (5 findings)                                | To Do  |
| SL-049 | `fix/should-fix-scripts-agent-operator-doc-comment-inaccuracy`           | scripts/agent-operator — doc-comment-inaccuracy (2 findings)                | To Do  |
| SL-050 | `fix/should-fix-scripts-agent-operator-missing-test-coverage`            | scripts/agent-operator — missing-test-coverage (6 findings)                 | To Do  |
| SL-051 | `fix/should-fix-scripts-agent-operator-other`                            | scripts/agent-operator — other (1 finding)                                  | To Do  |
| SL-052 | `fix/should-fix-scripts-agent-operator-silent-cap-truncation`            | scripts/agent-operator — silent-cap-truncation (1 finding)                  | To Do  |
| SL-053 | `fix/should-fix-scripts-api-gateway-client-missing-test-coverage`        | scripts/api-gateway-client — missing-test-coverage (1 finding)              | To Do  |
| SL-054 | `fix/should-fix-scripts-api-gateway-client-silent-cap-truncation`        | scripts/api-gateway-client — silent-cap-truncation (1 finding)              | To Do  |
| SL-055 | `fix/should-fix-scripts-api-gateway-client-unvalidated-input`            | scripts/api-gateway-client — unvalidated-input (1 finding)                  | To Do  |
| SL-056 | `fix/should-fix-scripts-athena-query-missing-test-coverage`              | scripts/athena-query — missing-test-coverage (1 finding)                    | To Do  |
| SL-057 | `fix/should-fix-scripts-athena-query-other`                              | scripts/athena-query — other (1 finding)                                    | To Do  |
| SL-058 | `fix/should-fix-scripts-cloudformation-stacks-drift-hardcoded-count`     | scripts/cloudformation-stacks — drift-hardcoded-count (1 finding)           | To Do  |
| SL-059 | `fix/should-fix-scripts-cloudformation-stacks-missing-test-coverage`     | scripts/cloudformation-stacks — missing-test-coverage (2 findings)          | To Do  |
| SL-060 | `fix/should-fix-scripts-cloudformation-stacks-unreachable-arg`           | scripts/cloudformation-stacks — unreachable-arg (1 finding)                 | To Do  |
| SL-061 | `fix/should-fix-scripts-cloudwatch-logs-analysis-missing-test-coverage`  | scripts/cloudwatch-logs-analysis — missing-test-coverage (2 findings)       | To Do  |
| SL-062 | `fix/should-fix-scripts-cloudwatch-logs-analysis-other`                  | scripts/cloudwatch-logs-analysis — other (1 finding)                        | To Do  |
| SL-063 | `fix/should-fix-scripts-cloudwatch-logs-analysis-unvalidated-input`      | scripts/cloudwatch-logs-analysis — unvalidated-input (1 finding)            | To Do  |
| SL-064 | `fix/should-fix-scripts-cloudwatch-logs-insights-doc-comment-inaccuracy` | scripts/cloudwatch-logs-insights — doc-comment-inaccuracy (2 findings)      | To Do  |
| SL-065 | `fix/should-fix-scripts-cloudwatch-logs-insights-missing-test-coverage`  | scripts/cloudwatch-logs-insights — missing-test-coverage (4 findings)       | To Do  |
| SL-066 | `fix/should-fix-scripts-codepipeline-ops-missing-test-coverage`          | scripts/codepipeline-ops — missing-test-coverage (1 finding)                | To Do  |
| SL-067 | `fix/should-fix-scripts-dynamodb-crud-missing-test-coverage`             | scripts/dynamodb-crud — missing-test-coverage (3 findings)                  | To Do  |
| SL-068 | `fix/should-fix-scripts-dynamodb-crud-other`                             | scripts/dynamodb-crud — other (1 finding)                                   | To Do  |
| SL-069 | `fix/should-fix-scripts-ecs-ops-doc-comment-inaccuracy`                  | scripts/ecs-ops — doc-comment-inaccuracy (1 finding)                        | To Do  |
| SL-070 | `fix/should-fix-scripts-ecs-ops-missing-test-coverage`                   | scripts/ecs-ops — missing-test-coverage (2 findings)                        | To Do  |
| SL-071 | `fix/should-fix-scripts-eks-ops-doc-comment-inaccuracy`                  | scripts/eks-ops — doc-comment-inaccuracy (5 findings)                       | To Do  |
| SL-072 | `fix/should-fix-scripts-eks-ops-missing-test-coverage`                   | scripts/eks-ops — missing-test-coverage (2 findings)                        | To Do  |
| SL-073 | `fix/should-fix-scripts-eks-ops-silent-cap-truncation`                   | scripts/eks-ops — silent-cap-truncation (1 finding)                         | To Do  |
| SL-074 | `fix/should-fix-scripts-eventbridge-schedules-doc-comment-inaccuracy`    | scripts/eventbridge-schedules — doc-comment-inaccuracy (1 finding)          | To Do  |
| SL-075 | `fix/should-fix-scripts-eventbridge-schedules-missing-test-coverage`     | scripts/eventbridge-schedules — missing-test-coverage (1 finding)           | To Do  |
| SL-076 | `fix/should-fix-scripts-json-etl-doc-comment-inaccuracy`                 | scripts/json-etl — doc-comment-inaccuracy (1 finding)                       | To Do  |
| SL-077 | `fix/should-fix-scripts-json-etl-missing-test-coverage`                  | scripts/json-etl — missing-test-coverage (1 finding)                        | To Do  |
| SL-078 | `fix/should-fix-scripts-json-etl-silent-cap-truncation`                  | scripts/json-etl — silent-cap-truncation (1 finding)                        | To Do  |
| SL-079 | `fix/should-fix-scripts-lambda-ops-missing-test-coverage`                | scripts/lambda-ops — missing-test-coverage (1 finding)                      | To Do  |
| SL-080 | `fix/should-fix-scripts-rds-data-sql-doc-comment-inaccuracy`             | scripts/rds-data-sql — doc-comment-inaccuracy (1 finding)                   | To Do  |
| SL-081 | `fix/should-fix-scripts-rds-data-sql-missing-test-coverage`              | scripts/rds-data-sql — missing-test-coverage (4 findings)                   | To Do  |
| SL-082 | `fix/should-fix-scripts-rds-data-sql-other`                              | scripts/rds-data-sql — other (2 findings)                                   | To Do  |
| SL-083 | `fix/should-fix-scripts-s3-objects-other`                                | scripts/s3-objects — other (1 finding)                                      | To Do  |
| SL-084 | `fix/should-fix-scripts-sqs-dead-letter-triage-missing-test-coverage`    | scripts/sqs-dead-letter-triage — missing-test-coverage (3 findings)         | To Do  |
| SL-085 | `fix/should-fix-scripts-sqs-dead-letter-triage-other`                    | scripts/sqs-dead-letter-triage — other (2 findings)                         | To Do  |
| SL-086 | `fix/should-fix-scripts-sqs-dead-letter-triage-silent-cap-truncation`    | scripts/sqs-dead-letter-triage — silent-cap-truncation (1 finding)          | To Do  |
| SL-087 | `fix/should-fix-scripts-sqs-dead-letter-triage-unvalidated-input`        | scripts/sqs-dead-letter-triage — unvalidated-input (1 finding)              | To Do  |
| SL-088 | `fix/should-fix-scripts-sqs-etl-missing-test-coverage`                   | scripts/sqs-etl — missing-test-coverage (2 findings)                        | To Do  |
| SL-089 | `fix/should-fix-scripts-sqs-etl-other`                                   | scripts/sqs-etl — other (1 finding)                                         | To Do  |
| SL-090 | `fix/should-fix-packages-m3l-cli-doc-comment-inaccuracy`                 | packages/m3l-cli — doc-comment-inaccuracy (4 findings)                      | To Do  |
| SL-091 | `fix/should-fix-packages-m3l-cli-drift-hardcoded-count`                  | packages/m3l-cli — drift-hardcoded-count (2 findings)                       | To Do  |
| SL-092 | `fix/should-fix-packages-m3l-cli-missing-test-coverage-1`                | packages/m3l-cli — missing-test-coverage (6 findings, part 1/3)             | To Do  |
| SL-093 | `fix/should-fix-packages-m3l-cli-missing-test-coverage-2`                | packages/m3l-cli — missing-test-coverage (6 findings, part 2/3)             | To Do  |
| SL-094 | `fix/should-fix-packages-m3l-cli-missing-test-coverage-3`                | packages/m3l-cli — missing-test-coverage (6 findings, part 3/3)             | To Do  |
| SL-095 | `fix/should-fix-packages-m3l-cli-other-1`                                | packages/m3l-cli — other (5 findings, part 1/2)                             | To Do  |
| SL-096 | `fix/should-fix-packages-m3l-cli-other-2`                                | packages/m3l-cli — other (5 findings, part 2/2)                             | To Do  |
| SL-097 | `fix/should-fix-packages-m3l-cli-silent-cap-truncation`                  | packages/m3l-cli — silent-cap-truncation (5 findings)                       | To Do  |
| SL-098 | `fix/should-fix-packages-m3l-cli-unvalidated-input`                      | packages/m3l-cli — unvalidated-input (2 findings)                           | To Do  |
| SL-099 | `fix/should-fix-packages-m3l-cli-weak-type`                              | packages/m3l-cli — weak-type (2 findings)                                   | To Do  |
| SL-100 | `fix/should-fix-packages-m3l-console-server-doc-comment-inaccuracy-1`    | packages/m3l-console-server — doc-comment-inaccuracy (6 findings, part 1/2) | To Do  |
| SL-101 | `fix/should-fix-packages-m3l-console-server-doc-comment-inaccuracy-2`    | packages/m3l-console-server — doc-comment-inaccuracy (6 findings, part 2/2) | To Do  |
| SL-102 | `fix/should-fix-packages-m3l-console-server-drift-hardcoded-count`       | packages/m3l-console-server — drift-hardcoded-count (1 finding)             | To Do  |
| SL-103 | `fix/should-fix-packages-m3l-console-server-missing-test-coverage-1`     | packages/m3l-console-server — missing-test-coverage (7 findings, part 1/4)  | To Do  |
| SL-104 | `fix/should-fix-packages-m3l-console-server-missing-test-coverage-2`     | packages/m3l-console-server — missing-test-coverage (7 findings, part 2/4)  | To Do  |
| SL-105 | `fix/should-fix-packages-m3l-console-server-missing-test-coverage-3`     | packages/m3l-console-server — missing-test-coverage (7 findings, part 3/4)  | To Do  |
| SL-106 | `fix/should-fix-packages-m3l-console-server-missing-test-coverage-4`     | packages/m3l-console-server — missing-test-coverage (5 findings, part 4/4)  | To Do  |
| SL-107 | `fix/should-fix-packages-m3l-console-server-other-1`                     | packages/m3l-console-server — other (8 findings, part 1/2)                  | To Do  |
| SL-108 | `fix/should-fix-packages-m3l-console-server-other-2`                     | packages/m3l-console-server — other (8 findings, part 2/2)                  | To Do  |
| SL-109 | `fix/should-fix-packages-m3l-console-server-silent-cap-truncation-1`     | packages/m3l-console-server — silent-cap-truncation (6 findings, part 1/2)  | To Do  |
| SL-110 | `fix/should-fix-packages-m3l-console-server-silent-cap-truncation-2`     | packages/m3l-console-server — silent-cap-truncation (6 findings, part 2/2)  | To Do  |
| SL-111 | `fix/should-fix-packages-m3l-console-server-unvalidated-input`           | packages/m3l-console-server — unvalidated-input (1 finding)                 | To Do  |
| SL-112 | `fix/should-fix-packages-m3l-console-server-weak-type`                   | packages/m3l-console-server — weak-type (2 findings)                        | To Do  |
| SL-113 | `fix/should-fix-packages-m3l-console-web-doc-comment-inaccuracy`         | packages/m3l-console-web — doc-comment-inaccuracy (7 findings)              | To Do  |
| SL-114 | `fix/should-fix-packages-m3l-console-web-missing-test-coverage`          | packages/m3l-console-web — missing-test-coverage (4 findings)               | To Do  |
| SL-115 | `fix/should-fix-packages-m3l-console-web-other`                          | packages/m3l-console-web — other (3 findings)                               | To Do  |
| SL-116 | `fix/should-fix-packages-m3l-console-web-unvalidated-input`              | packages/m3l-console-web — unvalidated-input (4 findings)                   | To Do  |
| SL-117 | `fix/should-fix-packages-m3l-console-web-weak-type`                      | packages/m3l-console-web — weak-type (3 findings)                           | To Do  |
| SL-118 | `fix/should-fix-claude-doc-comment-inaccuracy`                           | .claude — doc-comment-inaccuracy (1 finding)                                | To Do  |
| SL-119 | `fix/should-fix-claude-error-swallowed`                                  | .claude — error-swallowed (1 finding)                                       | To Do  |
| SL-120 | `fix/should-fix-claude-export-untested`                                  | .claude — export-untested (1 finding)                                       | To Do  |
| SL-121 | `fix/should-fix-claude-missing-test-coverage-1`                          | .claude — missing-test-coverage (5 findings, part 1/2)                      | To Do  |
| SL-122 | `fix/should-fix-claude-missing-test-coverage-2`                          | .claude — missing-test-coverage (5 findings, part 2/2)                      | To Do  |
| SL-123 | `fix/should-fix-claude-other-1`                                          | .claude — other (7 findings, part 1/3)                                      | To Do  |
| SL-124 | `fix/should-fix-claude-other-2`                                          | .claude — other (7 findings, part 2/3)                                      | To Do  |
| SL-125 | `fix/should-fix-claude-other-3`                                          | .claude — other (7 findings, part 3/3)                                      | To Do  |
| SL-126 | `fix/should-fix-claude-silent-cap-truncation`                            | .claude — silent-cap-truncation (3 findings)                                | To Do  |
| SL-127 | `fix/should-fix-claude-unvalidated-input`                                | .claude — unvalidated-input (6 findings)                                    | To Do  |
| SL-128 | `fix/should-fix-claude-weak-type`                                        | .claude — weak-type (3 findings)                                            | To Do  |
| SL-129 | `fix/should-fix-github-doc-comment-inaccuracy`                           | .github — doc-comment-inaccuracy (4 findings)                               | To Do  |
| SL-130 | `fix/should-fix-github-drift-hardcoded-count`                            | .github — drift-hardcoded-count (1 finding)                                 | To Do  |
| SL-131 | `fix/should-fix-github-missing-test-coverage`                            | .github — missing-test-coverage (4 findings)                                | To Do  |
| SL-132 | `fix/should-fix-github-other`                                            | .github — other (3 findings)                                                | To Do  |
| SL-133 | `fix/should-fix-github-silent-cap-truncation`                            | .github — silent-cap-truncation (1 finding)                                 | To Do  |
| SL-134 | `fix/should-fix-class-missing-test-coverage`                             | CLASS — missing-test-coverage (1 finding)                                   | To Do  |
| SL-135 | `fix/should-fix-class-other`                                             | CLASS — other (1 finding)                                                   | To Do  |
| SL-136 | `fix/should-fix-class-silent-cap-truncation`                             | CLASS — silent-cap-truncation (2 findings)                                  | To Do  |
| SL-137 | `fix/should-fix-docs-doc-comment-inaccuracy-1`                           | docs — doc-comment-inaccuracy (6 findings, part 1/2)                        | To Do  |
| SL-138 | `fix/should-fix-docs-doc-comment-inaccuracy-2`                           | docs — doc-comment-inaccuracy (6 findings, part 2/2)                        | To Do  |
| SL-139 | `fix/should-fix-docs-drift-hardcoded-count`                              | docs — drift-hardcoded-count (5 findings)                                   | To Do  |
| SL-140 | `fix/should-fix-docs-error-swallowed`                                    | docs — error-swallowed (2 findings)                                         | To Do  |
| SL-141 | `fix/should-fix-docs-missing-test-coverage-1`                            | docs — missing-test-coverage (5 findings, part 1/2)                         | To Do  |
| SL-142 | `fix/should-fix-docs-missing-test-coverage-2`                            | docs — missing-test-coverage (4 findings, part 2/2)                         | To Do  |
| SL-143 | `fix/should-fix-docs-other-1`                                            | docs — other (6 findings, part 1/2)                                         | To Do  |
| SL-144 | `fix/should-fix-docs-other-2`                                            | docs — other (6 findings, part 2/2)                                         | To Do  |
| SL-145 | `fix/should-fix-docs-unvalidated-input`                                  | docs — unvalidated-input (2 findings)                                       | To Do  |
| SL-146 | `fix/should-fix-templates-missing-test-coverage`                         | templates — missing-test-coverage (2 findings)                              | To Do  |
