# 0022. Re-introduce the `scripts/` workspace for real consumers

- **Status:** Accepted
- **Date:** 2026-07-07 (amended and accepted 2026-07-09)
- **Deciders:** Enrico Lionello (maintainer)

## Context and problem statement

[ADR-0019](./0019-remove-scripts-workspace.md) removed the `scripts/*`
workspace because its single `example-automation` package added tooling and
governance surface without shipping value — a hollow demo that every config,
rule, and guard change had to account for. That decision explicitly targeted
the _hollow example_, not the principle of in-repo consumers.

[ADR-0021](./0021-post-1.0-deepen-first-strategy.md) then set the post-1.0
direction: ship the 1.1 deepen wave, then stand up an **in-repo consumer
fleet** as "the immediate next iteration" — real automation scripts that
exercise the library end-to-end and convert its backlog from speculation to
observed usage. With 1.1.0 shipped, that fleet now needs a home.

Re-introducing the `scripts/*` workspace is a structural decision that inverts
part of ADR-0019, so it gets its own record. The open question this ADR
settles is not only _whether_ to restore the workspace (ADR-0021 already
committed to it) but _under what conventions_ — the layout, isolation,
config, secrets, AWS, and testing rules that keep the fleet from decaying back
into the maintenance-heavy, value-light state ADR-0019 rejected.

The conventions below were pinned against **shipped** library behavior, which
corrected three assumptions carried in the roadmap drafts:

- `M3LPaths` anchors one **flat** `data/{config,input,output}` tree at the
  workspace root with **no per-script namespacing** — every script shares that
  root (`M3LPaths.ts`). Per-script isolation is only achievable through the
  `M3L_*_DIR` env overrides; it is a caller convention, not a library feature.
- The preset loader resolves **only** caller-supplied paths (`extends` bases
  relative to the extending file) — there is **no** `scripts/<name>/configs/`
  local-fallback search root (`M3LScriptPresetLoader.ts`).
- Stage-9 archival copies inputs/configs **flat** into
  `data/output/{inputs,configs}` — there is no per-run / correlation-id run
  folder (`M3LFileCopier.ts`). (The per-run **correlation ID** _is_ real and
  threaded through every hook context.)

## Decision drivers

- **Real value, not a demo.** ADR-0019's failure mode was a package that
  shipped nothing; the fleet must consist of automations with actual value,
  structurally guarded against hollowness (knip rejects unused
  `workspace:*` imports).
- **Observed usage feeds the library.** ADR-0021 makes the fleet the source of
  the usage-driven backlog (the D4 intake gate needs a named consumer
  call-site) — the conventions must keep that feedback loop clean.
- **Conventions grounded in shipped behavior.** Ratify only what the library
  actually provides; do not encode a "feature" (per-script paths, config
  local-fallback, per-run folders) the code does not implement.
- **Minimal governance surface.** The workspace restoration must reuse the
  existing guards, rules, and gates (branch isolation, ESLint source rules,
  knip, signed commits) rather than inventing fleet-specific machinery.
- **No library impact.** The library's frozen three-entry `exports` map
  (ADR-0004) and hand-managed version (ADR-0020) are untouched; consumers use
  the public surface only.

## Considered options

1. **Keep the single-package layout.** Consumers live outside the repo.
   Rejected: ADR-0020 forbids publishing, so an external consumer cannot take
   a `workspace:*`/registry dependency — there is no supported way to consume
   the internal library from another repo today.
2. **Put consumers under `packages/`.** Reuse the existing published-package
   workspace. Rejected: conflates the one published library with private,
   never-published automations; muddies the `exports`/knip/publint gates that
   are scoped to the library.
3. **Re-introduce `scripts/*` for real consumers, under ratified fleet
   conventions.** Restore the workspace glob and its guardrails, add the fleet
   layout/isolation/config/secrets/AWS/testing conventions, and let the
   knip anti-hollow gate keep it honest. **Chosen.**

## Decision

We chose **option 3 — re-introduce the `scripts/*` workspace for real
consumers**, ratifying the following fleet conventions. This **supersedes
ADR-0019**: that decision removed the workspace, and this one restores it, so
the operative ruling on `scripts/*` now lives here. ADR-0019's underlying
reasoning — do not carry surface for a package that ships nothing — is not
discarded but inherited: it is precisely what the anti-hollow gate below
enforces, package by package instead of workspace-wide.

