#!/usr/bin/env node
// Guards documented claims by linking reference-page headings to source
// symbols at a specific git commit. Detects drift when source files change
// after the recorded commit so doc-vs-code gaps surface in CI rather than
// accumulating silently.
//
// Each *.provenance.json sidecar in docs/reference/ describes one reference
// page. Sections anchor a heading (e.g. "### `M3LError`") to one or more
// source files and the git SHA at which the mapping was verified. The schema
// lives at docs/reference/provenance.schema.json.
//
// Usage:
//   node bin/check-doc-provenance.mjs                   # verify all sidecars
//   node bin/check-doc-provenance.mjs --update          # re-stamp commit + date to HEAD
//   node bin/check-doc-provenance.mjs --affected <file> # only sidecars referencing <file>
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

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

function headingsInMd(mdPath) {
  return readFileSync(mdPath, "utf8")
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => l.replace(/^#{1,6} /, "").trim());
}

function symbolExportedIn(filePath, symbol) {
  const src = readFileSync(filePath, "utf8");
  // Escape regex metacharacters in the symbol name (e.g. < > in generics).
  const ident = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directRe = new RegExp(
    `\\bexport\\b(?:\\s+(?:abstract|declare|async))*\\s+` +
      `(?:class|function|type|interface|const|let|var|enum)\\s+${ident}\\b`,
  );
  const namedRe = new RegExp(
    `\\bexport\\b(?:\\s+type)?\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}`,
  );
  return directRe.test(src) || namedRe.test(src);
}

function gitDiffChanged(commit, filePath) {
  const res = spawnSync("git", ["diff", "--quiet", commit, "--", filePath], {
    cwd: root,
    encoding: "utf8",
  });
  return res.status === 1;
}

function gitHead() {
  return (
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .stdout ?? ""
  ).trim();
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

  let sidecarErrors = 0;
  let sidecarWarnings = 0;

  if (typeof data.doc !== "string") {
    console.error(`✗  ${rel}: missing or invalid "doc" field`);
    sidecarErrors++;
  }
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    console.error(`✗  ${rel}: "sections" must be a non-empty array`);
    sidecarErrors++;
  }

  if (sidecarErrors > 0) {
    totalErrors += sidecarErrors;
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

  const mdHeadings = headingsInMd(mdPath);

  for (const section of data.sections) {
    const tag = `"${section.heading}"`;

    if (!mdHeadings.includes(section.heading)) {
      console.error(
        `✗  ${rel}: heading ${tag} not found in ${data.doc}\n` +
          `   Known headings: ${mdHeadings.map((h) => `"${h}"`).join(", ")}`,
      );
      sidecarErrors++;
    }

    for (const source of section.sources ?? []) {
      const srcAbs = join(root, source.file);
      if (!existsSync(srcAbs)) {
        console.error(
          `✗  ${rel}: source file not found: ${source.file} (section ${tag})`,
        );
        sidecarErrors++;
        continue;
      }
      if (!symbolExportedIn(srcAbs, source.symbol)) {
        console.error(
          `✗  ${rel}: "${source.symbol}" not exported from ${source.file} (section ${tag})`,
        );
        sidecarErrors++;
      }
      if (section.commit && gitDiffChanged(section.commit, source.file)) {
        process.stderr.write(
          `⚠   ${rel}: stale — re-verify. ${source.file} changed since ` +
            `${section.commit.slice(0, 8)} (section ${tag}).\n` +
            `   Update the sidecar then run: node bin/check-doc-provenance.mjs --update\n`,
        );
        sidecarWarnings++;
      }
    }
  }

  totalErrors += sidecarErrors;
  totalWarnings += sidecarWarnings;
  if (sidecarErrors === 0) validated.push({ sidecarPath, data });
}

if (totalErrors > 0) {
  console.error(`\n✗  ${totalErrors} provenance error(s) found.`);
  process.exit(1);
}

if (isUpdate) {
  const head = gitHead();
  const date = today();
  for (const { sidecarPath, data } of validated) {
    for (const section of data.sections) {
      section.commit = head;
      section.retrieved = date;
    }
    writeFileSync(sidecarPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Updated: ${relative(root, sidecarPath)}`);
  }
  process.exit(0);
}

const warnSuffix =
  totalWarnings > 0 ? ` (${totalWarnings} staleness warning(s))` : "";
console.log(
  `✓  ${sidecars.length} provenance sidecar(s) verified${warnSuffix}.`,
);
