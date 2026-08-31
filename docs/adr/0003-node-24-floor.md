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

## Amendment (2026-08-31) — the pin is now enforced, and `fnm` is the version manager

Two enforcement claims above are wrong, and the cost of that was measurable.
Corrected here rather than by rewriting the original decision, per this
directory's append-only amendment convention.

- **`engine-strict=true` does not enforce this floor.** Decision drivers
  (line 15) and the Decision (line 26) both claim `engine-strict=true` in
  `.npmrc` makes developers and CI "fail loudly if the wrong Node version is
  active". That is false in the direction that actually occurs. `engines.node`
  is `">=24"` — a floor with **no ceiling** — so a machine running Node 26
  satisfies the range and `engine-strict` can never fire. The mechanism only
  ever guarded the _below-floor_ case, which no development machine here has
  hit; the case that did occur, and that cost real debugging time, was running
  _above_ it.
- **`.node-version` was authoritative for nobody.** The Decision says the
  floor "is pinned in `.node-version` (for local version managers like
  fnm/nvm/mise)" and that "`ci.yml` is locked to `node-version: 24`". Those
  were two independent pins that happened to agree. All four workflows plus
  `.github/actions/setup/action.yml` hardcoded the literal `24`; nothing read
  the file, and nothing compared the two. A Node bump therefore meant
  hand-editing `.node-version`, 22 `engines` fields, 4 workflows and the
  composite action, with no gate detecting a straggler.
- **Observed cost.** `packages/m3l-console-server`'s `readBigInts` test fails
  locally on Node 26 and is green in CI on Node 24 — a false failure produced
  purely by the version split, and indistinguishable from a real regression
  until someone thinks to check `node -v`.

### What changed

- **`bin/check-node-version.mjs`** (`pnpm check:node-version`) is the
  enforcement `engine-strict` never provided. Its static half asserts every
  workspace manifest's `engines.node` floor agrees with `.node-version` and
  that every `actions/setup-node` site in `.github/` reads
  `node-version-file: .node-version`; it exits non-zero on drift. Its runtime
  half compares the executing Node's major against the pin and is **warn-only**
  — CI passes it trivially, and a developer mid-session gets an advisory rather
  than a blocked `pnpm verify`.
- **All five provisioning sites now read the file**: `ci.yml:53`,
  `.github/actions/setup/action.yml:22`, `security-audit.yml:36`,
  `main-health.yml:62`, `skill-evals.yml:44`. `.node-version` is the single
  authority; the literals are gone and the gate keeps them gone.
- **`.claude/hooks/warn-node-version.mjs`** renders the same findings once per
  session at `SessionStart`, non-blocking, so a wrong-major machine is visible
  before work starts instead of after a confusing test failure.
- **`@types/node` is pinned to the 24.x line and asserted by the same gate**
  (added 2026-08-31, same amendment). This was the remaining hole: `typecheck`
  only ever proves the code compiles against whatever API surface
  `@types/node` describes, so with the types at 26 and the floor at 24 a green
  `typecheck` proved the code runs on Node 26 while claiming 24. It could use a
  Node-26-only API unchallenged — and did, in a `setInterval` overload in
  `packages/m3l-console-server/tests/stream-writer.test.ts`, which surfaced the
  moment the pin dropped to `24.13.3`. `findTypesNodeDrift` compares the
  **major only** (DefinitelyTyped ships frequent 24.x releases and
  `.node-version` names a bare major), and it lives in this gate rather than
  only in `.github/dependabot.yml` because an `ignore` rule suppresses a
  _proposal_, not a _state_ — a `pnpm up` or a hand edit would otherwise drift
  it silently. The Dependabot `ignore` is version-anchored (`versions: [">=25"]`)
  rather than `update-types`-anchored, because merging `dependabot.yml` triggers
  an immediate run and an update-type rule is evaluated against the
  then-current manifest. `bin/check-deps.mjs`'s `MAJOR_HOLDS` carries the
  matching hold so `check:deps` reports the gap as deliberate instead of failing.
- **Wired into CI and `pnpm verify`** via the `gates` lane and a matching
  `bin/lib/verify-steps.mjs` entry. Deliberately **not** added to
  `lefthook.yml` `pre-push`: the static half cannot drift without a tracked
  file changing (CI catches it on the PR), and the runtime half is advisory, so
  paying for it on every push would buy nothing.

### `fnm` is the chosen version manager

ADR-0001's decision 4 pinned the runtime with "`.node-version` (Node 24) +
Corepack + the existing `packageManager` field. No new tool (mise/Volta
rejected as heavier all-in-ones)." That "no new tool" stance is **amended to
admit `fnm`** (see ADR-0001's own 2026-08-31 amendment). The constraint that
forced it: every development machine installs Node via Homebrew, and the
`ctx7` formula requires the _unversioned_ `node` formula, so Homebrew keeps
`node` tracking the newest major. Nothing repo-side can change that, and
pinning Homebrew's `node` to 24 would break the unrelated CLIs that depend on
it.

`fnm` resolves the conflict rather than trading one breakage for another:
`eval "$(fnm env --use-on-cd --shell zsh)"` makes `.node-version` take effect
**per-directory**, so this repo gets Node 24 while Homebrew's `node` stays on
the newest major for everything else. mise and Volta remain rejected on the
original grounds — both are heavier all-in-ones that would also want to own
package-manager and tool versioning, which `packageManager` + pnpm's own
self-management already handle.

Version-manager setup is a machine-side step, not a repo change; the install
commands live in `docs/contributing/contributing.md` § Environment Setup, and
the shell-rc line belongs in the maintainer's own dotfiles.

### What did _not_ change

`engines.node` stays **`">=24"`** in all 22 manifests. That field is the
**consumer** contract, and a consumer running the library on Node 26 is fine
and should stay fine. What is pinned exactly is the **development and CI
runtime**, via `.node-version` plus the gate above. Narrowing `engines` to
`">=24 <25"` would be a contract change with no benefit and was explicitly
rejected. The `.npmrc` `engine-strict=true` line also stays: it still guards
the below-floor case correctly, which is the only case it ever guarded.

## Links

- Related: `.node-version`, `.npmrc` (`engine-strict=true`), root `package.json` (`engines`), `packages/m3l-common/package.json` (`engines`), `.github/workflows/ci.yml`.
- Enforcement (2026-08-31 amendment): `bin/check-node-version.mjs`, `.claude/hooks/warn-node-version.mjs`, `bin/lib/verify-steps.mjs`, `.github/actions/setup/action.yml`, `bin/check-deps.mjs` (`MAJOR_HOLDS`), `.github/dependabot.yml` (`ignore`).
- Related: ADR 0001 (toolchain choices), ADR 0002 (ESM-only output — also requires Node 22+ for consumers, but Node 24 is the producer floor).
