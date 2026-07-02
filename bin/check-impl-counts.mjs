#!/usr/bin/env node
// Derives the canonical IMPLEMENTED-submodule count (the numerator of the
// "N of 22" figure) from the Status column of docs/implementation-status.md and
// asserts that every prose/badge/HTML site quoting that numerator agrees.
//
// This is the numerator counterpart to check-doc-counts.mjs, which owns the
// denominator (total documented = 22). The numerator rotted undetected once
// (see docs/logs/2026-07-01-core-json.md, divergence 1) because two count sites
// — packages/m3l-common/README.md and docs/index.html — were checked nowhere.
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
  {
    file: "docs/index.html",
    pattern: /(\d+) \/ 22 implemented/,
    label: "docs/index.html status-row span",
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

// docs/index.html structural checks: the module tree must render exactly N
// implemented entries (class="done"), and the "done" status span must list the
// implemented names in order. These catch marker/name drift that a bare numeral
// would miss.
const html = read("docs/index.html");
if (html !== null) {
  const doneCount = (html.match(/class="done"/g) ?? []).length;
  if (doneCount !== expected) {
    console.error(
      `✗  docs/index.html: ${doneCount} module-tree entries carry class="done" ` +
        `but derived implemented count is ${expected}. Flip the ${
          doneCount > expected ? "extra" : "missing"
        } module(s) between class="done"/class="not-started".`,
    );
    errors++;
  }

  const doneSpan = /<span class="value done"[^>]*>\s*([^<]+?)\s*<\/span/.exec(
    html,
  );
  if (!doneSpan) {
    console.error(
      `✗  docs/index.html: could not locate the "done" names span ` +
        `(<span class="value done" …>).`,
    );
    errors++;
  } else {
    // Normalize internal whitespace: once the list crosses prettier's
    // printWidth (80) it wraps to newline + indent, which a `.trim()`-only
    // compare would reject. Collapsing runs of whitespace decouples this gate
    // from prettier's line-wrapping (see docs/logs/2026-07-01-core-analysis.md,
    // divergence 5) so no `<!-- prettier-ignore -->` is needed on the span.
    const doneNames = doneSpan[1].trim().replace(/\s+/g, " ");
    if (doneNames !== namesCsv) {
      console.error(
        `✗  docs/index.html: "done" names span lists "${doneNames}" ` +
          `but implemented modules are "${namesCsv}".`,
      );
      errors++;
    }
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
