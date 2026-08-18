# 0042. Defer the script-facing `packages/m3l-cli` package

- **Status:** Accepted
- **Date:** 2026-08-13
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

The post-comparison hardening-wave plan (`docs/plans/archive/2026-08-13-post-comparison-hardening-wave.md`,
§8) evaluated a script-facing interactive CLI — `packages/m3l-cli` — that
would discover the 13 packages under `scripts/*`, read their declared
`configParameters`, and offer `list`/`inspect`/`run`/`doctor` commands plus a
later interactive wizard with presets and history.

The evaluation concluded the design is genuinely viable: a zero-dependency
build (`node:util` `parseArgs`, native TS type-stripping for
`scripts/*/src/config.ts` imports, `Core.M3LPrompt`/`M3LMultiSpinner` for
interaction, `M3LUnknownParameterDetector`'s Damerau–Levenshtein matching for
fuzzy search) removes the minimal-dependency objection entirely, and the
`configParameters` seam every script already declares is unconsumed by any
existing tool (`grep -rln "configParameters" bin/` returns nothing). Root
`bin/` already covers static scaffolding/checking; the gap is genuinely
interactive, per-script introspection and guided execution.

That viability is not, by itself, a reason to build it now. This ADR records
the decision to defer implementation while keeping the evaluation on record,
so a future revisit starts from "here is the accepted design" rather than
re-deriving it.

## Decision drivers

- **Gated broadening** (ADR-0021, carried forward by ADR-0037): new capability
  surface — and `packages/m3l-cli` would be an entirely new workspace
  package, not a submodule — is gated on a named consumer need, not built
  speculatively ahead of one.
- **No named consumer pull today.** The 13 existing scripts are run directly
  (`pnpm --filter <script> start`); nothing in this repo's current usage
  pattern is blocked on the absence of a discovery/wizard layer. The plan's
  own phased build-out (8a–8g) is sized for a real, felt need, not a
  hypothetical one.
