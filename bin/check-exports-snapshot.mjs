#!/usr/bin/env node
// Guards the public API contract of @m3l-automation/m3l-common (rules 04).
//
// The package `exports` map IS the public contract (`.`, `./core`, `./aws`);
// adding, removing, or retyping an entry is a SEMVER event. `publint`/`attw`
// (check:exports) validate the map's *shape*, but not whether it *changed*.
// This check diffs the live exports map against a committed snapshot, so any
// change must show up as a deliberate, reviewed diff to the snapshot — it
// cannot slip in unnoticed. The .claude PostToolUse hook only nudges Claude
// edits; this runs in CI and on every contributor's machine.
//
// Usage:
//   node bin/check-exports-snapshot.mjs            # verify (fails on drift)
//   node bin/check-exports-snapshot.mjs --update   # rewrite the snapshot
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const pkgPath = join(root, "packages/m3l-common/package.json");
const snapshotRel = "packages/m3l-common/api-exports.json";
const snapshotPath = join(root, snapshotRel);
const { json, argv } = parseJsonFlag();
const reporter = createReporter(json);

// Deterministic, key-sorted serialization so the snapshot is stable regardless
// of authoring order in package.json.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const actual = `${JSON.stringify(JSON.parse(stableStringify(pkg.exports ?? {})), null, 2)}\n`;

if (argv.includes("--update")) {
  writeFileSync(snapshotPath, actual);
  reporter.change("updated", snapshotRel);
  reporter.finish();
  process.exit(0);
}

let expected;
try {
  expected = readFileSync(snapshotPath, "utf8");
} catch {
  reporter.error(
    `Missing exports snapshot at ${snapshotRel}. Run ` +
      `\`node bin/check-exports-snapshot.mjs --update\` to create it.`,
    { file: snapshotRel },
  );
  reporter.finish();
  process.exit(1);
}

if (actual !== expected) {
  reporter.error(
    `The public \`exports\` map of @m3l-automation/m3l-common changed but the ` +
      `committed snapshot (${snapshotRel}) was not updated. This is a SEMVER ` +
      `event (it must ship as \`feat!:\` / carry a \`BREAKING CHANGE:\` footer). ` +
      `If the change is intentional, run \`node bin/check-exports-snapshot.mjs ` +
      `--update\` and commit the updated snapshot alongside the change.`,
    { file: snapshotRel },
  );
  reporter.finish();
  process.exit(1);
}

reporter.succeed("exports map matches the committed snapshot.");
reporter.finish();
