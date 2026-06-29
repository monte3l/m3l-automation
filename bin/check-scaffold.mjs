#!/usr/bin/env node
// Verifies that every submodule directory under src/core/ and src/aws/ that
// contains an index.ts is re-exported from the corresponding namespace barrel,
// and that no barrel line points to a non-existent directory.
//
// Usage:
//   node bin/check-scaffold.mjs   # exits 0 on success, 1 on any mismatch
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgSrc = join(root, "packages/m3l-common/src");

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

/** Return module names cited in `export * from "./<name>/index.js"` lines. */
function barrelExports(barrelPath) {
  let content;
  try {
    content = readFileSync(barrelPath, "utf8");
  } catch {
    return [];
  }
  const re = /^export \* from "\.\/([^/]+)\/index\.js";/gm;
  const names = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    names.push(m[1]);
  }
  return names;
}

const namespaces = [
  { name: "core", dir: join(pkgSrc, "core"), barrel: join(pkgSrc, "core/index.ts") },
  { name: "aws",  dir: join(pkgSrc, "aws"),  barrel: join(pkgSrc, "aws/index.ts") },
];

let errors = 0;

for (const ns of namespaces) {
  const srcModules = new Set(implementedModules(ns.dir));
  const barrelModules = new Set(barrelExports(ns.barrel));

  for (const mod of srcModules) {
    if (!barrelModules.has(mod)) {
      console.error(
        `✗  src/${ns.name}/${mod}/index.ts exists but is NOT re-exported from src/${ns.name}/index.ts\n` +
          `   Add: export * from "./${mod}/index.js";`,
      );
      errors++;
    }
  }

  for (const mod of barrelModules) {
    if (!srcModules.has(mod)) {
      console.error(
        `✗  src/${ns.name}/index.ts re-exports "./${mod}/index.js" but src/${ns.name}/${mod}/index.ts does NOT exist`,
      );
      errors++;
    }
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} barrel mismatch(es). Align src/ directories with barrel re-exports.`,
  );
  process.exit(1);
}

console.log("✓  All barrel re-exports match src/ directories.");
