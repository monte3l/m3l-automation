#!/usr/bin/env node
// One-way sync: tracker markdown (docs/ROADMAP.md, docs/plans/IMPLEMENTATION.md)
// -> GitHub Issues + Milestones (ADR-0032 visibility hub, write-back half).
//
// Maintainer-run, locally, only — never wired into CI. The Actions
// GITHUB_TOKEN cannot write GitHub Projects v2 (see the ADR-0032 update
// note), so both hub-sync write-back runners (this one and
// sync-hub-projects.mjs) stay local, invoked by a human with an
// authenticated `gh`.
//
// Dry-run by default: prints the full plan and exits 0 WITHOUT any mutating
// `gh` call. Pass --apply to execute it. All planning logic (what to
// create/update/close/reopen) lives in bin/lib/hub-sync.mjs, which is pure;
// this file supplies only I/O (`gh`, the filesystem) and dry-run printing.
//
// Usage:
//   node bin/sync-hub-issues.mjs             # dry run
//   node bin/sync-hub-issues.mjs --apply     # execute the plan
//   node bin/sync-hub-issues.mjs --json      # ADR-0030 structured report
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractImplementation, extractRoadmap } from "./lib/project-hub.mjs";
import {
  actionableItems,
  HUB_LABEL,
  planIssueSync,
  planMilestones,
  PRIORITY_LABELS,
} from "./lib/hub-sync.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "monte3l/m3l-automation";
const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";

// The hub-sync label plus the four priority labels, bootstrapped (create or
// `--force` update) on every --apply run before any issue/milestone action.
const LABEL_DEFS = [
  {
    name: HUB_LABEL,
    color: "0e8a16",
    description:
      "Managed by the ADR-0032 visibility hub sync — do not edit manually.",
  },
  {
    name: PRIORITY_LABELS.p0,
    color: "b60205",
    description: "Priority 0 item (top of the roadmap backlog).",
  },
  {
    name: PRIORITY_LABELS.p1,
    color: "d93f0b",
    description: "Priority 1 item (near-term roadmap wave).",
  },
  {
    name: PRIORITY_LABELS.p2,
    color: "fbca04",
    description: "Priority 2 item (deferred / gated backlog).",
  },
  {
    name: PRIORITY_LABELS.governance,
    color: "5319e7",
    description: "Governance follow-up item (ADR/process work).",
  },
];

/**
 * The single injected `gh` execution seam: every runner call goes through
 * this function (or a test double shaped like it) so nothing else in this
 * file shells out directly. Always an argv array — never a shell string.
 *
 * @param {string[]} args
 * @returns {string} the child process's captured stdout
 */
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** Read one repo-relative file's contents as UTF-8 text. */
function readDoc(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
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

/** Parse a `gh` JSON-array response, tolerating an empty/whitespace body. */
function parseJsonArray(raw, context) {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON array from gh for ${context}, got ${typeof parsed}.`,
    );
  }
  return parsed;
}

/** `gh auth status` preflight — throws with a clear remedy on failure. */
function checkGhAuth(runGhFn) {
  try {
    runGhFn(["auth", "status"]);
  } catch (cause) {
    throw new Error(
      `gh auth status failed — run \`gh auth login\` first: ${ghErrorMessage(cause)}`,
      { cause },
    );
  }
}

/** Existing milestone titles for the repo (open milestones only). */
function loadExistingMilestoneTitles(runGhFn) {
  const raw = runGhFn(["api", `repos/${REPO}/milestones`, "--paginate"]);
  return parseJsonArray(raw, "milestones").map((milestone) => milestone.title);
}

// Every hub-sync-managed issue carries the hub-sync label (this runner is
// the only writer that ever applies it, on create), so filtering by label
// here is equivalent to "every marker-bearing issue" — including the ones
// close-detection needs to notice a row that was removed from the trackers.
// A markerless issue that happens to carry the label is still never touched
// (planIssueSync's own safety property: match is by marker only).
function loadExistingIssues(runGhFn) {
  const raw = runGhFn([
    "issue",
    "list",
    "-R",
    REPO,
    "--label",
    HUB_LABEL,
    "--state",
    "all",
    "--json",
    "number,title,body,state,labels",
    "--limit",
    "500",
  ]);
  return parseJsonArray(raw, "issue list").map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state === "CLOSED" ? "closed" : "open",
    labels: (issue.labels ?? []).map((label) => label.name),
  }));
}

