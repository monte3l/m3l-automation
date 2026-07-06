# 0003. Node 24 as the minimum runtime floor

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Enrico Lionello

## Context and problem statement

`@m3l-automation/m3l-common` and its automation scripts need a Node.js runtime floor. The choice determines which native platform features can be used unconditionally and which polyfills (if any) are needed. The decision was made implicitly when the repo was set up; this ADR formalises it.

## Decision drivers

- Prefer platform-native features; eliminate polyfill dependencies entirely.
- Node 24 is the current Active LTS; pinning to it aligns the library's lifecycle with the Node release schedule.
- `engine-strict=true` in `.npmrc` ensures developers and CI fail loudly if the wrong Node version is active.
- Automation scripts (primary consumers) run in controlled environments where the Node version can be pinned.

## Considered options

1. **Node 18 LTS** — oldest still-maintained LTS at time of writing; lacks native `--env-file` and `--env-file-if-exists`; would require a dotenv dependency.
2. **Node 20 LTS** — has `--env-file` (added in 20.6) but lacks `--env-file-if-exists` (added in 22.4); missing later stdlib improvements.
3. **Node 24 LTS** (chosen) — active LTS; has `--env-file-if-exists`, native `fetch`, improved `structuredClone`, and `--watch` stability; no dotenv needed.

## Decision

We chose **Node 24 LTS** as the runtime floor because it is the active LTS release and ships with every native feature the library and scripts rely on unconditionally — most critically `node --env-file-if-exists`, which eliminates the need for a dotenv dependency. Node 18 and 20 were rejected because they require dotenv as a polyfill, contradicting our non-negotiable "minimal runtime dependencies" constraint. The floor is pinned in `.node-version` (for local version managers like fnm/nvm/mise), declared in `engines.node: ">=24"` across all package.json files, and enforced by `engine-strict=true` in `.npmrc`. The `ci.yml` workflow is locked to `node-version: 24`.

## Consequences

- **Positive:** no dotenv or polyfill runtime dependency; `--env-file-if-exists` used natively in automation scripts; clean, unambiguous runtime contract.
- **Negative / trade-offs:** consumers cannot run the library on Node 18 or 20. For automation scripts in controlled environments this is an acceptable trade-off; it would be a concern for a general-purpose library targeting broader Node audiences.
- **Semver impact:** none (Node 24+ from day one; no existing consumers).

## Links

- Related: `.node-version`, `.npmrc` (`engine-strict=true`), root `package.json` (`engines`), `packages/m3l-common/package.json` (`engines`), `.github/workflows/ci.yml`.
- Related: ADR 0001 (toolchain choices), ADR 0002 (ESM-only output — also requires Node 22+ for consumers, but Node 24 is the producer floor).
