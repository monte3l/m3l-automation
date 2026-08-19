#!/usr/bin/env node
// Derives the canonical workflow set from .github/workflows/*.yml and asserts
// that docs/contributing/ci-cd.md's "CI/CD" section documents exactly those
// workflows — the spelled-out count in the section header plus one table row
// per workflow file. Prevents CI-table drift caused by adding or removing a
// workflow without updating that doc (e.g. scorecard.yml shipping undocumented).
//
// Canonical rule: .github/workflows/*.yml (and *.yaml) drives the set; the doc
// prose must match it in both directions — no undocumented workflow, no stale
// row for a workflow that no longer exists. CLAUDE.md carries only a one-line
// pointer to this file (moved out to shrink the always-loaded preamble — see
// CLAUDE.md's maintainer header); this gate was repointed alongside that move.
//
// Not to be confused with its name-sibling bin/check-workflows.mjs
// (`check:workflows`), which validates the .claude/workflows/ dynamic-workflow
// surface against the MODEL-MATRIX (ADR-0025). Deliberately separate checks;
// never merge them as "redundant."
//
// Usage:
//   node bin/check-workflows-doc.mjs   # verify (fails on mismatch)
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const workflowsRel = ".github/workflows";
const docRel = "docs/contributing/ci-cd.md";
const { json } = parseJsonFlag();
const reporter = createReporter(json);

// Number words for the spelled-out count in the section header sentence.
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

const errors = [];

// 1 — canonical workflow set from the filesystem.
let files;
try {
  files = readdirSync(join(root, workflowsRel))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
} catch {
  reporter.error(`Cannot read ${workflowsRel}/`);
  reporter.finish();
  process.exit(1);
}
const workflowFiles = new Set(files);
const count = files.length;

const content = readFileSync(join(root, docRel), "utf8");

// 2 — isolate the "## CI/CD" section so the table parse can't pick up unrelated
// *.yml mentions (lefthook.yml, dependabot.yml, pnpm-workspace.yaml, …).
const sectionMatch = /## CI\/CD\n([\s\S]*?)(?:\n## |\n?$)/.exec(content);
if (!sectionMatch) {
  reporter.error(`${docRel}: could not locate the "## CI/CD" section.`, {
    file: docRel,
  });
  reporter.finish();
  process.exit(1);
}
const section = sectionMatch[1];

// 3 — the spelled-out count in the section header sentence.
const headerMatch =
  /(\w+) GitHub Actions workflows in `\.github\/workflows\/`/.exec(section);
if (!headerMatch) {
  errors.push(
    `${docRel}: could not find the "<N> GitHub Actions workflows in ` +
      '`.github/workflows/`" header sentence.',
  );
} else {
  const expectedWord = NUMBER_WORDS[count] ?? String(count);
  const capitalized =
    expectedWord.charAt(0).toUpperCase() + expectedWord.slice(1);
  if (headerMatch[1].toLowerCase() !== expectedWord) {
    errors.push(
      `${docRel}: header says "${headerMatch[1]} GitHub Actions workflows" ` +
        `but .github/workflows/ has ${count} — expected "${capitalized}".`,
    );
  }
}

// 4 — table rows: each documents one `<name>.yml` in its first cell.
const documented = new Set();
for (const m of section.matchAll(/^\|\s*`([\w.-]+\.ya?ml)`/gm)) {
  documented.add(m[1]);
}

// Forward: every workflow file must have a table row.
for (const f of files) {
  if (!documented.has(f)) {
    errors.push(
      `${docRel}: workflow \`${f}\` exists in ${workflowsRel}/ but has no row ` +
        "in the CI/CD table.",
    );
  }
}

// Reverse: every documented row must correspond to a real workflow file.
for (const name of documented) {
  if (!workflowFiles.has(name)) {
    errors.push(
      `${docRel}: CI/CD table lists \`${name}\` but no such file exists in ` +
        `${workflowsRel}/ — remove the stale row.`,
    );
  }
}

if (errors.length > 0) {
  if (!json) console.error(`✗  ${errors.length} workflow-doc mismatch(es):`);
  for (const e of errors) reporter.error(e, { file: docRel });
  reporter.finish();
  process.exit(1);
}

reporter.succeed(
  `${docRel} CI/CD table matches ${count} workflow file(s) in ${workflowsRel}/.`,
);
reporter.finish();
