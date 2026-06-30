#!/usr/bin/env node
// Verifies that docs/reference/catalog.json, docs/reference/symbol-map.json,
// and the generated block in docs/reference/README.md are up to date with
// the current filesystem state. Exits 1 on any drift.
// Run via: pnpm check:index
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BEGIN_MARKER,
  END_MARKER,
  buildIndex,
  buildReadmeBlock,
  root,
} from "./lib/reference-index.mjs";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function extractBlock(content) {
  const start = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1) return null;
  return content.slice(start, end + END_MARKER.length);
}

const { catalog, symbolMap } = buildIndex();
let errors = 0;

const committedCatalog = readJson(join(root, "docs/reference/catalog.json"));
if (committedCatalog === null) {
  console.error(
    "✗  docs/reference/catalog.json is missing — run pnpm gen:index.",
  );
  errors++;
} else if (
  JSON.stringify(committedCatalog) !== JSON.stringify(catalog)
) {
  console.error(
    "✗  docs/reference/catalog.json is out of date — run pnpm gen:index.",
  );
  errors++;
}

const committedSymbolMap = readJson(
  join(root, "docs/reference/symbol-map.json"),
);
if (committedSymbolMap === null) {
  console.error(
    "✗  docs/reference/symbol-map.json is missing — run pnpm gen:index.",
  );
  errors++;
} else if (
  JSON.stringify(committedSymbolMap) !== JSON.stringify(symbolMap)
) {
  console.error(
    "✗  docs/reference/symbol-map.json is out of date — run pnpm gen:index.",
  );
  errors++;
}

let readmeContent;
try {
  readmeContent = readFileSync(join(root, "docs/reference/README.md"), "utf8");
} catch {
  readmeContent = null;
}
if (readmeContent === null) {
  console.error(
    "✗  docs/reference/README.md is missing — run pnpm gen:index.",
  );
  errors++;
} else {
  const committedBlock = extractBlock(readmeContent);
  if (committedBlock === null) {
    console.error(
      "✗  docs/reference/README.md is missing the GENERATED CATALOG markers — run pnpm gen:index.",
    );
    errors++;
  } else if (committedBlock !== buildReadmeBlock(catalog)) {
    console.error(
      "✗  docs/reference/README.md catalog block is out of date — run pnpm gen:index.",
    );
    errors++;
  }
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} reference-index drift(s). Run pnpm gen:index to regenerate.`,
  );
  process.exit(1);
}

console.log(
  `✓  Reference index is up to date: ${catalog.length} modules, ${Object.keys(symbolMap).length} symbols.`,
);
