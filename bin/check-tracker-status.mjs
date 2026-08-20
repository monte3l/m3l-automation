#!/usr/bin/env node
/**
 * Asserts that every Status cell, and every Priority cell, in every pipe
 * table under every `## `/`### ` heading, in `docs/ROADMAP.md` and
 * `docs/plans/IMPLEMENTATION.md` is in vocabulary. Status must be one of
 * ADR-0032's six documented tracker values — Done / To Do / In Progress /
 * Deferred / Blocked / Rejected (or one of the four legacy status emoji
 * `classifyStatusCell` also accepts). Priority must be Now, Next, Later, or
 * the dash placeholder marking a row as deliberately untiered (the
 * ADR-0051 semantic vocabulary, replacing the original P0/P1/P2).
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
 *
 * Exit codes:
 *   0  Every Status and Priority cell in both trackers is in-vocabulary.
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
} from "./lib/project-hub.mjs";
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
            `Now/Next/Later, nor the untiered dash placeholder — there is no tier beyond Later ` +
            `(PRIORITY_LABELS/MILESTONE_TITLES in bin/lib/hub-sync.mjs have no entry for one, ` +
            `and no GitHub milestone backs it), so sync:hub silently files this row under Later.`,
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
    "Every Status cell in both trackers is in the six-value vocabulary, and " +
      "every Priority cell is Now/Next/Later or the untiered placeholder.",
  );
  reporter.finish();
}
