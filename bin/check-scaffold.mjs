#!/usr/bin/env node
// Verifies that every submodule directory under src/core/ and src/aws/ that
// contains an index.ts is re-exported from the corresponding namespace barrel,
// and that no barrel line points to a non-existent directory. Also verifies
// every packages/* workspace has a root tsconfig.json project reference (and
// no stale one survives), the packages-side sibling of what
// check-script-scaffold.mjs already does for scripts/*.
//
// Usage:
//   node bin/check-scaffold.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const pkgSrc = join(root, "packages/m3l-common/src");
const { json } = parseJsonFlag();
const reporter = createReporter(json);

/** Return subdirectory names under `dir` that contain an index.ts. */
function implementedModules(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(dir, name, "index.ts")));
  } catch {
    return [];
  }
}

/**
 * Return module names cited in a barrel's re-export lines — either a full
 * `export * from "./<name>/index.js"` line, or a named `export {...}` /
 * `export type {...}` block whose `from` clause targets the module's own
 * index.ts. The named-export shape is a submodule barrel's fallback when
 * `export *` would create an ambiguous duplicate-export collision with a
 * sibling submodule (e.g. two identically-named local types) — matching on
 * the `from` clause alone (not anchoring to `export *`) recognizes both
 * shapes as proof the module is re-exported.
 */
function barrelExports(barrelPath) {
  let content;
  try {
    content = readFileSync(barrelPath, "utf8");
  } catch {
    return [];
  }
  const re = /from "\.\/([^/]+)\/index\.js";/gm;
  const names = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    names.push(m[1]);
  }
  return names;
}

const namespaces = [
  {
    name: "core",
    dir: join(pkgSrc, "core"),
    barrel: join(pkgSrc, "core/index.ts"),
  },
  {
    name: "aws",
    dir: join(pkgSrc, "aws"),
    barrel: join(pkgSrc, "aws/index.ts"),
  },
];

let errors = 0;

for (const ns of namespaces) {
  const srcModules = new Set(implementedModules(ns.dir));
  const barrelModules = new Set(barrelExports(ns.barrel));

  const barrelRel = `packages/m3l-common/src/${ns.name}/index.ts`;

  for (const mod of srcModules) {
    if (!barrelModules.has(mod)) {
      reporter.error(
        `src/${ns.name}/${mod}/index.ts exists but is NOT re-exported from src/${ns.name}/index.ts ` +
          `— add: export * from "./${mod}/index.js";`,
        { file: barrelRel },
      );
      errors++;
    }
  }

  for (const mod of barrelModules) {
    if (!srcModules.has(mod)) {
      reporter.error(
        `src/${ns.name}/index.ts re-exports "./${mod}/index.js" but src/${ns.name}/${mod}/index.ts does NOT exist`,
        { file: barrelRel },
      );
      errors++;
    }
  }
}

// --- packages/* root-tsconfig reference coverage -----------------------------
// The scripts-side sibling of this rule lives in check-script-scaffold.mjs
// (rootTsconfigRef/REQUIRED reference check) — that one is scoped to
// `./scripts/`, so a new `packages/*` workspace (today just m3l-common) had
// no forward/reverse coverage at all: `tsc -b` would silently never build it.
const tsconfigPath = join(root, "tsconfig.json");
const rootTsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
const rootRefs = (rootTsconfig.references ?? []).map((entry) => entry.path);

/** Directory names under `packages/` that contain a package.json. */
function packageDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(dir, name, "package.json")));
  } catch {
    return [];
  }
}

/** The root tsconfig `references` entry a packages/* workspace must have. */
function packageTsconfigRef(name) {
  return `./packages/${name}/tsconfig.build.json`;
}

const packageNames = packageDirs(join(root, "packages"));

// Forward: every packages/* workspace has a root reference.
for (const name of packageNames) {
  const ref = packageTsconfigRef(name);
  if (!rootRefs.includes(ref)) {
    reporter.error(
      `tsconfig.json is missing the project reference { "path": "${ref}" } — tsc -b will not build packages/${name}.`,
      { file: "tsconfig.json" },
    );
    errors++;
  }
}

// Reverse: every ./packages/ root reference points at a real workspace.
const packageRefs = rootRefs.filter((path) => path.startsWith("./packages/"));
for (const ref of packageRefs) {
  const name = ref.split("/")[2];
  if (!packageNames.includes(name)) {
    reporter.error(
      `tsconfig.json references "${ref}" but packages/${name}/ is not a package workspace (stale reference).`,
      { file: "tsconfig.json" },
    );
    errors++;
  }
}

// Warn (not error, matching the convention this mirrors): ./packages/
// references stay sorted alphabetically among themselves.
const sortedPackageRefs = [...packageRefs].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(packageRefs) !== JSON.stringify(sortedPackageRefs)) {
  reporter.warn(
    `tsconfig.json's "./packages/" references are not sorted alphabetically among themselves (found: ${packageRefs.join(", ")}; expected: ${sortedPackageRefs.join(", ")}).`,
    { file: "tsconfig.json" },
  );
}

if (errors > 0) {
  if (!json) {
    console.error(
      `\n✗  ${errors} barrel/tsconfig mismatch(es). Align src/ directories with barrel re-exports and packages/* with tsconfig.json's references.`,
    );
  }
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  "All barrel re-exports match src/ directories; packages/* tsconfig references are complete.",
);
reporter.finish();
