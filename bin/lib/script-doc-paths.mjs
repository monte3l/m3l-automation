// Build-independent script-scaffold path helpers, split out of
// bin/lib/script-scaffold.mjs so consumers that only need directory/path
// bookkeeping (bin/gen-project-hub.mjs, bin/lib/reference-index.mjs and its
// transitive consumers) never trigger that module's
// `packages/m3l-cli/dist` import — a hard requirement for
// .github/workflows/pages.yml, which builds the Pages dashboard without
// running `pnpm build` first.
//
// `SCRIPT_DOCS_DIR`/`docPagePath` duplicate packages/m3l-cli/src/scaffold/
// manifest.ts's own copies (ADR-0053 U9) rather than importing them, since
// that CLI module can only be reached once built. This is a narrow,
// deliberate exception to "one source of truth": both copies are plain
// string literals, and bin/tests/script-scaffold.test.ts asserts they stay
// identical to the CLI's canonical copy — so a rename there fails a test
// immediately rather than silently drifting.
//
// `scriptPackageDirs` was never CLI-owned — it is purely local, relocated
// here unchanged.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Directory (repo-relative) holding one contract page per script. */
export const SCRIPT_DOCS_DIR = "docs/reference/scripts";

/**
 * ```ts
 * docPagePath("data-sync"); // "docs/reference/scripts/data-sync.md"
 * ```
 *
 * @param {string} name - A kebab-case script name.
 * @returns {string}
 */
export function docPagePath(name) {
  return `${SCRIPT_DOCS_DIR}/${name}.md`;
}

/**
 * Directory names under `scripts/` that contain a package.json — the set of
 * script packages the checker validates. Artifact-only ghosts (a leftover
 * dist/ with no manifest) are ignored.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function scriptPackageDirs(repoRoot) {
  const scriptsDir = join(repoRoot, "scripts");
  if (!existsSync(scriptsDir)) {
    return [];
  }
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(scriptsDir, name, "package.json")));
}
