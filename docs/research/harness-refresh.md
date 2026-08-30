# Harness refresh tracker

<!-- harness-refresh: last-verified=unset claude-code-version=unset -->

Living record of `/refreshing-anthropic-guidance` sweeps — the per-facet,
per-source state a run diffs against, so each sweep reports what **changed**
since the last one instead of rediscovering the whole harness from scratch.
Unlike the dated point-in-time snapshots in this directory, this file is
updated **in place** on every run; `docs/research/README.md`'s index links
here rather than listing dated copies. Read
[`docs/research/README.md`](README.md) for the directory's general
conventions and the `refreshing-anthropic-guidance` skill for how this file
is produced and consumed.

This is a stub — no sweep has run yet, hence `last-verified=unset`.
`check:harness-freshness` (ADR-0082) treats `unset` the same as "more than
the staleness threshold old": it warns on every `pre-push` until the first
real sweep sets a real date, rather than a scaffolded-but-empty tracker
silently reading as fresh. The five facet sections below are seeded empty —
the first real sweep populates them with recorded claims and replaces both
`unset` values.

## Outstanding drift

_None recorded yet — first sweep pending._

## Facets

### Models & tiering

_No sources recorded yet._

### Claude Code features & settings

_No sources recorded yet._

### Agent & subagent design

_No sources recorded yet._

### Skills & context engineering

_No sources recorded yet._

### Hooks & lifecycle

_No sources recorded yet._
