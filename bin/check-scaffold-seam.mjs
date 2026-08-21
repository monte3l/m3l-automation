#!/usr/bin/env node
// Verifies the scaffolding seam laid down by the `scaffolding-submodules` skill stays
// intact: every submodule directory under src/core/ and src/aws/ that contains
// an index.ts must have ALL of
//   (a) a matching test file — either packages/m3l-common/tests/<module>.test.ts
//       exactly, or at least one packages/m3l-common/tests/<module>-*.test.ts
//       sibling (a module whose test suite lands across several ADR-0072
//       slices, e.g. `procedure-conditions.test.ts` before `procedure.test.ts`
//       itself exists, still has a seam — this only fails when NEITHER form
//       is present),
//   (b) a row for <module> in docs/implementation-status.md, and
//   (c) while that row's status is not yet ✅, a "## Landing plan" heading on
//       docs/reference/<ns>/<module>.md (ADR-0072) — the seam-plan record
//       `implementing-submodules` Step 5 fills in before RED/GREEN.
//
// This fills the gap between the sibling gates: check-scaffold proves the
// barrel <-> src wiring, and the doc-exports gate proves the barrel is
// documented, but nothing else guarantees a scaffolded module carries its TDD
// test file, a status-tracker row, and (while in flight) a recorded landing
// plan. A module missing any of these is half-scaffolded.
//
// Usage:
//   node bin/check-scaffold-seam.mjs   # exits 0 on success, 1 on any mismatch
import process from "node:process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonFlag, createReporter, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const pkg = join(root, "packages/m3l-common");
const statusPath = join(root, "docs/implementation-status.md");

/**
 * Return subdirectory names under `dir` that contain an index.ts.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function implementedModules(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(dir, name, "index.ts")));
  } catch {
    return [];
  }
}

/**
 * True if `testsDir` contains `<module>.test.ts` exactly, or at least one
 * `<module>-*.test.ts` sibling. A module landing across several ADR-0072
 * slices may ship only sibling-named test files for a while (e.g.
 * `procedure-conditions.test.ts` before `procedure.test.ts` itself exists) —
 * this only fails when the module has NEITHER form, i.e. no test coverage at
 * all.
 *
 * @param {string} testsDir
 * @param {string} module
 * @returns {boolean}
 */
export function hasSeamTestFile(testsDir, module) {
  if (existsSync(join(testsDir, `${module}.test.ts`))) return true;
  let entries;
  try {
    entries = readdirSync(testsDir);
  } catch {
    return false;
  }
  const siblingRe = new RegExp(`^${module}-.+\\.test\\.ts$`);
  return entries.some((name) => siblingRe.test(name));
}

/**
 * True if `docs/implementation-status.md` has a table row whose first cell
 * is exactly `module`.
 *
 * @param {string} statusText
 * @param {string} module
 * @returns {boolean}
 */
export function hasStatusRow(statusText, module) {
  return new RegExp(`^\\|\\s*${module}\\s*\\|`, "m").test(statusText);
}

// Column layout after split("|") (mirrors bin/check-test-counts.mjs and
// bin/lib/reference-index.mjs's parseImplementationStatus — each gate that
// reads this table owns its own small parser rather than sharing one):
//   [0] ""  [1] Submodule  [2] Spec  [3] Planned  [4] Symbols  [5] Status …
export const STATUS_COL = 5;

/**
 * The status emoji recorded for `module`'s row, or null if no row is found.
 * Returns the cell's first code point, mirroring
 * `bin/lib/reference-index.mjs`'s `parseImplementationStatus`.
 *
 * @param {string} statusText
 * @param {string} module
 * @returns {string | null}
 */
export function statusEmoji(statusText, module) {
  for (const line of statusText.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|");
    if (cols.length < 9) continue;
    if (cols[1].trim() !== module) continue;
    const cell = cols[STATUS_COL]?.trim() ?? "";
    return [...cell][0] ?? null;
  }
  return null;
}

