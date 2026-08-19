#!/usr/bin/env node
/**
 * Validates that the test counts recorded in the Notes column of
 * docs/implementation-status.md match the actual per-file Vitest counts.
 *
 * Only ✅ rows with a "N tests" phrase in their Notes column are checked.
 *
 * Counts come from `vitest list` — Vitest's *collection* pass — not from a full
 * `vitest run`. Collection imports each test file and expands `describe`/
 * `test.each` exactly as a real run would, so the numbers are identical, but no
 * test body executes. That matters because this gate used to spawn a third full
 * execution of the whole suite (4 800+ tests) purely to count it, which ran
 * concurrently with `pre-push`'s `test:coverage` lane and intermittently exited
 * non-zero under the resulting resource pressure — reported as a test failure
 * when no test had failed (F15, issue #489).
 *
 * Consequence worth knowing: this gate no longer fails when a test *fails*, only
 * when collection fails. That is the correct split — `pnpm test` / `test:coverage`
 * own test outcomes and run in both `pre-push` and CI. A failing test is still
 * collected, so its count stays verifiable independently of whether it passes.
 *
 * Usage:
 *   node bin/check-test-counts.mjs   # verify counts (exits 1 on mismatch)
 */
import process from "node:process";
import path, { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

// Scoped to packages/m3l-common/tests: that's the only tree
// docs/implementation-status.md's Notes column documents. Collecting the whole
// repo here previously let a same-named scripts/*/tests/*.test.ts file (e.g.
// scripts/json-etl/tests/config.test.ts) collide with a library submodule's
// basename below and silently overwrite its count depending on vitest's
// (non-deterministic) file-processing order.
const TESTS_SCOPE = "packages/m3l-common/tests";

// Core/AWS tables have 8 data columns → split by | yields 10 items (2 empty ends).
// The barrels table has only 3 data columns, so cols.length < 9 — it is skipped.
//
// Column layout (0-indexed after split):
//   [0] ""  [1] Submodule  [2] Spec  [3] Planned  [4] Symbols  [5] Status
//   [6] Tests  [7] Reviewed  [8] Notes  [9] ""
const STATUS_COL = 5;
const NOTES_COL = 8;

/**
 * Reduce `vitest list --json`'s flat entry array to submodule → test count.
 *
 * The JSON shape is a flat list of individual tests (one entry per expanded
 * `test.each` case), each carrying the absolute `file` it was collected from —
 * unlike `vitest run --reporter=json`, which nests `assertionResults` under a
 * per-file `testResults` entry.
 *
 * Tolerates a missing list and entries without a `file`: the report is external
 * input, and a malformed one should yield an empty count map that the caller's
 * "collected nothing" guard reports precisely, not a TypeError here.
 *
 * @param {Array<{ file?: string }> | undefined} collected
 * @returns {Map<string, number>} submodule name → number of collected tests
 */
export function countsByFile(collected) {
  const counts = new Map();
  for (const entry of collected ?? []) {
    const filePath = entry?.file ?? "";
    if (!filePath) continue;
    const submodule = path.basename(filePath).replace(/\.test\.ts$/, "");
    counts.set(submodule, (counts.get(submodule) ?? 0) + 1);
  }
  return counts;
}

/**
 * Extract the recorded counts from docs/implementation-status.md — every ✅ row
 * whose Notes column carries an "N tests" phrase.
 *
 * @param {string} statusMarkdown
 * @returns {Map<string, number>} submodule name → recorded test count
 */
export function parseRecordedCounts(statusMarkdown) {
  const recorded = new Map();
  for (const line of statusMarkdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*[-:]+/.test(line)) continue; // separator row

    const cols = line.split("|");
    if (cols.length < 9) continue;

    const submodule = cols[1].trim();
    const status = cols[STATUS_COL].trim();
    const notes = cols[NOTES_COL].trim();

    if (!status.includes("✅")) continue;
    // Header row guard. Digits allowed for full official AWS service names
    // (ADR-0028) that contain one (e.g. "s3", "ec2") — mirrors the same fix in
    // bin/lib/reference-index.mjs's parseImplementationStatus().
    if (!/^[a-z][a-z0-9-]*$/.test(submodule)) continue;

    const countMatch = /(\d+) tests/.exec(notes);
    if (!countMatch) continue; // row has no recorded count

    recorded.set(submodule, parseInt(countMatch[1], 10));
  }
  return recorded;
}

