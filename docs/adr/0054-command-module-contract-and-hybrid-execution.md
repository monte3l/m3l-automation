# 0054. Typed command-module contract and hybrid execution

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

Every execution path in `m3l-cli` today — `run`, the dynamic per-script
subcommand, the wizard — re-serialises parsed parameters back to
`--name=value` argv and spawns `scripts/<name>/dist/main.js` as a child
process (`packages/m3l-cli/src/run/spawn.ts`). The audit confirmed there is
no in-process execution mode and no direct parameter-to-step binding
anywhere. That boundary is a feature (isolation, signal handling, terminal
ownership) but it caps the product: progress cannot stream structured data
back to the CLI, cancellation crosses a process boundary, orchestration can
branch only on exit codes, and nothing works when the workspace — the thing
discovery scans — is absent, which blocks any distribution story
(ADR-0057).

Separately, the CLI privately implements every CLI-framework primitive
(parsing, routing, help, suggestion, exit-code mapping, TTY-aware output). If
scripts are to become modules of one application, the module contract needs a
typed home that does not invert ADR-0029.

## Decision drivers

- **ADR-0029 must hold verbatim:** every `scripts/*/package.json` declares
  exactly `{"@m3l-automation/m3l-common": "workspace:*"}`. A contract living
  in `m3l-cli` would force scripts to import the CLI — an inversion and a
  dependency cycle.
- **Spawn must remain first-class:** per-script Lambda exposure, direct
  `pnpm --filter` invocation, and the run-report/exit-code contract all
  assume a script owns its process.
- **Minimal public-API growth** (W5 promotion precedent: promote only what
  has two or more demonstrated consumers).
- **Illegal states unrepresentable:** an untyped or convention-only seam that
  the CLI casts into shape is the exact `any`-shaped boundary the project
  forbids.

## Considered options

1. **Keep spawn-only.** Rejected: forecloses in-process binding,
   fine-grained orchestration, and distribution.
2. **Full promotion — a `core/cli` framework submodule** (parsing, routing,
   help, output, all public). Rejected: freezes single-consumer APIs into
   the semver contract while the restructure needs them fluid, and grows the
   documented Core surface far beyond demonstrated need.
3. **Keep everything CLI-private, contract by convention.** Rejected: the
   contract types would have no importable home for scripts (ADR-0029
   inversion) and the seam would be untyped.
4. **Hybrid execution + selective promotion of the contract only.** Chosen.
5. **Merge scripts into the CLI package** (packaging alternative). Rejected:
   dissolves fourteen packages' identity, tests, per-script gates, ESLint
   zones and reference pages — the repo's largest possible migration for no
   user-visible capability.
6. **Dynamic plugin install** (`m3l plugin add`). Rejected for a
   single-maintainer fleet: plugin resolution, compatibility matrix, and
   integrity verification machinery with no third-party authors in sight.

## Decision

We chose **options 4** (execution + contract) with the **workspace-plugins**
packaging model from the comparison in options 5/6.

### The contract (promoted to `m3l-common`, additive minor)

A new Core-barrel submodule — working name **`core/cli-contract`** (final
name settled at implementation; Core submodule count 22 → 23 via
`gen:counts` when it ships) — carrying only:

- **Command-module descriptor types** — the shape a script exports to become
  a command module: identity, its declared `configParameters` (the existing
  seam), its declared operations (ADR-0055), and a typed `execute` entry
  that accepts bound parameters plus an execution context (logger port,
  `AbortSignal`, dry-run flag) and resolves to a typed outcome.
- **The exit-code mapping surface** — re-exposing the ADR-0035 registry
  mapping so the CLI maps an in-process outcome to the same code the child
  process would have exited with. No new codes are minted here; if flow
  orchestration needs new codes that is an ADR-0035 Update at ADR-0056's
  implementation time.
- **An output/logger port** — the interface through which a hosted script
  writes, so in-process output routes through the CLI's stream (TTY/`NO_COLOR`
  handling, redaction) instead of raw `process.stdout`.

Parsing, routing, help rendering, suggestions, tables, and the discovery
cache stay `m3l-cli`-private and free to change.

### Hybrid execution

- **Spawn stays the default** for `run`, dynamic subcommands, and the
  wizard. Behaviour, exit codes, and terminal ownership are unchanged.
- A script **opts in** by exporting a `commandModule` (the descriptor above)
  from a declared entry point. The CLI may then execute it **in-process**:
  parameters bind directly (no argv re-serialisation), cancellation forwards
  the CLI's `AbortSignal` (ADR-0049), and output flows through the port.
- **Guarantee parity, defined now:** the in-process path wraps the same
  composition root the child would run — config resolution, lifecycle hooks,
  AWS provisioning, and `run-report.json` writing all still happen, because
  the entry composes `M3LScript`/`runScript`, not a bypass of them. Named
  errors map through the same registry. `process.exit` is **forbidden** in
  the command-module path — outcomes resolve as values; the ESLint script
  zone gains that ban when the seam ships.

### Packaging: workspace plugins

