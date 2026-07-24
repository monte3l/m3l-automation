// Hand-authored catalog of every `package.json` `scripts` entry — the single
// source of truth `bin/list-commands.mjs` (the `pnpm commands` lister) and
// `bin/check-command-catalog.mjs` (the `pnpm check:command-catalog` gate)
// both read. Pure data + pure derivation only: no fs/process here, so both
// consumers can be exercised in tests without spawning anything (mirrors
// `bin/lib/count-sites.mjs`'s gen/check-shared-derivation shape).
//
// Each description is one sentence covering both scope (what the command
// does) and intended usage (when a human reaches for it), sourced from the
// script's own header comment or its `.github/workflows/ci.yml` step comment
// — both already carry exactly this information, written by the maintainer.
// This module does not re-derive those sentences from the source files at
// runtime (there is no reliable machine-checkable "this prose is accurate"
// signal), so `deriveCommandCatalogDiff` only guards the STRUCTURAL
// invariant: every `package.json` script has exactly one row here, and vice
// versa. A stale or misleading sentence is a review-time concern, not a
// machine-checkable one.

/**
 * One entry per `package.json` `scripts` key, in the exact order they appear
 * there. `name` must match the `package.json` key verbatim — `check:command-catalog`
 * (via {@link deriveCommandCatalogDiff}) fails loudly on any mismatch in either
 * direction.
 *
 * @type {{ name: string, description: string }[]}
 */