/**
 * Compare recorded counts against collected ones.
 *
 * A submodule with no collected entry at all yields `actual: null` — the test
 * file is missing or renamed, which is a different defect from a drifted count.
 *
 * @param {Map<string, number>} recorded
 * @param {Map<string, number>} actual
 * @returns {{ matches: Array<{ submodule: string, count: number }>,
 *             mismatches: Array<{ submodule: string, recorded: number, actual: number | null }> }}
 */
export function diffCounts(recorded, actual) {
  const matches = [];
  const mismatches = [];
  for (const [submodule, count] of recorded) {
    const found = actual.get(submodule);
    if (found === undefined) {
      mismatches.push({ submodule, recorded: count, actual: null });
    } else if (found !== count) {
      mismatches.push({ submodule, recorded: count, actual: found });
    } else {
      matches.push({ submodule, count });
    }
  }
  return { matches, mismatches };
}

/**
 * Render a mismatch as the operator-facing line explaining what to do about it.
 *
 * @param {{ submodule: string, recorded: number, actual: number | null }} mismatch
 * @returns {string}
 */
export function formatMismatch({ submodule, recorded, actual }) {
  if (actual === null) {
    return (
      `${submodule}: no matching test file in vitest results` +
      ` (expected ${TESTS_SCOPE}/${submodule}.test.ts)`
    );
  }
  return (
    `${submodule}: recorded ${recorded} tests, actual ${actual}` +
    ` — update the Notes column in docs/implementation-status.md`
  );
}

/**
 * Describe a failed `vitest list` spawn without guessing at the cause.
 *
 * The previous message ("fix failing tests before checking counts") named the one
 * cause this step can no longer have, and dropped the child's own output on the
 * floor. `signal` is the tell that matters most here: a non-null signal means the
 * kernel killed the process (SIGKILL under memory pressure), which is a machine
 * problem, not a repository one.
 *
 * @param {{ status?: number | null, signal?: string | null, error?: Error,
 *           stdout?: string, stderr?: string }} res
 * @param {number} [tailLines] how many trailing lines of each stream to include
 * @returns {string}
 */
export function formatCollectFailure(res, tailLines = 20) {
  const tail = (stream) =>
    (stream ?? "").trim().split("\n").slice(-tailLines).join("\n").trim();

  const parts = [];
  if (res.signal) {
    parts.push(
      `vitest list was killed by ${res.signal} — the machine ran out of a` +
        ` resource (usually memory); this is not a test or count failure.`,
    );
  } else if (res.error) {
    // Ordered before the exit-code branch: when the spawn itself fails, `status`
    // is null, and leading with "(exit null)" buries the one line that says why.
    parts.push(`vitest list could not be spawned: ${res.error.message}`);
  } else {
    parts.push(
      `vitest list failed to collect ${TESTS_SCOPE} (exit ${String(res.status)}).`,
    );
  }

  const stderr = tail(res.stderr);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  const stdout = tail(res.stdout);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (!stderr && !stdout) parts.push("The child produced no output.");

  return parts.join("\n");
}

