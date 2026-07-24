# 0035. Failure reporting and diagnostics architecture

- **Status:** Accepted
- **Date:** 2026-07-22
- **Deciders:** Enrico Lionello

## Context and problem statement

A five-facet audit of how the library and its nine consumer scripts surface
errors, crashes, exit codes, and failure state found that the raw materials for
troubleshooting exist but do not compose into a diagnosable system:

- `M3LError` carries `code`/`context`/`cause` and a 64-code vocabulary
  (`M3L_ERROR_CODES`), but nothing — type, field, or registry — distinguishes a
  **caller mistake** (bad config, API misuse) from an **external-system
  failure** (AWS, HTTP, polling against remote state) from a **library-internal
  fault**. The distinction lives only as prose in the coding rules.
- No mapping exists from error codes to **process exit codes**. `M3LScript.run()`
  re-throws after the `onError`/`onCleanup` hooks; the scaffold template and all
  nine consumer scripts call it bare, so every failure exits through Node's
  unhandled-rejection default (code 1) regardless of failure class.
- `installProcessGuards()` (unhandledRejection / uncaughtException / warning /
  beforeExit) is exported but called by nothing — not by `M3LScript`, any
  consumer script, or the scaffold template — and no doc says whose job it is to
  call it, or when, in CLI vs Lambda.
- A **failed run leaves no artifact**: stage-9 file archival runs only on the
  success path, `M3LScript` never logs the failing error itself, and the
  best-effort stderr diagnostic fires only when a hook _itself_ throws.
- The logger has **no level filtering and no debug toggle**: every event fans
  out to every handler unconditionally; there is no `M3L_LOG_LEVEL`/`M3L_DEBUG`
  or `--debug` wiring anywhere.
- Failure context is **event-only** where it matters most: retry exhaustion
  re-throws the last error unchanged (attempt history only in
  `retry:exhausted`), `M3LPollFailureError` carries no context at all, and
  importers collect per-record errors into a result the caller must remember to
  inspect.
- No cause-chain formatter exists ("A caused by B caused by C" with stacks),
  and the closest serializer (`serializeError`) omits `cause` entirely.

The audit's companion finding on the documentation side: no troubleshooting
guide, no error-code catalog, no exit-code reference, no run-archive guidance,
and issue templates that predate GitHub issue forms.

This ADR decides the architecture that closes those gaps. The **code work is
deliberately not part of this decision's landing PR** — this ADR plus the
updated reference pages are the contract future implementation phases build
against (the same docs-first pipeline every submodule follows).

## Decision drivers

- No breaking changes outside a major release; strict semver (the standing
  constraint) — the design must be adoptable incrementally as minors.
- A clear **library-vs-script separation** for triaging failures — the primary
  ask driving the audit.
- Post-mortem debuggability for unattended automation runs: a failed cron/CI
  run must leave enough evidence to diagnose without re-running.
- Minimal runtime dependencies; reuse the existing event fabric, config
  precedence chain, redaction helpers, and archival seam rather than adding
  parallel machinery.
- The library does not log by default and never logs secrets (standing security
  rule); every new diagnostic surface must be redaction-aware.

## Considered options

1. **Class-tier reshuffle** — introduce intermediate abstract tiers
   (`M3LCallerError` / `M3LExternalError` / `M3LInternalError`) and re-parent
   all 36 subclasses; exit codes derived from `instanceof`.
2. **Additive metadata + a diagnostics submodule** — an `origin`/`retryable`
   field on `M3LError` with per-subclass defaults, a documented catalog of all
   64 codes, and a new `core/diagnostics` submodule owning run reports, the
   exit-code registry, the cause-chain formatter, breadcrumbs, and dumps.
3. **Docs-only classification** — catalog the codes and the conventions in
   documentation, change no code surface.
4. **Script-template hardening only** — leave the library untouched; put
   top-level catch, guards, exit mapping, and report writing into the scaffold
   template each script copies.

## Decision

We chose **option 2**. The classification is additive metadata, the machinery
lives in one new submodule, and scripts adopt it through an opt-in wrapper —
nothing existing changes shape.