export const COMMAND_CATALOG = [
  {
    name: "build",
    description:
      "Compiles every workspace package (m3l-common + all consumer scripts) via turbo, emitting dist/ ESM .js + .d.ts. Run before publint/attw or a manual smoke test.",
  },
  {
    name: "typecheck",
    description:
      "Runs tsc across every workspace package via turbo with no emit. The fastest full-repo type-error signal; run after any source or test edit.",
  },
  {
    name: "lint",
    description:
      "Runs the flat ESLint config (strict TS, no any, ESM-only, dependency-direction zones) over the whole repo. Pre-push gate; pre-commit only lints staged files.",
  },
  {
    name: "lint:commit",
    description:
      "Lints a commit message: `-- --edit <file>` (the commit-msg hook's mode) or `-- --from <sha> --to <sha>` to lint every subject in a range — e.g. `pnpm lint:commit -- --from origin/main --to HEAD` before opening a PR.",
  },
  {
    name: "format",
    description:
      "Applies Prettier's `--write` across the repo. Use to fix formatting drift; pre-commit already auto-formats staged files.",
  },
  {
    name: "format:check",
    description:
      "Verifies Prettier formatting with no writes. Catches drift from any commit that bypassed the pre-commit hook; CI and pre-push both run this, not `format`.",
  },
  {
    name: "lint:md",
    description:
      "Lints every Markdown file (rumdl) excluding generated/vendored/archived paths. Run after any docs edit; wired into `/syncing-docs` and CI.",
  },
  {
    name: "test",
    description:
      "Runs the full Vitest suite once, no coverage. Fastest local test signal during iteration.",
  },
  {
    name: "test:coverage",
    description:
      "Runs the full suite with the v8 coverage gate from vitest.config.ts evaluated. `test` alone never evaluates the thresholds — CI and pre-push both use this one.",
  },
  {
    name: "test:watch",
    description:
      "Runs Vitest in watch mode for interactive TDD (RED → GREEN → refactor) against the files you're actively editing.",
  },
  {
    name: "knip",
    description:
      "Detects unused files, exports, and dependencies across the workspace. CI-only dead-code gate; run locally after removing a symbol or dependency.",
  },
  {
    name: "commands",
    description:
      "Lists every pnpm command in this file, grouped by family, with its description — this catalog, rendered. Add `-- --json` for a structured payload.",
  },
  {
    name: "check:command-catalog",
    description:
      "Verifies every `package.json` script has exactly one row in bin/lib/command-catalog.mjs and vice versa — the non-drift gate for `pnpm commands`'s data. Run after adding/removing/renaming a script.",
  },
  {
    name: "check:api",
    description:
      "Diffs the live `exports` map against a committed snapshot so any change to the public API contract (`.`, `./core`, `./aws`) shows up as a deliberate, reviewed diff. Run after touching a namespace barrel.",
  },
  {
    name: "check:provenance",
    description:
      "Verifies every docs/reference/**.provenance.json sidecar's heading/source/symbol still resolves and warns on staleness. Run after editing a submodule's source or its reference page.",
  },
  {
    name: "check:doc-counts",
    description:
      "Verifies the submodule-count denominator ('N of M') matches the files on disk under docs/reference/{core,aws}/ across every badge/prose site. Run after adding/removing a reference page.",
  },
  {
    name: "check:impl-counts",
    description:
      "Verifies the implemented-count numerator ('N of M') matches the ✅ rows in docs/implementation-status.md across every badge/prose/HTML site, plus the generated implemented-list sentence. Run after flipping a submodule's status.",
  },
  {
    name: "gen:counts",
    description:
      "Regenerates every 'N of M' count site (both counts) and the implemented-list block in docs/implementation-status.md from the filesystem-derived truth. Run before check:doc-counts/check:impl-counts after a status change.",
  },
  {
    name: "sync:docs",
    description:
      "Runs the full /syncing-docs reconciliation sequence (provenance restamp, counts, doc-exports, reference index, script-scaffold, markdown lint) as one deterministic entry point. Run after any submodule or script ships.",
  },
  {
    name: "sync:hub-issues",
    description:
      "Maintainer-run, local-only: syncs docs/ROADMAP.md + IMPLEMENTATION.md into GitHub Issues/Milestones. Dry-run by default; pass `-- --apply` to execute.",
  },
  {
    name: "sync:hub-projects",
    description:
      "Maintainer-run, local-only: syncs hub-sync-tracked issues onto the GitHub Projects (v2) board. Dry-run by default; pass `-- --apply`, and `-- --init` once to create/reuse the board.",
  },
  {
    name: "sync:hub",
    description:
      "Runs sync:hub-issues then sync:hub-projects as one umbrella pass (issues before projects, so the board sees already-closed issues). Same `-- --apply`/`-- --init` flags forward to both phases.",
  },
  {
    name: "check:doc-exports",
    description:
      "Verifies every public export surfaced through a namespace barrel is documented (present in its reference page heading or provenance sidecar). Run after adding an export.",
  },
  {
    name: "check:exports",
    description:
      "Runs publint + are-the-types-wrong against the built package to validate the exports map's shape (ESM-only, types resolution). Run after `pnpm build`, before publishing/reviewing an API change.",
  },
  {
    name: "check:scaffold",
    description:
      "Verifies every src/{core,aws}/<module>/index.ts is re-exported from its namespace barrel and that no barrel line points to a deleted directory. Run after scaffolding or removing a submodule.",
  },
  {
    name: "check:scaffold-seam",
    description:
      "Verifies every scaffolded submodule carries both its TDD test file and its docs/implementation-status.md row — the backstop for the scaffolding-submodules skill. Run after scaffolding a new submodule.",
  },
  {
    name: "check:script-scaffold",
    description:
      "Verifies every scripts/<name>/ package matches the ADR-0022 shape (modular src/, contract page, README, root tsconfig ref, smoke test). Run after scaffolding or editing a consumer script's structure.",
  },
  {
    name: "check:script-deps",
    description:
      "Verifies every scripts/*/package.json declares exactly the ADR-0029 dependency boundary (@m3l-automation/m3l-common via workspace:*, no devDependencies). Run after editing a consumer script's package.json.",
  },
  {
    name: "scaffold:script",
    description:
      "Deterministic generator for a brand-new scripts/<name>/ consumer-script package from templates/script/ (ADR-0022). The greenfield entry point when scripts/<name>/ doesn't exist yet.",
  },
  {
    name: "check:agents",
    description:
      "Verifies every skill/CLAUDE.md agent reference resolves to a real subagent or built-in, and that no spoke is granted the Agent tool (the no-nesting invariant). Run after editing .claude/agents/** or a skill's dispatch prompt.",
  },
  {
    name: "check:hooks",
    description:
      "Verifies every .claude/settings.json hook command resolves to a real .claude/hooks/*.mjs file, every event name is a real Claude Code lifecycle event, and no hook file is left unwired. Run after editing hooks or settings.json.",
  },
  {
    name: "check:zones",
    description:
      "Verifies the ADR-0009 dependency-direction zones (import-x/no-restricted-paths) are still present and correctly shaped in eslint.config.js — a deleted zone would otherwise pass `pnpm lint` silently. Run after editing eslint.config.js.",
  },
  {
    name: "check:deps",
    description:
      "Dependency hygiene gate covering what `pnpm audit` misses: outdated majors, deprecated packages, and peer mismatches. Run periodically or after a dependency bump.",
  },
  {
    name: "check:test-counts",
    description:
      "Verifies the per-submodule test counts recorded in docs/implementation-status.md's Notes column match the live Vitest suite. Run after adding/removing tests for an implemented submodule.",
  },
  {
    name: "check:workflows",
    description:
      "Verifies the .claude/workflows/ dynamic-workflow surface against the MODEL-MATRIX in docs/contributing/model-selection.md and the per-script agent-count guardrail (ADR-0025). Run after adding/editing a workflow script.",
  },
  {
    name: "check:workflows-doc",
    description:
      "Verifies CLAUDE.md's CI/CD table documents exactly the workflow files under .github/workflows/ — count plus one row each. Run after adding/removing a GitHub Actions workflow.",
  },
  {
    name: "check:cadence",
    description:
      "Verifies CLAUDE.md's Commands cadence table matches lefthook.yml's pre-commit/commit-msg/pre-push stages exactly. Run after editing lefthook.yml.",
  },
  {
    name: "check:worktree",
    description:
      ".worktreeinclude hygiene gate: every literal entry is gitignored and every path resolves, so `pnpm worktree:setup` provisions a fresh worktree correctly. Run after editing .worktreeinclude.",
  },
  {
    name: "check:signed-range",
    description:
      "Refuses an unsigned/unverified outgoing commit range (@{upstream}..HEAD, falling back to origin/main) — the same check the pre-push hook runs. Run locally to preflight a push before it's rejected.",
  },
  {
    name: "check:dup",
    description:
      "Copy-paste duplication density gate (jscpd, ADR-0034) — the one Sonar-style metric ESLint's per-function complexity rules don't cover. CI-only; run locally after a large refactor to spot-check duplication.",
  },
  {
    name: "gen:index",
    description:
      "Regenerates docs/reference/catalog.json + symbol-map.json (and the consumer-scripts catalog block in docs/reference/README.md) from each module's provenance sidecar. Run after any symbol or script changes, before check:index.",
  },
  {
    name: "gen:commit-stats-endpoint",
    description:
      "Emits shields.io endpoint-badge JSON (aggregate + per-model) to dist/commit-stats/ from the AI co-authorship commit history. Published by pages.yml on every push to main; rarely run by hand.",
  },
  {
    name: "gen:project-hub",
    description:
      "Renders the ADR-0032 visibility-hub dashboard (dist/index.html) from docs/ROADMAP.md, docs/plans/IMPLEMENTATION.md, and docs/implementation-status.md. Run to preview the hub locally after editing a tracker table.",
  },
  {
    name: "check:index",
    description:
      "Verifies docs/reference/catalog.json, symbol-map.json, and the README catalog block are current against docs/reference/ + the provenance sidecars. Run after gen:index.",
  },
  {
    name: "worktree:new",
    description:
      "Creates and provisions a linked sibling worktree in one step (git worktree add + worktree:setup) — the entry point for concurrent work in an isolated checkout. `-- <slug>` (branch feat/<slug>) or `-- <slug> --fix`.",
  },
  {
    name: "worktree:setup",
    description:
      "Provisions a worktree created via the manual `git worktree add` flow (install deps, register the merge driver, copy .worktreeinclude files). Run from inside a fresh manually-created worktree.",
  },
  {
    name: "worktree:remove",
    description:
      "Symmetric teardown for a worktree: removes it, prunes stale admin entries, and deletes its branch if safely merged. `-- <slug>` to remove a specific worktree once its work has landed.",
  },
  {
    name: "worktree:prune",
    description:
      "Cleans up every worktree whose branch is already merged into main or that git reports prunable. `-- --dry-run` to preview, `-- --force` to also remove ones with uncommitted changes.",
  },
  {
    name: "spoke:recover",
    description:
      "Automates the first step of the subagent-truncation recovery playbook: cross-references a spoke's journal against `git status`/`git diff` and recommends resume/redispatch/none. `-- --journal <path>` (required); the MCP `spoke_recover` tool wraps this same script.",
  },
  {
    name: "prepare",
    description:
      "Lifecycle script (auto-runs on `pnpm install`): installs the lefthook git hooks and registers the m3l-generated merge driver. Never run directly; re-run manually only to repair a broken hook install.",
  },
];