/**
 * Run Vitest's collection pass over {@link TESTS_SCOPE} and parse the report.
 *
 * The report is written to a temp file rather than read from stdout. `--json`
 * takes an *optional* value, so the bare flag makes cac swallow the following
 * positional and Vitest then tries to write the report onto the filter directory
 * (`EISDIR`) — passing an explicit path is required, not merely tidier. It also
 * retires the 10 MB `maxBuffer` the old stdout pipe depended on, which the report
 * (1.7 MB and growing with every test added) would eventually have exceeded.
 *
 * @returns {{ ok: true, collected: Array<{ file?: string }> } | { ok: false, message: string }}
 */
export function collectTests() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "m3l-test-counts-"));
  } catch (cause) {
    return {
      ok: false,
      message:
        `Could not create a temp directory for vitest's collection report: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const reportPath = join(dir, "collected.json");
  try {
    const res = spawnSync(
      "pnpm",
      ["vitest", "list", `--json=${reportPath}`, TESTS_SCOPE],
      { cwd: root, encoding: "utf8" },
    );

    if (res.error || res.status !== 0) {
      return { ok: false, message: formatCollectFailure(res) };
    }

    try {
      const collected = JSON.parse(readFileSync(reportPath, "utf8"));
      // `vitest list --json` documents a top-level array. Anything else means
      // the report format changed under us; say so rather than letting
      // countsByFile throw a bare "not iterable" TypeError three frames away.
      if (!Array.isArray(collected)) {
        return {
          ok: false,
          message:
            `vitest's collection report was not a JSON array (got ` +
            `${collected === null ? "null" : typeof collected}) — the ` +
            `\`vitest list --json\` output format changed.`,
        };
      }
      return { ok: true, collected };
    } catch (cause) {
      return {
        ok: false,
        message:
          `Could not read vitest's collection report at ${reportPath}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  } finally {
    // A throw from `finally` would REPLACE the return value computed above,
    // so a read-only tmpdir would surface as a cleanup crash and discard the
    // vitest diagnostic — the same lose-the-real-cause failure F15 was about.
    // Cleanup is best-effort; the OS reaps tmpdir regardless.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Intentionally ignored: see above. The primary result is already formed.
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  const collection = collectTests();
  if (!collection.ok) {
    reporter.error(collection.message);
    reporter.finish();
    process.exit(1);
  }

  let statusContent;
  try {
    statusContent = readFileSync(
      join(root, "docs/implementation-status.md"),
      "utf8",
    );
  } catch (cause) {
    reporter.error(
      `Cannot read docs/implementation-status.md: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    process.exit(1);
  }

  const recorded = parseRecordedCounts(statusContent);
  const actual = countsByFile(collection.collected);

  // `vitest list` exits 0 on a scope that matches no files, so a broken
  // TESTS_SCOPE or a moved test tree would otherwise surface as one "no matching
  // test file" error per documented row — 41 count failures reported for a
  // single configuration failure. Say what actually happened instead.
  if (actual.size === 0 && recorded.size > 0) {
    reporter.error(
      `vitest collected no tests under ${TESTS_SCOPE}, but ` +
        `docs/implementation-status.md records counts for ${recorded.size} ` +
        `submodule(s). The test tree moved or the scope is wrong — this is not count drift.`,
    );
    reporter.finish();
    process.exit(1);
  }

  const { matches, mismatches } = diffCounts(recorded, actual);

  for (const match of matches) {
    reporter.info(`✓  ${match.submodule}: ${match.count} tests`);
  }
  for (const mismatch of mismatches) {
    reporter.error(formatMismatch(mismatch));
  }

  if (mismatches.length > 0) {
    if (!json)
      console.error(
        `\n✗  ${mismatches.length} count mismatch(es). Edit the Notes column in docs/implementation-status.md to match.`,
      );
    reporter.finish({ mismatches });
    process.exit(1);
  }

  if (recorded.size === 0) {
    reporter.succeed(
      "No ✅ submodules with recorded test counts found — nothing to check.",
    );
  } else {
    reporter.info("");
    reporter.succeed(
      `All test counts match (${recorded.size} submodule(s) verified).`,
    );
  }
  reporter.finish({ mismatches });
}
