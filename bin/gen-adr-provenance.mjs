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
import { hashBlobs, trackedFiles } from "./lib/doc-provenance.mjs";
import {
  deriveProvenanceEntry,
  extractPathCandidates,
  filterToTracked,
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

const isExistingFile = (p) => {
  const abs = join(root, p);
  return existsSync(abs) && statSync(abs).isFile();
};

for (const filename of filenames) {
  const adr = filename.slice(0, 4);
  const content = readFileSync(join(adrDir, filename), "utf8");
  const existing = extractPathCandidates(content).filter(isExistingFile);
  candidatesByAdr.set(adr, existing);
  for (const p of existing) allExistingCandidates.add(p);
}

// A gitignored/untracked candidate (machine-local ephemeral state such as
// tmp/* or an unignored-by-repo .claude/settings.local.json) must never
// become a provenance source — see filterToTracked()'s doc comment. Degrade
// loudly rather than silently on a git failure: writing a sidecar derived
// from a wrong "everything is tracked" or "nothing is tracked" guess is
// worse than not writing one at all.
let tracked;
try {
  tracked = trackedFiles(root, [...allExistingCandidates]);
} catch (cause) {
  reporter.error(
    `Could not resolve git-tracked status for provenance candidates: ${/** @type {Error} */ (cause).message} — refusing to write a possibly-wrong docs/adr/provenance.json.`,
  );
  reporter.finish({ adrsTracked: 0, adrsTotal: filenames.length });
  process.exit(1);
}

const blobs = hashBlobs(
  root,
  [...allExistingCandidates].filter((p) => tracked.has(p)),
);

/** @type {import("./lib/adr-provenance.mjs").AdrProvenanceData} */
const next = {};
for (const [adr, paths] of candidatesByAdr) {
  const trackedPaths = filterToTracked(paths, tracked);
  const resolved = trackedPaths.map((path) => ({
    path,
    blob: blobs.get(path),
  }));
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
