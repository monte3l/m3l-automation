# Reaffirm ADR-0012's code-index MCP deferral (ADR-0023)

**Status: shipped** (commit `f44db22`)

## Context

An audit of every ADR (22) and work log (26) for decisions deferred due to
codebase immaturity found the deferral system largely healthy — but ADR-0012
(defer an external code-index MCP) had its revisit trigger half-fire: all 22
library submodules had landed, yet no reconciliation was ever recorded. A
fresh re-assessment was warranted: the repo had crossed ~51k LOC of tracked
TypeScript across 217 files with a ~100k-LOC trajectory still ahead (the
W2–W4 fleet plus gated D4/D5 modules), and Serena had matured to support
TypeScript via LSP backends — but in the same window Claude Code had gained
native LSP integration, and the repo's generated `catalog.json`/
`symbol-map.json` now delivered the O(1) symbol lookup ADR-0012 had
originally designed for.

## Approach / Decisions

- Considered three options: adopt Serena now (TS-capable via LSP backends,
  but adds a Python/`uv` dev-toolchain that friction-tests against
  ADR-0001's toolchain ethos); adopt a Node-only indexer now; or re-affirm
  the deferral on new grounds. Chose the third.
- Decision: the need is already covered by native LSP (the `typescript-lsp`
  plugin is enabled) plus the fully populated generated catalog/symbol-map,
  in an architecture — isolated submodules, independent script packages,
  per-module spec pages, hub-and-spoke Explore briefs — that suppresses
  cross-cutting grep cost.
- New revisit trigger: the W2–W4 fleet lands **and** spoke grep/context
  friction is observed that the catalog cannot answer. If that gate opens,
  Serena (now TS-mature) and a Node-only indexer re-rank against each other
  at that time.
- Alongside the ADR: two new P2-gated rows added to
  `docs/plans/IMPLEMENTATION.md` (the TypeScript 6→7 toolchain-upgrade hold,
  and this ADR-0012/0023 re-affirmation), mirrored into `docs/ROADMAP.md`'s
  gated section.
- A dated correction footnote was added to
  `docs/logs/2026-07-01-core-analysis.md` (divergence 5): its deferred
  `check-impl-counts.mjs` whitespace-normalization item targeted
  `docs/index.html`, which no longer exists — the item is obsolete, not
  pending.
- `scripts/example-automation/` (ignored build detritus only — `dist/`,
  `node_modules/`, zero git-tracked files) was deleted to align the working
  tree with its already-recorded ADR-0019/0022 removal.
- Explicitly out of scope: implementing the F-series P0 friction items
  themselves (already correctly tracked; separate future work), and any
  `src`/`tests` changes.

## Outcome

Landed as a docs-only PR: new
`docs/adr/0023-reaffirm-code-index-mcp-deferral.md`, with
`docs/adr/README.md`'s ADR-0012 row annotated "Re-affirmed by ADR-0023."
ADR-0012's own body stayed immutable, per the archive convention.
