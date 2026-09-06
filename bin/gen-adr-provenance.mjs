#!/usr/bin/env node
// Regenerates docs/adr/provenance.json: for every docs/adr/NNNN-*.md file,
// extracts its backtick-quoted repo-path citations (bin/lib/adr-provenance.mjs),
// keeps the ones that exist on disk, and stamps each with its current git
// blob SHA. An ADR's verifiedAt only advances when its source list or a
// blob actually changed — see bin/lib/adr-provenance.mjs's
// deriveProvenanceEntry() for the "changed sources only" contract.
//
// Usage:
//   node bin/gen-adr-provenance.mjs
//   node bin/gen-adr-provenance.mjs --json   # ADR-0030 structured report
//   pnpm gen:adr-provenance
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import { hashBlobs } from "./lib/doc-provenance.mjs";
import {
  deriveProvenanceEntry,
  extractPathCandidates,
} from "./lib/adr-provenance.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const adrDir = join(root, "docs/adr");
const provenancePath = join(adrDir, "provenance.json");
const today = new Date().toISOString().slice(0, 10);

/** @type {import("./lib/adr-provenance.mjs").AdrProvenanceData} */
const previous = existsSync(provenancePath)
  ? JSON.parse(readFileSync(provenancePath, "utf8"))
  : {};

const filenames = readdirSync(adrDir)
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .sort();

// One batched `git hash-object` call across every candidate from every ADR,
// not one call per file — hashBlobs() already dedupes and this keeps a
// 94-file sweep to a single spawn.
/** @type {Map<string, string[]>} */
const candidatesByAdr = new Map();
/** @type {Set<string>} */
const allExistingCandidates = new Set();

const isTrackableFile = (p) => {
  const abs = join(root, p);
  return existsSync(abs) && statSync(abs).isFile();
};

for (const filename of filenames) {
  const adr = filename.slice(0, 4);
  const content = readFileSync(join(adrDir, filename), "utf8");
  const existing = extractPathCandidates(content).filter(isTrackableFile);
  candidatesByAdr.set(adr, existing);
  for (const p of existing) allExistingCandidates.add(p);
}

const blobs = hashBlobs(root, [...allExistingCandidates]);

/** @type {import("./lib/adr-provenance.mjs").AdrProvenanceData} */
const next = {};
for (const [adr, paths] of candidatesByAdr) {
  const resolved = paths.map((path) => ({ path, blob: blobs.get(path) }));
  const entry = deriveProvenanceEntry(resolved, today, previous[adr]);
  if (entry) next[adr] = entry;
}

const config = await resolveConfig(provenancePath);
const formatted = await format(JSON.stringify(next, null, 2), {
  ...config,
  filepath: provenancePath,
});

const currentContent = existsSync(provenancePath)
  ? readFileSync(provenancePath, "utf8")
  : null;

if (currentContent === formatted) {
  reporter.succeed(
    `docs/adr/provenance.json already reflects ${Object.keys(next).length} ADR(s) with tracked sources — no changes.`,
  );
} else {
  writeFileSync(provenancePath, formatted, "utf8");
  reporter.change("updated", "docs/adr/provenance.json");
  reporter.succeed(
    `ADR provenance regenerated: ${Object.keys(next).length} of ${filenames.length} ADR(s) cite a tracked source.`,
  );
}

reporter.finish({
  adrsTracked: Object.keys(next).length,
  adrsTotal: filenames.length,
});