### 2.1 Fault-origin classification (errors)

`M3LError` gains two optional, additive fields, set via `M3LErrorOptions` and
defaulted per subclass:

- `origin: "caller" | "library" | "external"` — who must act to fix the
  failure. `caller`: the script/config author (bad config, invalid argument,
  API misuse). `external`: an external system (AWS SDK failures, HTTP errors,
  poll exhaustion against remote state). `library`: an internal invariant
  violation — a bug in `@m3l-automation/m3l-common` itself.
- `retryable: boolean | "situational"` — whether re-running without changes can
  plausibly succeed.

Both default to `undefined` on bare `M3LError` (unclassified), so no existing
construction changes meaning. The reference catalog
([errors → Error-code catalog](../reference/core/errors.md)) classifies every
built-in code; the source-scan completeness test that already guards
`M3L_ERROR_CODES` extends to assert every built-in code has a catalog
classification.

> **Implementation note (phase 2, 2026-07-23).** "Defaulted per subclass" is
> satisfied by deriving the default in the `M3LError` base constructor from
> `classifyErrorCode(code)`, rather than by pinning a literal in each of the 36
> subclasses. Because every built-in subclass pins a literal `code` and the
> catalog is exhaustively keyed over `M3LErrorCode`, the two are equivalent for
> every built-in error — and deriving is the stronger guarantee, since a
> per-subclass literal could silently disagree with the catalog that
> `mapErrorToExitCode` reads. The only difference is static: `error.origin`
> types as `M3LErrorOrigin | undefined` at a catch site instead of narrowing to
> a literal. Consequently a code with no catalog entry — a caller-defined code
> on a consumer subclass — is what yields `undefined`, which is the same
> unclassified outcome an un-annotated subclass would have had.

**This is the library-vs-script separation**: `origin: "library"` errors are
library bugs (file a bug report against m3l-common); `origin: "caller"` errors
are script/config issues (fix the script); `origin: "external"` errors are
environmental (check the external system, often retryable). The troubleshooting
guide and the failure-report issue form both triage on this axis.

### 2.2 Exit-code registry (diagnostics)

A small fixed registry — deliberately coarse so schedulers can branch on it,
with the fine detail carried by the error code and run report:

