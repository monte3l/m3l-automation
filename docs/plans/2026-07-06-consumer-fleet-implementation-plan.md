# Plan: consumer-fleet workspace — technical implementation

- **Date:** 2026-07-06 · **Baseline:** `main` after the 1.1.0 checkpoint
- **Implements:** `docs/plans/2026-07-06-consumer-fleet-roadmap.md`
  (Phase 5 of [ADR-0021](../adr/0021-post-1.0-deepen-first-strategy.md)).
- **Ground truth:** every fragment below was extracted from the removal
  commit `3ded259f` (the exact inverse diff) and from current `HEAD`. Where
  the old content was scaffold-era ("once `M3LScript` is implemented…"), it
  is **rewritten against the shipped API**, not restored verbatim — restoring
  the old text would recreate audit finding SF-4/SF-5.

## Context

Two PRs deliver the fleet foundation: **PR-1** restores the `scripts/*`
workspace and its guardrails (`feat/scripts-workspace-restore`); **PR-2**
ships the first real script (`feat/script-<name>`, one per script). ADR-0022
(re-introduce the workspace for real consumers; Related to ADR-0019) is
written at Phase F0 and lands with PR-1. No library source changes anywhere
in this plan; the library's `exports` map and version are untouched.

Verified non-changes (no edits needed): `turbo.json` (`build.dependsOn:
["^build"]` already orders `m3l-common` before any `workspace:*` dependent),
`vitest.config.ts` (coverage scoped to `packages/*/src` — scripts are exempt
from the 80% gate by design; its test `include` already discovers any
`scripts/**/tests/**` if added), `lefthook.yml` (globs `**/*.ts` /
`**/*.{ts,json,md,yml,yaml}` already cover `scripts/`), and both CI
workflows (`ci.yml` has no path filters; `claude-pr-review.yml` ignores only
`**.md` + `docs/**`, so fleet PRs are reviewed).

## WS-S1 — build machinery (PR-1)

Exact restorations, inverting `3ded259f`:

1. **`pnpm-workspace.yaml`** — add under `packages:`:

   ```yaml
   packages:
     - "packages/*"
     - "scripts/*"
   ```

   (Keep the existing `overrides`, `allowBuilds`, `minimumReleaseAge`
   sections untouched. Watch the known pnpm quirk: a later `pnpm install`
   may rewrite quoting — prettier-write the file before push.)

2. **Root `tsconfig.json`** — add the reference:

   ```json
   {
     "files": [],
     "references": [
       { "path": "./packages/m3l-common/tsconfig.build.json" },
       { "path": "./scripts/<first-script>" }
     ]
   }
   ```

   (One reference per script package; added in PR-2 when the package
   exists — PR-1 only restores the workspace glob so an empty `scripts/`
   dir does not break `tsc -b`.)

3. **`knip.json`** — restore the workspace block:

   ```json
   "workspaces": {
     "packages/m3l-common": {
       "entry": "src/index.ts",
       "project": "src/**/*.ts"
     },
     "scripts/*": {
       "entry": "src/main.ts",
       "project": "src/**/*.ts"
     }
   }
   ```

4. **`eslint.config.js`** — the source-only design-rules block (currently
   `files: ["packages/*/src/**/*.ts"]`, around line 96) becomes:

   ```javascript
   files: ["packages/*/src/**/*.ts", "scripts/*/src/**/*.ts"],
   ```

   This re-applies tsdoc/no-default-export/explicit-boundary-types/
   naming/complexity rules to fleet source. (The `internal/`-sealing and
   ESM-extension rules are repo-wide already.)

5. **Root `package.json`** — description back to:

   ```json
   "description": "Monorepo root for @m3l-automation/m3l-common and the automation scripts that consume it.",
   ```

**Gate for WS-S1:** `pnpm install` (lockfile updates for the workspace
glob), `pnpm lint`, `pnpm typecheck`, `pnpm knip` all green with the
restored config and (in PR-1) no script package yet — knip's `scripts/*`
block tolerates an empty glob.

## WS-S2 — guardrail hooks and their tests (PR-1)

1. **`.claude/hooks/guard-branch-isolation.mjs`** — `isProtectedPath`
   (currently lines 59–64) regains the scripts arm:

   ```javascript
   export function isProtectedPath(filePath) {
     return (
       /(^|\/)packages\/[^/]+\/src\//.test(filePath) ||
       /(^|\/)scripts\/[^/]+\/src\//.test(filePath) ||
       /(^|\/)tests\//.test(filePath)
     );
   }
   ```

   Restore the header-comment scope line (`scripts/*/src/**`) too.

