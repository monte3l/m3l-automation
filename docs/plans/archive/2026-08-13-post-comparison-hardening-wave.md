# Post-comparison hardening wave + in-house script CLI evaluation

**Status: shipped.** PRs #325, #326, #327, #328, #329, #330, #331 (feature
work) + this closeout PR (ADR-0042, ADR-0043, tracker reconciliation).

## Context

A second external reference review of a comparable TypeScript
automation-library ecosystem was compared against this repo, following on
from ADR-0037's capability-deepening wave (#305–#323, itself reconciled into
the trackers by PR #324). The reference material itself is not retained or
cited anywhere in this plan or the artifacts it produced.

**Catch-up was not the opportunity.** `m3l-common` was confirmed at or ahead
of the reference on nearly every Core capability it described. What the
comparison exposed instead was three actionable things — primitives shipped
in the prior wave that nothing consumed, a genuine unredacted-credential leak
in the HTTP client, and dead code paths that made shipped features silently
inert — plus two credible new-package evaluations (a script-facing CLI and a
step-pipeline engine) that were resolved by ADR rather than by building
either speculatively.

This wave was **additive-minor**. No item earned a breaking change on its own.

## Approach / Decisions

Small, independently gate-passing PRs, smallest-risk first — the same
sequencing ADR-0037's wave used.

1. **Doc drift fix.** `CLAUDE.md`/`.claude/rules/tests.md` claimed an "80%
   coverage gate"; the enforced thresholds are lines 90 / functions 83 /
   branches 80 / statements 89 with `perFile: true`. Corrected. **PR #325.**
2. **Closed a real credential leak.** `M3LHttpClient`'s `"request"` event
   emitted the full merged header map unredacted, and
   `M3LHttpClientError.context.url` carried an intact query string —
   `Authorization`/`x-api-key`/`?token=` reached every subscriber and every
   error message. Reused the shared `redactSensitiveLogValue`
   (`core/logging/redact.ts`) rather than writing a second redactor; stripped
   query strings from error-context URLs. **PR #326.**
3. **Made dead HTTP branches reachable.** `httpRetryAfterClassifier` read
   `err.retryAfterMs`, but nothing populated it — the client never parsed
   `Retry-After`. Added delta-seconds and HTTP-date parsing into an additive
   `retryAfterMs` field, added 408 to the retriable status set, and added an
   opt-in `maxResponseBytes` bound (default unbounded, keeping the change
   additive-minor). **PR #327.**
4. **Bounded the import path.** `internal/importers/resolveSource.ts` did a
   bare unbounded `readFile`, asymmetric with the ZIP extractor's existing
   bomb-hardening (depth cap, 4096 entries, 256 MiB). Added opt-in
   `maxBytes`/`maxRows`, default unbounded, throwing a chained `M3LError` on
   violation. **PR #328.**
5. **Added ReDoS regression coverage.** `core/logging/redact.ts` asserted in
   prose that its pattern "cannot backtrack catastrophically" with nothing
   verifying it. Added adversarial-padding regression tests (~440k chars
   against the three redaction passes; ~640k chars against the
   `aws/credentials/manager.ts` message classifiers), asserting bounded
   completion time. **PR #329.**
6. **Wired the unwired islands.** `M3LSingleFlight` (zero call sites) now
   coalesces concurrent SSO logins for the same profile in
   `aws/credentials/manager.ts` — its motivating case: validating profiles
   concurrently while logging in sequentially previously had no coalescing.
   `canonicalJsonHash` (zero consumers outside `core/json`) now
   content-addresses the checkpoint payload in
   `core/checkpoint/M3LCheckpointStore.ts`, so a corrupted or hand-mutated
   checkpoint is caught on resume. `M3LResult`'s retyping to the `M3LError`
   hierarchy was scoped out as genuinely breaking; the boundary policy (when
   a new API returns `Result` vs. throws) was recorded in the style guide
   instead of manufacturing a `Result`-returning API to justify the type.
   **PR #330.**
