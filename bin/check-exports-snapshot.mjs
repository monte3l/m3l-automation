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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "packages/m3l-common/package.json");
const snapshotPath = join(root, "packages/m3l-common/api-exports.json");

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

if (process.argv.includes("--update")) {
  writeFileSync(snapshotPath, actual);
  console.log(`Updated exports snapshot: ${snapshotPath}`);
  process.exit(0);
}

let expected;
try {
  expected = readFileSync(snapshotPath, "utf8");
} catch {
  console.error(
    `✗  Missing exports snapshot at ${snapshotPath}.\n` +
      `   Run \`node bin/check-exports-snapshot.mjs --update\` to create it.`,
  );
  process.exit(1);
}

if (actual !== expected) {
  console.error(
    `✗  The public \`exports\` map of @m3l-automation/m3l-common changed but the\n` +
      `   committed snapshot (packages/m3l-common/api-exports.json) was not updated.\n` +
      `   This is a SEMVER event (it must ship as \`feat!:\` / carry a\n` +
      `   \`BREAKING CHANGE:\` footer). If the change is intentional, run:\n` +
      `       node bin/check-exports-snapshot.mjs --update\n` +
      `   and commit the updated snapshot alongside the change.`,
  );
  process.exit(1);
}

console.log("✓  exports map matches the committed snapshot.");
