#!/usr/bin/env node
/**
 * Asserts that every Status cell, every Priority cell, and every optional
 * `Type` cell, in every pipe table under every `## `/`### ` heading, in
 * `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` is in vocabulary.
 * Status must be one of ADR-0032's six documented tracker values — Done /
 * To Do / In Progress / Deferred / Blocked / Rejected (or one of the four
 * legacy status emoji `classifyStatusCell` also accepts). Priority must be
 * Now, Next, Later, Gated, or the dash placeholder marking a row as
 * deliberately untiered (the ADR-0051 semantic vocabulary, replacing the
 * original P0/P1/P2, with `Gated` added by ADR-0073). Type, where a table
 * carries the column at all, must be one of the ten ADR-0073 Issue Types or
 * the dash placeholder meaning "use this section's default".
 *
 * This is the durable fix for issue #429: `classifyStatus`
 * (`bin/lib/project-hub.mjs`) silently classified any unrecognized cell as
 * "todo", so a board-side token (`In review`, from the GitHub Projects
 * "Status" field's original three-option vocabulary — ADR-0032's
 * "the tracker's 6-value status vocabulary maps onto the Project board's
 * 3-value Status field" Update; ADR-0052 later widened the board field to
 * the same six values as the tracker, retiring that three-option vocabulary)
 * that leaked into a tracker cell read as a quiet To Do instead of the error
 * it was — issue #204's D4 `aws/rds-data` row sat open with board status
 * "Pending" despite already-shipped work because of exactly this
 * fallthrough. `classifyStatus`/`classifyStatusCell` still default an
 * unrecognized cell to "todo" for the dashboard renderer (a bad cell still
 * needs *some* badge), and `sync:hub`'s `actionableItems` now warns on one
 * (`resolveStatus`, `bin/lib/hub-sync.mjs`) — but a warning in a dry-run log
 * is the same channel that let this go unnoticed for weeks. This check is
 * the hard backstop: it fails the build the moment an off-vocabulary Status
 * cell lands, before it can reach `main`.
 *
 * The Priority half was added with issue #480 / F13. `P3` sat on the F12 row
 * with no `p3` tier, label, or milestone behind it, warning on every single
 * `pnpm sync:hub` run — buried in five more warnings from the wave tables'
 * dash placeholder, which was intentional all along and is now recognized
 * rather than reported (`classifyPriorityCell`). Priority cells exist only in
 * `docs/plans/IMPLEMENTATION.md`; no table in `docs/ROADMAP.md` carries the
 * column, so that file simply yields nothing rather than being special-cased.
 * Cell vocabulary renamed P0/P1/P2 -> Now/Next/Later under ADR-0051; the
 * dash placeholder and the off-vocabulary-cell gate are otherwise unchanged.
 * ADR-0073 then added a real fourth tier, `Gated` — note that the literal
 * `P3` this half was built for stays off-vocabulary, since the new tier is
 * spelled `Gated`, not `P3`.
 *
 * The Type half was added by ADR-0073, which replaced a single `Capability`
 * Issue Type (48 of 60 open board items) with ten layer-based ones. The
 * column is **optional**: `findOffVocabularyTypeCells` inherits the shared
 * scan's "a table without the named column is skipped, not reported" rule,
 * so a table that never grows a Type column is never flagged. What this
 * gate buys is that a row which *does* carry one can't quietly fall back to
 * its section default on a typo — `resolveType` warns, but a warning in a
 * dry-run log is the same channel the Status half already proved unreliable.
 *
 * Exit codes:
 *   0  Every Status, Priority and Type cell in both trackers is in-vocabulary.
 *   1  At least one is not, or a tracker file could not be read.
 *
 * Usage:
 *   node bin/check-tracker-status.mjs
 *   pnpm check:tracker-status
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findOffVocabularyPriorityCells,
  findOffVocabularyStatusCells,
  findOffVocabularyTypeCells,
} from "./lib/project-hub.mjs";
import { TYPE_VALUES } from "./lib/hub-sync.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

const TRACKERS = ["docs/ROADMAP.md", "docs/plans/IMPLEMENTATION.md"];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const errors = [];

  try {
    for (const path of TRACKERS) {
      const content = readFileSync(join(root, path), "utf8");
      for (const { line, heading, cell } of findOffVocabularyStatusCells(
        content,
      )) {
        errors.push({
          file: path,
          line,
          message:
            `${path}:${line}: "## ${heading}" row's Status cell ("${cell}") is not one of the ` +
            `six documented tracker values (Done/To Do/In Progress/Deferred/Blocked/Rejected) — ` +
            `check for a typo (docs/adr/0032-project-management-visibility-hub.md, ` +
            `docs/adr/0052-hub-board-identity-and-field-taxonomy.md).`,
        });
      }
      for (const { line, heading, cell } of findOffVocabularyPriorityCells(
        content,
      )) {
        errors.push({
          file: path,
          line,
          message:
            `${path}:${line}: "## ${heading}" row's Priority cell ("${cell}") is not one of ` +
            `Now/Next/Later/Gated, nor the untiered dash placeholder — so sync:hub silently ` +
            `files this row under Later. Note the fourth tier is spelled "Gated", not "P3" ` +
            `(PRIORITY_LABELS/MILESTONE_TITLES in bin/lib/hub-sync.mjs, ADR-0073).`,
        });
      }
      for (const { line, heading, cell } of findOffVocabularyTypeCells(
        content,
        TYPE_VALUES,
      )) {
        errors.push({
          file: path,
          line,
          message:
            `${path}:${line}: "## ${heading}" row's Type cell ("${cell}") is not one of ` +
            `${TYPE_VALUES.join("/")}, nor the dash placeholder meaning "use this section's ` +
            `default" (TYPE_BY_ROADMAP_SECTION/TYPE_BY_IMPLEMENTATION_SECTION in ` +
            `bin/lib/hub-sync.mjs) — so sync:hub silently files this row under that default.`,
        });
      }
    }
  } catch (cause) {
    reporter.error(cause instanceof Error ? cause.message : String(cause));
    reporter.finish();
    process.exit(1);
  }

  if (errors.length > 0) {
    for (const { file, line, message } of errors) {
      reporter.error(message, { file, line });
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    "Every Status cell in both trackers is in the six-value vocabulary, " +
      "every Priority cell is Now/Next/Later/Gated or the untiered " +
      "placeholder, and every Type cell (where a table carries the column) " +
      "is one of the ten Issue Types or the section-default placeholder.",
  );
  reporter.finish();
}
