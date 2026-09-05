#!/usr/bin/env node
// Verifies every Context7-sourced `.claude/skills/*/references/*.md` snapshot
// carries a `<!-- reference-freshness: ... -->` stamp, that the stamp's
// tracked packages haven't drifted past the refresh policy the snapshot
// itself declares, and that no retired `ctx7` CLI instruction has crept back
// in now that the CLI is uninstalled (ADR-0093). Deliberately offline — it
// only compares stamped versions against installed manifests, so it runs
// fine in headless CI (no `--mcp-config`, no network call).
//
// Usage:
//   node bin/check-reference-freshness.mjs   # exits 0 on success, 1 on any drift
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/agent-roster.mjs";
import {
  deriveReferenceFreshnessIssues,
  isContext7Sourced,
} from "./lib/reference-freshness.mjs";
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, ".claude", "skills");

const { json } = parseJsonFlag();
const reporter = createReporter(json);

const referencesMarker = `${sep}references${sep}`;
const files = walk(skillsDir, (name) => name.endsWith(".md"))
  .filter((file) => file.includes(referencesMarker))
  .map((file) => ({
    path: relative(root, file),
    content: readFileSync(file, "utf8"),
  }));

/** @type {import("./lib/reference-freshness.mjs").PackageManifest[]} */
const manifests = [
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
];
const packagesDir = join(root, "packages");
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir, entry.name, "package.json");
  try {
    manifests.push(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    // No package.json in this directory — not a workspace package.
  }
}

const {
  missingStamp,
  malformedStamp,
  staleTracked,
  retiredClaims,
  unknownTracked,
  driftWarnings,
} = deriveReferenceFreshnessIssues(files, manifests);

for (const path of missingStamp) {
  reporter.error(
    `"${path}" is Context7-sourced but carries no <!-- reference-freshness: ... --> stamp. See docs/contributing/skills-catalog.md's "External documentation" section for the stamp format.`,
  );
}
for (const path of malformedStamp) {
  reporter.error(
    `"${path}"'s reference-freshness stamp is missing a required field (library=, tracks=, snapshot=, or refresh=major|minor) or a tracks= entry doesn't parse as name@version.`,
  );
}
for (const message of staleTracked) {
  reporter.error(`${message}. Refresh the snapshot and its stamp.`);
}
for (const path of retiredClaims) {
  reporter.error(
    `"${path}" still references a retired \`ctx7 <verb>\` CLI instruction — the ctx7 CLI is uninstalled. Replace it with the mcp__context7__* procedure.`,
  );
}
for (const message of unknownTracked) {
  reporter.warn(`${message}.`);
}
for (const message of driftWarnings) {
  reporter.warn(`${message}.`);
}

if (
  missingStamp.length > 0 ||
  malformedStamp.length > 0 ||
  staleTracked.length > 0 ||
  retiredClaims.length > 0
) {
  reporter.finish({
    missingStamp,
    malformedStamp,
    staleTracked,
    retiredClaims,
    unknownTracked,
    driftWarnings,
  });
  process.exit(1);
}

const context7SourcedCount = files.filter((f) =>
  isContext7Sourced(f.content),
).length;
reporter.succeed(
  `Reference-freshness stamps are current (${context7SourcedCount} Context7-sourced file(s) of ${files.length} reference file(s) checked).`,
);
reporter.finish({
  missingStamp,
  malformedStamp,
  staleTracked,
  retiredClaims,
  unknownTracked,
  driftWarnings,
});
