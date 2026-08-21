# 0053. CLI-first evolution programme: from launcher to product

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The repo has grown in three layers: `@m3l-automation/m3l-common` (the library),
fourteen consumer scripts under `scripts/*`, and `packages/m3l-cli` — the
launcher that ADR-0042's fired trigger activated and that shipped its full
8b–8g scope (`list`, `inspect`, `run`, dynamic per-script subcommands,
`doctor`, `presets`, `history`, `wizard`; contract in
[`docs/reference/cli.md`](../reference/cli.md)).

A five-facet audit (2026-08-20) of "what separates this from a fully fledged
CLI application" confirmed the launcher is complete but architecturally
bounded: dispatch is spawn-only with parameters re-serialised to child argv;
per-script operations are opaque `oneOf`-validated strings invisible to every
introspection surface; there is no cross-script composition (ADR-0047,
deferred); no shell completion; the reserved `new` command was never built;
the library's retry/resume/cancellation machinery is not reachable from the
CLI; and the CLI has no distribution story, no structure/doc gates, and no
tracker series.

The maintainer has decided the project's next programme is to evolve this
collection into **one CLI-first product**. This ADR records the programme's
direction, scope, and phasing; the technical contracts each phase implements
are separate decisions (ADR-0054 through ADR-0057).

## Decision drivers

- **Consumer pull is now real.** ADR-0021/0037's intake gate asks for named
  need; the maintainer has named one, including the first concrete
  multi-script flow (recorded in ADR-0056) — the exact trigger ADR-0047 set.
- **Preserve what works.** Fourteen shipped scripts, their tests, gates,
  W-series identity, and ADR-0029's dependency boundary must survive the
  restructure.
- **Gated broadening still applies.** Each phase lands against its own
  trigger; speculative surface (notably a single-file binary) stays gated.
- **Minimal public-API growth.** Whatever the restructure promotes into the
  library must clear the same bar every promotion has cleared: two or more
  demonstrated consumers (the W5 precedent).

## Considered options

1. **Deepen the launcher only** — close the UX gaps, keep the architecture.
   Rejected as the whole answer: it leaves the CLI workspace-bound and cannot
   deliver orchestration or distribution.
2. **Rebuild as a single merged application** — dissolve `scripts/*` into the
   CLI package. Rejected: the largest migration in the repo's history,
   destroying per-script identity, tests, and gates for no capability gain
   (ADR-0054 records the packaging comparison).
3. **Evolve in place: a phased CLI-first programme** — the launcher grows a
   typed plugin seam, scripts stay packages and join it additively, and
   orchestration/distribution land as gated phases. Chosen.

## Decision

We chose **option 3**. The programme has four pillars, phased A → B → C:

1. **Deepened launcher** — declarative, enumerable per-script operations
   (ADR-0055), shell completion, `m3l new` (activating the long-reserved
   name; scaffolding moves from `bin/scaffold-script.mjs` into the CLI,
   including a Lambda variant), and CLI-level surfacing of the library's
   retry/resume/cancellation machinery (ADR-0045/0049).
2. **CLI-first restructure (Phase A)** — a typed `commandModule` contract
   with **hybrid execution**: spawning `scripts/<name>/dist/main.js` remains
   the default; an opt-in in-process path binds parameters directly. Contract
   types promote selectively into `m3l-common`; scripts remain separate
   workspace packages that the CLI depends on (ADR-0054).
3. **Orchestration platform** — the cross-script orchestration engine lands
   in `m3l-cli` against the named flow that fired ADR-0047's trigger
   (ADR-0056). Its command name is **`flow`**, added to the reserved set.
4. **Distributable product (Phases B/C)** — Phase B publishes the CLI, the
   library, and the script fleet to a **private GitHub Packages npm
   registry** (ADR-0057). Phase C — a Node SEA single-file binary — is
   **recorded, not opened**: it requires a bundler exception to
   ADR-0001/0002 and stays gated behind its own future ADR.

