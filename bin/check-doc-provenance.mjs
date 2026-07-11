#!/usr/bin/env node
// Guards documented claims by linking reference-page headings to source
// symbols. Detects drift when source content changes after the recorded
// blob so doc-vs-code gaps surface in CI rather than accumulating silently.
//
// Each *.provenance.json sidecar in docs/reference/ describes one reference
// page. Sections anchor a heading (e.g. "### `M3LError`") to one or more
// source files and the git blob SHA of each file's content when last
// verified. Staleness is content-addressed, not commit-addressed: a rebase
// that leaves a source file byte-identical never marks it stale, even though
// the commit SHA changes. The schema lives at docs/reference/provenance.schema.json.
//
// Usage:
//   node bin/check-doc-provenance.mjs                   # verify all sidecars
//   node bin/check-doc-provenance.mjs --update          # re-stamp blob + date for changed sources only
//   node bin/check-doc-provenance.mjs --affected <file> # only sidecars referencing <file>
//
// Exit contract: hard errors (bad heading/missing file/removed symbol) always
// exit 1. In the full-verify path staleness ALSO exits 1 so cross-merge drift
// fails CI; the --affected path (advisory hook) exits 0 with the warning on
// stderr so mid-work edits are never blocked. Re-stamp with --update — it is
// safe to run bare since only sidecars with an actually-changed source blob
// are rewritten.
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  parseHeadings,
  isSymbolExported,
  hashBlobs,
  verifySidecarSections,
  applyBlobUpdates,
} from "./lib/doc-provenance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsRef = join(root, "docs/reference");

const args = process.argv.slice(2);
const isUpdate = args.includes("--update");
const affectedIdx = args.indexOf("--affected");
const affectedFile =
  affectedIdx !== -1 ? (args[affectedIdx + 1] ?? null) : null;

function findSidecars(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findSidecars(full));
    else if (entry.name.endsWith(".provenance.json")) results.push(full);
  }
  return results;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

let sidecars = findSidecars(docsRef);

if (affectedFile !== null) {
  const norm = affectedFile.replace(/\\/g, "/");
  sidecars = sidecars.filter((s) => {
    try {
      const data = JSON.parse(readFileSync(s, "utf8"));
      return (data.sections ?? []).some((sec) =>
        (sec.sources ?? []).some((src) => src.file === norm),
      );
    } catch {
      return false;
    }
  });
  if (sidecars.length === 0) {
    console.log(`✓  No provenance sidecars reference ${affectedFile}.`);
    process.exit(0);
  }
}

let totalErrors = 0;
let totalWarnings = 0;
const validated = [];

// One batched `git hash-object` for every source file across every sidecar
// in scope, instead of a spawn per source per run.
const parsedSidecars = [];
const allSourceFiles = new Set();
for (const sidecarPath of sidecars) {
  const rel = relative(root, sidecarPath);
  let data;
  try {
    data = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch (e) {
    console.error(`✗  ${rel}: invalid JSON — ${e.message}`);
    totalErrors++;
    continue;
  }

  if (typeof data.doc !== "string") {
    console.error(`✗  ${rel}: missing or invalid "doc" field`);
    totalErrors++;
    continue;
  }
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    console.error(`✗  ${rel}: "sections" must be a non-empty array`);
    totalErrors++;
    continue;
  }

  const mdPath = join(docsRef, data.doc);
  if (!existsSync(mdPath)) {
    console.error(
      `✗  ${rel}: sibling doc not found: docs/reference/${data.doc}`,
    );
    totalErrors++;
    continue;
  }

  parsedSidecars.push({ sidecarPath, rel, data, mdPath });
  for (const section of data.sections) {
    for (const source of section.sources ?? []) {
      if (existsSync(join(root, source.file))) allSourceFiles.add(source.file);
    }
  }
}

const blobs = hashBlobs(root, [...allSourceFiles]);

for (const { sidecarPath, rel, data, mdPath } of parsedSidecars) {
  const mdHeadings = parseHeadings(readFileSync(mdPath, "utf8"));

  const { errors, warnings, staleSources } = verifySidecarSections(
    data,
    mdHeadings,
    {
      fileExists: (file) => existsSync(join(root, file)),
      symbolCheck: (file, symbol) =>
        isSymbolExported(readFileSync(join(root, file), "utf8"), symbol),
      blobOf: (file) => blobs.get(file),
    },
  );

  for (const message of errors) console.error(`✗  ${rel}: ${message}`);
  for (const message of warnings) {
    process.stderr.write(
      `⚠   ${rel}: ${message}\n` +
        `   Update the sidecar then run: node bin/check-doc-provenance.mjs --update\n`,
    );
  }

  totalErrors += errors.length;
  totalWarnings += warnings.length;
  if (errors.length === 0)
    validated.push({ sidecarPath, rel, data, staleSources });
}

if (totalErrors > 0) {
  console.error(`\n✗  ${totalErrors} provenance error(s) found.`);
  process.exit(1);
}

if (isUpdate) {
  const date = today();
  let updatedCount = 0;
  for (const { sidecarPath, rel, data, staleSources } of validated) {
    const next = applyBlobUpdates(data, staleSources, date);
    if (next === null) continue;
    writeFileSync(sidecarPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Updated: ${rel}`);
    updatedCount++;
  }
  if (updatedCount === 0) console.log("✓  No sidecars needed re-stamping.");
  process.exit(0);
}

// Full-verify path (CI): staleness is a hard failure so cross-merge drift
// surfaces in CI instead of accumulating silently. The advisory --affected
// path (used by the guard-provenance-staleness PostToolUse hook) keeps exiting
// 0 with the warning on stderr so mid-work source edits are never blocked.
if (totalWarnings > 0 && affectedFile === null) {
  process.stderr.write(
    `\n✗  ${totalWarnings} provenance staleness warning(s) — re-stamp with ` +
      `node bin/check-doc-provenance.mjs --update (or run /syncing-docs).\n`,
  );
  process.exit(1);
}

const warnSuffix =
  totalWarnings > 0 ? ` (${totalWarnings} staleness warning(s))` : "";
console.log(
  `✓  ${sidecars.length} provenance sidecar(s) verified${warnSuffix}.`,
);