Scripts remain separate workspace packages — tests, coverage, gates,
W-series identity, per-script docs all intact — and each **adds** the
`commandModule` export (scaffold template updated; adoption is additive and
per-script). The CLI declares script packages as real `dependencies`, so
discovery can resolve over the dependency graph rather than directory
scanning — the property that makes publication (ADR-0057) possible. The
dependency direction is CLI → script, which ADR-0029 and `check:script-deps`
permit (they constrain scripts only).

## Consequences

- **Positive:** a typed, end-to-end in-process seam with ADR-0029 intact;
  spawn preserved for isolation-sensitive uses and Lambda; the contract has
  two-plus consumers (the CLI and every adopting script) on day one;
  orchestration and distribution both gain the seam they need.
- **Negative / trade-offs:** two parsing implementations continue to coexist
  (script config loader; CLI `parseArgs`) — reconciled by the contract, not
  merged; in-process execution shares one process, so a misbehaving script
  can affect the CLI (mitigated by the `process.exit` ban and the ports, and
  spawn remains available); later promotions out of the CLI remain possible,
  each its own semver event.
- **Semver impact:** none from this ADR (docs only). Implementation is an
  **additive minor** on `m3l-common` (new barrel submodule; Core 22 → 23;
  `check:api` unaffected — barrel-surfaced symbols only, no new `exports`
  subpath).

## Update (2026-08-26) — the contract as implemented

