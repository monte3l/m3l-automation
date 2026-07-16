#!/usr/bin/env node
// Verifies every scripts/*/package.json declares exactly one runtime
// dependency — @m3l-automation/m3l-common via workspace:* — and no
// devDependencies (ADR-0029: scripts depend only on the library; the
// workspace root owns all tooling). This is the package.json-declaration
// half of the boundary; the source-level half (no @aws-sdk/* import) is
// already enforced by eslint.config.js's scripts/*/src/**/*.ts override.
//
// Separate from check-deps.mjs, which is scoped to the published library
// package's ADR-0017 exact-pin/optional-peer rules — a different package
// set and a different rule.
//
// Usage:
//   node bin/check-script-deps.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scriptPackageDirs } from "./lib/script-scaffold.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a script package.json's dependency declarations against ADR-0029:
 * exactly one runtime dependency (@m3l-automation/m3l-common, pinned to
 * workspace:*) and no devDependencies at all. Pure — operates on a parsed
 * package.json object. Returns human-readable problem strings (empty array =
 * conformant).
 *
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} pkg
 * @returns {string[]}
 */
export function scriptDependencyErrors(pkg) {
  const problems = [];
  const deps = pkg.dependencies ?? {};
  const depNames = Object.keys(deps);
  const isExactlyTheLibrary =
    depNames.length === 1 &&
    depNames[0] === "@m3l-automation/m3l-common" &&
    deps["@m3l-automation/m3l-common"] === "workspace:*";
  if (!isExactlyTheLibrary) {
    problems.push(
      `dependencies must be exactly {"@m3l-automation/m3l-common": "workspace:*"} (got ${JSON.stringify(deps)}) — ADR-0029 bans script-local dependencies; a new capability becomes a library wrapper first.`,
    );
  }
  if (pkg.devDependencies !== undefined) {
    problems.push(
      `devDependencies must not be declared — the workspace root owns all tooling (ADR-0029).`,
    );
  }
  return problems;
}

// Main execution — only run when invoked directly, not when imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let errors = 0;
  function report(message) {
    console.error(`✗  ${message}`);
    errors++;
  }

  const scriptNames = scriptPackageDirs(root);
  for (const name of scriptNames) {
    const manifestPath = join(root, "scripts", name, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      report(`scripts/${name}/package.json is not valid JSON: ${cause}`);
      continue;
    }
    for (const problem of scriptDependencyErrors(pkg)) {
      report(`scripts/${name}/package.json: ${problem}`);
    }
  }

  if (errors > 0) {
    console.error(
      `\n✗  ${errors} script-dependency mismatch(es). ADR-0029: scripts depend only on @m3l-automation/m3l-common.`,
    );
    process.exit(1);
  }

  console.log(
    scriptNames.length === 0
      ? "✓  No script packages under scripts/ — nothing to check."
      : `✓  ${scriptNames.length} script package(s) declare exactly the ADR-0029 dependency boundary.`,
  );
}