7. **AWS depth — three additive improvements.** Credential-failure
   classification now checks `error.name` (`ExpiredTokenException` →
   `SSO_SESSION_EXPIRED`, `SSOTokenProviderFailure` → `SSO_SESSION_INVALID`)
   before falling back to the existing message-regex chain, so a reworded or
   localized SDK message no longer misclassifies as `UNKNOWN`/non-recoverable.
   `M3LAWSCredentialsManagerOptions` gained an optional `logger`
   (`M3LLoggerHandler`) observing the SSO login lifecycle (`STEP` before
   spawn, `SUCCESS`/`WARNING`/`ERROR` on settlement) — a 4-spoke pre-push
   review (code-reviewer, spec-conformance-reviewer, security-reviewer,
   silent-failure-hunter) independently caught a critical bug in the first
   draft (unguarded `handler.handle()` calls that could crash the process or
   leave the SSO promise permanently unsettled) before it ever reached the
   remote; the fix added a `dispatchLoggerEvent` helper mirroring
   `M3LLogger.dispatch`'s established isolate-to-stderr pattern, and closed a
   related gap where the spawn-`"error"` path emitted no terminal event.
   `M3LS3Operations`/`M3LDynamoDBOperations` were added as thin
   `.services.s3Operations`/`.services.dynamoDBOperations` wrapper classes —
   both submodules were free-function-only with no class reachable through
   `AWSServiceProvider`, an asymmetry with every other wrapped AWS service
   (ADR-0038); the `.services` getter count rose from 15 to 17. This also
   required [ADR-0041](../../adr/0041-logger-seam-zone-widening.md), widening
   the `aws/**` ESLint Zone A except-list to two closed leaf files in
   `core/logging` (`M3LLogEvent.ts`, `M3LLogEventCategory.ts`) so the
   credentials manager could import the handler port type without pulling in
   the mid-layer logging graph — modeled directly on
   [ADR-0040](../../adr/0040-single-flight-zone-widening.md)'s precedent from
   item 6 above. **PR #331.**
8. **Script-facing CLI package — evaluated, deferred by ADR.** A zero-dependency
   `packages/m3l-cli` design (discovery/introspection over the
   `configParameters` seam every consumer script already declares, using only
   `node:util`'s `parseArgs`, native TS type-stripping, `Core.M3LPrompt`, and
   `M3LUnknownParameterDetector` — no new runtime dependency) was fully
   evaluated: a dependency-replacement table, an 8a–8g phased build-out, and a
   seven-row risk register with a mitigation for each. The design is genuinely
   viable, but no named consumer call-site exists — building it now would
   repeat the speculative-broadening pattern ADR-0021/ADR-0037/ADR-0039
   already declined elsewhere. Recorded as
   [ADR-0042](../../adr/0042-script-cli-package-deferred.md): design accepted
   on paper, build deferred, gated on an explicit revisit trigger. Not
   implemented.
9. **Step-pipeline engine — evaluated, deferred by ADR.** All 13
   `scripts/*/src/steps/run-*.ts` dispatchers (4,867 lines) repeat four
   identical shapes (an operation-union type, a settings struct, a
   destructive-operations set, a required-field table). The duplication is
   real but not yet costly, and an engine abstraction is a design commitment
   that is easy to get wrong speculatively. Recorded as
   [ADR-0043](../../adr/0043-step-pipeline-engine-deferred.md), gated on a
   named consumer the way ADR-0039 gated Bedrock. The same ADR closes three
   other reference capabilities outright, with no revisit trigger: LLM/Bedrock
   invocation (already declined, ADR-0039), a canonical-JSON contracts
   package (the capability already exists as `core/json`'s
   `canonicalJsonStringify`/`canonicalJsonHash`), and a typed client for an
   internal alerting service (no such service exists in this repo). Not
   implemented.

## Outcome

- `pnpm verify` — 35 of 35 runnable steps passed (gitleaks and the
  frozen-lockfile reinstall skip by design locally), including `pnpm knip`,
  against the final tree.
- Targeted checks confirmed the wave did what it claims: `M3LSingleFlight`
  has a real call site in `aws/credentials/manager.ts`; `canonicalJsonHash`
  has a real call site in `core/checkpoint/M3LCheckpointStore.ts`; ReDoS
  regression tests exist in `credentials.test.ts` and `logging.test.ts`; a
  secret-bearing header round-tripped through the `"request"` event asserts
  redacted (`network.test.ts`); every `scripts/*/package.json` dependencies
  block still equals exactly `{"@m3l-automation/m3l-common": "workspace:*"}`
  across all 13 scripts.
- `pnpm check:impl-counts`/`pnpm check:doc-counts` — the 39/39 submodule
  ledger reconciles; `pnpm check:api` shows the exports map matching the
  committed snapshot (additive-only, no removal or retype slipped in);
  `pnpm check:zones` confirms the ADR-0009/0040/0041 dependency-direction
  guards are intact.
- Two new ADRs (0042, 0043) close out the wave's evaluation-only items;
  `docs/adr/README.md`'s index updated.
- `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` gained a
  "Post-comparison hardening wave" section mirroring the prior
  capability-deepening wave's reconciliation shape, with PR citations in an
  adjacent column per the ADR-0024 row-locality rule; the AWS getter reality
  table's `s3`/`dynamoDB` rows updated to note the new `.services`-tier
  getters.
- This plan file replaces the standing plan-mode scratch file
  (`tmp-packages-md-against-the-current-frolicking-snowflake.md`), which is
  now fully resolved: §1–§7 shipped as PRs #325–#331, §8–§9 closed via
  ADR-0042/ADR-0043 rather than implementation, and §0b's tracker
  reconciliation (for the prior wave) had already landed as PR #324 before
  this wave began.
