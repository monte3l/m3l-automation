# 0009. Dependency-direction guard: import-x/no-restricted-paths vs dependency-cruiser

- **Status:** Proposed
- **Date:** 2026-06-28
- **Deciders:** m3l-automation maintainers

## Context and problem statement

An enforcement audit of rules 01–04 found that **dependency direction / module
layering is not enforced automatically**. SOLID's Dependency Inversion (rules 03) and the architecture's layering intent (rules 04) — e.g. "high-level policy
must not reach into low-level mechanism", or "a cross-cutting submodule must not
import an application-framework submodule" — currently rely only on review
subagents (`code-reviewer`, `spec-conformance-reviewer`), which is
non-deterministic.

Today the only deterministically-guarded boundary is `internal/` privacy,
enforced by an `import-x/no-restricted-paths` zone on the three public barrels
(see `eslint.config.js` and [ADR-0004](./0004-exports-map-contract.md)). That is
sufficient _now_ only because `src/` is still an empty scaffold (three barrels +
an empty `internal/`) — there is no inter-submodule layering to protect yet.

This ADR records the decision to add a broader dependency-direction guard, and
which tool to use, **so it is not relitigated** when submodules start landing.

## Decision drivers

- **Minimal dependencies** — the project keeps both runtime and dev tooling
  lean; a new tool must earn its place.
- **Deterministic enforcement** — move layering rules from advisory review to a
  blocking gate (rules 03/04), consistent with the rest of the CI pipeline.
- **No premature tooling** — there is nothing to enforce until a real layering
  exists; adding rules with zero targets is waste.
- **Shallow import graph / tree-shaking** — layering rules should reinforce the
  existing performance constraints, not fight them.

## Considered options

1. **`import-x/no-restricted-paths` zones** — reuse the already-installed
   `eslint-plugin-import-x`. Runs inside `pnpm lint` (no new dependency, no new
   CI step). Expresses "files in zone A may not import from zone B" via
   path-based `zones`. Already proven here for the `internal/` boundary. Limited
   to path/glob zones; cannot express richer graph constraints (orphans,
   cycles, reach-through-N-hops).
2. **`dependency-cruiser`** — a dedicated dependency-graph linter with a richer
   rule language (forbidden/allowed edges, cycle detection, orphan detection,
   reachability), plus graph visualization. Adds a dev dependency, its own
   config file, and a CI step. Heavier, but scales to complex layering.
3. **Do nothing — rely on review** (status quo). Zero tooling cost;
   non-deterministic and inconsistent with the project's "make it a gate"
   posture.

## Decision

**Proposed (deferred).** When Core submodules establish a layering worth
enforcing, start with **option 1 (`import-x/no-restricted-paths`)** because it
adds zero dependencies, runs in the existing lint gate, and matches the pattern
already in use. **Escalate to option 2 (`dependency-cruiser`)** only if the
layering outgrows path-based zones (e.g. cycle/orphan detection or
many-to-many edge constraints become necessary).

**Trigger to revisit:** the first time two or more implemented Core submodules
import one another, or a documented layer ordering exists in
`docs/m3l-common-architecture.md`. The natural seam is the `implement-submodule`
pipeline producing real inter-module imports.

## Consequences

- **Positive:** records the intent and the tool choice now, so the guard can be
  added at the right moment without re-debating; keeps dependencies minimal by
  defaulting to the tool already present.
- **Negative / trade-offs:** until the trigger fires, dependency direction
  between submodules remains review-enforced (non-deterministic). Path-based
  zones may later prove insufficient, forcing the option-2 migration this ADR
  anticipates.
- **Semver impact:** none — these are dev-time lint/CI gates with no effect on
  the published `exports` map or runtime behavior.

## Links

- Related: [ADR-0004 (exports map / `internal/` privacy)](./0004-exports-map-contract.md),
  `eslint.config.js` (`import-x/no-restricted-paths` zone),
  `docs/contributing/branch-protection.md`, rules `03-design-principles-and-patterns.md`
  and `04-architecture.md`.
