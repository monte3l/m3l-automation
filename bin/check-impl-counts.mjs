#!/usr/bin/env node
// Derives the canonical IMPLEMENTED-submodule count (the numerator of the
// "N of M" figure) from the Status column of docs/implementation-status.md and
// asserts that every prose/badge/HTML site quoting that numerator agrees —
// plus that the generated implemented-list block (the marker-delimited
// sentence near the top of docs/implementation-status.md) matches a fresh
// render, so a hand edit inside the markers is caught.
//
// This is the numerator counterpart to check-doc-counts.mjs, which owns the
// denominator (total documented, itself derived — not a fixed number; see
// bin/lib/count-sites.mjs). The numerator rotted undetected once
// (see docs/logs/2026-07-01-core-json.md, divergence 1) because
// packages/m3l-common/README.md was checked nowhere. Site inventory shared
// with gen-doc-counts.mjs and check-doc-counts.mjs via bin/lib/count-sites.mjs.
//
// Canonical rule: a submodule is implemented when its Status-column emoji in
// docs/implementation-status.md is ✅. That set drives both the count (N) and
// the ordered name list rendered in the generated implemented-list block.
//
// Usage:
//   node bin/check-impl-counts.mjs   # verify (fails on mismatch)
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  root,
  deriveCounts,
  locateSite,
  locateBlock,
  lineOf,
  IMPLEMENTED_COUNT_SITES,
  GENERATED_LIST_SITES,
} from "./lib/count-sites.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const counts = deriveCounts();
const namesCsv = counts.implementedNames.join(", ");
let errors = 0;

function read(file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    reporter.error(`Cannot read ${file}`, { file });
    errors++;
    return null;
  }
}

for (const site of IMPLEMENTED_COUNT_SITES) {
  const content = read(site.file);
  if (content === null) continue;

  const result = locateSite(content, site, counts);
  if (!result.found) {
    reporter.error(
      `${site.file}: expected pattern not found: ${site.pattern}`,
      {
        file: site.file,
      },
    );
    errors++;
    continue;
  }

  if (result.actual !== result.expected) {
    const ctx = content
      .slice(
        Math.max(0, result.matchIndex - 20),
        result.matchIndex + result.matchText.length + 20,
      )
      .trim();
    reporter.error(
      `${site.file}: ${site.label} says ${result.actual} but derived count is ${result.expected}\n` +
        `   Context: "...${ctx}..."`,
      { file: site.file, line: lineOf(content, result.matchIndex) },
    );
    errors++;
  }
}

for (const site of GENERATED_LIST_SITES) {
  const content = read(site.file);
  if (content === null) continue;

  const loc = locateBlock(content, site.marker);
  if (!loc) {
    reporter.error(
      `${site.file} is missing the GENERATED ${site.marker} markers — run pnpm gen:counts.`,
      { file: site.file },
    );
    errors++;
    continue;
  }

  const committedBlock = content.slice(loc.start, loc.end);
  const freshBlock = site.render(counts);
  if (committedBlock !== freshBlock) {
    reporter.error(
      `${site.file} ${site.label} is out of date — run pnpm gen:counts.`,
      { file: site.file, line: lineOf(content, loc.start) },
    );
    errors++;
  }
}

if (errors > 0) {
  if (!json)
    console.error(
      `\n✗  ${errors} implemented-count mismatch(es). Derived implemented count ` +
        `is ${counts.implemented} (${namesCsv}). Run pnpm gen:counts, or fix the ` +
        `Status column in docs/implementation-status.md if the derivation is wrong.`,
    );
  reporter.finish({
    counts: {
      core: counts.coreCount,
      aws: counts.awsCount,
      total: counts.total,
      implemented: counts.implemented,
    },
  });
  process.exit(1);
}

reporter.succeed(
  `Implemented count matches everywhere: ${counts.implemented} of ${counts.total} (${namesCsv}).`,
);
reporter.finish({
  counts: {
    core: counts.coreCount,
    aws: counts.awsCount,
    total: counts.total,
    implemented: counts.implemented,
  },
});
