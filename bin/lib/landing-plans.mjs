// Pure logic for bin/check-landing-plans.mjs (ADR-0072's 2026-09-07
// amendment, issue #998 / ROADMAP H5). Every non-submodule multi-PR wave's
// "## Landing plan" table gets the same durable record a submodule already
// has via bin/check-scaffold-seam.mjs — sited on a live dated plan doc
// (docs/plans/YYYY-MM-DD-<slug>.md) instead of a docs/reference/<ns>/<mod>.md
// reference page. No fs/process here (mirrors bin/lib/logs-index.mjs and
// bin/lib/promotion-stamps.mjs) so the checker's decision logic is testable
// against synthetic fixtures without touching disk.
import { landingPlanVerdict } from "../check-scaffold-seam.mjs";
import { extractLandingPlanTable } from "../../.claude/hooks/statusline-context-pressure.mjs";

/** Where live, in-flight dated plan docs are scanned from. */
export const PLAN_DIR = "docs/plans";

/**
 * A dated plan doc's filename shape — the same `YYYY-MM-DD-<slug>.md`
 * convention `docs/plans/README.md` already documents as the split between a
 * living tracker (`ROADMAP.md`, `IMPLEMENTATION.md` — no date prefix) and a
 * point-in-time plan. `README.md` and `IMPLEMENTATION.md` fall out of this
 * predicate for free; `docs/plans/archive/` is a directory, never a
 * filename this regex sees (the scan only reads `docs/plans/` non-
 * recursively — see bin/check-landing-plans.mjs).
 */
export const DATED_PLAN_RE = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

/**
 * @param {string[]} filenames entries of `docs/plans/` (basenames, not
 *   full paths) — e.g. from `readdirSync(..., { withFileTypes: true })`
 *   filtered to files.
 * @returns {string[]} the subset that are live dated plan docs, sorted.
 */
export function selectDatedPlans(filenames) {
  return filenames.filter((name) => DATED_PLAN_RE.test(name)).sort();
}

/**
 * @param {string[][]} dataRows every data row's cells, from
 *   {@link extractLandingPlanTable}.
 * @param {number} sliceIndex column index of the `Slice` header cell, or -1
 *   if the table has none.
 * @returns {string[]} duplicate Slice values (each reported once, in first-
 *   seen order) — empty when every non-empty Slice cell is unique. A
 *   `sliceIndex` of -1 (no `Slice` column at all) returns empty: nothing to
 *   compare, and `check-scaffold-seam.mjs`'s sibling table shape doesn't
 *   require one either.
 */
export function findDuplicateSliceIds(dataRows, sliceIndex) {
  if (sliceIndex === -1) return [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {string[]} */
  const duplicates = [];
  for (const row of dataRows) {
    const id = (row[sliceIndex] ?? "").trim();
    if (id === "") continue;
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 2) duplicates.push(id);
  }
  return duplicates;
}

/**
 * @param {string[][]} dataRows every data row's cells, from
 *   {@link extractLandingPlanTable}.
 * @param {number} sliceIndex column index of the `Slice` header cell, or -1
 *   if the table has none.
 * @returns {boolean} true if the table has a `Slice` column and at least one
 *   row's cell is empty/whitespace-only. False (nothing to flag) when there
 *   is no `Slice` column at all.
 */
export function hasEmptySliceId(dataRows, sliceIndex) {
  if (sliceIndex === -1) return false;
  return dataRows.some((row) => (row[sliceIndex] ?? "").trim() === "");
}

/**
 * One plan doc's full verdict: the same `"ok" | "missing-page" |
 * "missing-heading" | "unparseable-table"` arms {@link landingPlanVerdict}
 * already returns (reused so this gate's error text reads like
 * `check:scaffold-seam`'s), plus this gate's own additional structural
 * checks — empty or duplicate Slice IDs — layered on top of an otherwise-`ok`
 * table. `"missing-page"` cannot occur in practice here (a scanned file was
 * already read from disk to get `text`), but the arm is kept so a caller
 * passing `null` defensively still gets a defined result rather than a
 * crash.
 *
 * @param {string | null} text plan-doc file content, or null if unreadable.
 * @returns {{
 *   verdict: "ok" | "missing-page" | "missing-heading" | "unparseable-table",
 *   emptySliceId: boolean,
 *   duplicateSliceIds: string[],
 * }}
 */
export function checkLandingPlanDoc(text) {
  const verdict = landingPlanVerdict(text);
  if (verdict !== "ok" || text === null) {
    return { verdict, emptySliceId: false, duplicateSliceIds: [] };
  }

  const table = extractLandingPlanTable(text);
  // landingPlanVerdict() === "ok" already proved a parseable table exists,
  // so this is unreachable in practice — the null check is only here so the
  // two functions can never silently disagree about "ok".
  if (table === null) {
    return {
      verdict: "unparseable-table",
      emptySliceId: false,
      duplicateSliceIds: [],
    };
  }

  return {
    verdict: "ok",
    emptySliceId: hasEmptySliceId(table.dataRows, table.sliceIndex),
    duplicateSliceIds: findDuplicateSliceIds(table.dataRows, table.sliceIndex),
  };
}