- **Scope and governance cost are non-trivial even at zero runtime
  dependencies.** A new workspace package touches `bin/check-deps.mjs`,
  `knip.json`, root `tsconfig` references, and coverage-config inclusion
  (the plan's own risk register, row 2) — real surface area to add and then
  maintain, independent of the dependency count.
- **This wave is additive-minor and closing, not opening new fronts.** §7
  (AWS depth) already shipped the wave's substantive additions; layering a
  new package on top would extend the wave indefinitely rather than close it.

## Considered options

1. **Build `packages/m3l-cli` now, following the plan's 8a–8g phasing.**
   Rejected: no named consumer call-site exists yet; this is exactly the
   speculative-broadening pattern ADR-0021/ADR-0037 already declined for
   other capabilities (e.g. an SSM config provider, a Bedrock invoker in
   ADR-0039).
2. **Record the evaluation as an accepted design and defer the build,
   revisiting when a concrete trigger appears.** Preserves the design work
   (zero-dependency table, phased build-out, risk register with per-row
   mitigations) so a future session does not re-run the same audit, while not
   committing to the governance and maintenance cost until a real need
   exists.
3. **Discard the evaluation entirely and let the question resurface from
   scratch next time.** Rejected: throws away verified, non-obvious findings
   (native TS type-stripping works with zero deps on Node 24; the
   `configParameters` seam is unconsumed) that took real investigation to
   establish.

## Decision

We chose **option 2**.

`packages/m3l-cli` is **not** being implemented as part of this wave. The
design remains accepted on paper: a private, unpublished package depending
only on `@m3l-automation/m3l-common` via `workspace:*`, phased 8a
(ADR — this document, retroactively) through 8g (interactive wizard), with
the zero-dependency replacement table and the seven-row risk register from
the source plan carried forward unchanged below.

**Revisit trigger.** Build phase 8a (discovery + introspection: `list` and
`inspect`) only once one of the following becomes true:

- A user or script maintainer explicitly asks to browse/inspect the 13
  scripts' declared parameters without opening each `config.ts` by hand, or
- A second wave of consumer scripts (beyond the current 13) makes manual
  discovery-by-directory-scan genuinely painful, or
- The `configParameters` seam grows a second consumer need (e.g. a
  documentation generator) that would make a shared discovery module pay for
  itself independent of the CLI.

None of these has occurred as of this ADR.

### Carried-forward design record

**Zero-dependency replacement table** (verified, not assumed):

| Need                             | Conventional dep    | In-house replacement                                 | Status                                                                |
| -------------------------------- | ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Arg parsing                      | `commander`         | `node:util` `parseArgs`                              | Built-in, verified present                                            |
| Import `scripts/*/src/config.ts` | `tsx` loader        | Node native type-stripping                           | Verified: `await import("./cfg.ts")` succeeds with no loader, no deps |
| Interactive prompts              | `@inquirer/prompts` | `Core.M3LPrompt`, `M3LMultiSpinner`, `M3LLoadingBar` | Already public                                                        |
| Fuzzy search                     | `fuse.js`           | `M3LUnknownParameterDetector` (Damerau–Levenshtein)  | Already public                                                        |
| Spawn / mtime cache              | —                   | `node:child_process`, `node:fs`                      | Built-in                                                              |

**Phasing** (unchanged from the source plan, retained for a future
implementer): 8a ADR (this document) → 8b discovery + introspection (`list`,
`inspect`) → 8c execution (`run <script> -- [args]`) → 8d runtime-registered
per-script subcommands → 8e `doctor` → 8f presets + history (blocked on the
`M3LConfigParameter.secret` prerequisite below) → 8g interactive wizard.

**Library prerequisite for 8f.** `M3LConfigParameter` has no `secret` flag,
and `core/config/M3LSecretsSpecifier.ts` is a standalone name-set with no
producer. Presets/history cannot be built safely until an additive
`secret?: boolean` is added to `M3LConfigParameter` and the CLI builds its
`M3LSecretsSpecifier` from each script's declared parameters — this must ship
before 8f, not as part of it.

**Risk register** (every risk keeps its mitigation on record for whenever
implementation resumes):

| Risk                                                                                                       | Mitigation                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native type-stripping cannot execute type-directed emit (`enum`, `namespace`, decorators) in a `config.ts` | Verified zero occurrences today; add an ESLint zone banning them under `scripts/*/src/config.ts`, and have the CLI fail with a named error rather than a stack trace.                                                     |
| A new workspace package escapes existing governance                                                        | `bin/check-deps.mjs`, `knip.json`, root `tsconfig` references, and coverage-config inclusion must all gain an `m3l-cli` entry.                                                                                            |
| Presets/history persist secret values                                                                      | The `secret` flag prerequisite above; the preset writer refuses to persist any parameter marked secret; history stores parameter names and outcomes, never values; displayed values go through `redactSensitiveLogValue`. |
| A script name shadows a static command (`list`, `inspect`, `run`, `doctor`, `new`, `help`)                 | Verified no current collision; `run <script>` is the always-unambiguous canonical form; add the reserved-name list to `bin/scaffold-script.mjs` and `check-script-scaffold.mjs`.                                          |
| Importing 13 config modules on every invocation slows startup                                              | mtime-keyed cache in `Core.M3LPaths.getCacheDir()`; discovery is lazy so `--help`/`--version`/static commands never pay for it.                                                                                           |
| History file grows unbounded                                                                               | Bounded ring buffer with an explicit cap, mirroring `core/diagnostics/breadcrumbs.ts`'s pattern.                                                                                                                          |
| Best-effort persistence fails (read-only FS, permissions)                                                  | Never fatal — degrade to in-memory for the session, surfaced through `doctor`.                                                                                                                                            |

## Consequences

- **Positive:** the design work is preserved and reviewable rather than
  living only in a plan-mode scratch file; a future "should we build a script
  CLI" question has an immediate, correct default (the design above, gated
  on the revisit trigger) instead of requiring a fresh audit; the wave closes
  without open-ended scope creep.
- **Negative / trade-offs:** the `configParameters` introspection gap
  identified during the audit remains unaddressed until the trigger fires —
  a consumer wanting programmatic access to a script's declared parameters
  still has to read `config.ts` by hand.
- **Semver impact:** none. No code, export, or `exports`-map entry changes;
  this ADR records a design decision and a deferred build, not an
  implementation.

## Update 2026-08-13 — revisit trigger fired; build activated