### Fleet conventions (ratified)

A script is a small package, never a single bloated `main.ts`, with this
fixed source shape:

```text
scripts/<name>/src/
  main.ts        # composition root ONLY: construct M3LScript + run()
  config.ts      # the declared M3LConfigParameter set (named export)
  hooks.ts       # lifecycle hooks (always present, even when empty — see §9)
  steps/         # business logic, one module per step/concern
    <step>.ts    # pure named exports taking injected deps
```

1. **Package naming & shape.** One directory per script under `scripts/`,
   package name `@m3l-automation/<script-name>`, `private: true`, `type:
"module"`, `engines.node >= 24`, depending on
   `@m3l-automation/m3l-common` via `workspace:*`.
2. **Modular source layout (never a single-file script).** `main.ts` is a thin
   **composition root** only — construct `M3LScript`, wire config/hooks, call
   `run()`; it carries no business logic. Logic lives in named-export modules
   that receive their dependencies (config values, logger, paths, AWS provider)
   as parameters, so each is unit-testable without running the lifecycle
   (the source shape shown above). This is **structurally enforced**, not
   merely advised: the ESLint
   source-rules block re-scoped to `scripts/*/src/**` applies complexity ≤ 10,
   max-depth ≤ 3, max-lines-per-function ≤ 60, named exports, and
   no-default-export — a script that stuffs logic into `main.ts` fails lint.
3. **Anti-hollow gate.** The knip `scripts/*` workspace block (`entry:
src/main.ts`, `project: src/**/*.ts`) fails on unused files/exports/deps —
   a script that declares the `workspace:*` dependency but does not exercise
   the library does not pass. A script must do real work to be green.
4. **Per-script data isolation via env overrides.** Because `M3LPaths` shares
   one flat `data/{config,input,output}` root across all scripts (no library
   namespacing), each script isolates its I/O by setting `M3L_CONFIG_DIR`,
   `M3L_INPUT_DIR`, and `M3L_OUTPUT_DIR` (in its gitignored `.env`) to absolute
   paths under a per-script subtree, e.g. `data/<script-name>/{config,input,
output}`. This is the only isolation the library supports and is the fleet's
   defence against concurrent-run races on the shared root. All I/O still flows
   through the `M3LPaths` getters — never hand-built paths.
