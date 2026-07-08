# Consumer-fleet roadmap — post-deepening (Phase 5 of ADR-0021)

- **Date:** 2026-07-06 · **Starts:** after the 1.1.0 checkpoint of the
  deepen-first wave
  (`docs/plans/2026-07-06-post-1.0-deepen-first-roadmap.md`)
- **Authority:** [ADR-0021](../adr/0021-post-1.0-deepen-first-strategy.md)
  — "the in-repo consumer fleet follows as the immediate next iteration."
  Technical detail lives in
  `docs/plans/2026-07-06-consumer-fleet-implementation-plan.md`.
- **Purpose:** stand up real, value-shipping automation scripts inside the
  monorepo (`scripts/*` workspace, `workspace:*` consumption), and convert
  the library's backlog from speculation to observed usage.

## Governance note — ADR-0022 first

ADR-0019 removed the `scripts/` workspace because a hollow example carried
maintenance cost without shipping value; it explicitly did not forbid real
consumers. Re-introducing the workspace for **production scripts** is a
structural decision and gets its own record: **ADR-0022 — re-introduce the
`scripts/` workspace for real consumers** (Related to ADR-0019, not a
supersession — 0019's example-workspace reasoning stands). Write it at
Phase F0; it ratifies the fleet conventions below.

## Phase F0 — decisions (maintainer, no code)

1. **First script candidates.** Name 1–3 real automations with actual value
   (the knip gate structurally rejects hollow scripts). Per script: purpose,
   inputs/outputs, AWS touchpoints, CLI-only or CLI+Lambda.
2. **Fleet conventions** (ratified in ADR-0022): package naming
   (`@m3l-automation/<script-name>`), one directory per script under
   `scripts/`, a **modular source layout** — `main.ts` is a thin composition
   root only (construct `M3LScript`, wire config/hooks, call `run()`); all
   business logic lives in named-export modules (`config.ts`, `hooks.ts`,
   `steps/*`) per the layout contract in the implementation plan — never a
   single bloated `main.ts`; per-script `data/` subdirectory discipline
   (MONOREPO mode anchors `data/{config,input,output}` at the repo root —
   concurrent scripts must not race on shared paths), config presets
   location, and the testing policy for scripts (recommendation: scripts are exempt from the
   80% coverage gate — `vitest.config.ts` already scopes coverage to
   `packages/*/src` — but each script ships at least a config-declaration
   smoke test).
3. **Deployment target for the first script.** Local CLI is the default
   validated path. If Lambda is in scope: decide arch (and therefore the
   `better-sqlite3` strategy — arch-matched build, or no FTS usage), and the
   packaging tool.

## Phase F1 — workspace restoration — `feat/scripts-workspace-restore`

Mechanically re-introduce the workspace by inverting the removal commit
(`3ded259f`), in four layers (exact diffs in the implementation plan):

1. **Build machinery:** `pnpm-workspace.yaml` (`- "scripts/*"`), root
   `tsconfig.json` reference, `knip.json` `scripts/*` workspace block,
   `eslint.config.js` source-rules scope, root `package.json` description.
2. **Guardrails:** `guard-branch-isolation.mjs` (+ its test),
   `inject-decision-gate.mjs`, `post-edit-verify.mjs` — restore
   `scripts/*/src` coverage so fleet code gets the same branch/PR discipline
   as library code.
3. **Agent-system reintegration:** restore `.claude/rules/scripts.md`
   (updated to the shipped 1.1 API, not the scaffold-era text), the
   `scripts/**` path entries in `domain-knowledge.md` / `refactoring.md`,
   the `scripts/*/src` mentions in four skills (`auditing`, `creating-prs`,
   `eslint-flat-config`, `starting-work`), and the `scaffolding-scripts`
   skill (rewritten against the real `M3LScript` API).
4. **Docs:** CLAUDE.md layout/rules/hook sections, style guide scope note,
   the two guides that were genericized ("workload" → per-script wording).

No library change; zero semver impact. `turbo.json`, `vitest.config.ts`,
`lefthook.yml`, and CI need **no changes** (verified: globs and `^build`
ordering are workspace-agnostic; `claude-pr-review` has no `scripts/`
ignore, so fleet PRs get reviewed).

## Phase F2 — first real script — `feat/script-<name>`

Scaffold via the restored `scaffolding-scripts` skill, then implement the
Phase F0 candidate end-to-end in the modular layout (thin `main.ts`
composition root, logic in `steps/*` modules) on the real `M3LScript`
lifecycle: metadata,
declared `M3LConfigParameter`s (using the 1.1 validators), hooks,
`ctx`-driven logging with a correlation ID, `M3LPaths`-resolved I/O, AWS via
the `aws.profile` provisioning seam where needed. `pnpm build` +
`node --env-file-if-exists=.env dist/main.js` smoke run is the acceptance
gate; knip must pass with the script's real imports.

## Phase F3 — run/deploy validation

- **CLI path (always):** full run against real inputs; verify MONOREPO-mode
  data dirs, run archival (stage 9), and interactive credential flow
  (`M3LAWSCredentialsManager`) on this machine.
- **Lambda path (only if Phase F0 chose it):** package per the decided
  strategy, deploy, verify `M3L_DEPLOYMENT_MODE=standalone` +
  `M3L_BASE_DIR=/tmp` behavior and warm-start semantics. Record findings —
  this is the library's first real deployment evidence.

## Phase F4 — the usage-driven backlog loop (standing operating mode)

After each script ships or is materially extended:

1. Write the work log (`/writing-work-logs`) with a dedicated **"library
   friction"** section: APIs that fought back, missing capabilities, docs
   gaps.
2. Friction items graduate into library issues tagged by kind: additive 1.x
   candidate, D4 module candidate (now with the named consumer call-site
   ADR-0021 requires), or 2.0 evidence (design errors — collect, don't act,
   until a deliberate 2.0 case exists).
3. Periodically run `/promoting-work-log-lessons` so fleet lessons reach the
   rules/skills.

**D4 intake gate (from ADR-0021):** a new library submodule is scheduled
only when a fleet script demonstrates the need — e.g. two scripts
hand-rolling the same SSM config fetch unlocks the SSM config provider; a
script needing notifications unlocks the SES transport (new optional
`@aws-sdk/client-sesv2` peer per ADR-0017); any webhook need first schedules
the `M3LHttpClient` POST enhancement.

**D5 trigger:** if fleet growth ever motivates a separate repo (or another
project adopts this workflow), the platform-extraction minimal path
(portability census in the ADR-0021 review record) becomes actionable.

## Sequence and exit criteria

```text
1.1.0 shipped (deepen-first wave)
  │
  ├─ F0 decisions + ADR-0022 (Proposed → Accepted)
  ├─ F1 workspace restoration (one PR; no library change)
  ├─ F2 first real script (one PR per script)
  ├─ F3 run/deploy validation (evidence recorded in work log)
  └─ F4 standing loop: usage → friction log → tagged backlog → gated D4/D5
```

Fleet iteration is "done" as a project phase when: ADR-0022 is Accepted, at
least one real script runs end-to-end from the restored workspace, CI and
all hooks are green with the workspace present, and the first
library-friction log entry exists — from then on F4 is the permanent
operating mode feeding every subsequent library iteration.
