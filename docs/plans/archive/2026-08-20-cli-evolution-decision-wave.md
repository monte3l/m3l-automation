# CLI-first evolution — exploratory design and decision wave

**Status: shipped** — PR `feat/cli-evolution-docs` (U1 of the programme).

## Context

The user asked for an exploratory design of the project's evolution "from a
simple collection of packages, libraries and scripts to a fully fledged CLI
application" — investigate, interview, propose designs, then write the
documentation and tracker items for future implementation.

An `/auditing` fan-out over five facets (current `m3l-cli` state, the
deferral ADRs, the consumer-script landscape, library building blocks, and
the docs/governance surface — 20 agents, adversarial verification) found the
ADR-0042 launcher complete (8b–8g all shipped) but architecturally bounded:
spawn-only dispatch, operations as opaque `oneOf` strings invisible to every
introspection surface, no orchestration (ADR-0047 deferred on a named-flow
trigger), no completion, the reserved-but-unbuilt `new` command, no
retry/resume surfacing, no CLI structure/doc gates, no tracker series, and
no distribution/versioning stance. Eight further findings were refuted by
the verify pass (unified invocation and logging consistency exist).

## Approach / Decisions

A three-round maintainer interview settled every fork:

- **End state — all four pillars**: deepened launcher, CLI-first
  restructure, orchestration platform, distributable product.
- **Hybrid execution** over spawn-only or in-process-only: spawn stays the
  default; a typed opt-in `commandModule` seam is added (ADR-0054).
- **Selective promotion** over a full `core/cli` framework or a
  convention-only contract: descriptor types, exit-code mapping, and an
  output port promote to `m3l-common` (a future `core/cli-contract`,
  Core 22 → 23); parsing/routing/help stay CLI-private. ADR-0029 holds.
- **Workspace plugins** over merge-into-one-app or dynamic plugin install:
  scripts stay packages and add the typed export; the CLI depends on them.
- **Orchestration activated**: the maintainer named the first real flow —
  sqs-etl → json-etl → dynamodb-crud → sqs-etl (dump queue, extract,
  compare against DynamoDB, selectively delete) — firing ADR-0047's
  trigger; `m3l flow` in `m3l-cli`, spawn-first (ADR-0056).
- **Phased distribution**: private GitHub Packages npm registry first
  (ADR-0057, partially superseding ADR-0020 with survivors enumerated);
  Node SEA binary recorded but gated behind a future bundler-exception ADR.
- **Tracker identity**: U-series rows reuse the registered `impl:cli:*`
  namespace and the Capability issue type — zero sync-code or
  label-taxonomy changes, verified against `bin/lib/hub-sync.mjs` before
  authoring.

## Outcome

Shipped as U1: ADR-0053…0057 + index rows; Update blocks on ADR-0042/0047;
ADR-0020 marked partially superseded; the dated programme plan
`docs/plans/2026-08-20-cli-evolution.md` (U1–U14 decomposition, target
`cli.md` structure for the future `check:cli-docs` gate); U-series rows in
`IMPLEMENTATION.md` § m3l-cli build-out and a sync-skipped ROADMAP wave
subsection; the filing-work legend gains U-series under Capability; and the
`required`/`defaultValue`/bare-optional config-declaration rule lands in the
style guide + `.claude/rules/scripts.md`. All 40 `pnpm verify` steps green;
`sync:hub-issues` dry-run previews 13 U-issues with clean keys.