/**
 * Compare `package.json`'s live `scripts` object against {@link COMMAND_CATALOG}
 * and report any structural drift in either direction. Both arrays are
 * sorted for a deterministic, diffable result.
 *
 * @param {Record<string, string>} packageScripts `package.json`'s `scripts` object
 * @param {{ name: string, description: string }[]} [catalog] defaults to {@link COMMAND_CATALOG}
 * @returns {{ missingFromCatalog: string[], staleInCatalog: string[] }}
 * @example
 * ```js
 * import { deriveCommandCatalogDiff } from "@m3l-automation/workspace/bin/lib/command-catalog.mjs";
 *
 * deriveCommandCatalogDiff({ build: "turbo run build" });
 * // { missingFromCatalog: [], staleInCatalog: [...every other catalog name] }
 * ```
 */
export function deriveCommandCatalogDiff(
  packageScripts,
  catalog = COMMAND_CATALOG,
) {
  const catalogNames = new Set(catalog.map((entry) => entry.name));
  const scriptNames = new Set(Object.keys(packageScripts));

  const missingFromCatalog = [...scriptNames]
    .filter((name) => !catalogNames.has(name))
    .sort();
  const staleInCatalog = [...catalogNames]
    .filter((name) => !scriptNames.has(name))
    .sort();

  return { missingFromCatalog, staleInCatalog };
}

