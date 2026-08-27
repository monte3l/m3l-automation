# Plan: U7 — hybrid execution in the CLI

**Status: shipped** — landed on `feat/u7-library-host-seams`,
`feat/u7-cli-in-process-host`, and `feat/u7-dependency-graph-discovery`,
closing issue #531. Decision:
[ADR-0054](../../adr/0054-command-module-contract-and-hybrid-execution.md).

## Context

Issue #531 asked for an opt-in **in-process** execution path for
`commandModule`-exporting scripts — direct parameter binding, `AbortSignal`
forwarding, output port — with spawn staying the default, plus the CLI
declaring script packages as dependencies so discovery resolves over the
dependency graph (doctor + cache updated).

Every claim in the issue was re-derived against the tree before any code was
written. Three held: a host logger genuinely could not carry
`resolveLogLevelFloor()` (internal, unexported) or a script's derived
`secrets`, which is why U6 left `main.ts` non-delegating with two composition
sites standing; discovery genuinely was a plain `readdirSync` scan with no
dependency-graph awareness. One did not: PR #684 (landed earlier in the same
session, on the branch this plan started from) claimed in its own doc changes
that the three U6 pilot scripts had been rewritten to consume the library's
promoted seams — `git show --name-only` on that commit proved no
`scripts/**` file was touched. Rather than weaken the docs to match the
under-shipped code, the plan chose to land the rewrite the docs already
described, closing that gap as the first slice.

## Approach / Decisions

Four slices, three PRs (ADR-0072 reviewable-slice discipline):

- **Slice A** (PR #684, `feat/u7-library-host-seams`) — finished the branch's
  own doc claims. Deleted the three U6 pilots' (`json-etl`, `sqs-etl`,
  `dynamodb-crud`) locally-duplicated `consoleOutput`/`isAbortFailure`/
  `captureFailures`/`toOutcome` in favor of the library's
  `Core.createCommandOutput`/`Core.deriveCommandOutcome`/
  `Core.captureRunFailures`; rewrote each pilot's `main.ts` to delegate to
  `commandModule.execute`, retiring the second composition site. A TOCTOU
  fix (snapshotting `context.signal` before a conditional spread) closed a
  re-read window found in review.
- **Slice B** (PR #689, `feat/u7-cli-in-process-host`) — the CLI half. New
  `packages/m3l-cli/src/run/in-process.ts` locates a script's
  `dist/command.js`, dynamically imports it (a computed specifier, so the
  `no-restricted-imports` boundary doesn't fire), guards the export with
  `Core.isM3LCommandModule`, and binds parameters directly instead of
  re-serializing to argv. Wired behind a new `--in-process` flag on the
  dynamic per-script dispatch only (`run`/`wizard` stay spawn-only by
  design); `m3l doctor` gained a `command-module:<name>` row (`ok`/`warn`,
  never `fail`). Three review rounds fixed: a TOCTOU re-read of a foreign
  module's `configParameters` that could bypass secret redaction (closed by
  pinning the value via `Object.defineProperty` with a read-back
  verification — the reviewer's own suggested patch was itself a no-op,
  since the function was `void`-returning; redesigned it to return `boolean`
  and reject the whole candidate on a lying `Proxy`); a `__proto__`-named
  parameter being silently dropped by Node's own `parseArgs` rather than
  surfacing the library's prototype-pollution guard; and a bug in the
  restoration mechanism that truncated a repeated `__proto__`-named
  `STRING_ARRAY` value to its first occurrence.
- **Slice C** (PR #695, `feat/u7-dependency-graph-discovery`) — dependency-
  graph discovery. `packages/m3l-cli/package.json` now declares all 16
  `scripts/*` packages as `workspace:*` dependencies; `discoverScripts`
  resolves each via `createRequire(...).resolve("<pkg>/package.json")` over
  that declared graph first, falling back to the existing filesystem scan
  for anything unresolved (graph wins on a name collision) — the property
  ADR-0057 needs to publish the CLI independently of a shared `scripts/`
  directory. `m3l doctor` gained a `dependency-graph` row. Three parallel
  review passes (code-reviewer, spec-conformance-reviewer,
  silent-failure-hunter) converged on the same real defect: `runDoctor`
  called `discoverScripts` unguarded, before `checkDependencyGraph`'s own
  isolated check ran, so a non-`MODULE_NOT_FOUND` resolution failure could
  abort the whole doctor run instead of degrading to one `warn` row — fixed
  with a retry that stubs both throwing collaborators
  (`readOwnManifest`/`resolveScriptManifest`) to non-throwing values, closed
  across two follow-up commits and a fourth targeted verification pass.
- **Slice D** (this sync) — `pnpm sync:hub -- --apply` to reconcile the hub;
  GitHub had already auto-closed #531 via the PR #695 body's `Closes #531`.

## Outcome

U7's tracker row (`docs/plans/IMPLEMENTATION.md`) flipped to `Done` / `CLI
capability`. `docs/reference/core/cli-contract.md`'s stale "the CLI actually
calling any of this is U7's next slice" scope note was corrected now that
`packages/m3l-cli` does. `docs/reference/cli.md` gained a "Dependency-graph
discovery, filesystem fallback" design invariant, `--in-process` documentation,
new exit codes, and the two new `m3l doctor` rows. Issue #531 closed
`completed`; epic #608 (CLI evolution wave) stays open for the remaining
U-series items.
