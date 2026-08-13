#!/usr/bin/env node
// Regenerates every "N of M" badge/prose site and the generated
// implemented-list block from the derived counts. Run via: pnpm gen:counts
//
// Shares its site inventory and derivation with check-doc-counts.mjs and
// check-impl-counts.mjs via bin/lib/count-sites.mjs, so a generate-then-check
// round-trip always agrees.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  root,
  deriveCounts,
  locateSite,
  locateBlock,
  TOTAL_COUNT_SITES,
  IMPLEMENTED_COUNT_SITES,
  GENERATED_LIST_SITES,
} from "./lib/count-sites.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const counts = deriveCounts();
const allSites = [...TOTAL_COUNT_SITES, ...IMPLEMENTED_COUNT_SITES];
const byFile = new Map();
for (const site of allSites) {
  if (!byFile.has(site.file)) byFile.set(site.file, []);
  byFile.get(site.file).push(site);
}

let touchedFiles = 0;

for (const [file, sites] of byFile) {
  const filePath = join(root, file);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    reporter.error(`gen:counts — cannot read ${file}, skipping.`);
    continue;
  }

  let changed = false;
  // Re-locate each site against the current (possibly already-edited)
  // content, so multiple sites in the same file don't clobber each other's
  // offsets.
  for (const site of sites) {
    const result = locateSite(content, site, counts);
    if (!result.found || result.actual === result.expected) continue;
    content =
      content.slice(0, result.capturedIndex) +
      String(result.expected) +
      content.slice(result.capturedIndex + result.capturedText.length);
    changed = true;
  }

  if (changed) {
    writeFileSync(filePath, content, "utf8");
    touchedFiles++;
    reporter.change("updated", file);
  }
}

// Every generated-block site (the implementation-status.md implemented-list
// sentence, plus the three README-family submodule-name lists). Each site's
// own file is re-read fresh (independent of the numeric splice pass above),
// so a file appearing in both passes (e.g. README.md) never has its offsets
// invalidated by the other pass's edit.
for (const site of GENERATED_LIST_SITES) {
  const filePath = join(root, site.file);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    reporter.error(`gen:counts — cannot read ${site.file}, skipping.`);
    continue;
  }

  const loc = locateBlock(content, site.marker);
  if (!loc) {
    reporter.error(
      `gen:counts — ${site.file} is missing the GENERATED ${site.marker} markers; add them once, then re-run.`,
    );
    continue;
  }

  const freshBlock = site.render(counts);
  const nextContent =
    content.slice(0, loc.start) + freshBlock + content.slice(loc.end);
  if (nextContent !== content) {
    writeFileSync(filePath, nextContent, "utf8");
    touchedFiles++;
    reporter.change("updated", site.file, `(${site.label})`);
  }
}

if (touchedFiles === 0) {
  reporter.succeed("All count sites already match the derived counts.");
} else {
  reporter.succeed(
    `gen:counts done — ${touchedFiles} file(s) updated to Core=${counts.coreCount}, AWS=${counts.awsCount}, total=${counts.total}, implemented=${counts.implemented}.`,
  );
}

reporter.finish({
  counts: {
    core: counts.coreCount,
    aws: counts.awsCount,
    total: counts.total,
    implemented: counts.implemented,
  },
});