5. **Config & preset location.** Preset/config files live under the
   `data/config/presets/` root (the library's own docstring convention) and are
   passed to the preset loader by **explicit path** — there is no library
   search root or `scripts/<name>/configs/` fallback, so none is claimed.
   Config is declared with `M3LConfigParameter` (using the 1.1
   `M3LConfigValidators`); `process.env` is never read directly — config is the
   only input seam.
6. **Secrets.** Only via the gitignored `.env` (listed in `.worktreeinclude`
   so worktrees inherit it) or config `secretNames` — never literals
   (`guard-secret-writes` + gitleaks enforce).
7. **AWS access via the config seam.** Scripts obtain AWS clients through the
   `aws.profile` dynamic-provisioning seam, not hand-constructed SDK clients.
8. **Testing policy.** Scripts are **exempt from the 80% coverage gate**
   (`vitest.config.ts` already scopes coverage to `packages/*/src`), but each
   script **must ship at least a config-declaration smoke test** — the
   scaffold generator emits it, and `pnpm check:script-scaffold` fails CI when
   it is missing (§9). Unit tests for `steps/` modules are encouraged (the
   injected-deps layout makes them mockable without the lifecycle) but not
   mandatory. Vitest discovers any `scripts/**/tests/**` via the existing
   `include`; those files sit outside the coverage gate.
9. **Deterministic production pipeline (amendment, 2026-07-09).** The scaffold
   shape is not prose: it is defined once in the shared manifest
   `bin/lib/script-scaffold.mjs`, emitted by the generator
   `pnpm scaffold:script <name>` from the template sources under
   `templates/script/`, and enforced in CI by `pnpm check:script-scaffold` —
   generator and checker consume the same manifest, so the emitted and
   verified shapes cannot drift. The ratified specifics:
   - **Uniform shape, no optional files:** `hooks.ts` is always present (an
     empty `M3LScriptLifecycleHooks` object is valid), and `src/steps/` and
     `tests/` are **flat** — the conformance scan is deliberately one level
     deep; growth means more flat step modules (the ESLint design rules
     already cap module size), not nesting.
   - **Two documentation artifacts with disjoint responsibilities**, both
     scaffolded and both required: `scripts/<name>/README.md` covers how to
     _run_ the script (invocation, `.env`, `M3L_*_DIR` overrides), and
     `docs/reference/scripts/<name>.md` is the _contract_ (purpose, config
     schema, steps, inputs/outputs). Every script is indexed in the generated
     consumer-scripts catalog in `docs/reference/README.md`
     (`pnpm gen:index` / `pnpm check:index`).
   - **Tooling/build tsconfig split** mirroring the library, so `tests/` are
     type-checked; the root `tsconfig.json` references
     `scripts/<name>/tsconfig.build.json` (inserted by the generator).
   - **Pipeline skills:** `scaffolding-scripts` (greenfield entry, runs the
     generator) hands off to `implementing-scripts` (the script-scale TDD
     loop reusing the shared spokes). Evolving the shape means changing the
     templates + manifest together in their own PR — never hand-editing a
     scaffolded package's structure.

### Restoration scope (mechanics)

The workspace is restored by inverting removal commit `3ded259f` across build
machinery (`pnpm-workspace.yaml`, root `tsconfig.json`, `knip.json`,
`eslint.config.js`, root `package.json` description), guardrail hooks
(`guard-branch-isolation.mjs` + test, `inject-decision-gate.mjs`,
`post-edit-verify.mjs` — restoring `scripts/*/src` coverage), the agent-system
(`.claude/rules/scripts.md` rewritten to the 1.1 API, `domain-knowledge.md` /
`refactoring.md` paths, four skills, and a rewritten `scaffolding-scripts`
skill), and docs. Scaffold-era "once `M3LScript` is implemented…" text is
**rewritten against the shipped API**, never restored verbatim. `turbo.json`,
`vitest.config.ts`, `lefthook.yml`, and both CI workflows need no change
(their globs and `^build` ordering are already workspace-agnostic). Exact
diffs live in `docs/plans/2026-07-06-consumer-fleet-implementation-plan.md`.

## Consequences

- **Positive:** the library gains its first real, end-to-end consumers and the
  usage-driven backlog loop (ADR-0021 F4) becomes operable; the fleet reuses
  every existing guard and gate; conventions match shipped behavior, so a
  script that follows them cannot silently rely on a feature the library does
  not have; the knip and ESLint gates keep the fleet honest and modular by
  construction.
- **Negative / trade-offs:** the governance surface ADR-0019 shed returns (the
  `scripts/*` glob, a knip workspace, an ESLint scope, guard paths, a rule
  file, and a scaffolding skill all reappear) — accepted here because it now
  carries **real value**, which is exactly the condition ADR-0019 left open.
  Per-script data isolation is a manual `.env` convention rather than a library
  guarantee, so a script that omits the overrides will race on the shared
  `data/` root; the convention, not the code, prevents this.
- **Semver impact:** none. `scripts/*` is a private, never-published dev
  workspace; restoring it does not touch the `exports` map, any public type,
  or the library version.

## Links

- Supersedes / superseded by: **supersedes
  [ADR-0019](./0019-remove-scripts-workspace.md)** (restores the workspace it
  removed, for real consumers; its hollow-example reasoning is inherited by the
  per-package anti-hollow gate above).
- Authority / sequencing: [ADR-0021](./0021-post-1.0-deepen-first-strategy.md)
  (post-1.0 direction — the consumer fleet as the immediate next iteration),
  `docs/plans/2026-07-06-consumer-fleet-roadmap.md` (Phase F0–F4),
  `docs/plans/2026-07-06-consumer-fleet-implementation-plan.md` (WS-S1–S6).
- Related: [ADR-0004](./0004-exports-map-contract.md) (frozen exports map —
  untouched), [ADR-0013](./0013-git-worktrees-for-task-isolation.md) /
  [ADR-0014](./0014-symmetric-worktree-tooling.md) (worktree isolation the
  fleet reuses), [ADR-0017](./0017-dependency-loading-standard.md) (governs any
  future AWS transport peer a fleet script pulls in),
  [ADR-0018](./0018-shared-script-options-bag.md) (`M3LScriptOptions` the
  scripts construct against), [ADR-0020](./0020-drop-release-automation.md)
  (internal-only posture that makes an in-repo consumer the only option).
