#!/usr/bin/env node
// One-way sync: hub-sync-managed GitHub Issues -> the GitHub Projects v2
// board (ADR-0032 visibility hub, write-back half). The board is a view
// over the issues bin/sync-hub-issues.mjs already owns — this runner never
// invents a card for anything that isn't a tracked hub-sync issue.
//
// Maintainer-run, locally, only — never wired into CI. The Actions
// GITHUB_TOKEN cannot write GitHub Projects v2 (see the ADR-0032 update
// note), so both hub-sync write-back runners (this one and
// sync-hub-issues.mjs) stay local, invoked by a human with an authenticated
// `gh` that has the `project` OAuth scope.
//
// Dry-run by default: prints the full plan and exits 0 WITHOUT any mutating
// `gh` call. Pass --apply to execute it. --init is a one-time, idempotent
// setup step that creates the board (or reuses it) and configures its
// Status field. All planning logic lives in bin/lib/hub-sync.mjs, which is
// pure; this file supplies only I/O (`gh`, the filesystem) and printing.
//
// Usage:
//   node bin/sync-hub-projects.mjs             # dry run
//   node bin/sync-hub-projects.mjs --init      # one-time: create/reuse the board
//   node bin/sync-hub-projects.mjs --apply     # execute the plan
//   node bin/sync-hub-projects.mjs --json      # ADR-0030 structured report
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractImplementation, extractRoadmap } from "./lib/project-hub.mjs";
import {
  actionableItems,
  HUB_LABEL,
  HUB_PROJECT_TITLE,
  parseHubMarker,
  planProjectSync,
} from "./lib/hub-sync.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "monte3l/m3l-automation";
const OWNER = "monte3l";
const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";

// The Status single-select's desired options — GitHub's project-create
// default is "Todo"/"In Progress"/"Done"; ADR-0032 wants these three names,
// matching the mapping baked into planProjectSync.
const DESIRED_STATUS_OPTIONS = ["Pending", "In review", "Done"];

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

/**
 * Preflight: probe `gh project list`, throwing a clear, actionable error on
 * failure. When the failure looks like a missing/expired scope (the
 * message/stderr mentions "scope" or "auth"), the thrown message states the
 * exact remedy: `gh auth refresh -s project`.
 *
 * @returns {{ number: number, title: string }[]} the owner's existing projects
 */
function probeProjects(runGhFn) {
  let raw;
  try {
    raw = runGhFn([
      "project",
      "list",
      "--owner",
      OWNER,
      "--format",
      "json",
      "--limit",
      "100",
    ]);
  } catch (cause) {
    const message = ghErrorMessage(cause);
    if (/scope|auth/i.test(message)) {
      throw new Error(
        `Missing GitHub Projects access. Run: gh auth refresh -s project`,
        {
          cause,
        },
      );
    }
    throw new Error(`gh project list failed: ${message}`, { cause });
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.projects ?? []);
}

function findProjectByTitle(projects) {
  return (
    projects.find((project) => project.title === HUB_PROJECT_TITLE) ?? null
  );
}

/** Resolve the Status field's id and its option-name -> option-id map. */
function resolveStatusField(runGhFn, projectNumber) {
  const raw = runGhFn([
    "project",
    "field-list",
    String(projectNumber),
    "--owner",
    OWNER,
    "--format",
    "json",
  ]);
  const parsed = JSON.parse(raw);
  const fields = Array.isArray(parsed) ? parsed : (parsed.fields ?? []);
  const statusField = fields.find((field) => field.name === "Status");
  if (!statusField) {
    throw new Error(
      `Project #${projectNumber} has no "Status" field — run --init or add one manually.`,
    );
  }
  return {
    fieldId: statusField.id,
    optionIdByName: new Map(
      (statusField.options ?? []).map((option) => [option.name, option.id]),
    ),
  };
}

// A GraphQL mutation with the desired options embedded as literals (no
// dynamic user input beyond the field id, which comes from GitHub's own
// field-list response) — the "straightforward" case; anything more
// elaborate (e.g. preserving existing option colors) is left to the manual
// fallback below.
function updateStatusFieldOptions(runGhFn, fieldId) {
  const optionsLiteral = DESIRED_STATUS_OPTIONS.map(
    (name) => `{name: ${JSON.stringify(name)}, color: GRAY, description: ""}`,
  ).join(", ");
  const mutation = `mutation { updateProjectV2Field(input: { fieldId: ${JSON.stringify(fieldId)}, singleSelectOptions: [${optionsLiteral}] }) { clientMutationId } }`;
  runGhFn(["api", "graphql", "-f", `query=${mutation}`]);
}

/**
 * Ensure the board's Status field carries exactly {@link DESIRED_STATUS_OPTIONS}.
 * Never throws: inspection or mutation failures are reported as a warning
 * with the exact manual step, and --init continues regardless.
 */
