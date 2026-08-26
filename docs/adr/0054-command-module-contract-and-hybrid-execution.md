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