2. **`bin/tests/guard-branch-isolation.test.ts`** — restore the test title
   `"protects package and script src trees and any tests dir"` and the
   assertion:

   ```typescript
   expect(isProtectedPath("scripts/my-job/src/main.ts")).toBe(true);
   ```

3. **`.claude/hooks/inject-decision-gate.mjs`** (line ~57) — PR rule message
   back to:

   ```text
   • PR — any `src/`/`tests/`/`scripts/*/src` change lands via PR, never a direct commit to `main`.
   ```

4. **`.claude/hooks/post-edit-verify.mjs`** — restore the scope regex and
   its stale-`dist/` comment:

   ```javascript
   // Scope: library src/tests, or a script's src.
   const inScope =
     /^packages\/[^/]+\/(src|tests)\//.test(rel) ||
     /^scripts\/[^/]+\/src\//.test(rel);
   ```

**Gate:** `pnpm test` (bin suites), `pnpm check:hooks`.
**Note on ordering:** hooks are `.claude/`/`bin/` tooling, not library
`src/` — the branch-isolation guard does not block these edits, but PR-1
still goes through `/start-work` → branch → PR like everything else.

## WS-S3 — rules, skills, agent-system reintegration (PR-1)

1. **Restore `.claude/rules/scripts.md`** — the removed file's rule set is
   still accurate against the shipped API (verified: hook order, resolution
   order, `workspace:*`, `M3LPaths`, Lambda env vars all match current
   `docs/reference/core/script.md`). Restore it with three updates: add the
   1.1 features (declare validators with `M3LConfigValidators`; pass/read
   the correlation ID), add the **modular-layout rule** ("`main.ts` is a
   composition root only — config in `config.ts`, hooks in `hooks.ts`,
   business logic in named-export `steps/` modules with injected deps;
   never a single-file script"), and keep the front-matter
   `paths: ["scripts/**"]`.
2. **`.claude/rules/domain-knowledge.md`** — restore `- "scripts/**/*.ts"`
   to `paths`.
3. **`.claude/rules/refactoring.md`** — restore `- "scripts/**"` to `paths`
   and the title `# Refactoring rules (source, scripts & tests)`.
4. **Skill prose restorations** (four files, exact spots from the removal
   diff):
   - `.claude/skills/auditing/SKILL.md` (~line 169): re-add
     `scripts/*/src/**` to the guarded-paths sentence.
   - `.claude/skills/creating-prs/SKILL.md` (~lines 182–185): re-add
     `scripts/*/src/` to the review-spoke fan-out trigger.
   - `.claude/skills/eslint-flat-config/SKILL.md` (~line 197): re-add
     `scripts/*/src/**` to the shipped-source scope description.
   - `.claude/skills/starting-work/SKILL.md` (4 spots: ~lines 10, 28–32,
     81, 126): re-add `scaffolding-scripts` to the skill list and
     `scripts/*/src/**` to the guard descriptions.
5. **Recreate `.claude/skills/scaffolding-scripts/`** — rewritten against
   the real API (do not restore the deleted scaffold-era version):
   - Step 0: defer to `/starting-work`.
   - Steps: ask for script name/purpose → create
     `scripts/<name>/package.json` + `tsconfig.json` (templates in WS-S5)
     → scaffold the **modular `src/` skeleton** from the WS-S5 layout
     contract (thin `main.ts` composition root + `config.ts` + `steps/`
     with one starter step module — never a single-file script) → add the
     root `tsconfig.json` reference → `pnpm install` → `pnpm build` →
     smoke run.
   - Include `evals/` with trigger cases mirroring the other skills'
     format, and re-run `pnpm check:agents` (skill references must
     resolve).

**Gate:** `pnpm check:agents`, `pnpm check:hooks`, `lint:md` (skills/rules
are markdown but `.claude/**` is excluded from `lint:md` — the post-edit md
hook still runs rumdl per-file; keep them clean anyway).

## WS-S4 — docs (PR-1)

Exact spots from the removal diff:

