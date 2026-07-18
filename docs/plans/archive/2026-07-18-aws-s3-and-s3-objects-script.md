# `aws/s3` wrapper + `s3-objects` script (2026-07-18)

**Status: shipped** — PR 1 (`feat/aws-s3`, `aws/s3`) merged as
[#160](https://github.com/monte3l/m3l-automation/pull/160); PR 2
(`feat/s3-objects`, the consumer script) in this change set

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` + `docs/plans/
IMPLEMENTATION.md` targeting `s3-objects`, the first W3 consumer script. The
gate's exploration step found the trackers' phrasing — "existing getters ✓;
thin op-dispatch" — didn't hold: the `s3` getter on `AWSClientProvider`
returns a **raw `S3Client`**, and dispatching a single S3 operation requires
constructing an `@aws-sdk/client-s3` command object, which ADR-0027/ADR-0029
forbid inside `scripts/*/src`. `s3-objects` had nothing library-side to call.
This reshaped scope into a 2-PR chain — a new `aws/s3` operations wrapper
first, then the script — the same pattern `api-gateway-client`/`aws/signing`
and `athena-query`/`aws/athena` had already set (see the rows above).

## Approach / Decisions

- **PR 1 — `aws/s3` library submodule (ADR-0033):** built in a new linked
  worktree (`m3l-automation-aws-s3`, branch `feat/aws-s3`) via the full
  `scaffolding-submodules` → `implementing-submodules` pipeline. Seven free
  functions (`listObjects`/`headObject`/`getObject`/`putObject`/
  `copyObject`/`deleteObject`/`deleteObjects`) mirroring `aws/dynamodb`'s
  shape — no class facade, unlike `aws/sqs`'s `M3LSQSOperations`. A
  `silent-failure-hunter` review caught a real correctness bug: `headObject`'s
  not-found detection originally fell back to a bare HTTP-404 check, which
  would have silently mislabeled a `NoSuchBucket` misconfiguration as "object
  doesn't exist"; narrowed to the modeled `NotFound` SDK exception name only.
  A `syncing-docs` pass surfaced a real latent tooling bug:
  `parseImplementationStatus()`'s name-validation regex excluded any digit,
  silently dropping "s3"
  (the first ADR-0028-compliant digit-bearing submodule name) from every doc
  count; fixed and regression-tested. 36 tests, 100% coverage on
  `operations.ts`/`error.ts`. Full detail: `docs/logs/2026-07-18-aws-s3.md`.
- **PR 2 — `s3-objects` script:** built in a second linked worktree
  (`m3l-automation-s3-objects`, branch `feat/s3-objects`, created off
  `origin/main` only after PR 1 merged) via `scaffolding-scripts` →
  `implementing-scripts`. Seven-operation op-dispatch (`list`/`describe`/
  `get`/`put`/`copy`/`delete`/`delete-batch`) over `aws/s3`'s free functions
  via `script.aws.clients.s3` (a raw `S3Client`), destructive gate covering
  `put`/`copy`/`delete`/`delete-batch`.
- **Contract-extraction-before-RED, done deliberately.** Before dispatching
  `test-author`, `spec-conformance-reviewer` ran in CONTRACT mode against the
  hub's own first-draft contract page and surfaced 5 real ambiguities
  (unspecified not-found handling, run-summary shape, `failed.jsonl` record
  shape, no error-code family, unspecified gate-decline behavior) — all
  closed by amending the doc with a new "Behavioral contract" section before
  any test was written, rather than letting downstream spokes guess
  divergently.
- **3-reviewer convergence.** `code-reviewer`, `security-reviewer`, and
  `silent-failure-hunter` — dispatched independently, no cross-visibility —
  all separately flagged the identical bug: `single-object-ops.ts` left local
  `readFile`/`writeFile` errors unwrapped, inconsistent with its sibling
  steps. `silent-failure-hunter` additionally found `delete-batch.ts` was
  silently discarding already-accumulated progress when a later chunk's
  `AWS.deleteObjects` call rejected outright (distinct from the normal
  per-key-errors partial-failure path). Both closed in one fix round; 10 new
  failure-path tests followed (92 → 102). Full detail:
  `docs/logs/2026-07-18-s3-objects.md`.
- **Rebase conflicts on PR 2.** `origin/main` advanced 6 commits during the
  session (`aws/lambda` + `lambda-ops` scaffold, `aws/eventbridge`,
  `aws/athena`, misc docs). Conflicts: `tsconfig.json` (adjacent
  project-reference entries — union), `docs/reference/README.md`'s generated
  consumer-scripts catalog (adjacent table rows — union), and a real same-row
  collision in `docs/ROADMAP.md`/`docs/plans/IMPLEMENTATION.md`'s W3
  section — both branches had independently edited the same bundled W3
  entry. Resolved deliberately rather than picking a side: verified against
  the actual landed state (`aws/lambda`/`aws/eventbridge` were done as
  library wrappers, but `lambda-ops` was scaffold-only and
  `eventbridge-schedules` not yet started), and wrote the merged prose to
  reflect that `lambda-ops`/`eventbridge-schedules` needed the same
  "existing getters ✓ is not actually verified" correction `s3-objects`
  proved.
- Two lessons promoted into durable rules: `implementing-scripts/SKILL.md`
  (run the contract-extraction spoke in CONTRACT mode against a hub-authored
  draft page before RED) and `test-author.md` (verify a claimed behavior
  against the real source before writing an assertion against it).

## Outcome

`aws/s3` (7 functions + `M3LS3OperationError` + 9 types, ADR-0033) shipped on
`feat/aws-s3`, merged as PR #160. `s3-objects` (7-operation op-dispatch
script, 102 tests) shipped on `feat/s3-objects` in this change set, closing
out the W3 `s3-objects` row in both `docs/ROADMAP.md` and `docs/plans/
IMPLEMENTATION.md`. See `docs/logs/2026-07-18-aws-s3.md` and
`docs/logs/2026-07-18-s3-objects.md` for the full work logs.
