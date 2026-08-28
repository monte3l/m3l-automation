// Classifies the file paths changed between two git refs into the CI-relevant
// categories ci.yml's lane jobs and the `gates` lane's individual steps gate
// on: `ts`, `deps`, `scripts`, `claude`, `workflows`, `docs`, `md`. A path can
// set more than one category (e.g. `CLAUDE.md` is both `workflows` and
// `docs`) — categories are independent booleans, not a partition.
//
// Fails OPEN, never closed: bin/ci-changed-paths.mjs defaults every category
// to true when the diff can't be computed (bad refs, git error, no common
// history) — a silent mis-scoped skip is worse than an unnecessary lane run.
// Same rule for a change under `bin/**` here: the check scripts' own logic
// lives there, so a change to any one of them sets every category true
// rather than trusting this classifier to know which single category its
// own edit belongs to. Same rule again for any path that matches NO
// predicate at all: an unclassified path (e.g. a new top-level directory
// like `templates/`) is exactly the case this classifier can't yet reason
// about, so it forces every category true rather than silently reading as
// all-false — three review rounds each found a different unmatched path
// (a config file, a snapshot, a template) before this net was added.

/** @typedef {"ts" | "deps" | "scripts" | "claude" | "workflows" | "docs" | "md" | "console"} ChangeCategory */

/** @type {ChangeCategory[]} */
export const CHANGE_CATEGORIES = [
  "ts",
  "deps",
  "scripts",
  "claude",
  "workflows",
  "docs",
  "md",
  "console",
];

/**
 * Per-category path predicates. Deliberately generous/overlapping — a
 * mis-scoped MISS (a path that should set a category but doesn't) is the
 * failure mode that silently skips a needed CI gate; a mis-scoped HIT
 * (a category set true when it didn't need to be) only costs runner time.
 *
 * @type {Record<ChangeCategory, (path: string) => boolean>}
 */
const PREDICATES = {
  ts: (path) =>
    path.endsWith(".ts") ||
    // .tsx: packages/m3l-console-web (ADR-0067) is the only source of these.
    path.endsWith(".tsx") ||
    path === "eslint.config.js" ||
    path === "package.json" ||
    path.endsWith("/package.json") ||
    path === "pnpm-lock.yaml" ||
    path === "pnpm-workspace.yaml" ||
    path === "turbo.json" ||
    path.endsWith("tsconfig.json") ||
    path.endsWith("tsconfig.base.json") ||
    path.endsWith("tsconfig.build.json") ||
    // The committed exports-map snapshot check:api/check:exports-semver diff
    // against — matches no other predicate (not .ts, not package.json).
    path === "packages/m3l-common/api-exports.json" ||
    // Tool config files whose owning check has no other way to notice a
    // config-only edit: knip.json configures `pnpm knip`, .jscpd.json
    // configures `pnpm check:dup` — both gated on `ts`.
    path === "knip.json" ||
    path === ".jscpd.json",
  deps: (path) =>
    path === "package.json" ||
    path.endsWith("/package.json") ||
    path === "pnpm-lock.yaml" ||
    path === "pnpm-workspace.yaml",
  scripts: (path) => path.startsWith("scripts/"),
  claude: (path) => path.startsWith(".claude/"),
  workflows: (path) =>
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    path === "lefthook.yml" ||
    path === "bin/lib/verify-steps.mjs" ||
    path === "bin/check-verify-parity.mjs" ||
    path === "bin/check-cadence-doc.mjs" ||
    path === "bin/check-workflows-doc.mjs" ||
    path === "CLAUDE.md",
  docs: (path) =>
    path.startsWith("docs/") ||
    path === "CLAUDE.md" ||
    path === "README.md" ||
    path.endsWith("/README.md"),
  md: (path) =>
    path.endsWith(".md") ||
    // rumdl reads this file as its config (markdownlint-compatible format);
    // configures `pnpm lint:md`, gated on `md`.
    path === ".markdownlint.json",
  // ADR-0067's X9b Playwright job triggers on this category rather than the
  // broad `ts` one — Playwright is expensive enough (browser install +
  // runtime) that the CI-cost decision was to path-scope it to the two
  // packages that make up the console (frontend + backend), not run it on
  // every TypeScript change repo-wide.
  console: (path) =>
    path.startsWith("packages/m3l-console-web/") ||
    path.startsWith("packages/m3l-console-server/"),
};

/**
 * Classify a set of changed paths into the boolean category flags.
 *
 * @param {string[]} paths repo-relative paths, POSIX separators
 * @returns {Record<ChangeCategory, boolean>}
 */
export function classifyChangedPaths(paths) {
  const anyBinChange = paths.some((p) => p.startsWith("bin/"));
  const anyUnclassified = paths.some(
    (p) => !CHANGE_CATEGORIES.some((category) => PREDICATES[category](p)),
  );
  const forceAll = anyBinChange || anyUnclassified;
  /** @type {Record<ChangeCategory, boolean>} */
  const flags = /** @type {any} */ ({});
  for (const category of CHANGE_CATEGORIES) {
    flags[category] = forceAll || paths.some((p) => PREDICATES[category](p));
  }
  return flags;
}

/**
 * Every category set true — the fail-open default when the diff itself
 * can't be trusted.
 *
 * @returns {Record<ChangeCategory, boolean>}
 */
export function allChanged() {
  /** @type {Record<ChangeCategory, boolean>} */
  const flags = /** @type {any} */ ({});
  for (const category of CHANGE_CATEGORIES) flags[category] = true;
  return flags;
}

/**
 * Resolve the changed-path list between two refs via `git diff --name-only`.
 * Throws if either ref doesn't resolve or the diff otherwise fails — the CLI
 * entry point (bin/ci-changed-paths.mjs) treats any throw as fail-open.
 *
 * @param {{ execFileSync: typeof import("node:child_process").execFileSync }} deps
 * @param {string} cwd repo root
 * @param {string} base
 * @param {string} head
 * @returns {string[]}
 */
export function resolveChangedPaths({ execFileSync }, cwd, base, head) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { cwd, encoding: "utf8" },
  );
  return output.split("\n").filter((line) => line.length > 0);
}
