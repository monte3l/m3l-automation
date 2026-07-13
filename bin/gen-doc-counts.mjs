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
  buildImplementedListBlock,
  TOTAL_COUNT_SITES,
  IMPLEMENTED_COUNT_SITES,
  IMPLEMENTED_LIST_BEGIN_MARKER,
  IMPLEMENTED_LIST_END_MARKER,
} from "./lib/count-sites.mjs";

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
    console.error(`✗  gen:counts — cannot read ${file}, skipping.`);
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
    console.log(`Updated: ${file}`);
  }
}

// The generated implemented-list block in docs/implementation-status.md.
const statusPath = join(root, "docs/implementation-status.md");
let statusContent;
try {
  statusContent = readFileSync(statusPath, "utf8");
} catch {
  statusContent = null;
}
if (statusContent !== null) {
  const start = statusContent.indexOf(IMPLEMENTED_LIST_BEGIN_MARKER);
  const end = statusContent.indexOf(IMPLEMENTED_LIST_END_MARKER);
  const freshBlock = buildImplementedListBlock(counts);
  if (start !== -1 && end !== -1) {
    const nextContent =
      statusContent.slice(0, start) +
      freshBlock +
      statusContent.slice(end + IMPLEMENTED_LIST_END_MARKER.length);
    if (nextContent !== statusContent) {
      writeFileSync(statusPath, nextContent, "utf8");
      touchedFiles++;
      console.log(
        "Updated: docs/implementation-status.md (implemented-list block)",
      );
    }
  } else {
    console.error(
      "✗  gen:counts — docs/implementation-status.md is missing the GENERATED IMPLEMENTED-LIST markers; add them once, then re-run.",
    );
  }
}

if (touchedFiles === 0) {
  console.log("✓  All count sites already match the derived counts.");
} else {
  console.log(
    `✓  gen:counts done — ${touchedFiles} file(s) updated to Core=${counts.coreCount}, AWS=${counts.awsCount}, total=${counts.total}, implemented=${counts.implemented}.`,
  );
}