| Exit code | Meaning                                         | Typical origin |
| --------- | ----------------------------------------------- | -------------- |
| `0`       | Success                                         | —              |
| `1`       | Unclassified failure (reserved; Node's default) | unknown        |
| `2`       | Configuration / usage error                     | caller         |
| `3`       | External-system failure                         | external       |
| `4`       | Library-internal fault                          | library        |
| `5`       | Interrupted (signal-forced shutdown)            | —              |

`mapErrorToExitCode(error)` resolves an unknown thrown value to a registry code
via `origin` (falling back to catalog lookup by `code`, then to `1`).
`M3LScript.run()` keeps its exact contract (re-throw, never exit); adoption
happens in the composition root via the new `runScript()` wrapper (§2.4), which
sets `process.exitCode` — never `process.exit()`, so in-flight writes flush.
The signal layer's forced-exit changes from `1` to `5` **only through the
wrapper**; the existing `signalHandlers` behavior is untouched.

### 2.3 Run reports (diagnostics)

Every wrapped run persists a machine-readable report to
`data/output/<timestamp>/run-report.json`, extending the existing stage-9
archival seam (`M3LFileCopier` / `getLastArchiveReport()`):

- **Always:** script name/version, `correlationId`, execution environment
  snapshot (mode, Node version, platform), config fingerprint (parameter names
  and _sources_ — never values, redaction-first), step timeline (lifecycle
  stages + breadcrumbs with timestamps/durations), outcome, exit code, archive
  manifest.
- **On failure, additionally:** the fully-walked cause chain via
  `formatErrorChain()` (every level's name/code/message/stack, redacted), the
  failing stage, and the breadcrumb trail at time of failure.
- **The failure path must produce the report.** Today a failed run archives
  nothing; the report writer runs best-effort inside the error path (isolated
  exactly like the `onError`/`onCleanup` hook failures are today) so a crash
  cannot lose its own post-mortem. If report writing itself fails, the report
  serializes to the best-effort stderr diagnostic instead.

### 2.4 `runScript()` wrapper and the guard contract (script)

A new top-level entry helper — the only place process-wide behavior composes:

```text
runScript(script, mainFn, options?) →
  installProcessGuards() + top-level catch + run report + process.exitCode
```

- **CLI:** the scaffold template's composition root migrates from bare
  `await script.run(mainFn)` to `await runScript(script, mainFn)`. Existing
  scripts keep working untouched (strictly additive); they adopt the wrapper
  when next edited.
- **Lambda:** `createLambdaHandler()` remains the entry; guards are **not**
  auto-installed (the platform owns the process). The documented contract: a
  Lambda module _may_ call `installProcessGuards()` once at module scope;
  `setProcessGuardRequestId` is auto-wired per invocation (already true today).
- **Reconciled exit semantics** (previously contradictory across layers):
  guards observe and never exit; the signal layer force-exits on the second
  signal; the wrapper is the single place an exit code is _set_.

### 2.5 Log levels and the debug toggle (logging)

- `M3LLogger` gains an optional `minLevel` (severity floor derived from the
  nine `M3LLogEventCategory` values, plus a new `DEBUG` category below `TEXT`);
  handlers gain the same option for per-sink floors. Default: current behavior
  (everything passes) — additive.
- Resolution reuses the config precedence chain: CLI flag (`--log-level`,
  `--debug`) > environment (`M3L_LOG_LEVEL`, `M3L_DEBUG=1`) > config file >
  default. `M3L_DEBUG=1` is the one-switch debug mode: floor drops to `DEBUG`
  and the library's own diagnostic events (breadcrumbs, timings) become
  visible.
- `logger.errorFrom(error, message?)` logs an error with its code, context,
  and **full cause chain** as structured fields (closing the
  `serializeError`-omits-`cause` gap); `logger.time(label)` returns a disposer
  that logs a duration, replacing the per-module inline `Date.now()` deltas.

**Carve-out (phase 4b): the config-file tier was dropped — CLI + env only.**
Phase 4b ships `--log-level`/`--debug` > `M3L_LOG_LEVEL`/`M3L_DEBUG=1` > default,
resolved once in the `M3LScript` constructor for the default logger it builds (a
caller-supplied `options.logger` opts out entirely). The `config file` tier was
cut for two reasons: (1) a config-file floor cannot influence the logs emitted
_while config is still loading_ — the floor would only be known afterward, so
the tier is inert for exactly the early-stage output an operator most wants to
see; and (2) applying it to the already-constructed default logger (built before
config loads, with a `readonly` floor) would need either a public mutator on
`M3LLogger` or rebuilding the logger, which breaks identity for any holder of
`script.logger`. CLI + env cover the operational need. An out-of-vocabulary
explicit value — or a valueless `--log-level` — fails loud with `M3LError`
(`ERR_INVALID_ARGUMENT`); the `--debug`/`M3L_DEBUG` toggles are boolean and never
throw. This is additive and semver-minor: no new public symbol (the resolver is
`internal/`), no `exports`-map change.

### 2.6 Diagnostic context: breadcrumbs, dumps, dry-run (diagnostics)

- `M3LBreadcrumbTrail` subscribes to the existing typed event fabric
  (`retry:*`, `poll:*`, `import:*`, HTTP `request`/`response`/`error`) and
  keeps a bounded ring buffer of redaction-safe entries. The trail feeds the
  run report's step timeline and is available to `onError` — so "what was
  happening just before the failure" survives even though thrown error shapes
  stay unchanged (retry exhaustion still throws the last error; the attempt
  history now lives in the trail and report).
- `M3LPollFailureError` gains an optional `context` parameter (additive) so a
  terminal poll failure can carry the attempt it failed on.
- `collectDiagnostics()` produces an on-demand, redacted snapshot: execution
  environment, resolved paths, config fingerprint, package version — the same
  block the run report embeds, callable anywhere (e.g. an `onError` hook or a
  `--diagnostics` flag a script chooses to expose).
- **Dry-run:** `runScript(script, mainFn, { dryRun: true })` (surfaced as a
  `--dry-run` flag in the template) executes stages 1–5 — environment
  detection, hooks, config load + validation, AWS provisioning including
  credential validation — then stops before `mainFn`, reporting what was
  validated in the run report. Scripts that want side-effect-aware dry-run
  deeper than the boundary read `ctx.dryRun` from the hook context.

## Consequences

- **Positive:** failures become triageable by origin (library vs script vs
  external) at every surface — error object, exit code, run report, issue
  form; unattended runs leave a post-mortem artifact on the path that needs it
  most (failure); debugging is switchable at runtime without code changes;
  everything reuses existing seams (events, config chain, redaction, archival)
  so no new runtime dependency is introduced.
- **Negative / trade-offs:** the classification adds a maintenance duty (every
  new error code must be cataloged — enforced by extending the existing
  completeness test); run reports add one file per run to `data/output/`
  (bounded by the same retention the archives already imply); `runScript()` is
  one more public symbol whose behavior overlaps `run()` (mitigated: `run()`
  stays primitive, the wrapper composes it); exit codes are coarse by design —
  consumers needing finer grain read the run report or error code.
- **Semver impact:** minor, repeatedly — each phase is additive (new fields
  with `undefined` defaults, new optional options, new exported symbols through
  the existing `core` barrel; no new `exports` subpath). No major is required
  at any phase.

  **One carve-out, found in phase 4a.** `M3LScriptHookContext` gained a
  **required** `dryRun: boolean` rather than an optional one, so a hook can
  branch on `ctx.dryRun` without a `?? false` dance. That is source-breaking
  for anyone _constructing_ the context as an object literal — which hooks
  never do, but test fakes do: seven in-repo consumer scripts had to add the
  field. Accepted rather than weakened to optional, because the package is
  internal and unpublished (ADR-0020), so every consumer lives in this monorepo
  and was fixed in the same change set.

## Rollout

Phased implementation, each phase an independent minor following the standard
docs-first pipeline (`scaffolding-submodules` → `implementing-submodules`, or
`implementing-scripts` for the template refresh):

1. `core/diagnostics` submodule — `formatErrorChain`, exit-code registry +
   `mapErrorToExitCode`, `collectDiagnostics`, `M3LBreadcrumbTrail`, run-report
   schema + writer.
2. `core/errors` — `origin`/`retryable` on `M3LErrorOptions` + per-subclass
   defaults + catalog completeness test extension.
3. `core/logging` — `DEBUG` category, `minLevel`, `errorFrom`, `time`.
4. `core/script`, split in two when it shipped:
   - **4a** — the `runScript()` wrapper (guards + catch + report + exit code +
     dry-run) and `M3LPollFailureError` context. `runScript` ships from
     `core/script`, not `core/diagnostics`: Zone B forbids
     `core/* → core/script`.
   - **4b** — the log-level precedence chain inherited from phase 3. Shipped
     CLI + env only (`--log-level`/`--debug` > `M3L_LOG_LEVEL`/`M3L_DEBUG=1` >
     default), resolved in the `M3LScript` constructor for its default logger.
     The originally-listed config-file tier was dropped rather than deferred —
     it cannot influence config-load-time logs, and reaching the
     already-constructed default logger would need a public `M3LLogger` mutator
     or a logger rebuild that breaks `script.logger` identity (see the §2.5
     carve-out). No new public symbol; the resolver is `internal/`.
5. Template + consumer-script refresh — **shipped**. The scaffold template and
   all nine existing scripts migrated from bare `script.run(fn)` to
   `Core.runScript(script, fn, { dryRun })`, so every consumer now surfaces the
   origin-specific exit codes and the run report, plus a `--dry-run` switch. This
   phase also reconciled the archival-vs-report directory split A1 left open:
   `M3LScript` now owns a per-run `runStartedAt`, and stage-9 archival and the run
   report both derive their directory from it, so a run's `inputs/`, `configs/`,
   and `run-report.json` co-locate under one `data/output/<timestamp>/`. **One
   behavioral delta:** archival moved from flat/overwriting `data/output/{inputs,
configs}` to the per-run timestamped directory (no exported-symbol change; the
   `runDirectoryName` seam is `internal/`).

No tracking issues are filed for these phases (single-maintainer repo; this
rollout section is the sequencing record).

## Update (2026-07-23) — the run report is a sensitive artifact

Implementing phase 1 disproved a premise this ADR carried implicitly: that
`run-report.json` could be made safe to share by redacting it. It cannot, and
the attempt was actively counterproductive.

**Evidence.** Four adversarial refute passes ran against the phase-1
implementation. All four succeeded, finding ten confirmed secret leaks into the
persisted report. More telling than the count is the pattern:

- Every leak was in a **denylist** surface — free-text error `message`/`stack`,
  arbitrary caller-supplied `archive`/`context` — guarded by a URL-scrubbing
  regex plus `redactSensitiveLogValue`'s heuristic key-name matching.
- Every **allowlist** surface held across all four rounds without a single
  leak: the breadcrumb summarizers (which keep only named scalar fields per
  event), the source-label allowlist, the set-cardinality marker.
- Every **structural invariant** held: path containment, symlink/`wx` write
  protection, the cycle seen-set, `Map`/`Set` key-preserving normalization.
- Three of the four fix rounds **introduced regressions**. Round 1's
  cycle-breaking pre-pass silently disabled `Map`/`Set` redaction that had
  previously worked; round 4's regex rewrite reopened
  `?X-Amz-Signature=<value>` and made an unterminated quote swallow a following
  URL. Each rewrite of the pattern broke a case its predecessor handled.

A regex over unbounded caller text is a denylist against an infinite input
space. It does not converge, and iterating on it made the surface less stable,
not more.

**Decision.** `run-report.json` is reclassified as a **sensitive artifact — a
crash dump**. It retains full diagnostic fidelity (error messages, stacks,
cause-chain context, the archive manifest), and redaction remains as
defense-in-depth rather than a guarantee. What changes is the contract around
it:

- `docs/guides/troubleshooting.md` no longer tells operators to attach the
  report to bug reports. The guidance is now: treat it as sensitive, review
  before sharing.
- §2.3's "redaction-first" framing above describes an aspiration the
  implementation approximates, not a property it guarantees. The
  [diagnostics reference](../reference/core/diagnostics.md) states the real
  contract.
- The two surfaces that _can_ be allowlisted were converted rather than
  patched: `archive` is projected to the known `M3LFileCopyReport` shape
  instead of accepting an arbitrary object, and object **keys** are scrubbed
  alongside values.

**Accepted residual limitations** (documented, not fixed — the reclassification
is what covers them):

- `?X-Amz-Signature=<angle-bracketed-value>` is not URL-scrubbed, because
  `signature` is absent from `SENSITIVE_KEY_NAMES` so the name-based pass
  cannot fire either.
- An unterminated quote after a URL `key=` can swallow a following URL to
  end-of-string; if the outer URL then fails to parse, the swallowed span is
  restored verbatim.
- Free-text error messages and stacks may contain anything a caller or an
  upstream service put there, including absolute paths that disclose the OS
  username.

**Consequence for the breadcrumb trail.** The trail keeps its stricter
guarantee — it is allowlisted per event and has survived every adversarial
pass — so it remains suitable for sharing where the full report is not. That
asymmetry is deliberate.

## Links

- Related: [ADR-0005](./0005-error-hierarchy.md) (M3LError/M3LResult model —
  extended, not superseded), [ADR-0018](./0018-shared-script-options-bag.md)
  (M3LScriptOptions bag the wrapper options follow),
  [ADR-0022](./0022-reintroduce-scripts-workspace.md) (script composition-root
  layout the template change lands in)
- Specs: [reference/core/diagnostics](../reference/core/diagnostics.md),
  [reference/core/errors](../reference/core/errors.md),
  [reference/core/logging](../reference/core/logging.md),
  [reference/core/script](../reference/core/script.md),
  [reference/core/polling](../reference/core/polling.md)
- Guide: [Troubleshooting](../guides/troubleshooting.md)