// A script name's family is the substring before its first ":", or the whole
// name when there is none — e.g. "check:hooks" -> "check", "build" -> "build".
// This is why "lint:md"/"lint:commit" group with bare "lint", and
// "format:check" groups with bare "format": no hand-maintained grouping
// config exists to drift from the naming itself.
function familyOf(name) {
  const colonIndex = name.indexOf(":");
  return colonIndex === -1 ? name : name.slice(0, colonIndex);
}

/**
 * Group every `package.json` script by {@link familyOf}, joined against
 * {@link COMMAND_CATALOG} for its description. A script with no catalog entry
 * still appears (falling back to its raw command string as the description,
 * flagged via `hasDescription: false`) so the lister never hides an
 * undocumented command — {@link deriveCommandCatalogDiff} is the blocking
 * half of that gap. Families and the entries within them are both sorted
 * alphabetically — fully mechanical, nothing hand-ordered to go stale.
 *
 * @param {Record<string, string>} packageScripts `package.json`'s `scripts` object
 * @param {{ name: string, description: string }[]} [catalog] defaults to {@link COMMAND_CATALOG}
 * @returns {{ family: string, entries: { name: string, description: string, hasDescription: boolean }[] }[]}
 * @example
 * ```js
 * import { groupByFamily } from "@m3l-automation/workspace/bin/lib/command-catalog.mjs";
 *
 * groupByFamily({ "lint": "eslint .", "lint:md": "rumdl check ." });
 * // [{ family: "lint", entries: [{ name: "lint", ... }, { name: "lint:md", ... }] }]
 * ```
 */
export function groupByFamily(packageScripts, catalog = COMMAND_CATALOG) {
  const descriptionByName = new Map(
    catalog.map((entry) => [entry.name, entry.description]),
  );
  const groups = new Map();

  for (const [name, command] of Object.entries(packageScripts)) {
    const family = familyOf(name);
    const description = descriptionByName.get(name);
    const entry = {
      name,
      description: description ?? command,
      hasDescription: description !== undefined,
    };
    const existing = groups.get(family);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(family, [entry]);
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, entries]) => ({
      family,
      entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
