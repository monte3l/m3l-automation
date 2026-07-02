#!/usr/bin/env node
// Verifies the scaffolding seam laid down by the `scaffolding-submodules` skill stays
// intact: every submodule directory under src/core/ and src/aws/ that contains
// an index.ts must have BOTH
//   (a) a matching test file at packages/m3l-common/tests/<module>.test.ts, and
//   (b) a row for <module> in docs/implementation-status.md.
//
// This fills the gap between the sibling gates: check-scaffold proves the
// barrel <-> src wiring, and the doc-exports gate proves the barrel is
// documented, but nothing else guarantees a scaffolded module carries its TDD
// test file and a status-tracker row. A module missing either is half-scaffolded.
//
// Usage:
//   node bin/check-scaffold-seam.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/m3l-common");
const statusPath = join(root, "docs/implementation-status.md");

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

/** True if `docs/implementation-status.md` has a table row whose first cell is exactly `module`. */
function hasStatusRow(statusText, module) {
  return new RegExp(`^\\|\\s*${module}\\s*\\|`, "m").test(statusText);
}

const namespaces = ["core", "aws"];
const statusText = (() => {
  try {
    return readFileSync(statusPath, "utf8");
  } catch {
    return "";
  }
})();

let errors = 0;

if (statusText === "") {
  console.error(`✗  Could not read docs/implementation-status.md`);
  errors++;
}

for (const ns of namespaces) {
  for (const mod of implementedModules(join(pkg, "src", ns))) {
    const testFile = join(pkg, "tests", `${mod}.test.ts`);
    if (!existsSync(testFile)) {
      console.error(
        `✗  src/${ns}/${mod}/index.ts exists but tests/${mod}.test.ts is missing (scaffold seam broken)`,
      );
      errors++;
    }
    if (statusText !== "" && !hasStatusRow(statusText, mod)) {
      console.error(
        `✗  src/${ns}/${mod}/index.ts exists but has no row in docs/implementation-status.md`,
      );
      errors++;
    }
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} scaffold-seam gap(s). Every src submodule needs a test file and a status row.`,
  );
  process.exit(1);
}

console.log(
  "✓  Every src submodule has a matching test file and status-tracker row.",
);
