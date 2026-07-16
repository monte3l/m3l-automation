#!/usr/bin/env node
// Derives the canonical submodule count from docs/reference/ and asserts
// that prose documents use the correct numbers. Prevents count drift caused
// by adding or removing a reference page without updating the prose.
//
// Canonical rule: docs/reference/core/*.md drives the Core count;
// docs/reference/aws/*.md drives the AWS count; the total is Core + AWS.
// Site inventory shared with gen-doc-counts.mjs and check-impl-counts.mjs via
// bin/lib/count-sites.mjs, so the three can never disagree about the sites.
//
// Usage:
//   node bin/check-doc-counts.mjs   # verify counts (fails on mismatch)
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  root,
  deriveCounts,
  locateSite,
  TOTAL_COUNT_SITES,
} from "./lib/count-sites.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const counts = deriveCounts();
let errors = 0;

for (const site of TOTAL_COUNT_SITES) {
  const filePath = join(root, site.file);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    reporter.error(`Cannot read ${site.file}`);
    errors++;
    continue;
  }

  const result = locateSite(content, site, counts);
  if (!result.found) {
    reporter.error(`${site.file}: expected pattern not found: ${site.pattern}`);
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
        `   Derived: Core=${counts.coreCount} + AWS=${counts.awsCount} = ${counts.total}\n` +
        `   Context: "...${ctx}..."`,
    );
    errors++;
  }
}

if (errors > 0) {
  if (!json)
    console.error(
      `\n✗  ${errors} count mismatch(es). Update the prose to match the derived counts ` +
        `(Core: ${counts.coreCount}, AWS: ${counts.awsCount}, total: ${counts.total}), or run pnpm gen:counts.`,
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
  `All doc counts match: ${counts.coreCount} Core + ${counts.awsCount} AWS = ${counts.total} total.`,
);
reporter.finish({
  counts: {
    core: counts.coreCount,
    aws: counts.awsCount,
    total: counts.total,
    implemented: counts.implemented,
  },
});
