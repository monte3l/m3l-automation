#!/usr/bin/env node
// Advisory freshness check for docs/adr/provenance.json: re-derives every
// ADR's source-file citations against live disk state and warns for any
// whose cited file's blob SHA has drifted since verifiedAt, was newly added
// and never verified, or has disappeared entirely. Never blocks — it can
// only ever say "go re-read this ADR," which is a judgment call for a
// human, not a structural break check:adr-index enforces.
//
// This is the "stale reads, not stale docs" gap the audit found: an ADR
// asserting a concrete repo fact (an exports-map entry count, a path that
// no longer exists) had zero machine signal when the underlying file
// changed. bin/lib/adr-claims.mjs (check:adr-claims, blocking) covers the
// ~15 load-bearing ADRs with a mechanically-probeable assertion; this
// covers every ADR that cites ANY concrete path, more broadly but only as
// a "something changed" signal, not a correctness proof.
//
// Usage:
//   node bin/check-adr-provenance.mjs
//   node bin/check-adr-provenance.mjs --json   # ADR-0030 structured report
//   pnpm check:adr-provenance
import process from "node:process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashBlobs } from "./lib/doc-provenance.mjs";
import {
  checkAdrProvenance,
  deriveProvenanceEntry,
  extractPathCandidates,
} from "./lib/adr-provenance.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const { json } = parseJsonFlag();
const reporter = createReporter(json);
const root = repoRoot(import.meta.url);

const adrDir = join(root, "docs/adr");
const provenancePath = join(adrDir, "provenance.json");

if (!existsSync(provenancePath)) {
  reporter.warn(
    "docs/adr/provenance.json is missing — run pnpm gen:adr-provenance.",
  );
  reporter.finish({ findings: [] });
  process.exit(0);
}

/** @type {import("./lib/adr-provenance.mjs").AdrProvenanceData} */
const committed = JSON.parse(readFileSync(provenancePath, "utf8"));

const filenames = readdirSync(adrDir)
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .sort();

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

// A bare re-run (nothing actually changed on disk) must never itself read
// as drift: force verifiedAt to match the committed entry so
// deriveProvenanceEntry()'s date logic never fires here — checkAdrProvenance
// only compares source lists and blobs, never dates.
/** @type {import("./lib/adr-provenance.mjs").AdrProvenanceData} */
const fresh = {};
for (const [adr, paths] of candidatesByAdr) {
  const resolved = paths.map((path) => ({ path, blob: blobs.get(path) }));
  const entry = deriveProvenanceEntry(resolved, "", committed[adr]);
  if (entry)
    fresh[adr] = { ...entry, verifiedAt: committed[adr]?.verifiedAt ?? "" };
}

const findings = checkAdrProvenance(committed, fresh);

for (const finding of findings) {
  reporter.warn(finding, { file: "docs/adr/provenance.json" });
}

if (findings.length === 0) {
  reporter.succeed(
    `docs/adr/provenance.json is fresh — ${Object.keys(committed).length} tracked ADR(s), no drift.`,
  );
}

reporter.finish({ findings, tracked: Object.keys(committed).length });

// Advisory only — never blocks a push. See the header comment above.
process.exit(0);
