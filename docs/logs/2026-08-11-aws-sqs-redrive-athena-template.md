# Work log — `aws/sqs` redrive + `aws/athena` template compiler (2026-08-11)

PR 8 of the 9-PR capability-deepening wave for `@m3l-automation/m3l-common`'s
Core and AWS surface. Unlike PRs 5-7 (new submodules), this PR extends two
already-shipped submodules — `M3LSQSOperations` gains a `redrive` method, and
`aws/athena` gains a standalone `compileAthenaQueryTemplate` function — so the
hub-and-spoke pipeline ran against existing `docs/reference/aws/{sqs,athena}.md`
pages rather than scaffolding new ones. This log records what shipped, what
matched the plan, what diverged (a closed-not-merged prerequisite PR, two
truncated spoke reports, and a security finding a fix round initially missed),
and the lessons worth carrying into PR 9.

## Summary

- **`M3LSQSOperations.redrive(sourceQueueUrl, destinationQueueUrl, processMessage, options?)`** — composes the existing `receive`/`sendBatch`/`deleteBatch` methods into a receive→process→move flow. 5 new types (`M3LSQSRedriveDecision`, `M3LSQSRedriveProcessor`, `M3LSQSReceiveDeduplicationMode`, `M3LSQSRedriveOptions`, `M3LSQSRedriveResult`). No new error class, no new Zone A edge.
- **`compileAthenaQueryTemplate(template, parameters)`** (new `aws/athena/template.ts`) — named `:placeholder` SQL compiler over Athena's existing positional `ExecutionParameters`. New `M3LAthenaCompiledQuery` type and `M3LAthenaTemplateError` (`ERR_ATHENA_TEMPLATE_COMPILE`).
- 8 new exports total (5 on `aws/sqs`, 3 on `aws/athena`) plus 1 new error class, surfaced through the existing `./aws` barrel — three-entry `exports` map unchanged.
- Tests: `sqs.test.ts` 56 tests (28 pre-existing + 28 net new/rewritten across two rounds), `athena.test.ts` 37 tests (20 pre-existing + 17 net new). Full workspace suite: 6433/6433 passing. `pnpm lint`/`pnpm typecheck`/`pnpm build`/`pnpm format:check` all clean.
- Review verdicts: `code-reviewer` pass (1 should-fix, 1 confirmation pass clean), `spec-conformance-reviewer` conformant-with-nits (doc-precision only, no code changes), `security-reviewer` 2 should-fix on first pass + 1 residual should-fix caught only on confirmation re-review (all 3 fixed and reconfirmed clean), `type-design-analyzer` 0 must-fix / 2 should-fix taken + 2 explicitly deferred as out-of-scope judgment calls, `silent-failure-hunter` clean on first pass.
- Docs: `docs/reference/aws/{sqs,athena}.md` extended with new sections; both `.provenance.json` sidecars updated; `docs/reference/core/errors.md` catalog table gained the new error code row; `docs/implementation-status.md` rows updated (symbol counts and test counts). `/syncing-docs` 14/14 clean.
- Shipped as commit `00a368a` on `feat/sqs-dlq-athena-templating`, PR [#321](https://github.com/monte3l/m3l-automation/pull/321) — `MERGEABLE`, CI freshly queued at time of writing.

Skills used: `starting-work`, `implementing-submodules`, `syncing-docs`, `writing-commits`, `creating-prs`, `writing-work-logs`.

Spoke incidents: 2 truncations / 0 stalls / 0 resumes (both truncations closed via a fresh tightly-scoped follow-up dispatch rather than `SendMessage` resume, since the prior agent was no longer reachable).

## What went as planned

- **RED failed for the right reason, both rounds.** The initial `test-author` dispatch produced 36 failures, every one a `TypeError: … is not a function` / `TS2305`/`TS2724`/`TS2339` naming a not-yet-exported symbol — no test-logic failures mixed in.
- **The contract-extraction pass (Phase 1) caught a real ambiguity before it became a bug.** `spec-conformance-reviewer` in contract mode flagged the drop-path delete-entry id-collision risk (AMB-3) and the counter-sum-invariant gap (AMB-2) before any code was written; both were resolved in the contract and never surfaced as review findings later.
- **The `move`/`drop`/`retry` page-batching logic was correct on the first GREEN pass** for the SQS side — no review round found a Must-fix in the core composition logic itself, only in a defensive edge case (the exhaustive-switch default) and in the type-design/API-shape layer.
- **The Athena scanner's core algorithm (quote-state tracking, `::` cast handling, repeated-placeholder expansion) was correct on the first GREEN pass** — every review round's findings on this file were about a genuinely new edge case (the literal-`?` rejection), not a bug in the originally-specified behavior.
- **Doc-first design paid off again.** Writing the full behavioral contract into `docs/reference/aws/{sqs,athena}.md` before dispatching any spoke meant `test-author` and `code-implementer` worked from one settled, precise contract instead of independently guessing and diverging — consistent with every prior submodule PR in this wave.

## What didn't go as planned, and why

### 1. PR #314 (the prerequisite ADR decision record) was found closed, not merely unmerged

Task #15 tracked "resolve the PR #314 ADR-0037/38/39 gap before PR9" on the assumption the PR was open-but-unmerged. When PR 8 started, `gh pr view 314` showed `state: CLOSED`, `closedAt: 2026-08-10T19:58:12Z` — closed outside this session's visibility, with no comment explaining why. ADR-0038 (the SQS-redrive/services-tier decision this PR's design directly depends on) still exists in full on the still-present branch `feat/packages-audit-decisions`, so its content was read and used as a design reference, but it cannot be cited as a landed decision record — the doc text for this PR was written to avoid an "(ADR-0037/ADR-0038)" citation that would have pointed at a non-existent file on `main`.

**Why it happened:** The closure happened in a separate, earlier session (or by the user directly) with no record visible to this session until `gh pr view` was run partway through PR 8's `/starting-work` gate.

**Fix for future:** When a plan references a prerequisite PR by number, re-check its live state (`gh pr view <n> --json state,mergedAt,closedAt`) at the start of every dependent PR, not just once at plan-authoring time — a PR's state can change between sessions with no notification. Task #15 remains open and now carries strictly more information (closed, not just unmerged) for whoever resolves it before PR 9.

### 2. The hub's own dispatch prompt to `test-author` contained an internal contradiction

The RED-phase dispatch prompt's point 5 said a delete-failure-after-successful-send "still counts as `moved`," while point 8 in the same prompt said the opposite ("counts in neither `moved` nor `dropped`"). `test-author` caught the conflict, resolved it against the canonical `docs/reference/aws/sqs.md` (which agreed with point 8), flagged the discrepancy explicitly in its report, and proceeded correctly rather than picking one arbitrarily or stalling.

**Why it happened:** The dispatch prompt was hand-written from the same design reasoning as the doc, but a phrase was transcribed inconsistently between two summary points describing the same rule.

**Fix for future:** When a dispatch prompt restates a behavioral rule already fully specified in a doc the spoke is also told to read, prefer a single unambiguous statement (or a direct doc quote) over re-deriving it in prose twice in the same prompt — two independent restatements of one rule are a drift risk even when the hub believes they say the same thing.

### 3. Two `code-implementer` dispatches returned truncated final reports

The first full-implementation dispatch (SQS + Athena types/client/template/errors/registry) ended with "Now let's add `M3LAthenaTemplateError` to errors.ts." — a mid-thought, not a completion summary. The later fix-round dispatch (typed error fields + fail-loud `messageLimit` + literal-`?` rejection + cause-message scoping) ended similarly ("ESLint clean. Now typecheck..."). In both cases, per the `implementing-submodules` skill's explicit guidance, the actual state was verified directly (`git status --porcelain`, journal file, `git diff --stat`, and a real test run) rather than trusting the report. Both times the gap was small and real: the first left the Athena barrel (`aws/athena/index.ts`) unwired despite `template.ts` and `errors.ts` being fully correct; a follow-up dispatch closed it in one pass. `ListAgents` showed neither original spoke as reachable for a `SendMessage` resume, so both gaps were closed via a fresh, tightly-scoped dispatch instead.

**Why it happened:** Both dispatches covered a wide surface (multiple files, several distinct sub-tasks) in one turn; the truncation point in both cases landed after the substantive work was done but before the final wiring/report step.

**Fix for future:** For a multi-file, multi-symbol dispatch, consider explicitly sequencing the final "wire the barrel and verify" step as its own numbered item in the prompt with its own verification command, so a truncation mid-verification still leaves the wiring done — this wave's dispatches already ask for a journal, which is what made the truncations cheap to recover from; the barrel-wiring step specifically seems to be the one most often left for last and most often where truncation lands.

### 4. A confirmation re-review caught a residual security leak the first fix round missed entirely

The first-pass `security-reviewer` flagged that `redrive`'s defensive exhaustive-switch throw embedded the whole caller-returned decision object in its error `message`. The fix round correctly scoped the `message` text to just the `action` field — but left `{ cause: exhaustive }` unchanged, still chaining the entire original value. The **confirmation** re-review (explicitly dispatched per the skill's "re-review every substantive fix round" rule) caught this on its own initiative, demonstrating via an executed probe that `error.toJSON()`/`console.error(error)` still leaked the planted secret through the `cause` channel even though `error.message` was now clean.

