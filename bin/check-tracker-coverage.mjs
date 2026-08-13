#!/usr/bin/env node
/**
 * Asserts that every status-bearing (`## `-level, has a "Status" column)
 * table in `docs/ROADMAP.md` and `docs/plans/IMPLEMENTATION.md` is registered
 * in `ROADMAP_SECTION_HEADINGS`/`IMPLEMENTATION_SECTION_HEADINGS`
 * (`bin/lib/project-hub.mjs`) — the heading maps `extractRoadmap`/
 * `extractImplementation` use to find tracker tables for the hub dashboard
 * and the `sync:hub` GitHub write-back.
 *
 * This is the durable fix for the failure mode a 2026-08 audit found: the
 * capability-deepening and post-comparison hardening wave tables (added to
 * `IMPLEMENTATION.md` on 2026-08-11/2026-08-13) went completely unparsed for
 * weeks — `extractImplementation` only reports an `errors` entry for a
 * heading it already knows to look for, so a brand-new tracker table is a
 * silent no-op forever unless something else notices it exists. This check
 * is that something else: it scans both trackers for every `## ` section
 * whose table has a "Status" column, and fails loudly the moment one has no
 * registered extractor — before it can go unnoticed for a single sync cycle,
 * let alone weeks.
 *
 * Exit codes:
 *   0  Every status-bearing tracker table is registered.
 *   1  At least one is not, or a tracker file could not be read.
 *
 * Usage:
 *   node bin/check-tracker-coverage.mjs
 *   pnpm check:tracker-coverage
 */
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findUncoveredStatusHeadings,
  IMPLEMENTATION_SECTION_HEADINGS,
  ROADMAP_SECTION_HEADINGS,
} from "./lib/project-hub.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);

const TRACKERS = [
  {
    path: "docs/ROADMAP.md",
    registeredHeadings: ROADMAP_SECTION_HEADINGS,
  },
  {
    path: "docs/plans/IMPLEMENTATION.md",
    registeredHeadings: IMPLEMENTATION_SECTION_HEADINGS,
  },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const errors = [];

  try {
    for (const { path, registeredHeadings } of TRACKERS) {
      const content = readFileSync(join(root, path), "utf8");
      const uncovered = findUncoveredStatusHeadings(
        content,
        registeredHeadings,
      );
      for (const heading of uncovered) {
        errors.push(
          `${path}: "## ${heading}" has a Status-column table but no registered ` +
            `extractor — add it to the matching heading map in bin/lib/project-hub.mjs ` +
            `(and, if it should feed sync:hub, an actionableItems() block in bin/lib/hub-sync.mjs).`,
        );
      }
    }
  } catch (cause) {
    reporter.error(cause instanceof Error ? cause.message : String(cause));
    reporter.finish();
    process.exit(1);
  }

  if (errors.length > 0) {
    for (const message of errors) reporter.error(message);
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    "Every status-bearing tracker table has a registered extractor.",
  );
  reporter.finish();
}
