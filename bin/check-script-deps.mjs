#!/usr/bin/env node
// Verifies every scripts/*/package.json declares exactly one runtime
// dependency — @monte3l/m3l-common, either via the new plain workspace:*
// specifier or (transitionally — see below) the pre-rename aliased form —
// and no devDependencies (ADR-0029: scripts depend only on the library; the
// workspace root owns all tooling). This is the package.json-declaration
// half of the boundary; the source-level half (no @aws-sdk/* import) is
// already enforced by eslint.config.js's scripts/*/src/**/*.ts override.
//
// TRANSITIONAL (ADR-0103 P4a / P4a2): P4a dropped the pre-rename
// @m3l-automation/m3l-common alias for 16 of the 17 scripts packages in one
// PR; the 17th (agent-operator, by far the largest) was deferred to a
// follow-up PR (P4a2) to stay under the review-size ceiling
// (docs/plans/2026-09-12-u13-registry-publish.md). This checker accepts
// EITHER shape until P4a2 lands and migrates agent-operator too, at which
// point TRANSITIONAL_ALIASED_NAME/VALUE and the branch that accepts them
// should be deleted — main must never be broken by a package that hasn't
// migrated yet.
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
import { join } from "node:path";
import { scriptPackageDirs } from "./lib/script-doc-paths.mjs";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

/** The one permitted dependency's key and workspace target (ADR-0029), the
 * renamed `@monte3l/m3l-common` name as of ADR-0103's P4a slice. */
const LIBRARY_DEPENDENCY_NAME = "@monte3l/m3l-common";
const LIBRARY_DEPENDENCY_VALUE = "workspace:*";

/** TRANSITIONAL (see the header comment) — the pre-rename aliased shape,
 * still declared by agent-operator until P4a2 migrates it too. Delete this
 * pair and the branch below that checks it once that lands. */
const TRANSITIONAL_ALIASED_NAME = "@m3l-automation/m3l-common";
const TRANSITIONAL_ALIASED_VALUE = "workspace:@monte3l/m3l-common@*";

/**
 * Validate a script package.json's dependency declarations against ADR-0029:
 * exactly one runtime dependency — @monte3l/m3l-common, either via a plain
 * workspace: specifier or (transitionally, until P4a2) the pre-rename
 * aliased form — and no devDependencies at all. Pure — operates on a parsed
 * package.json object.
 * Returns human-readable problem strings (empty array = conformant).
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
    ((depNames[0] === LIBRARY_DEPENDENCY_NAME &&
      deps[LIBRARY_DEPENDENCY_NAME] === LIBRARY_DEPENDENCY_VALUE) ||
      (depNames[0] === TRANSITIONAL_ALIASED_NAME &&
        deps[TRANSITIONAL_ALIASED_NAME] === TRANSITIONAL_ALIASED_VALUE));
  if (!isExactlyTheLibrary) {
    problems.push(
      `dependencies must be exactly {"${LIBRARY_DEPENDENCY_NAME}": "${LIBRARY_DEPENDENCY_VALUE}"} (got ${JSON.stringify(deps)}) — ADR-0029 bans script-local dependencies; a new capability becomes a library wrapper first.`,
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
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  let errors = 0;
  function report(message, file) {
    reporter.error(message, file ? { file } : undefined);
    errors++;
  }

  const scriptNames = scriptPackageDirs(root);
  for (const name of scriptNames) {
    const manifestPath = join(root, "scripts", name, "package.json");
    const manifestRel = `scripts/${name}/package.json`;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      report(`${manifestRel} is not valid JSON: ${cause}`, manifestRel);
      continue;
    }
    for (const problem of scriptDependencyErrors(pkg)) {
      report(`${manifestRel}: ${problem}`, manifestRel);
    }
  }

  if (errors > 0) {
    if (!json) {
      console.error(
        `\n✗  ${errors} script-dependency mismatch(es). ADR-0029: scripts depend only on @m3l-automation/m3l-common.`,
      );
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    scriptNames.length === 0
      ? "No script packages under scripts/ — nothing to check."
      : `${scriptNames.length} script package(s) declare exactly the ADR-0029 dependency boundary.`,
  );
  reporter.finish();
}