**Why it happened:** The original finding's fix instructions named "the message" as the leak surface (because that's what the first-pass review demonstrated), and the fix round satisfied exactly that instruction. `cause` is a separate observable channel from `message`, and nothing in the fix-round dispatch explicitly asked about it.

**Fix for future:** This is a second, independent confirmation of the existing `.claude/rules/library-src.md` "per-channel audit" rule (a security claim proven for one observable channel — `message`, a resolved value — is not automatically true for another — `cause`, `toJSON()`, console inspection). When a security finding involves an error object, the fix-round dispatch should explicitly ask the implementer to check every field being set on the thrown error (`message`, `cause`, `context`), not just the one the original finding named — and the confirmation re-review after any security fix round is not a formality; it found a real, un-caught defect here.

### 5. The regression test for finding #4 initially didn't guard the vulnerability it was meant to catch

The first version of the leak-regression test used an object-shaped malformed decision (`{ action: "bogus", leakedSecret: SECRET }`). `String()` on a plain object already evaluates to `"[object Object]"` in JavaScript regardless of the fix, so this test would have passed against both the buggy and the fixed implementation — it didn't discriminate. The confirmation re-review's replay of the pre-fix behavior against this exact fixture surfaced the gap; the fixture was then changed to a bare string decision (`String(secretString) === secretString`, which does discriminate the fix) in a follow-up `test-author` dispatch.