1. **`CLAUDE.md`** (5 locations): repo-layout comment
   (`pnpm-workspace.yaml # packages/* + scripts/* …`), restore the
   `scripts/` tree lines under Repository Layout, restore the
   `scripts/**` → `scripts.md` rules bullet and the
   "source/scripts/tests" refactoring bullet, and the
   `guard-branch-isolation` description
   (`packages/*/src/**`, `scripts/*/src/**`, `**/tests/**`).
2. **`docs/contributing/style-guide.md`** (~line 556): scope note back to
   `packages/*/src/** + scripts/*/src/**`.
3. **`docs/guides/environments-and-paths.md`** (~lines 566–575): restore
   the per-script wording and the
   `scripts/{category}/{script-name}/configs/` local-fallback line —
   **verify first** that the configs local-fallback is real shipped
   behavior in `M3LPaths`/config providers; if it is not, document only
   what ships (this line predates implementation).
4. **`docs/m3l-common-architecture.md`** (~lines 586–598): restore
   "single entry point for all scripts and Lambda handlers in the
   monorepo" phrasing and the same data-layout lines (same verification
   caveat as above).

**Gate:** `pnpm check:doc-counts`, `check:impl-counts`,
`check:workflows-doc` (CLAUDE.md edits sit near its parsed tables — keep
table rows untouched), `lint:md`, `docs-consistency-reviewer` sweep.

**PR-1 assembly:** WS-S1…WS-S4 + ADR-0022 in one PR:
`feat: restore scripts workspace for real consumers (ADR-0022)`.
Spokes: hub edits config/hooks/docs directly (none are `packages/*/src` or
`tests/`… except the bin test edit, which `test-author` handles), then
`code-reviewer` + `docs-consistency-reviewer` post-edit. Full local gate
run before push: `lint`, `format:check`, `typecheck`, `test`, `build`,
`knip`, `check:hooks`, `check:agents`, `lint:md`.

## WS-S5 — first real script (PR-2, one per script)

Templates (modernized from the deleted `example-automation` files):

**`scripts/<name>/package.json`:**

```json
{
  "name": "@m3l-automation/<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "<what this automation does>",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b",
    "start": "node --env-file-if-exists=.env dist/main.js"
  },
  "dependencies": {
    "@m3l-automation/m3l-common": "workspace:*"
  }
}
```

**`scripts/<name>/tsconfig.json`:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "references": [{ "path": "../../packages/m3l-common/tsconfig.build.json" }],
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

**Source layout contract (fleet convention, ratified in ADR-0022):** a
script is a small package, never a single bloated `main.ts`. `main.ts` is a
thin **composition root** — construct `M3LScript`, wire config/hooks, call
`run()` — and carries no business logic. Logic lives in named-export
modules that receive their dependencies (config values, logger, paths, aws
provider) as parameters, so each is unit-testable without running the
lifecycle. The ESLint source rules restored in WS-S1 (complexity ≤ 10,
max-depth ≤ 3, max-lines-per-function ≤ 60, named exports, no default
export) apply to `scripts/*/src/**` and structurally enforce this.

```text
scripts/<name>/src/
  main.ts        # composition root ONLY: construct M3LScript + run()
  config.ts      # the declared M3LConfigParameter set (named export)
  hooks.ts       # lifecycle hooks (omit if trivial)
  steps/         # business logic, one module per step/concern
    <step>.ts    # pure named exports taking injected deps
```

**`src/main.ts` shape** (real API — verified against
`docs/reference/core/script.md` and the shipped signatures):

```typescript
import { Core } from "@m3l-automation/m3l-common";
import { configParameters } from "./config.js";
import { hooks } from "./hooks.js";
import { runExport } from "./steps/run-export.js"; // example step

const script = new Core.M3LScript({
  metadata: { name: "<name>", version: "0.0.0" },
  config: configParameters,
  hooks,
});

await script.run(async () => {
  await runExport(/* deps resolved from config/script.aws/M3LPaths */);
});
```

**`src/config.ts` shape** (1.1 validators; AWS seam via the exported
param-name constants when the script touches AWS):

```typescript
import { Core } from "@m3l-automation/m3l-common";

export const configParameters = [
  new Core.M3LConfigParameter({
    name: "batchSize",
    type: "INT",
    defaultValue: 100,
    validate: Core.M3LConfigValidators.range(1, 10_000),
  }),
  // + AWS_PROFILE_PARAM_NAME / AWS_REGION_PARAM_NAME parameters when needed
];
```