U3 shipped the contract as `core/cli-contract` (PR for issue #527). Four points
where the implementation refines what this ADR recorded:

**The submodule name is `core/cli-contract`.** This ADR left it open; the
tracker's working name was kept, so no doc churn was needed.

**The count is Core 23 → 24, not 22 → 23.** The "22 → 23" in Consequences above
(and in the U3 tracker rows) was authored on 2026-08-20. `core/procedure`
landed on 2026-08-21 and consumed 22 → 23, making this ADR's figure stale
before U3 began. The fleet total is 42 → 43. `gen:counts` derives every count
site from the filesystem, so only the hand-written prose was wrong; the tracker
rows are corrected in the U3 PR.

**ADR-0055's operations field is deliberately absent.** The serialisable
operation declaration lands in `core/config` at U4; the descriptor is widened
then, as a second additive minor. No placeholder type was shipped, so U4 is a
clean addition rather than a replacement.

**The `M3LScript`/`runScript` composition could not live in the contract — an
ADR-0009 constraint this ADR did not anticipate.** The "guarantee parity" clause
of § The contract assumes the descriptor's `execute` composes
`M3LScript`/`runScript`. It cannot: `eslint.config.js` defines a layering zone
forbidding any `core/**` module from importing `core/script` (the composition
root), asserted by `bin/check-eslint-zones.mjs`. The rule is
`import-x/no-restricted-paths`, which is not type-aware, so even `import type`
is blocked.

`core/cli-contract` therefore defines its types structurally and imports nothing
from `core/script`. The composition moves to the adopting script's entry file
(U6) and the CLI's in-process host (U7) — both outside the zone. **No zone
widening was performed and no new ADR was raised**: ADR-0040 and ADR-0041 are
the widening precedent and each cost its own ADR, which is disproportionate for
one tracker item whose requirement is satisfied without it.

The consequence worth stating plainly: the parity guarantee is a **convention**,
not a type-level guarantee. Nothing in `core/cli-contract` proves a given
`execute` composed `M3LScript`. It is enforced by `templates/script/`'s shape at
U6, by `check:script-scaffold`, and by structural type tests that prove the
seams line up (`M3LCommandModule` satisfies `M3LScriptMetadata`;
`M3LCommandContext["logger"]` is exactly what `M3LScriptOptions.logger` accepts)
— never that the composition happened.

A related mechanical finding: the exit-code surface could not be a bare
re-export of `mapErrorToExitCode`. The Core barrel is
`export * from "./<mod>/index.js"` per submodule, so the same name arriving from
both `core/diagnostics` and `core/cli-contract` is TS2308 at compile time and a
silently dropped export under ES module semantics. It shipped instead as a
distinct symbol built on the same registry — `mapCommandOutcomeToExitCode`,
an outcome→code mapper — which is what this ADR's "so the CLI maps an
in-process outcome to the same code the child process would have exited with"
actually asks for. It mints no new codes.

## Update (2026-08-26) — U7a: the host seams, as implemented

U6 left three consequences standing (recorded in this ADR's first Update
above): two composition sites in an adopting script, `execute` accepting but
not forwarding `context.output`/`logger`/`signal`, and `TParameters` stuck at
`Record<string, never>` because `M3LScriptOptions` had no seam to inject
host-bound values. U7's first slice (U7a, PR for issue #531) closes the
library-side half of all three, before the CLI itself calls any of it.

**The `M3LScriptOptions.loggerHandler` idea from this ADR's own "output/logger
port" phrasing does not work, and the reason is worth recording.** The
descriptor's `execute` receives `M3LCommandContext.logger`, a **built**
`M3LLogger` — not a handler list — so there is nothing on the context for a
script to inject a handler into. The seam that actually closes the gap is a
factory, not an injection point: `core/cli-contract/logger.ts`'s
`createCommandLogger(options)` takes a host's raw `M3LLoggerHandler[]` plus
the command's `configParameters`, and internally applies the exact policy
`M3LScript`'s own default-logger construction already applies —
`resolveLogLevelFloor()` plus `deriveSecretsSpecifier()` — over the host's
handlers instead of a hardcoded console one. This is legal because
`core/cli-contract` may import `core/logging`/`core/config`/`internal/**`
freely; the ADR-0009 zone (below) bans only `core/**` → `core/script`. A
script's `execute` can then safely do `logger: context.logger` — the seam this
ADR wanted, delivered by a different shape than first assumed.

**Parameter binding replaces, not layers over, precedence level 1 — a
correction to how far this ADR's language went.** `M3LScriptOptions.host`
(module-private `M3LScriptHostOptions`, following this file's existing
unexported-inline-options precedent) supplies `parameterValues` bound in
place of the command-line provider, never above it: layering would leave the
_host's own_ `process.argv` live at level 1, so a flag on the host's
invocation (`m3l --json --in-process s3-objects`) could leak into a script
declaring an unrelated `json` parameter — a contamination class the spawn
path cannot have. A bound value reports `config.sourceOf() === "cli"` (a new
optional `sourceLabel` constructor argument on `M3LInMemoryConfigProvider`,
additive), so a hosted run's `run-report.json` cannot be told apart from a
spawned one's by provenance alone — the parity property this ADR names.

**Cancellation forwarding required suppressing this library's own shutdown
handlers, not merely adding a new one.** `M3LScriptOptions.host` present (even
`{}`) skips `registerShutdownSignals`'s `SIGTERM`/`SIGINT`/`SIGQUIT`
registration entirely — a hosted script installing its own would tear down
the host's _other_ work on the first Ctrl-C — and bridges `host.signal`
instead, aborting `script.signal` before running cleanup, the same ordering
the non-hosted path already used. This closes the "hosted command still
terminates its host on a double signal" gap the previous Update recorded:
`runScript`'s own `installProcessGuards`/`pushForcedSignalExitCode` needed no
change, because they only ever affected the handlers `host` now suppresses.

**The four duplicated pilot helpers (this ADR's original "check:dup headroom"
gate on fleet adoption) are promoted, split across two submodules by the same
ADR-0009 zone.** `consoleOutput` → `createCommandOutput` and the abort
predicate + outcome derivation → `deriveCommandOutcome` land in
`core/cli-contract` (both name only symbols that module may already reach).
The fourth, `captureFailures` → `captureRunFailures`, could **not** land
there: it returns `M3LScriptLifecycleHooks`, and the zone forbids
`core/cli-contract` from naming anything in `core/script` even structurally
without re-declaring the whole hook contract as a second source of truth. It
lands in `core/script` instead, next to `runScript`, its only real neighbor.
The three U6 pilots and `templates/script/src/command.ts.tmpl` were rewritten
in the same PR to consume all four promotions, which is what actually clears
the `check:dup` headroom this ADR's fleet-adoption gate depends on.

**Two new runtime guards close a hostile-boundary gap this ADR did not
originally name.** `isM3LCommandModule`/`isM3LCommandOutcome`
(`core/cli-contract/guards.ts`) are the type guards a host needs before it can
trust a foreign `dist/`'s export or whatever a foreign `execute` resolved to
— reachable only once the CLI's in-process host (U7's next slice) actually
`import()`s untrusted code, but shipped now so that host is written against
them rather than the guards being extracted from it afterwards. Both carry the
same never-throws, read-each-property-once discipline
`mapCommandOutcomeToExitCode` already established, deliberately: a `Proxy`, a
throwing getter, or a revoked handle are all reachable at this boundary, and a
guard that threw would cost the caller the one answer it asked for.

None of this required a zone widening or a new ADR — every seam above
composes with the existing ADR-0009 boundary rather than crossing it, and the
whole slice remains an additive `m3l-common` minor (Core stays 24; no new
`exports`-map subpath; `check:api` unaffected).

## Links

- Programme: [ADR-0053](./0053-cli-first-evolution-programme.md). Operations
  model: [ADR-0055](./0055-declarative-operation-introspection.md).
  Orchestration consumer: [ADR-0056](./0056-cross-script-orchestration-engine.md).
  Distribution dependent: [ADR-0057](./0057-private-registry-distribution.md).
- Related: [ADR-0029 (the boundary preserved)](./0029-script-dependency-boundary.md),
  [ADR-0035 (exit-code registry reused)](./0035-failure-reporting-and-diagnostics.md),
  [ADR-0049 (the cancellation signal forwarded)](./0049-cooperative-cancellation-contract.md),
  [ADR-0018 (the options bag the entry composes)](./0018-shared-script-options-bag.md),
  [ADR-0042 (the CLI this extends)](./0042-script-cli-package-deferred.md).
