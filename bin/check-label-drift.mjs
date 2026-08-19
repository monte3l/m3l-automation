#!/usr/bin/env node
// Verifies every label bin/lib/label-defs.mjs declares (the ADR-0032
// visibility hub's hub-sync/priority:*/type:*/status:*/triage set) exists on
// the live repository with the exact name, description, and color
// bin/sync-hub-issues.mjs would bootstrap it with. Push-only in CI (ci.yml,
// mirroring "Check hub drift" and "Check GitHub platform-feature stance") —
// needs a `gh`-authenticated session.
//
// check:hub-drift catches an issue whose OWN labels drifted from its tracker
// row. It never inspects the label objects themselves, so a hand-renamed or
// hand-deleted managed label (e.g. reverting ADR-0051's rename by editing
// `priority:0-now` back to `priority:p0` on GitHub) went undetected until
// this gate was added.
//
// Usage:
//   node bin/check-label-drift.mjs
//   pnpm check:label-drift
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LABEL_DEFS } from "./lib/label-defs.mjs";
import { deriveLabelDrift } from "./lib/label-drift.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const REPO = "monte3l/m3l-automation";

/**
 * The single injected `gh` execution seam: every call in this file goes
 * through this function (or a test double shaped like it), mirroring
 * `bin/check-github-features.mjs`'s `runGh` so nothing here shells out
 * directly in `bin/tests/**`.
 *
 * @param {string[]} args
 * @returns {string} the child process's captured stdout
 */
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** Extract the clearest available message from a failed `execFileSync` call. */
function ghErrorMessage(cause) {
  if (
    cause &&
    typeof cause === "object" &&
    "stderr" in cause &&
    typeof cause.stderr === "string" &&
    cause.stderr.trim() !== ""
  ) {
    return cause.stderr.trim();
  }
  return cause instanceof Error ? cause.message : String(cause);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  try {
    const raw = runGh([
      "label",
      "list",
      "-R",
      REPO,
      "--limit",
      "200",
      "--json",
      "name,description,color",
    ]);
    /** @type {import("./lib/label-drift.mjs").LiveLabel[]} */
    const liveLabels = JSON.parse(raw);

    const findings = deriveLabelDrift(LABEL_DEFS, liveLabels);

    for (const message of findings) reporter.error(message);

    if (findings.length > 0) {
      reporter.finish({ findings });
      process.exit(1);
    }

    reporter.succeed(
      `All ${LABEL_DEFS.length} hub-managed labels match the live repository ` +
        "(ADR-0051 vocabulary).",
    );
    reporter.finish({ findings });
  } catch (cause) {
    const message =
      cause instanceof Error && "stderr" in cause
        ? `gh label list -R ${REPO} failed — run \`gh auth login\` first if ` +
          `this is an auth error: ${ghErrorMessage(cause)}`
        : cause instanceof Error
          ? cause.message
          : String(cause);
    reporter.error(message);
    reporter.finish();
    process.exit(1);
  }
}