**`src/steps/*.ts` shape:** pure named-export functions with injected
dependencies — `export async function runExport(deps: { logger, outputDir,
batchSize }): Promise<void>` — using importers/exporters, polling with
telemetry handlers, `script.aws` where provisioned. No module-level state,
no direct `process.env` reads (config is the only input seam).

Requirements that make the script "real" (and keep gates green):

- The declared config set, hooks, and body must actually exercise the
  library — `pnpm knip` fails unused imports by design.
- `main.ts` stays a composition root: any conditional, loop, or I/O beyond
  constructing the script and invoking steps belongs in a `steps/` module.
  Reviewers reject business logic in `main.ts`.
- I/O only through `M3LPaths` dirs, under a per-script subdirectory
  (fleet convention from Phase F0) to avoid cross-script races on the
  shared MONOREPO `data/` root.
- Secrets only via `.env` (gitignored; listed in `.worktreeinclude`) or
  config `secretNames` — never literals (`guard-secret-writes` +
  gitleaks enforce).
- AWS access via the `aws.profile` config seam (dynamic provisioning) —
  not hand-constructed SDK clients.
- Add the root `tsconfig.json` reference for the new package (deferred
  from WS-S1 item 2).
- Optional per fleet policy: `scripts/<name>/tests/` with a
  config-declaration smoke test and unit tests for `steps/` modules —
  the injected-deps layout makes steps testable with plain mocks, no
  `M3LScript` lifecycle needed (vitest discovers the files via the
  existing `include`; they sit outside the coverage gate).

**Spokes (PR-2):** `scripts/*/src` is guarded — `submodule-implementer`
writes the script (its grant covers implementation writes),
`code-reviewer` + `security-reviewer` (env/credential handling) review;
`silent-failure-hunter` if the script has retry/polling paths.
**Commit:** `feat(scripts): add <name> automation`.
**Gates:** `pnpm build` (turbo orders m3l-common first), `pnpm lint`,
`pnpm typecheck`, `pnpm knip`, smoke run
`pnpm --filter @m3l-automation/<name> start` against real inputs.

## WS-S6 — run/deploy validation and evidence

1. **CLI validation (always):** end-to-end run on this machine; verify
   MONOREPO-mode paths land under `data/`, output archival (stage 9)
   produces the run folder, SSO credential prompt flow works when AWS is
   declared. Record actual behavior vs docs in the work log.
2. **Lambda validation (only if Phase F0 chose it):** bundle per the F0
   packaging decision; set `M3L_DEPLOYMENT_MODE=standalone`,
   `M3L_BASE_DIR=/tmp`; verify per-invocation reset + warm SDK clients +
   distinct correlation IDs per invocation (1.1 behavior). The
   `better-sqlite3` constraint applies: arch-matched build or no
   FTS usage — record which was chosen.
3. **Work log** (`/writing-work-logs`):
   `docs/logs/YYYY-MM-DD-scripts-<name>.md` with the mandatory
   **library-friction section** — this seeds the F4 backlog loop and is
   the fleet's core deliverable back to the library.

## Execution order

```text
F0 decisions + ADR-0022 drafted
  │
  ▼
PR-1  feat/scripts-workspace-restore   (WS-S1 → S2 → S3 → S4 + ADR-0022)
  │     all local gates + CI green with an empty scripts/ glob
  ▼
PR-2  feat/script-<name>               (WS-S5; repeat per F0 candidate)
  │     knip-proof real usage; smoke run recorded
  ▼
WS-S6 validation + friction log  →  F4 standing loop (roadmap)
```

## Risks & mitigations

- **Doc-count/gate regressions from CLAUDE.md edits** — `check:doc-counts`
  and `check:workflows-doc` parse CLAUDE.md prose/tables; run the full
  `check:*` suite locally before pushing PR-1.
- **Stale-`dist/` typecheck noise** — a script's typecheck depends on a
  fresh `m3l-common` build; `post-edit-verify` will nudge to rebuild
  (restored comment documents this as intentional).
- **Scaffold-era text leaking back** — SF-4/SF-5 recurrence is the known
  failure mode of "restore from the old commit"; WS-S3/S5 templates are
  rewritten, and `docs-consistency-reviewer` sweeps PR-1/PR-2 for
  "not yet implemented / design target / currently empty" phrasing.
- **Shared `data/` races** — enforced by fleet convention (per-script
  subdirs) until real contention motivates a library-level feature (which
  then enters the F4 loop as evidence).