function ensureStatusOptions(runGhFn, reporter, projectNumber) {
  let statusField;
  try {
    statusField = resolveStatusField(runGhFn, projectNumber);
  } catch (cause) {
    reporter.warn(
      `Could not inspect the Status field (${ghErrorMessage(cause)}). ` +
        `Manually set its options to exactly: ${DESIRED_STATUS_OPTIONS.join(", ")}.`,
    );
    return;
  }

  const currentNames = [...statusField.optionIdByName.keys()];
  const matches =
    currentNames.length === DESIRED_STATUS_OPTIONS.length &&
    DESIRED_STATUS_OPTIONS.every((name) =>
      statusField.optionIdByName.has(name),
    );
  if (matches) return;

  try {
    updateStatusFieldOptions(runGhFn, statusField.fieldId);
    reporter.info(
      `Status field options set to: ${DESIRED_STATUS_OPTIONS.join(", ")}.`,
    );
  } catch (cause) {
    reporter.warn(
      `Could not set the Status field options automatically (${ghErrorMessage(cause)}). ` +
        `Manually edit the board's Status field to exactly these options: ${DESIRED_STATUS_OPTIONS.join(", ")}.`,
    );
  }
}

/** Create (or reuse) the board, then ensure its Status field. Idempotent. */
function runInit({ runGh: runGhFn, reporter, projects }) {
  let project = findProjectByTitle(projects);
  if (project) {
    reporter.info(
      `Project "${HUB_PROJECT_TITLE}" already exists (#${project.number}); reusing it.`,
    );
  } else {
    const raw = runGhFn([
      "project",
      "create",
      "--owner",
      OWNER,
      "--title",
      HUB_PROJECT_TITLE,
      "--format",
      "json",
    ]);
    project = JSON.parse(raw);
    reporter.change(
      "created",
      `project board "${HUB_PROJECT_TITLE}" (#${project.number})`,
    );
  }

  ensureStatusOptions(runGhFn, reporter, project.number);

  reporter.succeed(
    `Project board ready: "${HUB_PROJECT_TITLE}" (#${project.number}).`,
  );
  reporter.finish({
    project: { number: project.number, title: HUB_PROJECT_TITLE },
  });
}

// Every hub-sync-managed issue carries the hub-sync label (bin/sync-hub-issues.mjs
// is the only writer that ever applies it, on create), so filtering by label
// here is equivalent to "every marker-bearing issue."
function loadHubIssues(runGhFn) {
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
    "number,body,state",
    "--limit",
    "500",
  ]);
  const trimmed = raw.trim();
  return trimmed === "" ? [] : JSON.parse(trimmed);
}

// Join a fetched hub-sync issue to the current item it tracks (by marker
// key) to recover its board status; a marker whose item is no longer in the
// trackers (already closed by bin/sync-hub-issues.mjs, most likely) falls
// back to "other" -> "Pending", which only matters if the issue is somehow
// still open. A markerless issue is never tracked, by construction.
function toTrackedIssue(issue, itemByKey) {
  const key = parseHubMarker(issue.body);
  if (key === null) return null;
  const item = itemByKey.get(key);
  return {
    number: issue.number,
    state: issue.state === "CLOSED" ? "closed" : "open",
    status: item ? item.status : "other",
  };
}

function loadProjectItems(runGhFn, projectNumber) {
  const raw = runGhFn([
    "project",
    "item-list",
    String(projectNumber),
    "--owner",
    OWNER,
    "--format",
    "json",
    "--limit",
    "500",
  ]);
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  return items
    .map((item) => ({
      itemId: item.id,
      issueNumber: item.content?.number,
      status:
        typeof item.status === "string" && item.status !== ""
          ? item.status
          : null,
    }))
    .filter((item) => typeof item.issueNumber === "number");
}

function resolveProjectId(runGhFn, projectNumber) {
  const raw = runGhFn([
    "project",
    "view",
    String(projectNumber),
    "--owner",
    OWNER,
    "--format",
    "json",
  ]);
  return JSON.parse(raw).id;
}

function issueUrl(number) {
  return `https://github.com/${REPO}/issues/${number}`;
}

function addProjectItem(runGhFn, projectNumber, issueNumber) {
  const raw = runGhFn([
    "project",
    "item-add",
    String(projectNumber),
    "--owner",
    OWNER,
    "--url",
    issueUrl(issueNumber),
    "--format",
    "json",
  ]);
  return JSON.parse(raw).id;
}

function setItemStatus(
  runGhFn,
  projectId,
  fieldId,
  optionIdByName,
  itemId,
  statusName,
) {
  const optionId = optionIdByName.get(statusName);
  if (!optionId) {
    throw new Error(
      `Status option "${statusName}" not found on the board's Status field — run --init to (re)configure it.`,
    );
  }
  runGhFn([
    "project",
    "item-edit",
    "--id",
    itemId,
    "--field-id",
    fieldId,
    "--project-id",
    projectId,
    "--single-select-option-id",
    optionId,
  ]);
}

function archiveProjectItem(runGhFn, projectNumber, itemId) {
  runGhFn([
    "project",
    "item-archive",
    String(projectNumber),
    "--owner",
    OWNER,
    "--id",
    itemId,
  ]);
}

