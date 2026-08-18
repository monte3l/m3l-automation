#!/usr/bin/env node
// Verifies every consumer-script README and reference page against the
// canonical structure spec (docs/contributing/script-docs-structure.md).
// Complements check-script-scaffold.mjs (which checks file layout, package
// shape, and the basic "Examples section is populated" rule) with a deeper
// section-structure check enforcing the spec's full section requirements and
// style rules.
//
// Per script package:
//   - README.md: all required sections present and in order, contract
//     blockquote present, ≥3 runnable examples, "Operations at a glance" table
//     uses "Operation" column header (not "Command"), no scaffold placeholder.
//   - docs/reference/scripts/<name>.md: all required sections present,
//     contract blockquote present, config table uses "Validation" column (not
//     "Declarative `validate:`").
//
// Sanctioned exceptions are listed in SCRIPT_DOCS_EXCEPTIONS (bin/lib/script-docs.mjs);
// see docs/contributing/script-docs-structure.md §Sanctioned deviations.
//
// Usage:
//   node bin/check-script-docs.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readmeStructureErrors,
  referenceStructureErrors,
} from "./lib/script-docs.mjs";
import {
  SCRIPT_DOCS_DIR,
  scriptPackageDirs,
} from "./lib/script-scaffold.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let errors = 0;
function report(message, file) {
  reporter.error(message, file ? { file } : undefined);
  errors++;
}

const scriptNames = scriptPackageDirs(root);

for (const name of scriptNames) {
  // --- README ---
  const readmeRel = `scripts/${name}/README.md`;
  const readmePath = join(root, readmeRel);
  if (existsSync(readmePath)) {
    const readmeText = readFileSync(readmePath, "utf8");
    for (const problem of readmeStructureErrors(readmeText, name)) {
      report(`${readmeRel}: ${problem}`, readmeRel);
    }
  }

  // --- Reference page ---
  const pageRel = `${SCRIPT_DOCS_DIR}/${name}.md`;
  const pagePath = join(root, pageRel);
  if (existsSync(pagePath)) {
    const pageText = readFileSync(pagePath, "utf8");
    for (const problem of referenceStructureErrors(pageText, name)) {
      report(`${pageRel}: ${problem}`, pageRel);
    }
  }
}

if (errors > 0) {
  if (!json) {
    console.error(
      `\n✗  ${errors} script-docs mismatch(es). See docs/contributing/script-docs-structure.md for the canonical spec.`,
    );
  }
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  scriptNames.length === 0
    ? "No script packages under scripts/ — nothing to check."
    : `${scriptNames.length} script README(s) and reference page(s) conform to the canonical structure spec.`,
);
reporter.finish();