The first revisit trigger has fired: the maintainer explicitly requested the
build via issue [#333](https://github.com/monte3l/m3l-automation/issues/333)
(a user "asks to browse/inspect the 13 scripts' declared parameters" — and,
beyond that, requested the full phased build-out). The deferral is therefore
lifted; implementation proceeds on `feat/m3l-cli` following the 8b→8g phasing
above, full scope confirmed (8b–8g including the `M3LConfigParameter.secret`
library prerequisite before 8f). The Status stays Accepted — this update
activates the recorded design rather than replacing it.

A pre-build re-verification (2026-08-13) confirmed every design assumption
still holds — 13 ADR-0022-compliant scripts each exporting `configParameters`,
the seam still unconsumed by `bin/` tooling, every named library export
public, no reserved-name collision, no superseding ADR — with **one
correction to the zero-dependency table**:

- **Native type-stripping is not universally sufficient for
  `scripts/*/src/config.ts`.** The table's verification used a single file
  with no relative imports. In the real fleet,
  `scripts/json-etl/src/config.ts` imports `./lib/field-spec.js` — a relative
  `.js` specifier whose target exists only as `src/lib/field-spec.ts`, and
  Node's type-stripping does not rewrite `.js` → `.ts`, so a source import of
  that config fails with `ERR_MODULE_NOT_FOUND`. The discovery loader is
  therefore **dist-first**: prefer `scripts/<name>/dist/config.js` (tsc
  output, always resolvable), falling back to type-stripped `src/config.ts`
  only when `dist` is absent or stale, and failing with a named `M3LError`
  (never a raw stack) otherwise. The mtime cache keys on both `src/config.ts`
  and `dist/config.js`; `doctor` reports unbuilt scripts. The risk-register
  row on type-directed emit (and its ESLint zone) stays — it protects the
  fallback path.

## Update 2026-08-14 — 8b-8g shipped

The full activated phasing has shipped: 8b discovery/introspection +
governance (PR #407), 8c `run` (PR #415), 8d dynamic subcommands (PR #417),
8e `doctor` (PR #418), 8f presets + history (PR #419) atop the
`M3LConfigParameter.secret` library prerequisite (PR #416, m3l-common
2.3.0), and 8g interactive wizard (final PR of the series). The CLI's
living contract is `docs/reference/cli.md`. Two design corrections from
the build are recorded there: the dist-first loader (above) and a
reserved-name set widened to nine (`presets`, `history`, `wizard` joined
the original six as new static commands landed).

## Update 2026-08-14 — library prerequisite gap closed (issue #337)

The "Library prerequisite for 8f" section above set a hard rule: the
`M3LSecretsSpecifier` producer "must ship before 8f, not as part of it." In
practice only half of that prerequisite shipped before 8f — PR #416 added the
`secret?: boolean` flag, but `core/config/M3LSecretsSpecifier.ts` still had no
producer anywhere in the repo when 8f (PR #419) and 8g (PR #420) shipped on
top of it. This was a tracker/ADR bookkeeping gap, not a functional one: the
CLI never depended on the missing producer, because a live class instance
cannot survive the CLI's JSON discovery cache, so 8f's presets/history layer
built its own serializable `M3LCliParameterDescriptor.secret: boolean` field
instead and never needed `M3LSecretsSpecifier` at all. The rule in this ADR
was accurate about what _should_ gate 8f; it was simply never re-verified
against the shipped code before 8f was marked done.

The gap is closed retroactively: `deriveSecretsSpecifier(schema, options?)`
(`core/config`, m3l-common 2.4.0) is now the real producer, deriving an
`M3LSecretsSpecifier` from a schema's declared `secret` parameters, and
`core/logging`'s `redactSensitiveLogValue`/`redactSensitiveLogText` are the
real consumer via a new optional `M3LRedactOptions`. See
`docs/reference/core/config.md` ("Secret parameters") and
`docs/reference/core/logging.md` ("Redacting with a declared secrets
specifier") for the shipped contract. This closes issue #337 and the
corresponding `docs/plans/IMPLEMENTATION.md` tracker row.

## Update (2026-08-18) — the CLI's remit is not extended to orchestration

A maintainer decision recorded in
[ADR-0047](./0047-cross-script-orchestration-deferred.md) establishes that
**cross-script orchestration — sequencing whole consumer scripts and branching on
what each concluded — belongs to `packages/m3l-cli`** when it is built, because
this package already owns workspace discovery, parameter translation, process
spawning and invocation history, and because driving scripts as processes keeps
ADR-0029's dependency boundary intact.

**It is not being built in this programme.** ADR-0047 defers it on the standing
intake gate, with a named multi-script flow as the revisit trigger. This package's
remit therefore stays exactly as the 8b–8g build-out left it; nothing in the
current CLI surface changes.

Recorded here so that a future reader of this ADR does not conclude, from the
placement decision alone, that the orchestrator is in scope for `m3l-cli` today.

## Links

- Related: [ADR-0021 (post-1.0 deepen-first strategy — the broadening intake
  gate this decision applies)](./0021-post-1.0-deepen-first-strategy.md),
  [ADR-0037 (deepen-first re-read — carries the intake gate
  forward)](./0037-deepen-first-re-read-against-consumer-pull.md),
  [ADR-0029 (script dependency boundary — unaffected; the CLI depends on
  scripts' presence, not the reverse)](./0029-script-dependency-boundary.md),
  [ADR-0039 (LLM/Bedrock deferral — same gated-broadening
  pattern)](./0039-llm-integration-out-of-scope.md).
- Source evaluation: `docs/plans/archive/2026-08-13-post-comparison-hardening-wave.md`
  §8.
