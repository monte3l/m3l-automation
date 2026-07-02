#!/usr/bin/env node
// Derives the canonical IMPLEMENTED-submodule count (the numerator of the
// "N of 22" figure) from the Status column of docs/implementation-status.md and
// asserts that every prose/badge/HTML site quoting that numerator agrees.
//
// This is the numerator counterpart to check-doc-counts.mjs, which owns the
// denominator (total documented = 22). The numerator rotted undetected once
// (see docs/logs/2026-07-01-core-json.md, divergence 1) because
// packages/m3l-common/README.md was checked nowhere.
//
// Canonical rule: a submodule is implemented when its Status-column emoji in
// docs/implementation-status.md is ✅. That set drives both the count (N) and
// the ordered name list rendered on the landing page.
//
// Usage:
//   node bin/check-impl-counts.mjs   # verify (fails on mismatch)
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, parseImplementationStatus } from "./lib/reference-index.mjs";

// Implemented submodules, in table order (insertion order of the status map).
const status = parseImplementationStatus();
const implemented = Object.keys(status).filter((name) => status[name] === "✅");
const expected = implemented.length;
const namesCsv = implemented.join(", ");

// Numeric sites: each captures the numerator in group 1 and must equal `expected`.
const numericChecks = [
  {
    file: "README.md",
    pattern: /modules-(\d+)%2F22/,
    label: "root README.md badge URL",
  },
  {
    file: "README.md",
    pattern: /(\d+) of 22 submodules are/,
    label: "root README.md prose callout",
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /modules-(\d+)%2F22/,
    label: "npm-facing README.md badge URL",
  },
  {
    file: "packages/m3l-common/README.md",
    pattern: /(\d+) of 22 submodules are/,
    label: "npm-facing README.md prose callout",
  },
  {
    file: "docs/README.md",
    pattern: /implemented \((\d+) of 22\)/,
    label: "docs/README.md development-status callout",
  },
  {
    file: "docs/implementation-status.md",
    pattern: /\((\d+) of 22 submodules\)/,
    label: "implementation-status.md intro prose",
  },
];

let errors = 0;

function read(file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    console.error(`✗  Cannot read ${file}`);
    errors++;
    return null;
  }
}

for (const check of numericChecks) {
  const content = read(check.file);
  if (content === null) continue;

  const m = check.pattern.exec(content);
  if (!m) {
    console.error(
      `✗  ${check.file}: expected pattern not found: ${check.pattern}`,
    );
    errors++;
    continue;
  }

  const actual = parseInt(m[1], 10);
  if (actual !== expected) {
    const ctx = content
      .slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)
      .trim();
    console.error(
      `✗  ${check.file}: ${check.label} says ${actual} but derived count is ${expected}\n` +
        `   Context: "...${ctx}..."`,
    );
    errors++;
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} implemented-count mismatch(es). Derived implemented count ` +
      `is ${expected} (${namesCsv}). Update each site to match, or fix the ` +
      `Status column in docs/implementation-status.md if the derivation is wrong.`,
  );
  process.exit(1);
}

console.log(
  `✓  Implemented count matches everywhere: ${expected} of 22 (${namesCsv}).`,
);
