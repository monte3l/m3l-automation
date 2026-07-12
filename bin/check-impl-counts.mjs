#!/usr/bin/env node
// Derives the canonical IMPLEMENTED-submodule count (the numerator of the
// "N of 22" figure) from the Status column of docs/implementation-status.md and
// asserts that every prose/badge/HTML site quoting that numerator agrees —
// plus that the generated implemented-list block (the marker-delimited
// sentence near the top of docs/implementation-status.md) matches a fresh
// render, so a hand edit inside the markers is caught.
//
// This is the numerator counterpart to check-doc-counts.mjs, which owns the
// denominator (total documented = 22). The numerator rotted undetected once
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
  buildImplementedListBlock,
  IMPLEMENTED_COUNT_SITES,
  IMPLEMENTED_LIST_BEGIN_MARKER,
  IMPLEMENTED_LIST_END_MARKER,
} from "./lib/count-sites.mjs";

const counts = deriveCounts();
const namesCsv = counts.implementedNames.join(", ");
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

for (const site of IMPLEMENTED_COUNT_SITES) {
  const content = read(site.file);
  if (content === null) continue;

  const result = locateSite(content, site, counts);
  if (!result.found) {
    console.error(
      `✗  ${site.file}: expected pattern not found: ${site.pattern}`,
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
    console.error(
      `✗  ${site.file}: ${site.label} says ${result.actual} but derived count is ${result.expected}\n` +
        `   Context: "...${ctx}..."`,
    );
    errors++;
  }
}

const statusContent = read("docs/implementation-status.md");
if (statusContent !== null) {
  const start = statusContent.indexOf(IMPLEMENTED_LIST_BEGIN_MARKER);
  const end = statusContent.indexOf(IMPLEMENTED_LIST_END_MARKER);
  if (start === -1 || end === -1) {
    console.error(
      "✗  docs/implementation-status.md is missing the GENERATED IMPLEMENTED-LIST markers — run pnpm gen:counts.",
    );
    errors++;
  } else {
    const committedBlock = statusContent.slice(
      start,
      end + IMPLEMENTED_LIST_END_MARKER.length,
    );
    const freshBlock = buildImplementedListBlock(counts);
    if (committedBlock !== freshBlock) {
      console.error(
        "✗  docs/implementation-status.md implemented-list block is out of date — run pnpm gen:counts.",
      );
      errors++;
    }
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} implemented-count mismatch(es). Derived implemented count ` +
      `is ${counts.implemented} (${namesCsv}). Run pnpm gen:counts, or fix the ` +
      `Status column in docs/implementation-status.md if the derivation is wrong.`,
  );
  process.exit(1);
}

console.log(
  `✓  Implemented count matches everywhere: ${counts.implemented} of 22 (${namesCsv}).`,
);