/** `hub-sync create --force` every fixed label; safe/idempotent to re-run. */
function bootstrapLabels(runGhFn) {
  for (const { name, color, description } of LABEL_DEFS) {
    runGhFn([
      "label",
      "create",
      name,
      "-R",
      REPO,
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
  }
}

function createMilestone(runGhFn, title) {
  runGhFn([
    "api",
    `repos/${REPO}/milestones`,
    "-X",
    "POST",
    "-f",
    `title=${title}`,
  ]);
}

function createIssue(runGhFn, payload) {
  const args = [
    "issue",
    "create",
    "-R",
    REPO,
    "--title",
    payload.title,
    "--body",
    payload.body,
  ];
  for (const label of payload.labels) args.push("--label", label);
  if (payload.milestoneTitle !== null) {
    args.push("--milestone", payload.milestoneTitle);
  }
  runGhFn(args);
}

// A priority label the currently-fetched issue carries but the desired
// payload does not — stale from a prior run whose item priority changed.
function stalePriorityLabels(currentLabels, payload) {
  return currentLabels.filter(
    (label) => label.startsWith("priority:") && !payload.labels.includes(label),
  );
}

function editIssue(runGhFn, number, payload, currentIssue) {
  const args = [
    "issue",
    "edit",
    String(number),
    "-R",
    REPO,
    "--title",
    payload.title,
    "--body",
    payload.body,
  ];
  for (const label of payload.labels) args.push("--add-label", label);
  for (const label of stalePriorityLabels(
    currentIssue?.labels ?? [],
    payload,
  )) {
    args.push("--remove-label", label);
  }
  if (payload.milestoneTitle !== null) {
    args.push("--milestone", payload.milestoneTitle);
  } else {
    args.push("--remove-milestone");
  }
  runGhFn(args);
}

function closeIssue(runGhFn, number, comment) {
  runGhFn(["issue", "close", String(number), "-R", REPO, "--comment", comment]);
}

function reopenIssue(runGhFn, number) {
  runGhFn(["issue", "reopen", String(number), "-R", REPO]);
}

function printPlan(reporter, milestonePlan, issuePlan) {
  reporter.info(`Milestones to create (${milestonePlan.create.length}):`);
  for (const title of milestonePlan.create) reporter.info(`  + ${title}`);

  reporter.info(`Issues to create (${issuePlan.create.length}):`);
  for (const { key, payload } of issuePlan.create) {
    reporter.info(`  + [${key}] ${payload.title}`);
  }

  reporter.info(`Issues to update (${issuePlan.update.length}):`);
  for (const { number, key, payload } of issuePlan.update) {
    reporter.info(`  ~ #${number} [${key}] ${payload.title}`);
  }

  reporter.info(`Issues to close (${issuePlan.close.length}):`);
  for (const { number, key, comment } of issuePlan.close) {
    reporter.info(`  - #${number} [${key}] (${comment})`);
  }

  reporter.info(`Issues to reopen (${issuePlan.reopen.length}):`);
  for (const { number, key } of issuePlan.reopen) {
    reporter.info(`  ^ #${number} [${key}]`);
  }

  reporter.info(`Untouched: ${issuePlan.untouched.length}`);
}

/**
 * The full read -> plan -> (print | apply) pipeline. Every I/O dependency is
 * injected so the orchestration itself stays testable; the main-guard below
 * wires the real `gh`/filesystem implementations.
 *
 * @param {{
 *   runGh: typeof runGh,
 *   reporter: ReturnType<typeof createReporter>,
 *   apply: boolean,
 *   readDoc: typeof readDoc,
 * }} deps
 * @example
 * ```js
 * import { createReporter } from "./lib/report.mjs";
 * import { runIssueSync } from "./sync-hub-issues.mjs";
 *
 * runIssueSync({
 *   runGh: (args) => "",
 *   reporter: createReporter(false),
 *   apply: false,
 *   readDoc: (path) => "",
 * });
 * ```
 */
export function runIssueSync({
  runGh: runGhFn,
  reporter,
  apply,
  readDoc: readDocFn,
}) {
  checkGhAuth(runGhFn);

  const roadmap = extractRoadmap(readDocFn(ROADMAP_PATH));
  const implementation = extractImplementation(readDocFn(IMPLEMENTATION_PATH));
  const extractionErrors = [...roadmap.errors, ...implementation.errors];
  if (extractionErrors.length > 0) {
    for (const message of extractionErrors) reporter.error(message);
    reporter.finish();
    process.exit(1);
  }

  const items = actionableItems(roadmap, implementation);

  const existingMilestoneTitles = loadExistingMilestoneTitles(runGhFn);
  const existingIssues = loadExistingIssues(runGhFn);
  const existingIssuesByNumber = new Map(
    existingIssues.map((issue) => [issue.number, issue]),
  );

  const milestonePlan = planMilestones(items, existingMilestoneTitles);
  const issuePlan = planIssueSync(items, existingIssues);

  printPlan(reporter, milestonePlan, issuePlan);

  if (!apply) {
    reporter.succeed(
      `Dry run — pass --apply to execute. Would create ${milestonePlan.create.length} milestone(s); ` +
        `${issuePlan.create.length} issue(s) to create, ${issuePlan.update.length} to update, ` +
        `${issuePlan.close.length} to close, ${issuePlan.reopen.length} to reopen, ` +
        `${issuePlan.untouched.length} untouched.`,
    );
    reporter.finish({
      applied: false,
      milestones: { create: milestonePlan.create.length },
      issues: {
        create: issuePlan.create.length,
        update: issuePlan.update.length,
        close: issuePlan.close.length,
        reopen: issuePlan.reopen.length,
        untouched: issuePlan.untouched.length,
      },
    });
    return;
  }

  bootstrapLabels(runGhFn);

  for (const title of milestonePlan.create) {
    createMilestone(runGhFn, title);
    reporter.change("created", `milestone: ${title}`);
  }

  for (const { key, payload } of issuePlan.create) {
    createIssue(runGhFn, payload);
    reporter.change("created", `issue [${key}] ${payload.title}`);
  }

  for (const { number, key, payload } of issuePlan.update) {
    editIssue(runGhFn, number, payload, existingIssuesByNumber.get(number));
    reporter.change("updated", `issue #${number} [${key}]`);
  }

  for (const { number, key, comment } of issuePlan.close) {
    closeIssue(runGhFn, number, comment);
    reporter.change("removed", `issue #${number} [${key}] closed (${comment})`);
  }

  for (const { number, key, payload } of issuePlan.reopen) {
    reopenIssue(runGhFn, number);
    editIssue(runGhFn, number, payload, existingIssuesByNumber.get(number));
    reporter.change("updated", `issue #${number} [${key}] reopened`);
  }

  reporter.succeed(
    `Applied: ${milestonePlan.create.length} milestone(s) created; ${issuePlan.create.length} issue(s) created, ` +
      `${issuePlan.update.length} updated, ${issuePlan.close.length} closed, ${issuePlan.reopen.length} reopened.`,
  );
  reporter.finish({
    applied: true,
    milestones: { create: milestonePlan.create.length },
    issues: {
      create: issuePlan.create.length,
      update: issuePlan.update.length,
      close: issuePlan.close.length,
      reopen: issuePlan.reopen.length,
      untouched: issuePlan.untouched.length,
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const apply = argv.includes("--apply");
  const reporter = createReporter(json);

  try {
    runIssueSync({ runGh, reporter, apply, readDoc });
  } catch (cause) {
    reporter.error(
      `Issue sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    process.exit(1);
  }
}
