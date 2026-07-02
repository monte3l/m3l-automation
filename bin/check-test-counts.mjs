#!/usr/bin/env node
// Validates that the test counts recorded in the Notes column of
// docs/implementation-status.md match the actual per-file Vitest counts.
//
// Only ✅ rows with a "N tests" phrase in their Notes column are checked.
// Runs Vitest with the JSON reporter internally — no pre-generated output
// file needed.
//
// Usage:
//   node bin/check-test-counts.mjs   # verify counts (exits 1 on mismatch)
import process from "node:process";
import path, { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 1. Run Vitest with the JSON reporter to get per-file test counts.
// ---------------------------------------------------------------------------

const res = spawnSync("pnpm", ["vitest", "run", "--reporter=json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});

// Vitest exits 0 on pass, 1 on failure. Guard against a broken suite.
if (res.status !== 0) {
  const detail = res.stderr?.trim() ?? "";
  console.error(
    `✗  vitest failed (exit ${String(res.status)}) — fix failing tests before checking counts.`,
  );
  if (detail) console.error(detail);
  process.exit(1);
}

let vitestData;
try {
  vitestData = JSON.parse(res.stdout);
} catch {
  console.error(
    "✗  Failed to parse vitest JSON output. Run `pnpm test` to confirm tests pass.",
  );
  process.exit(1);
}

// Build map: submodule name → actual test count (number of individual test() calls)
// Vitest JSON reporter uses `name` for the file path (not `testFilePath`).
const actualCounts = new Map();
for (const suite of vitestData.testResults ?? []) {
  const filePath = suite.name ?? suite.testFilePath ?? "";
  if (!filePath) continue;
  const submodule = path.basename(filePath).replace(/\.test\.ts$/, "");
  actualCounts.set(submodule, suite.assertionResults?.length ?? 0);
}

// ---------------------------------------------------------------------------
// 2. Parse docs/implementation-status.md for ✅ rows with recorded counts.
// ---------------------------------------------------------------------------

let statusContent;
try {
  statusContent = readFileSync(
    join(root, "docs/implementation-status.md"),
    "utf8",
  );
} catch {
  console.error("✗  Cannot read docs/implementation-status.md");
  process.exit(1);
}

// Core/AWS tables have 8 data columns → split by | yields 10 items (2 empty ends).
// The barrels table has only 3 data columns, so cols.length < 9 — it is skipped.
//
// Column layout (0-indexed after split):
//   [0] ""  [1] Submodule  [2] Spec  [3] Planned  [4] Symbols  [5] Status
//   [6] Tests  [7] Reviewed  [8] Notes  [9] ""
const STATUS_COL = 5;
const NOTES_COL = 8;

let errors = 0;
let checked = 0;

for (const line of statusContent.split("\n")) {
  if (!line.startsWith("|")) continue;
  if (/^\|\s*[-:]+/.test(line)) continue; // separator row

  const cols = line.split("|");
  if (cols.length < 9) continue;

  const submodule = cols[1].trim();
  const status = cols[STATUS_COL].trim();
  const notes = cols[NOTES_COL].trim();

  if (!status.includes("✅")) continue;
  if (!/^[a-z]+$/.test(submodule)) continue; // header row guard

  const countMatch = /(\d+) tests/.exec(notes);
  if (!countMatch) continue; // row has no recorded count

  const recorded = parseInt(countMatch[1], 10);
  const actual = actualCounts.get(submodule);

  if (actual === undefined) {
    console.error(
      `✗  ${submodule}: no matching test file in vitest results` +
        ` (expected packages/m3l-common/tests/${submodule}.test.ts)`,
    );
    errors++;
    continue;
  }

  if (actual !== recorded) {
    console.error(
      `✗  ${submodule}: recorded ${recorded} tests, actual ${actual}` +
        ` — update the Notes column in docs/implementation-status.md`,
    );
    errors++;
  } else {
    console.log(`✓  ${submodule}: ${actual} tests`);
  }
  checked++;
}

if (errors > 0) {
  console.error(
    `\n✗  ${errors} count mismatch(es). Edit the Notes column in docs/implementation-status.md to match.`,
  );
  process.exit(1);
}

if (checked === 0) {
  console.log(
    "✓  No ✅ submodules with recorded test counts found — nothing to check.",
  );
} else {
  console.log(`\n✓  All test counts match (${checked} submodule(s) verified).`);
}
