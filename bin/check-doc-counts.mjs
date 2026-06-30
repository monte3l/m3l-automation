#!/usr/bin/env node
// Derives the canonical submodule count from docs/reference/ and asserts
// that prose documents use the correct numbers. Prevents count drift caused
// by adding or removing a reference page without updating the prose.
//
// Canonical rule: docs/reference/core/*.md drives the Core count;
// docs/reference/aws/*.md drives the AWS count; the total is Core + AWS.
//
// Usage:
//   node bin/check-doc-counts.mjs   # verify counts (fails on mismatch)
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function countMdFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

const coreCount = countMdFiles(join(root, "docs/reference/core"));
const awsCount = countMdFiles(join(root, "docs/reference/aws"));
const total = coreCount + awsCount;

// Each check: a file, a regex capturing the numeric claim, the expected value,
// and a human-readable label used in error messages.
const checks = [
  {
    file: "CLAUDE.md",
    pattern: /Core namespace barrel \((\d+) submodules surfaced here\)/,
    expected: coreCount,
    label: "Core barrel comment",
  },
  {
    file: "CLAUDE.md",
    pattern: /\d+ of (\d+) submodules are implemented/,
    expected: total,
    label: "total submodule count (implementation state line)",
  },
  {
    file: "docs/README.md",
    pattern: /(\d+) submodules documented/,
    expected: total,
    label: "total submodule count (development status callout)",
  },
  {
    file: "README.md",
    pattern: /modules-\d+%2F(\d+)-/,
    expected: total,
    label: "total submodule count (root README.md badge URL)",
  },
  {
    file: "README.md",
    pattern: /\d+ of (\d+) submodules are/,
    expected: total,
    label: "total submodule count (root README.md prose)",
  },
];

let errors = 0;

for (const check of checks) {
  const filePath = join(root, check.file);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    console.error(`✗  Cannot read ${check.file}`);
    errors++;
    continue;
  }

  const m = check.pattern.exec(content);
  if (!m) {
    console.error(
      `✗  ${check.file}: expected pattern not found: ${check.pattern}`,
    );
    errors++;
    continue;
  }

  const actual = parseInt(m[1], 10);
  if (actual !== check.expected) {
    const ctx = content
      .slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)
      .trim();
    console.error(
      `✗  ${check.file}: ${check.label} says ${actual} but derived count is ${check.expected}\n` +
        `   Derived: Core=${coreCount} + AWS=${awsCount} = ${total}\n` +
        `   Context: "...${ctx}..."`,
    );
    errors++;
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} count mismatch(es). Update the prose to match the derived counts ` +
      `(Core: ${coreCount}, AWS: ${awsCount}, total: ${total}).`,
  );
  process.exit(1);
}

console.log(
  `✓  All doc counts match: ${coreCount} Core + ${awsCount} AWS = ${total} total.`,
);
