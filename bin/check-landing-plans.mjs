#!/usr/bin/env node
// Verifies every live, in-flight dated plan doc under docs/plans/
// (docs/plans/YYYY-MM-DD-<slug>.md — docs/plans/README.md's split between a
// living tracker and a point-in-time plan) carries a durable slice record:
// a "## Landing plan" heading whose section parses as a
// "| Slice | [Branch |] Scope | Status |" table (ADR-0072's 2026-09-07
// amendment, issue #998 / ROADMAP H5), with non-empty, unique Slice IDs.
//
// This is the non-submodule counterpart to bin/check-scaffold-seam.mjs's
// submodule arm (c): that gate anchors on a src/{core,aws}/<mod>/ directory
// and its docs/reference/<ns>/<mod>.md reference page; this one anchors on a
// docs/plans/ file instead. The two stay deliberately disjoint scans sharing
// only the heading constant and the parser (bin/lib/landing-plans.mjs), so
// this gate never touches docs/implementation-status.md and the scaffold-seam
// gate never touches docs/plans/.
//
// A finished plan belongs in docs/plans/archive/ (excluded from this scan,
// per docs/plans/README.md), not retrofitted with a table — "finished" and
// "carries a landing plan" are the same statement by construction of the
// scan predicate (see bin/lib/landing-plans.mjs's DATED_PLAN_RE).
//
// Exit codes: 0 on success, 1 on any finding. Blocking, like
// check:scaffold-seam — not advisory.
//
// Usage:
//   node bin/check-landing-plans.mjs
//   node bin/check-landing-plans.mjs --json   # ADR-0030 structured report
//   pnpm check:landing-plans
import process from "node:process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";
import {
  PLAN_DIR,
  checkLandingPlanDoc,
  selectDatedPlans,
} from "./lib/landing-plans.mjs";

const root = repoRoot(import.meta.url);

/**
 * @param {string} dir absolute path to docs/plans/.
 * @returns {string[]} basenames of every file directly under `dir` — a
 *   non-recursive listing, so docs/plans/archive/**'s contents are never
 *   seen at all (they aren't filenames this function returns).
 */
function listPlanFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const planDir = join(root, PLAN_DIR);
  const planFiles = selectDatedPlans(listPlanFiles(planDir));

  let errors = 0;
  const findings = [];

  for (const filename of planFiles) {
    const relPath = `${PLAN_DIR}/${filename}`;
    let text;
    try {
      text = readFileSync(join(planDir, filename), "utf8");
    } catch {
      text = null;
    }

    const result = checkLandingPlanDoc(text);
    // The three verdict arms are mutually exclusive by construction
    // (checkLandingPlanDoc returns exactly one), but emptySliceId and
    // duplicateSliceIds are independent booleans checked only once verdict
    // is "ok" — a table can have BOTH an empty cell and a duplicate ID, and
    // each is reported (and counted) on its own rather than one masking the
    // other, matching check-scaffold-seam.mjs's every-independent-problem
    // reporting for a module.
    /** @type {string[]} */
    const messages = [];

    if (result.verdict === "missing-page") {
      messages.push(`${relPath} could not be read.`);
    } else if (result.verdict === "missing-heading") {
      messages.push(
        `${relPath} is missing a "## Landing plan" heading (ADR-0072) — every live dated plan doc needs a durable slice record. Add the heading, or git mv this file into docs/plans/archive/ if the work it describes has already shipped.`,
      );
    } else if (result.verdict === "unparseable-table") {
      messages.push(
        `${relPath}'s "## Landing plan" section has a heading but no parseable Slice/Status table. See docs/adr/0072-reviewable-slice-discipline.md's 2026-09-07 amendment for the required "| Slice | Scope | Status |" table shape.`,
      );
    } else {
      if (result.emptySliceId) {
        messages.push(
          `${relPath}'s "## Landing plan" table has a row with an empty Slice cell — every row needs a non-empty slice identifier.`,
        );
      }
      if (result.duplicateSliceIds.length > 0) {
        messages.push(
          `${relPath}'s "## Landing plan" table has duplicate Slice ID(s): ${result.duplicateSliceIds.join(", ")}.`,
        );
      }
    }

    for (const message of messages) {
      reporter.error(message, { file: relPath });
      findings.push({ file: relPath, verdict: result.verdict, message });
      errors++;
    }
  }

  if (errors > 0) {
    if (!json) {
      console.error(
        `\n✗  ${errors} landing-plan gap(s). Every live dated plan doc under ${PLAN_DIR}/ needs a "## Landing plan" heading with a parseable, ID-unique Slice/Status table.`,
      );
    }
    reporter.finish({ findings, checked: planFiles.length });
    process.exit(1);
  }

  reporter.succeed(
    `All ${planFiles.length} live dated plan doc(s) under ${PLAN_DIR}/ carry a valid Landing plan.`,
  );
  reporter.finish({ findings, checked: planFiles.length });
}
