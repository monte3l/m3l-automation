#!/usr/bin/env node
// Regenerates the <!-- BEGIN/END GENERATED ADR INDEX --> block in
// docs/adr/README.md from each ADR file's own Status/Relations block
// (ADR-0094). Mirrors bin/gen-reference-index.mjs's generate/check split —
// see bin/lib/adr-index.mjs for the pure derivation both this script and
// bin/check-adr-index.mjs share.
//
// Usage:
//   node bin/gen-adr-index.mjs
//   node bin/gen-adr-index.mjs --json   # ADR-0030 structured report
//   pnpm gen:adr-index
import process from "node:process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADR_DIR,
  BEGIN_MARKER,
  END_MARKER,
  README_PATH,
  buildGeneratedBlock,
  findGeneratedBlockRange,
  parseAdrEntry,
} from "./lib/adr-index.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const entries = readdirSync(join(root, ADR_DIR))
  .map((filename) =>
    parseAdrEntry(
      filename,
      readFileSync(join(root, ADR_DIR, filename), "utf8"),
    ),
  )
  .filter((entry) => entry !== null)
  .sort((a, b) => a.number - b.number);

const block = buildGeneratedBlock(entries);
const readmePath = join(root, README_PATH);
const content = readFileSync(readmePath, "utf8");

const range = findGeneratedBlockRange(content);
if (!range) {
  reporter.error(
    `${README_PATH} is missing the GENERATED ADR INDEX markers — add ` +
      `${BEGIN_MARKER} / ${END_MARKER} around the ## Index table first.`,
  );
  reporter.finish();
  process.exit(1);
}

const next = content.slice(0, range.start) + block + content.slice(range.end);

if (next === content) {
  reporter.succeed(
    `${README_PATH} already reflects all ${entries.length} ADR(s) — no changes.`,
  );
} else {
  writeFileSync(readmePath, next, "utf8");
  reporter.change("updated", README_PATH);
  reporter.succeed(`ADR index regenerated: ${entries.length} ADR(s).`);
}

reporter.finish({ adrs: entries.length });
