#!/usr/bin/env node
// Opens, updates, or closes the single "main is red" tracking issue in
// response to a workflow_run event on CI or Pages
// (.github/workflows/main-health.yml). This closes the last gap the
// 6-slice CI-fix effort named but didn't solve: nothing alerted when `main`
// went red — seven consecutive red pushes over 2.5 hours went unremarked by
// any automation before this.
//
// Reads the workflow_run event fields from env vars the calling workflow
// step sets (WORKFLOW_NAME, RUN_URL, HEAD_SHA, CONCLUSION, RUN_UPDATED_AT)
// rather than substituting `${{ }}` expressions directly into a shell
// command string — this script has no injection surface from untrusted
// event data.
//
// A success only closes the issue once the OTHER watched workflow's own
// latest completed run on main is also green (otherWorkflowLatestConclusion
// / decideSuccessAction) — CI recovering while Pages is still red must not
// close the tracking issue. The calling workflow's `concurrency:` group
// serializes overlapping notify runs (CI and Pages can both complete on the
// same push), so a second run always re-reads live issue state after the
// first run's write, rather than racing it into creating a duplicate.
//
// Never runs usefully outside that workflow (it needs a real workflow_run
// payload and a `gh`-authenticated GITHUB_TOKEN), but is a real bin/*.mjs
// script rather than inline workflow shell, so its actual logic
// (bin/lib/main-health.mjs) is unit-testable against synthetic state.
//
// Usage (only ever invoked by main-health.yml):
//   WORKFLOW_NAME=CI RUN_URL=... HEAD_SHA=... CONCLUSION=failure \
//     RUN_UPDATED_AT=2026-08-27T10:00:00Z node bin/notify-main-health.mjs
import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  buildFailureComment,
  buildFailureIssueBody,
  buildPartialResolutionComment,
  buildResolutionComment,
  decideSuccessAction,
  findTrackingIssue,
  MAIN_HEALTH_ISSUE_TITLE,
  otherWatchedWorkflow,
} from "./lib/main-health.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const REPO = "monte3l/m3l-automation";

/**
 * The single injected `gh` execution seam — mirrors
 * bin/sync-hub-issues.mjs's own `runGh`. Always an argv array, never a
 * shell string.
 *
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** @param {string} name @returns {string} */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}.`);
  }
  return value;
}

/**
 * `--search '"..." in:title'` is a relevance-ranked TEXT search — it can
 * return an issue that merely mentions the title string, not only an exact
 * match, so {@link findTrackingIssue}'s subsequent exact-string `.find()` is
 * load-bearing, not redundant. `--limit 30` keeps the one real tracking
 * issue (there is ever at most one open at a time, by this script's own
 * design) comfortably inside the result window even if several unrelated
 * issues happen to phrase-match.
 *
 * @returns {{ number: number, title: string } | null}
 */
function findOpenTrackingIssue(runGhFn) {
  const raw = runGhFn([
    "issue",
    "list",
    "-R",
    REPO,
    "--state",
    "open",
    "--search",
    `"${MAIN_HEALTH_ISSUE_TITLE}" in:title`,
    "--json",
    "number,title",
    "--limit",
    "30",
  ]);
  const issues = JSON.parse(raw.trim() || "[]");
  return findTrackingIssue(issues);
}

/**
 * `gh issue create` has no `--json` output mode — parse the created issue's
 * number from its printed URL (`.../issues/<number>`), matching
 * bin/sync-hub-issues.mjs's own `createIssue`. Throws on any other output
 * shape rather than reporting a misleading success message.
 *
 * @param {string} output
 * @returns {number}
 */
function parseCreatedIssueNumber(output) {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  if (!match) {
    throw new Error(
      `Could not parse an issue number from \`gh issue create\`'s output: ${output}`,
    );
  }
  return parseInt(match[1], 10);
}

/**
 * The other watched workflow's own most recent COMPLETED run's conclusion
 * on `main` — the live source of truth {@link decideSuccessAction} checks
 * before closing the tracking issue, rather than trusting that this run's
 * own success means main is fully green. `null` when it has no run history
 * at all (a repo where only one of the two has ever run).
 *
 * @param {(args: string[]) => string} runGhFn
 * @param {string} otherWorkflow
 * @returns {string | null}
 */
function otherWorkflowLatestConclusion(runGhFn, otherWorkflow) {
  const raw = runGhFn([
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    otherWorkflow,
    "--branch",
    "main",
    "--status",
    "completed",
    "--limit",
    "1",
    "--json",
    "conclusion",
  ]);
  const runs = JSON.parse(raw.trim() || "[]");
  return runs[0]?.conclusion ?? null;
}

const { json } = parseJsonFlag();
const reporter = createReporter(json);

try {
  const workflow = requireEnv("WORKFLOW_NAME");
  const runUrl = requireEnv("RUN_URL");
  const sha = requireEnv("HEAD_SHA");
  const conclusion = requireEnv("CONCLUSION");
  // The watched run's own completion time, not this notify job's run time —
  // a queued or retried notify job (see the workflow's concurrency group)
  // would otherwise stamp a skewed "Occurred:" timestamp.
  const occurredAt = requireEnv("RUN_UPDATED_AT");
  const occurrence = { workflow, runUrl, sha, occurredAt };

  const existing = findOpenTrackingIssue(runGh);

  if (conclusion === "failure") {
    if (existing) {
      runGh([
        "issue",
        "comment",
        String(existing.number),
        "-R",
        REPO,
        "--body",
        buildFailureComment(occurrence),
      ]);
      reporter.succeed(
        `${workflow} failed on main — updated existing tracking issue #${existing.number}.`,
      );
    } else {
      const created = runGh([
        "issue",
        "create",
        "-R",
        REPO,
        "--title",
        MAIN_HEALTH_ISSUE_TITLE,
        "--body",
        buildFailureIssueBody(occurrence),
      ]);
      const issueNumber = parseCreatedIssueNumber(created);
      reporter.succeed(
        `${workflow} failed on main — opened tracking issue #${issueNumber}.`,
      );
    }
  } else if (conclusion === "success") {
    if (existing) {
      const other = otherWatchedWorkflow(workflow);
      const otherConclusion = otherWorkflowLatestConclusion(runGh, other);
      const action = decideSuccessAction(otherConclusion);

      if (action === "close") {
        runGh([
          "issue",
          "comment",
          String(existing.number),
          "-R",
          REPO,
          "--body",
          buildResolutionComment(occurrence),
        ]);
        runGh([
          "issue",
          "close",
          String(existing.number),
          "-R",
          REPO,
          "--reason",
          "completed",
        ]);
        reporter.succeed(
          `${workflow} passed on main — closed tracking issue #${existing.number}.`,
        );
      } else {
        runGh([
          "issue",
          "comment",
          String(existing.number),
          "-R",
          REPO,
          "--body",
          buildPartialResolutionComment({ ...occurrence, other }),
        ]);
        reporter.succeed(
          `${workflow} passed on main, but ${other} is still red — tracking issue #${existing.number} stays open.`,
        );
      }
    } else {
      reporter.succeed(
        `${workflow} passed on main and no tracking issue is open — nothing to do.`,
      );
    }
  } else {
    reporter.succeed(
      `${workflow}'s conclusion "${conclusion}" is neither failure nor success — nothing to do.`,
    );
  }
} catch (cause) {
  reporter.error(cause instanceof Error ? cause.message : String(cause));
  reporter.finish();
  process.exit(1);
}

reporter.finish();