**Tracker identity.** The programme's work is the **U-series** (U1–U14),
tracked as rows in `docs/plans/IMPLEMENTATION.md`'s existing
"m3l-cli build-out" section (keys `impl:cli:u*`, Issue Type `Capability` —
no sync-code or label-taxonomy change) with a coarse summary subsection in
`docs/ROADMAP.md` Priority 0. Phase detail lives in
[`docs/plans/2026-08-20-cli-evolution.md`](../plans/2026-08-20-cli-evolution.md).

**Governance.** The programme adds the two missing machine gates — a
`packages/m3l-cli` structure gate and a `docs/reference/cli.md` doc-structure
gate, mirroring `check:script-scaffold`/`check:script-docs` — and reserves
the new command names `flow` and `completion` alongside the existing nine.

**Relationship to ADR-0046 (`core/procedure`).** The two engines are
deliberately uncoupled: `core/procedure` (B2, not yet implemented) sequences
steps **inside** one script; ADR-0056's engine sequences **whole scripts** as
processes. The U-series neither depends on nor blocks B2/W7; sequencing
between the programmes is a maintainer priority call recorded in the
trackers, not a technical dependency.

## Consequences

- **Positive:** the "collection of packages and scripts" gains a single
  product identity with a recorded end state; every capability gap the audit
  confirmed now has a home, an ADR, and a tracker row; distribution becomes
  possible without dissolving the workspace architecture.
- **Negative / trade-offs:** the programme is large (fourteen tracker
  phases); fleet versions move together once published (accepted in
  ADR-0057); two parsing implementations (script config loader, CLI
  `parseArgs`) continue to coexist, reconciled by contract rather than by
  shared code (accepted in ADR-0054).
- **Semver impact:** none from this ADR (docs only). The programme's library
  phases are additive minors, each recorded in its own ADR.

## Links

- Implements the decision set: [ADR-0054](./0054-command-module-contract-and-hybrid-execution.md),
  [ADR-0055](./0055-declarative-operation-introspection.md),
  [ADR-0056](./0056-cross-script-orchestration-engine.md),
  [ADR-0057](./0057-private-registry-distribution.md).
- Related: [ADR-0042 (the launcher this evolves)](./0042-script-cli-package-deferred.md),
  [ADR-0047 (orchestration placement + fired trigger)](./0047-cross-script-orchestration-deferred.md),
  [ADR-0021](./0021-post-1.0-deepen-first-strategy.md) /
  [ADR-0037](./0037-deepen-first-re-read-against-consumer-pull.md) (the intake
  gate this programme passes through), [ADR-0029 (the boundary the restructure
  preserves)](./0029-script-dependency-boundary.md),
  [ADR-0046 (the uncoupled in-script engine)](./0046-codified-procedure-engine.md).
- Plan: [`docs/plans/2026-08-20-cli-evolution.md`](../plans/2026-08-20-cli-evolution.md).

## Update (2026-08-21): tracker identity re-homed by ADR-0073

The Tracker identity paragraph above recorded the U-series as living in
`docs/plans/IMPLEMENTATION.md`'s "m3l-cli build-out" section under keys
`impl:cli:u*` with Issue Type `Capability` and "no sync-code or label-taxonomy
change". [ADR-0073](0073-hub-board-classification-and-hierarchy.md) changes all
three: that section held this programme plus the V- and X-series, which is what
made 48 of 60 open board items type `Capability`. The U-series now lives in its
own `## CLI evolution wave (U-series)` section under keys
`impl:cli-evolution:u*` (the old keys retained as `legacyKeys`, so no issue is
re-filed), and its rows carry the layer-based Issue Types — mostly
`CLI capability`, with `Library capability` for U3/U4, `Fleet retrofit` for
U5/U6, `Tooling & gates` for U2, `Infrastructure` for U13/U14, and
`Governance` for U1. The programme's scope, phases, and plan document are
unaffected; only its tracker address and classification move.
