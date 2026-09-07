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
 * @returns {{ files: string[], error: string | null }} basenames of every
 *   file directly under `dir` — a non-recursive listing, so
 *   docs/plans/archive/**'s contents are never seen at all (they aren't
 *   filenames this function returns) — or a non-null `error` when `dir`
 *   itself could not be read. `docs/plans/` is a committed, always-present
 *   directory in this repo, so any read failure here (renamed, moved,
 *   permissions) is anomalous and must surface as a finding: silently
 *   returning an empty list would let this blocking gate report "0 plan
 *   doc(s), all pass" — a false all-clear — exactly when its anchor
 *   directory has gone missing.
 */
export function listPlanFiles(dir) {
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    return { files, error: null };
  } catch (cause) {
    return {
      files: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const planDir = join(root, PLAN_DIR);
  const { files, error: dirError } = listPlanFiles(planDir);
  const planFiles = selectDatedPlans(files);

  let errors = 0;
  const findings = [];

  if (dirError !== null) {
    const message = `${PLAN_DIR}/ could not be read: ${dirError}`;
    reporter.error(message, { file: PLAN_DIR });
    findings.push({ file: PLAN_DIR, kind: "unreadable-directory", message });
    errors++;
  }

  for (const filename of planFiles) {
    const relPath = `${PLAN_DIR}/${filename}`;
    let text;
    try {
      text = readFileSync(join(planDir, filename), "utf8");
    } catch {
      text = null;
    }

    const result = checkLandingPlanDoc(text);
    // The verdict/missingSliceColumn/emptySliceId/duplicateSliceIds arms
    // below are mutually exclusive PRECONDITIONS (checkLandingPlanDoc
    // never sets more than one of missing-heading/unparseable-table/
    // missingSliceColumn true at once), but emptySliceId and
    // duplicateSliceIds are independent booleans once neither of those
    // preconditions holds — a table can have BOTH an empty cell and a
    // duplicate ID, and each is reported (and counted) on its own rather
    // than one masking the other, matching check-scaffold-seam.mjs's
    // every-independent-problem reporting for a module. Each pushed
    // finding carries its own `kind`, distinct from checkLandingPlanDoc's
    // `verdict` field — a `verdict: "ok"` doc can still produce an
    // empty-slice-id or duplicate-slice-id finding, and a `--json` consumer
    // needs to tell those apart from an actual clean pass.
    /** @type {{ kind: string, message: string }[]} */
    const problems = [];

    if (result.verdict === "missing-page") {
      problems.push({
        kind: "missing-page",
        message: `${relPath} could not be read.`,
      });
    } else if (result.verdict === "missing-heading") {
      problems.push({
        kind: "missing-heading",
        message: `${relPath} is missing a "## Landing plan" heading (ADR-0072) — every live dated plan doc needs a durable slice record. Add the heading, or git mv this file into docs/plans/archive/ if the work it describes has already shipped.`,
      });
    } else if (result.verdict === "unparseable-table") {
      problems.push({
        kind: "unparseable-table",
        message: `${relPath}'s "## Landing plan" section has a heading but no parseable Slice/Status table. See docs/adr/0072-reviewable-slice-discipline.md's 2026-09-07 amendment for the required "| Slice | Scope | Status |" table shape.`,
      });
    } else if (result.missingSliceColumn) {
      problems.push({
        kind: "missing-slice-column",
        message: `${relPath}'s "## Landing plan" table has no "Slice" column — every row needs a non-empty, unique slice identifier in a dedicated Slice column.`,
      });
    } else {
      if (result.emptySliceId) {
        problems.push({
          kind: "empty-slice-id",
          message: `${relPath}'s "## Landing plan" table has a row with an empty Slice cell — every row needs a non-empty slice identifier.`,
        });
      }
      if (result.duplicateSliceIds.length > 0) {
        problems.push({
          kind: "duplicate-slice-id",
          message: `${relPath}'s "## Landing plan" table has duplicate Slice ID(s): ${result.duplicateSliceIds.join(", ")}.`,
        });
      }
    }

    for (const { kind, message } of problems) {
      reporter.error(message, { file: relPath });
      findings.push({ file: relPath, kind, message });
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