/** Matches a `## Landing plan` heading at any level-2 heading line. */
export const LANDING_PLAN_HEADING = /^##\s+Landing plan\s*$/m;

/**
 * The ADR-0072 Landing-plan verdict for one in-flight module, given its
 * reference-page text (or `null` if the page could not be read). Pulled out
 * of the CLI block so the branching decision — as opposed to just its
 * message text — is directly unit-testable.
 *
 * @param {string | null} refText
 * @returns {"ok" | "missing-page" | "missing-heading"}
 */
export function landingPlanVerdict(refText) {
  if (refText === null) return "missing-page";
  return LANDING_PLAN_HEADING.test(refText) ? "ok" : "missing-heading";
}

// Everything below only runs when this file is executed directly (`node
// bin/check-scaffold-seam.mjs` / `pnpm check:scaffold-seam`), never on
// import — every sibling `bin/*.mjs` gate follows this guard so importing a
// script for its exported helpers (as the test suite does) never triggers a
// live repo scan or a stray `process.exit`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const namespaces = ["core", "aws"];
  const statusText = (() => {
    try {
      return readFileSync(statusPath, "utf8");
    } catch {
      return "";
    }
  })();

  let errors = 0;

  if (statusText === "") {
    reporter.error(`Could not read docs/implementation-status.md`, {
      file: "docs/implementation-status.md",
    });
    errors++;
  }

  for (const ns of namespaces) {
    const testsDir = join(pkg, "tests");
    for (const mod of implementedModules(join(pkg, "src", ns))) {
      if (!hasSeamTestFile(testsDir, mod)) {
        reporter.error(
          `src/${ns}/${mod}/index.ts exists but neither tests/${mod}.test.ts nor a tests/${mod}-*.test.ts sibling is present (scaffold seam broken)`,
          { file: `packages/m3l-common/src/${ns}/${mod}/index.ts` },
        );
        errors++;
      }
      if (statusText !== "" && !hasStatusRow(statusText, mod)) {
        reporter.error(
          `src/${ns}/${mod}/index.ts exists but has no row in docs/implementation-status.md`,
          { file: "docs/implementation-status.md" },
        );
        errors++;
      }

      // ADR-0072: while a module is in flight (any status other than ✅ —
      // including "no row found", which is itself already reported above),
      // its reference page must record a Landing plan. All 41 modules were
      // ✅ when this check landed, so it is vacuously green until the next
      // submodule is scaffolded.
      const status = statusText === "" ? null : statusEmoji(statusText, mod);
      if (status !== null && status !== "✅") {
        const refPath = join(root, "docs/reference", ns, `${mod}.md`);
        let refText;
        try {
          refText = readFileSync(refPath, "utf8");
        } catch {
          refText = null;
        }
        const verdict = landingPlanVerdict(refText);
        if (verdict === "missing-page") {
          reporter.error(
            `docs/reference/${ns}/${mod}.md is missing (needed for its "## Landing plan" heading, ADR-0072)`,
            { file: `docs/reference/${ns}/${mod}.md` },
          );
          errors++;
        } else if (verdict === "missing-heading") {
          reporter.error(
            `docs/reference/${ns}/${mod}.md is missing a "## Landing plan" heading — required while status is not yet ✅ (ADR-0072)`,
            { file: `docs/reference/${ns}/${mod}.md` },
          );
          errors++;
        }
      }
    }
  }

  if (errors > 0) {
    if (!json) {
      console.error(
        `\n✗  ${errors} scaffold-seam gap(s). Every src submodule needs a test file, a status row, and (while in flight) a Landing plan.`,
      );
    }
    reporter.finish();
    process.exit(1);
  }

  reporter.succeed(
    "Every src submodule has a matching test file, status-tracker row, and (while in flight) a Landing plan.",
  );
  reporter.finish();
}
