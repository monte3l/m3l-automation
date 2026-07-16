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
import { parseJsonFlag, createReporter } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { json } = parseJsonFlag();
const reporter = createReporter(json);

// ---------------------------------------------------------------------------
// 1. Run Vitest with the JSON reporter to get per-file test counts.
// ---------------------------------------------------------------------------

// Scoped to packages/m3l-common/tests: that's the only tree
// docs/implementation-status.md's Notes column documents. Running the whole
// repo here previously let a same-named scripts/*/tests/*.test.ts file (e.g.
// scripts/json-etl/tests/config.test.ts) collide with a library submodule's
// basename below and silently overwrite its count depending on vitest's
// (non-deterministic) file-processing order.
const res = spawnSync(
  "pnpm",
  ["vitest", "run", "--reporter=json", "packages/m3l-common/tests"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  },
);

// Vitest exits 0 on pass, 1 on failure. Guard against a broken suite.
if (res.status !== 0) {
  const detail = res.stderr?.trim() ?? "";
  reporter.error(
    `vitest failed (exit ${String(res.status)}) — fix failing tests before checking counts.` +
      (detail ? `\n${detail}` : ""),
  );
  reporter.finish();
  process.exit(1);
}

let vitestData;
try {
  vitestData = JSON.parse(res.stdout);
} catch {
  reporter.error(
    "Failed to parse vitest JSON output. Run `pnpm test` to confirm tests pass.",
  );
  reporter.finish();
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
  reporter.error("Cannot read docs/implementation-status.md");
  reporter.finish();
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
const mismatches = [];

for (const line of statusContent.split("\n")) {
  if (!line.startsWith("|")) continue;
  if (/^\|\s*[-:]+/.test(line)) continue; // separator row

  const cols = line.split("|");
  if (cols.length < 9) continue;

  const submodule = cols[1].trim();
  const status = cols[STATUS_COL].trim();
  const notes = cols[NOTES_COL].trim();

  if (!status.includes("✅")) continue;
  if (!/^[a-z][a-z-]*$/.test(submodule)) continue; // header row guard

  const countMatch = /(\d+) tests/.exec(notes);
  if (!countMatch) continue; // row has no recorded count

  const recorded = parseInt(countMatch[1], 10);
  const actual = actualCounts.get(submodule);

  if (actual === undefined) {
    reporter.error(
      `${submodule}: no matching test file in vitest results` +
        ` (expected packages/m3l-common/tests/${submodule}.test.ts)`,
    );
    mismatches.push({ submodule, recorded, actual: null });
    errors++;
    continue;
  }

  if (actual !== recorded) {
    reporter.error(
      `${submodule}: recorded ${recorded} tests, actual ${actual}` +
        ` — update the Notes column in docs/implementation-status.md`,
    );
    mismatches.push({ submodule, recorded, actual });
    errors++;
  } else {
    reporter.info(`✓  ${submodule}: ${actual} tests`);
  }
  checked++;
}

if (errors > 0) {
  if (!json)
    console.error(
      `\n✗  ${errors} count mismatch(es). Edit the Notes column in docs/implementation-status.md to match.`,
    );
  reporter.finish({ mismatches });
  process.exit(1);
}

if (checked === 0) {
  reporter.succeed(
    "No ✅ submodules with recorded test counts found — nothing to check.",
  );
} else {
  reporter.info("");
  reporter.succeed(`All test counts match (${checked} submodule(s) verified).`);
}
reporter.finish({ mismatches });