function printPlan(reporter, plan) {
  reporter.info(`Board items to add (${plan.add.length}):`);
  for (const { issueNumber, status } of plan.add) {
    reporter.info(`  + issue #${issueNumber} -> ${status}`);
  }

  reporter.info(`Board items to update status (${plan.setStatus.length}):`);
  for (const { issueNumber, status } of plan.setStatus) {
    reporter.info(`  ~ issue #${issueNumber} -> ${status}`);
  }

  reporter.info(`Board items to archive (${plan.archive.length}):`);
  for (const { issueNumber } of plan.archive) {
    reporter.info(`  - issue #${issueNumber}`);
  }
}

function applyProjectPlan({ runGh: runGhFn, reporter, projectNumber, plan }) {
  const projectId = resolveProjectId(runGhFn, projectNumber);
  const { fieldId, optionIdByName } = resolveStatusField(
    runGhFn,
    projectNumber,
  );

  for (const { issueNumber, status } of plan.add) {
    const itemId = addProjectItem(runGhFn, projectNumber, issueNumber);
    setItemStatus(runGhFn, projectId, fieldId, optionIdByName, itemId, status);
    reporter.change(
      "created",
      `board item for issue #${issueNumber} (status: ${status})`,
    );
  }

  for (const { itemId, issueNumber, status } of plan.setStatus) {
    setItemStatus(runGhFn, projectId, fieldId, optionIdByName, itemId, status);
    reporter.change(
      "updated",
      `board item for issue #${issueNumber} -> status ${status}`,
    );
  }

  for (const { itemId, issueNumber } of plan.archive) {
    archiveProjectItem(runGhFn, projectNumber, itemId);
    reporter.change("removed", `board item for issue #${issueNumber} archived`);
  }
}

/**
 * The full read -> plan -> (print | apply) pipeline, plus the one-time
 * `--init` path. Every I/O dependency is injected so the orchestration
 * itself stays testable; the main-guard below wires the real
 * `gh`/filesystem implementations.
 *
 * @param {{
 *   runGh: typeof runGh,
 *   reporter: ReturnType<typeof createReporter>,
 *   apply: boolean,
 *   init: boolean,
 *   readDoc: typeof readDoc,
 * }} deps
 * @example
 * ```js
 * import { createReporter } from "./lib/report.mjs";
 * import { runProjectSync } from "./sync-hub-projects.mjs";
 *
 * runProjectSync({
 *   runGh: (args) => "",
 *   reporter: createReporter(false),
 *   apply: false,
 *   init: false,
 *   readDoc: (path) => "",
 * });
 * ```
 */
export function runProjectSync({
  runGh: runGhFn,
  reporter,
  apply,
  init,
  readDoc: readDocFn,
}) {
  const projects = probeProjects(runGhFn);

  if (init) {
    runInit({ runGh: runGhFn, reporter, projects });
    return;
  }

  const project = findProjectByTitle(projects);
  if (!project) {
    reporter.error(
      `Project board "${HUB_PROJECT_TITLE}" not found — run with --init to create it.`,
    );
    reporter.finish();
    process.exit(1);
  }

  const roadmap = extractRoadmap(readDocFn(ROADMAP_PATH));
  const implementation = extractImplementation(readDocFn(IMPLEMENTATION_PATH));
  const extractionErrors = [...roadmap.errors, ...implementation.errors];
  if (extractionErrors.length > 0) {
    for (const message of extractionErrors) reporter.error(message);
    reporter.finish();
    process.exit(1);
  }

  const items = actionableItems(roadmap, implementation);
  const itemByKey = new Map(items.map((item) => [item.key, item]));

  const trackedIssues = loadHubIssues(runGhFn)
    .map((issue) => toTrackedIssue(issue, itemByKey))
    .filter((issue) => issue !== null);
  const existingProjectItems = loadProjectItems(runGhFn, project.number);

  const plan = planProjectSync(trackedIssues, existingProjectItems);

  printPlan(reporter, plan);

  if (!apply) {
    reporter.succeed(
      `Dry run — pass --apply to execute. Would add ${plan.add.length}, ` +
        `update status on ${plan.setStatus.length}, archive ${plan.archive.length}.`,
    );
    reporter.finish({
      applied: false,
      project: { number: project.number, title: project.title },
      board: {
        add: plan.add.length,
        setStatus: plan.setStatus.length,
        archive: plan.archive.length,
      },
    });
    return;
  }

  applyProjectPlan({
    runGh: runGhFn,
    reporter,
    projectNumber: project.number,
    plan,
  });

  reporter.succeed(
    `Applied: added ${plan.add.length}, updated status on ${plan.setStatus.length}, archived ${plan.archive.length}.`,
  );
  reporter.finish({
    applied: true,
    project: { number: project.number, title: project.title },
    board: {
      add: plan.add.length,
      setStatus: plan.setStatus.length,
      archive: plan.archive.length,
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const apply = argv.includes("--apply");
  const init = argv.includes("--init");
  const reporter = createReporter(json);

  try {
    runProjectSync({ runGh, reporter, apply, init, readDoc });
  } catch (cause) {
    reporter.error(
      `Project sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    process.exit(1);
  }
}