**Why it happened:** The original test-writing dispatch asked for "a decision object carrying a leaked field," which is a natural way to think about "smuggling a secret through a malformed object" but happens to route through a JS coercion quirk that neutralizes the exact assertion being made.

**Fix for future:** When writing a regression test for a string-serialization/leak bug, explicitly verify the fixture against the **pre-fix** behavior first (or ask the spoke to do so and report the failure mode), not just that it fails post-fix for the right symptom — a fixture that happens to also fail for an unrelated reason (or, as here, happens to coincidentally pass) doesn't prove the fix is what makes it pass.

## Lessons learned

- **Re-check a cited prerequisite PR's live state at the start of every dependent task.** A PR referenced as "open, needs merging" in a plan or a task tracker can be closed by a separate session with no notification — `gh pr view <n> --json state,closedAt` costs one call and prevents citing a decision record that no longer exists on `main`.
- **A dispatch prompt restating a doc's rule twice is a drift risk, even when the hub believes both restatements agree.** Prefer quoting the doc once over paraphrasing a behavioral rule in two separate summary points of the same prompt.
- **Truncated spoke reports are recoverable cheaply when a journal path was provided** — both truncations in this PR were closed with a single small follow-up dispatch, not a re-run of the whole task, because `git status --porcelain` plus the journal made the actual gap obvious in under a minute.
- **The barrel-wiring step is the one most likely to get left undone when a multi-file dispatch truncates near the end.** Worth calling out as its own explicit, separately-verified item in a dispatch prompt that touches a new file plus its barrel.
- **A security fix scoped to "the message" doesn't prove the same claim for `cause`/`context`/`toJSON()`.** Confirmed a second time (see `.claude/rules/library-src.md`'s existing per-channel-audit rule) — an error-object security finding's fix instructions should name every field on the thrown error, and the confirmation re-review after a security fix round found a real defect the first fix round missed, not a formality.
- **A leak-regression test must be checked against the pre-fix code, not just the post-fix code.** `String(anObject)` coercing to `"[object Object]"` silently defeats an object-shaped leak fixture regardless of whether the underlying bug is fixed — a bare-value fixture (string/primitive) is the one that actually discriminates a "stringify only the safe field" fix from a "stringify the whole value" bug. _(promoted → .claude/agents/test-author.md)_
