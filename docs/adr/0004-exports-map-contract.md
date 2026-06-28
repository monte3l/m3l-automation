# 0004. Three-entry exports map as the public contract

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

`@m3l-automation/m3l-common` exposes its API exclusively through the Node.js
`exports` map in `package.json`. Before the first public release the team needed
to decide how many entries to expose — one flat entry, one per submodule, or a
small set of namespace entries. The choice has direct semver implications: every
entry in the `exports` map is a stable public contract that cannot be removed or
retyped without a major version bump.

## Decision drivers

- Minimal public surface area; internal helpers must not be importable by
  consumers.
- The `exports` map is the sole mechanism for semver enforcement of access
  paths.
- New submodules must be addable without expanding the `exports` map (to avoid
  constant minor bumps).
- `publint` and `@arethetypeswrong/cli` (`attw`) validate the map in CI.

## Considered options

1. **Single `.` entry** — everything re-exported from one barrel. Simple but
   monolithic; prevents tree-shaking by namespace; one barrel import pulls all
   submodules.
2. **Per-submodule entries** — one entry per submodule (e.g., `./errors`,
   `./config`, `./logging`). Fine-grained but creates a wide contract surface
   costly to maintain under semver; every new submodule is a minor release;
   renaming one is a major.
3. **Three-namespace entries** (chosen) — `.` (re-exports both namespaces),
   `./core` (Core namespace), `./aws` (AWS namespace). New submodules surface
   through the namespace barrel, not as new paths.

## Decision

1. **The map has exactly three entries: `.`, `./core`, and `./aws`.** Each maps
   to a `types` (`.d.ts`) and a `default` (ESM `.js`) condition — no `require`
   condition (see ADR 0002). Adding, removing, or retyping any of these three
   entries is a semver event: removal or retypes are breaking (major); a new
   fourth entry is additive (minor).

2. **New submodules are surfaced through the namespace barrel, not new `exports`
   entries.** Adding `src/core/logging/` means re-exporting it from
   `src/core/index.ts` — the `./core` entry is unchanged and no version bump is
   required beyond what the new symbols warrant.

3. **`src/internal/` is never added to the `exports` map.** It has no `exports`
   entry and may change freely without a semver bump. `publint` and `attw
--profile esm-only` in CI enforce that the map stays valid and ESM-correct.

## Consequences

- **Positive:** a stable, narrow contract; consumers import from
  `@m3l-automation/m3l-common`, `@m3l-automation/m3l-common/core`, or
  `@m3l-automation/m3l-common/aws`; the CI gate catches exports-map drift on
  every PR.
- **Negative / trade-offs:** consumers cannot do fine-grained submodule imports
  (e.g., `…/core/errors`) — they must go through the namespace barrel. This is
  intentional: it keeps the contract surface small.
- **Semver impact:** any change to the three-entry set is at minimum a minor
  (addition) or major (removal or retypes). Internal changes and new submodule
  re-exports via a barrel are not semver events.

## Links

- Related: ADR 0002 (ESM-only — the `default`-only condition in each entry),
  `packages/m3l-common/package.json` (the live exports map), `package.json`
  (`check:exports` script), `src/core/index.ts`, `src/aws/index.ts`,
  `src/internal/`.
