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
//   node bin/sync-hub-projects.mjs --prune-views  # delete views VIEW_DEFS omits
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
  indexItemsByKey,
  parseHubMarker,
  planProjectSync,
} from "./lib/hub-sync.mjs";
import {
  DESIRED_PRIORITY_OPTIONS,
  DESIRED_STATUS_OPTIONS,
  MANUAL_VIEW_STEPS,
  OPTIONAL_VIEW_FIELDS,
  STATUS_OPTION_RENAME_SOURCE,
  VIEW_DEFS,
} from "./lib/hub-views.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "monte3l/m3l-automation";
const OWNER = "monte3l";
const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";

// The --limit passed to `gh issue list` / `gh project item-list`. A result
// whose length reaches this window means gh silently truncated the page —
// reading only part of the tracked issues/board items would make the
// planner think removed rows are gone and re-add/duplicate them, so that
// case is a hard error, never a silent under-read.
const LIST_LIMIT = 500;

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

// Shared by both runProjectSync (non-init path) and runInit: when the
// title lookup misses, a lone existing project on the owner is far more
// likely a hand-renamed board than a genuinely missing one — the owner is
// not expected to run more than the one hub board. Returns the loud-fail
// message for that case, or `null` when the miss looks like a genuinely
// missing board (0 or 2+ projects), in which case the caller's normal
// "not found" / "would create" handling applies instead.
function renameDetectionMessage(projects) {
  if (projects.length !== 1) return null;
  return (
    `Project board "${HUB_PROJECT_TITLE}" not found, but the owner has exactly ` +
    `one project: "${projects[0].title}" (#${projects[0].number}). The board may ` +
    `have been renamed on GitHub without updating HUB_PROJECT_TITLE ` +
    `(bin/lib/hub-sync.mjs) to match — fix the constant rather than running --init, ` +
    `which would create a second, empty board.`
  );
}

/** Resolve any single-select field's id and its option-name -> option-id map. */
function resolveSingleSelectField(runGhFn, projectNumber, fieldName) {
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
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(
      `Project #${projectNumber} has no "${fieldName}" field — run --init or add one manually.`,
    );
  }
  return {
    fieldId: field.id,
    optionIdByName: new Map(
      (field.options ?? []).map((option) => [option.name, option.id]),
    ),
  };
}

// A GraphQL mutation with the desired options embedded as literals (no
// dynamic user input beyond the field id, which comes from GitHub's own
// field-list response) — the "straightforward" case; anything more
// elaborate (e.g. preserving existing option colors) is left to the manual
// fallback below.
//
// `updateProjectV2Field`'s `singleSelectOptions` is a full REPLACE, not a
// merge: any desired option submitted with NO `id` is treated as brand new,
// even when an option under that exact name already exists — the old
// option (and every item's value pointing at its id) is silently orphaned.
// So an existing option's id is preserved whenever `optionIdByName` already
// has an entry under its `option.name` — covering both "unchanged" (found
// under its own name) and "renamed" (found via `renameSource`, which maps a
// desired name to the pre-migration name it replaces) in one lookup, own-name
// checked first since that's the common case and needs no renameSource
// entry at all. Confirmed live (2026-08-20): adding a 4th Priority option
// with no renameSource churned the ids of the three unchanged options and
// wiped all 21 items' board Priority values, recovered only because the
// very next planProjectSync --apply happened to re-set every value from the
// tracker's own source of truth — a renameSource gap here has no such safety
// net in general.
function updateSingleSelectOptions(
  runGhFn,
  fieldId,
  optionIdByName,
  desiredOptions,
  renameSource = {},
) {
  const optionsLiteral = desiredOptions
    .map((option) => {
      const oldName = renameSource[option.name];
      const existingId =
        optionIdByName.get(option.name) ??
        (oldName ? optionIdByName.get(oldName) : undefined);
      const idField = existingId ? `id: ${JSON.stringify(existingId)}, ` : "";
      return (
        `{${idField}name: ${JSON.stringify(option.name)}, ` +
        `color: ${option.color}, description: ${JSON.stringify(option.description)}}`
      );
    })
    .join(", ");
  const mutation = `mutation { updateProjectV2Field(input: { fieldId: ${JSON.stringify(fieldId)}, singleSelectOptions: [${optionsLiteral}] }) { clientMutationId } }`;
  runGhFn(["api", "graphql", "-f", `query=${mutation}`]);
}

/** Whether a single-select field's current options are exactly the desired set. */
function singleSelectOptionsMatch(optionIdByName, desiredOptions) {
  const currentNames = [...optionIdByName.keys()];
  const desiredNames = desiredOptions.map((option) => option.name);
  return (
    currentNames.length === desiredNames.length &&
    desiredNames.every((name) => optionIdByName.has(name))
  );
}

/**
 * Ensure `fieldName` carries exactly `desiredOptions`. Never throws:
 * inspection or mutation failures are reported as a warning with the exact
 * manual step, and --init continues regardless.
 */
function ensureSingleSelectOptions(
  runGhFn,
  reporter,
  projectNumber,
  fieldName,
  desiredOptions,
  renameSource = {},
) {
  const desiredNames = desiredOptions.map((option) => option.name).join(", ");
  let field;
  try {
    field = resolveSingleSelectField(runGhFn, projectNumber, fieldName);
  } catch (cause) {
    reporter.warn(
      `Could not inspect the ${fieldName} field (${ghErrorMessage(cause)}). ` +
        `Manually set its options to exactly: ${desiredNames}.`,
    );
    return;
  }

  if (singleSelectOptionsMatch(field.optionIdByName, desiredOptions)) return;

  try {
    updateSingleSelectOptions(
      runGhFn,
      field.fieldId,
      field.optionIdByName,
      desiredOptions,
      renameSource,
    );
    reporter.info(`${fieldName} field options set to: ${desiredNames}.`);
  } catch (cause) {
    reporter.warn(
      `Could not set the ${fieldName} field options automatically (${ghErrorMessage(cause)}). ` +
        `Manually edit the board's ${fieldName} field to exactly these options: ${desiredNames}.`,
    );
  }
}

// Read-only preview of what --init (without --apply) would do to a
// single-select field of an already-existing board — never mutates.
function previewSingleSelectOptions(
  runGhFn,
  reporter,
  projectNumber,
  fieldName,
  desiredOptions,
) {
  const desiredNames = desiredOptions.map((option) => option.name).join(", ");
  let field;
  try {
    field = resolveSingleSelectField(runGhFn, projectNumber, fieldName);
  } catch (cause) {
    reporter.info(
      `Could not inspect the ${fieldName} field (${ghErrorMessage(cause)}); would attempt to set its ` +
        `options to: ${desiredNames}.`,
    );
    return;
  }

  if (singleSelectOptionsMatch(field.optionIdByName, desiredOptions)) {
    reporter.info(`${fieldName} field options already match: ${desiredNames}.`);
    return;
  }

  const currentNames = [...field.optionIdByName.keys()];
  reporter.info(
    `Would set ${fieldName} field options to: ${desiredNames} ` +
      `(currently: ${currentNames.length > 0 ? currentNames.join(", ") : "none"}).`,
  );
}

/**
 * All of a project's views — used to match {@link VIEW_DEFS}, to prune the
 * undeclared ones, and (by the planned check:hub-views gate, reading the same
 * shape) to assert
 * the board against its declaration.
 *
 * Reads more than the reconciler strictly needs. `filter`, `sortByFields` and
 * `fields` are all readable on `ProjectV2View` even though sort is not
 * writable through any mutation, and reading them is what lets a caller
 * capture a view's sort BEFORE a full-replace column update and diff it
 * after — the one loss this module cannot repair automatically.
 */
function listExistingViews(runGhFn, projectId) {
  const query =
    `query { node(id: ${JSON.stringify(projectId)}) { ... on ProjectV2 { ` +
    `views(first: 20) { nodes { id name layout filter ` +
    `sortByFields(first: 10) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } } ` +
    `fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } } } } } } }`;
  const raw = runGhFn(["api", "graphql", "-f", `query=${query}`]);
  return JSON.parse(raw).data.node.views.nodes;
}

/**
 * Flatten one view node's `sortByFields` connection into the plain
 * `{field, direction}` shape {@link VIEW_DEFS}'s own `sort` uses, so the two
 * are directly comparable. A view with no sort yields `[]`.
 */
function viewSortPairs(view) {
  return (view?.sortByFields?.nodes ?? []).map((node) => ({
    field: node?.field?.name ?? null,
    direction: node?.direction ?? null,
  }));
}

/** Render a sort list as "Priority ASC, Created ASC" for reporting. */
function formatSort(pairs) {
  return pairs.length > 0
    ? pairs.map((pair) => `${pair.field} ${pair.direction}`).join(", ")
    : "none";
}

/**
 * Resolve each of `fieldNames` to its live field id via `gh project
 * field-list`.
 *
 * All-or-nothing on the mandatory names. `configuration.visibleFieldIds` is a
 * full REPLACE, so a short list does not mean "skip that column" — it means
 * "these are now the only columns". Warning-and-skipping a name that failed to
 * resolve therefore turns one typo in {@link VIEW_DEFS} into a silently
 * truncated view, which is the exact shape of the 2026-08-20 incident that
 * wiped 21 items' Priority. A miss on a mandatory name returns `null` and the
 * caller skips that view's update entirely.
 *
 * A name in {@link OPTIONAL_VIEW_FIELDS} (the built-in "Type" column, which
 * has no enabling mutation — see {@link MANUAL_VIEW_STEPS}) is exempt: it is
 * omitted with an informational note rather than a warning, since it is
 * legitimately absent until a human enables the field.
 *
 * @returns {string[] | null} the ordered field ids, or `null` if any
 *   mandatory name did not resolve
 */
function resolveFieldIds(runGhFn, reporter, projectNumber, fieldNames) {
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
  const idByName = new Map(fields.map((field) => [field.name, field.id]));

  const ids = [];
  const missing = [];
  for (const name of fieldNames) {
    const id = idByName.get(name);
    if (id) {
      ids.push(id);
    } else if (OPTIONAL_VIEW_FIELDS.has(name)) {
      reporter.info(
        `View field "${name}" is not on the board yet — omitting it from the ` +
          `visible-column set. It is declared, so it will sync automatically ` +
          `once the field is enabled. See the manual view-setup steps.`,
      );
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    reporter.warn(
      `Declared view field(s) ${missing.map((name) => `"${name}"`).join(", ")} ` +
        `did not resolve to a board field id. Skipping this view's column ` +
        `update rather than writing a partial visibleFieldIds — that key is a ` +
        `full replace, so a short list would delete every other column.`,
    );
    return null;
  }
  return ids;
}

// createProjectV2View cannot set `filter` (CreateProjectV2ViewInput has no
// such field), so a freshly created view always needs the immediate
// updateProjectV2View follow-up below to apply it.
function createView(runGhFn, projectId, viewDef, fieldIds) {
  const mutation =
    `mutation { createProjectV2View(input: { projectId: ${JSON.stringify(projectId)}, ` +
    `name: ${JSON.stringify(viewDef.name)}, layout: ${viewDef.layout}, ` +
    `configuration: { visibleFieldIds: ${JSON.stringify(fieldIds)} } }) ` +
    `{ projectV2View { id } } }`;
  const raw = runGhFn(["api", "graphql", "-f", `query=${mutation}`]);
  return JSON.parse(raw).data.createProjectV2View.projectV2View.id;
}

function updateView(runGhFn, viewId, viewDef, fieldIds) {
  const mutation =
    `mutation { updateProjectV2View(input: { viewId: ${JSON.stringify(viewId)}, ` +
    `name: ${JSON.stringify(viewDef.name)}, layout: ${viewDef.layout}, ` +
    `filter: ${JSON.stringify(viewDef.filter)}, ` +
    `configuration: { visibleFieldIds: ${JSON.stringify(fieldIds)} } }) ` +
    `{ clientMutationId } }`;
  runGhFn(["api", "graphql", "-f", `query=${mutation}`]);
}

/**
 * Delete one view by its node id. Never by name: a name is user-editable and
 * two views can be renamed into each other between the read and the write,
 * whereas an id read in this same run identifies exactly the view that was
 * inspected.
 */
function deleteView(runGhFn, viewId) {
  const mutation =
    `mutation { deleteProjectV2View(input: { viewId: ${JSON.stringify(viewId)} }) ` +
    `{ clientMutationId } }`;
  runGhFn(["api", "graphql", "-f", `query=${mutation}`]);
}

/**
 * Reconcile one view def against the board, returning whether it succeeded.
 *
 * Captures the view's sort BEFORE the update and re-reads it after, because
 * whether `updateProjectV2View` with `configuration.visibleFieldIds`
 * preserves `sortByFields` is not answerable from the schema — it documents
 * only that sort is not an *input*, not what the resolver does to it. Sort is
 * readable but not writable, so a loss can only be repaired by hand; on loss
 * this warns with the captured field names and directions plus the UI path,
 * rather than reporting a silent success.
 *
 * @returns {boolean} true if the view was created or updated
 */
function reconcileView(
  runGhFn,
  reporter,
  projectNumber,
  projectId,
  viewDef,
  existing,
) {
  const fieldIds = resolveFieldIds(
    runGhFn,
    reporter,
    projectNumber,
    viewDef.fields,
  );
  if (fieldIds === null) {
    reporter.warn(
      `Skipped view "${viewDef.name}" — see the unresolved-field warning above.`,
    );
    return false;
  }

  const sortBefore = existing ? viewSortPairs(existing) : [];

  try {
    if (existing) {
      updateView(runGhFn, existing.id, viewDef, fieldIds);
      reporter.change(
        "updated",
        `view "${existing.name}" -> "${viewDef.name}" (${viewDef.layout})`,
      );
    } else {
      const viewId = createView(runGhFn, projectId, viewDef, fieldIds);
      updateView(runGhFn, viewId, viewDef, fieldIds);
      reporter.change("created", `view "${viewDef.name}" (${viewDef.layout})`);
    }
  } catch (cause) {
    reporter.warn(
      `Could not reconcile view "${viewDef.name}" (${ghErrorMessage(cause)}).`,
    );
    return false;
  }

  // Only meaningful when there was a sort to lose — a freshly created view
  // never had one.
  if (sortBefore.length > 0) {
    try {
      const after = listExistingViews(runGhFn, projectId).find(
        (view) => view.id === existing.id,
      );
      // A view that VANISHED is not a view whose sort was cleared — reporting
      // the latter would send the maintainer to re-apply a sort on something
      // that no longer exists.
      if (!after) {
        reporter.warn(
          `View "${viewDef.name}" (id ${existing.id}) was not found when ` +
            `re-reading the board after its update, so its sort ` +
            `(${formatSort(sortBefore)}) could not be confirmed. The view may ` +
            `have been deleted or recreated concurrently — inspect the board.`,
        );
        return true;
      }
      const sortAfter = viewSortPairs(after);
      if (sortAfter.length === 0) {
        reporter.warn(
          `View "${viewDef.name}" lost its sort order (${formatSort(sortBefore)}) ` +
            `to the column update. Sort is readable but NOT writable through any ` +
            `mutation, so restore it by hand: open the view, click the field ` +
            `header, and re-apply ${formatSort(sortBefore)}.`,
        );
      }
    } catch (cause) {
      reporter.warn(
        `Could not re-read view "${viewDef.name}" to confirm its sort survived ` +
          `the column update (${ghErrorMessage(cause)}); verify ` +
          `${formatSort(sortBefore)} by hand.`,
      );
    }
  }

  return true;
}

/**
 * Report — or, with `pruneViews`, delete — every view on the board that
 * {@link VIEW_DEFS} does not declare.
 *
 * Deletion is opt-in behind `--prune-views` and is never a side effect of
 * `--init --apply`. Deleting a view is irreversible through the API: a board
 * view's group-by is not settable by any mutation, so a wrongly-deleted one
 * can only be rebuilt by hand. Same precedent as `--init-issue-types` and
 * `--retype-closed` — an irreversible or wide-blast-radius operation gets its
 * own flag.
 *
 * Four guards, in order:
 * - skipped entirely if any view create/update failed, so a def that failed to
 *   create cannot have its predecessor deleted;
 * - matched off a RE-READ of the live views rather than the stale pre-update
 *   map, so a view this run created or renamed is not pruned by it;
 * - aborted if the prune set would empty the board (GitHub's own last-view
 *   refusal is a backstop, not the guard);
 * - by id, never by name.
 */
function pruneUndeclaredViews(
  runGhFn,
  reporter,
  projectId,
  pruneViews,
  allReconciled,
) {
  const declaredNames = new Set(VIEW_DEFS.map((viewDef) => viewDef.name));

  let live;
  try {
    live = listExistingViews(runGhFn, projectId);
  } catch (cause) {
    reporter.warn(
      `Could not re-read the board's views to check for undeclared ones ` +
        `(${ghErrorMessage(cause)}).`,
    );
    return;
  }

  const undeclared = live.filter((view) => !declaredNames.has(view.name));
  if (undeclared.length === 0) return;

  const named = undeclared.map((view) => `"${view.name}"`).join(", ");

  if (!allReconciled) {
    reporter.warn(
      `Not pruning undeclared view(s) ${named}: at least one declared view ` +
        `failed to reconcile this run, and deleting a view while the board is ` +
        `in an unknown state risks removing the only usable surface.`,
    );
    return;
  }

  if (undeclared.length >= live.length) {
    reporter.warn(
      `Not pruning undeclared view(s) ${named}: doing so would leave the board ` +
        `with no views at all. Declare a view in VIEW_DEFS and re-run --init ` +
        `first.`,
    );
    return;
  }

  if (!pruneViews) {
    reporter.info(
      `Undeclared view(s) on the board: ${named}. VIEW_DEFS declares only ` +
        `${[...declaredNames].map((name) => `"${name}"`).join(", ")}. Deleting a ` +
        `view is irreversible through the API (a board view's group-by cannot ` +
        `be restored by any mutation), so it is opt-in: re-run with ` +
        `--prune-views to preview the deletion, then --prune-views --apply.`,
    );
    return;
  }

  for (const view of undeclared) {
    try {
      deleteView(runGhFn, view.id);
      reporter.change("removed", `view "${view.name}" (${view.layout})`);
    } catch (cause) {
      reporter.warn(
        `Could not delete view "${view.name}" (${ghErrorMessage(cause)}).`,
      );
    }
  }
}

/**
 * Ensure the board carries exactly {@link VIEW_DEFS}: create or update each,
 * optionally prune the undeclared ones, then print the
 * {@link MANUAL_VIEW_STEPS} the API cannot perform. Never throws — a per-view
 * mutation failure is reported as a warning so one bad view doesn't block the
 * rest of --init.
 */
function ensureViews(runGhFn, reporter, projectNumber, pruneViews = false) {
  const projectId = resolveProjectId(runGhFn, projectNumber);
  const existingByName = new Map(
    listExistingViews(runGhFn, projectId).map((view) => [view.name, view]),
  );

  let allReconciled = true;
  for (const viewDef of VIEW_DEFS) {
    const ok = reconcileView(
      runGhFn,
      reporter,
      projectNumber,
      projectId,
      viewDef,
      existingByName.get(viewDef.name),
    );
    if (!ok) allReconciled = false;
  }

  pruneUndeclaredViews(runGhFn, reporter, projectId, pruneViews, allReconciled);

  for (const step of MANUAL_VIEW_STEPS) {
    reporter.info(`Manual step remaining: ${step}`);
  }
}

// Read-only preview of what --init (without --apply) would do to the
// board's views — never mutates.
function previewViews(runGhFn, reporter, projectNumber, pruneViews = false) {
  let projectId;
  let live;
  try {
    projectId = resolveProjectId(runGhFn, projectNumber);
    live = listExistingViews(runGhFn, projectId);
  } catch (cause) {
    reporter.info(
      `Could not inspect the board's views (${ghErrorMessage(cause)}); would attempt to ` +
        `create/update: ${VIEW_DEFS.map((view) => view.name).join(", ")}.`,
    );
    return;
  }

  const existingByName = new Map(live.map((view) => [view.name, view]));

  for (const viewDef of VIEW_DEFS) {
    const existing = existingByName.get(viewDef.name);
    if (existing) {
      reporter.info(
        `Would update view "${existing.name}" -> "${viewDef.name}" (${viewDef.layout}, filter: ${viewDef.filter}).`,
      );
      reporter.info(
        `Would set its columns to: ${viewDef.fields.join(", ")} (ordered — ` +
          `visibleFieldIds is a full replace).`,
      );
      const sortNow = viewSortPairs(existing);
      reporter.info(
        `Its sort is currently ${formatSort(sortNow)}; declared: ` +
          `${formatSort(viewDef.sort ?? [])} (not settable via the API).`,
      );
    } else {
      reporter.info(
        `Would create view "${viewDef.name}" (${viewDef.layout}, filter: ${viewDef.filter}).`,
      );
    }
  }

  // Mirrors ensureViews's prune reporting. In preview there is nothing to
  // re-read after, so this runs against the same single read — and
  // `allReconciled` is true because nothing has been attempted yet.
  const declaredNames = new Set(VIEW_DEFS.map((viewDef) => viewDef.name));
  const undeclared = live.filter((view) => !declaredNames.has(view.name));
  if (undeclared.length > 0) {
    const named = undeclared.map((view) => `"${view.name}"`).join(", ");
    if (undeclared.length >= live.length) {
      reporter.info(
        `Would NOT prune undeclared view(s) ${named}: doing so would leave the ` +
          `board with no views at all.`,
      );
    } else if (pruneViews) {
      reporter.info(
        `Would DELETE undeclared view(s) ${named} by id. Irreversible through ` +
          `the API — a board view's group-by cannot be restored by any mutation.`,
      );
    } else {
      reporter.info(
        `Undeclared view(s) on the board: ${named}. Not deleted without ` +
          `--prune-views.`,
      );
    }
  }
}

/**
 * Create (or reuse) the board, then ensure its Status/Priority fields and
 * its saved views. Idempotent. Without `apply`, only read-only probes
 * run (project list, and — for an already-existing board — field-list) and
 * the function prints what it WOULD do; with `apply`, it executes. Never
 * calls `process.exit`; always returns `{ ok: true }` (this path has no
 * failure branch of its own — `gh` failures propagate to the caller's
 * try/catch).
 *
 * @returns {{ ok: boolean }}
 */
function runInit({ runGh: runGhFn, reporter, apply, projects, pruneViews }) {
  const existingProject = findProjectByTitle(projects);

  // Run the same rename-detection guard runProjectSync's non-init path
  // uses, before splitting on apply — otherwise a title miss here would
  // (in preview) misleadingly report "would create" or (with --apply)
  // actually create a second, empty board, in exactly the scenario this
  // guard exists to catch.
  if (!existingProject) {
    const renameMessage = renameDetectionMessage(projects);
    if (renameMessage) {
      reporter.error(renameMessage);
      reporter.finish();
      return { ok: false };
    }
  }

  if (!apply) {
    if (existingProject) {
      reporter.info(
        `Would reuse existing project "${HUB_PROJECT_TITLE}" (#${existingProject.number}).`,
      );
      previewSingleSelectOptions(
        runGhFn,
        reporter,
        existingProject.number,
        "Status",
        DESIRED_STATUS_OPTIONS,
      );
      previewSingleSelectOptions(
        runGhFn,
        reporter,
        existingProject.number,
        "Priority",
        DESIRED_PRIORITY_OPTIONS,
      );
      previewViews(runGhFn, reporter, existingProject.number, pruneViews);
    } else {
      reporter.info(
        `Would create project board "${HUB_PROJECT_TITLE}" (owner: ${OWNER}).`,
      );
      reporter.info(
        `Would then set its Status field options to: ${DESIRED_STATUS_OPTIONS.map((o) => o.name).join(", ")}.`,
      );
      reporter.info(
        `Would then set its Priority field options to: ${DESIRED_PRIORITY_OPTIONS.map((o) => o.name).join(", ")}.`,
      );
      reporter.info(
        `Would then create/update its views: ${VIEW_DEFS.map((v) => v.name).join(", ")}.`,
      );
    }
    reporter.succeed("Dry run — pass --apply to execute.");
    reporter.finish({
      applied: false,
      project: existingProject
        ? { number: existingProject.number, title: existingProject.title }
        : null,
    });
    return { ok: true };
  }

  let project = existingProject;
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

  ensureSingleSelectOptions(
    runGhFn,
    reporter,
    project.number,
    "Status",
    DESIRED_STATUS_OPTIONS,
    STATUS_OPTION_RENAME_SOURCE,
  );
  ensureSingleSelectOptions(
    runGhFn,
    reporter,
    project.number,
    "Priority",
    DESIRED_PRIORITY_OPTIONS,
  );
  ensureViews(runGhFn, reporter, project.number, pruneViews);

  reporter.succeed(
    `Project board ready: "${HUB_PROJECT_TITLE}" (#${project.number}).`,
  );
  reporter.finish({
    applied: true,
    project: { number: project.number, title: HUB_PROJECT_TITLE },
  });
  return { ok: true };
}

// Every hub-sync-managed issue carries the hub-sync label (bin/sync-hub-issues.mjs
// is the only writer that ever applies it, on create), so filtering by label
// here is equivalent to "every marker-bearing issue."
//
// Returns `null` (after reporting the error) when the response reached the
// --limit window — see the LIST_LIMIT comment.
function loadHubIssues(runGhFn, reporter) {
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
    String(LIST_LIMIT),
  ]);
  const trimmed = raw.trim();
  const issues = trimmed === "" ? [] : JSON.parse(trimmed);
  if (issues.length >= LIST_LIMIT) {
    reporter.error(
      `gh issue list returned ${issues.length} issue(s), at or beyond the --limit ${LIST_LIMIT} window — ` +
        `the sync would under-read and could duplicate board items; raise the limit.`,
    );
    return null;
  }
  return issues;
}

// Join a fetched hub-sync issue to the current item it tracks (by marker
// key) to recover its board status; a marker whose item is no longer in the
// trackers (already closed by bin/sync-hub-issues.mjs, most likely) falls
// back to "todo" -> "Pending", which only matters if the issue is somehow
// still open. A markerless issue is never tracked, by construction.
//
// `itemByKey` is indexItemsByKey's map, so an issue whose marker still
// carries a pre-namespacing key (Item.legacyKeys) resolves to its item
// rather than reading as vanished — the board must keep showing real
// statuses in the window between the key change landing and the next
// `sync:hub --apply` rewriting the markers.
function toTrackedIssue(issue, itemByKey) {
  const key = parseHubMarker(issue.body);
  if (key === null) return null;
  const item = itemByKey.get(key);
  return {
    number: issue.number,
    state: issue.state === "CLOSED" ? "closed" : "open",
    status: item ? item.status : "todo",
    // Same "item vanished from the trackers" fallback resolveStatus uses for
    // an off-vocabulary cell: default to the lowest tier rather than throw,
    // since this path only matters defensively (the issue would already be
    // closed by sync-hub-issues.mjs in the normal case).
    priority: item ? item.priority : "p2",
  };
}

// Returns `null` (after reporting the error) when the response reached the
// --limit window — see the LIST_LIMIT comment.
function loadProjectItems(runGhFn, reporter, projectNumber) {
  const raw = runGhFn([
    "project",
    "item-list",
    String(projectNumber),
    "--owner",
    OWNER,
    "--format",
    "json",
    "--limit",
    String(LIST_LIMIT),
  ]);
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  if (items.length >= LIST_LIMIT) {
    reporter.error(
      `gh project item-list returned ${items.length} item(s), at or beyond the --limit ${LIST_LIMIT} window — ` +
        `the sync would under-read and could duplicate board items; raise the limit.`,
    );
    return null;
  }
  return items
    .map((item) => ({
      itemId: item.id,
      issueNumber: item.content?.number,
      status:
        typeof item.status === "string" && item.status !== ""
          ? item.status
          : null,
      priority:
        typeof item.priority === "string" && item.priority !== ""
          ? item.priority
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

// Set (or, when `optionName` is `null`, clear) one single-select field on
// one board item. `null` is how a governance item's Priority is represented
// — cleared, never a stray option (see PROJECT_PRIORITY_OPTIONS in
// bin/lib/hub-sync.mjs) — so this is the one write path that needs a
// clear branch; Status never passes `null`.
function setItemSingleSelect(
  runGhFn,
  projectId,
  fieldId,
  optionIdByName,
  itemId,
  fieldLabel,
  optionName,
) {
  if (optionName === null) {
    const mutation =
      `mutation { clearProjectV2ItemFieldValue(input: { projectId: ${JSON.stringify(projectId)}, ` +
      `itemId: ${JSON.stringify(itemId)}, fieldId: ${JSON.stringify(fieldId)} }) { clientMutationId } }`;
    runGhFn(["api", "graphql", "-f", `query=${mutation}`]);
    return;
  }

  const optionId = optionIdByName.get(optionName);
  if (!optionId) {
    throw new Error(
      `${fieldLabel} option "${optionName}" not found on the board's ${fieldLabel} field — run --init to (re)configure it.`,
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
  for (const { issueNumber, status, priority } of plan.add) {
    reporter.info(
      `  + issue #${issueNumber} -> ${status}, priority ${priority ?? "(none)"}`,
    );
  }

  reporter.info(`Board items to update status (${plan.setStatus.length}):`);
  for (const { issueNumber, status } of plan.setStatus) {
    reporter.info(`  ~ issue #${issueNumber} -> ${status}`);
  }

  reporter.info(`Board items to update priority (${plan.setPriority.length}):`);
  for (const { issueNumber, priority } of plan.setPriority) {
    reporter.info(
      `  ~ issue #${issueNumber} -> priority ${priority ?? "(none)"}`,
    );
  }

  reporter.info(`Board items to archive (${plan.archive.length}):`);
  for (const { issueNumber } of plan.archive) {
    reporter.info(`  - issue #${issueNumber}`);
  }
}

function applyProjectPlan({ runGh: runGhFn, reporter, projectNumber, plan }) {
  const projectId = resolveProjectId(runGhFn, projectNumber);
  const status = resolveSingleSelectField(runGhFn, projectNumber, "Status");
  const priority = resolveSingleSelectField(runGhFn, projectNumber, "Priority");

  for (const {
    issueNumber,
    status: statusName,
    priority: priorityName,
  } of plan.add) {
    const itemId = addProjectItem(runGhFn, projectNumber, issueNumber);
    setItemSingleSelect(
      runGhFn,
      projectId,
      status.fieldId,
      status.optionIdByName,
      itemId,
      "Status",
      statusName,
    );
    setItemSingleSelect(
      runGhFn,
      projectId,
      priority.fieldId,
      priority.optionIdByName,
      itemId,
      "Priority",
      priorityName,
    );
    reporter.change(
      "created",
      `board item for issue #${issueNumber} (status: ${statusName}, priority: ${priorityName ?? "none"})`,
    );
  }

  for (const { itemId, issueNumber, status: statusName } of plan.setStatus) {
    setItemSingleSelect(
      runGhFn,
      projectId,
      status.fieldId,
      status.optionIdByName,
      itemId,
      "Status",
      statusName,
    );
    reporter.change(
      "updated",
      `board item for issue #${issueNumber} -> status ${statusName}`,
    );
  }

  for (const {
    itemId,
    issueNumber,
    priority: priorityName,
  } of plan.setPriority) {
    setItemSingleSelect(
      runGhFn,
      projectId,
      priority.fieldId,
      priority.optionIdByName,
      itemId,
      "Priority",
      priorityName,
    );
    reporter.change(
      "updated",
      `board item for issue #${issueNumber} -> priority ${priorityName ?? "none"}`,
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
 * `gh`/filesystem implementations. NEVER calls `process.exit` itself —
 * every failure path (the `gh project list` preflight, extraction errors, a
 * missing board, a truncated result window, any other `gh` call throwing)
 * is caught here and turned into a reported error plus a returned
 * `{ ok: false }`, so the function is always safely callable (and its
 * outcome assertable) without killing the calling process. Only the
 * main-guard below turns a `!ok` outcome into `process.exit(1)`.
 *
 * @param {{
 *   runGh: typeof runGh,
 *   reporter: ReturnType<typeof createReporter>,
 *   apply: boolean,
 *   init: boolean,
 *   pruneViews?: boolean,
 *   readDoc: typeof readDoc,
 * }} deps
 * @returns {{ ok: boolean }}
 * @example
 * ```js
 * import { createReporter } from "./lib/report.mjs";
 * import { runProjectSync } from "./sync-hub-projects.mjs";
 *
 * const outcome = runProjectSync({
 *   runGh: (args) => "",
 *   reporter: createReporter(false),
 *   apply: false,
 *   init: false,
 *   readDoc: (path) => "",
 * });
 * outcome.ok; // false — an empty runGh stub fails the `gh project list` preflight
 * ```
 */
export function runProjectSync({
  runGh: runGhFn,
  reporter,
  apply,
  init,
  pruneViews = false,
  readDoc: readDocFn,
}) {
  try {
    const projects = probeProjects(runGhFn);

    // --prune-views implies the view-reconciliation path: pruning is only
    // meaningful once VIEW_DEFS has been reconciled in the same run, so the
    // flag runs --init's board setup rather than needing both flags typed.
    if (init || pruneViews) {
      return runInit({
        runGh: runGhFn,
        reporter,
        apply,
        projects,
        pruneViews,
      });
    }

    const project = findProjectByTitle(projects);
    if (!project) {
      // See renameDetectionMessage: the same guard runInit uses (the one
      // drift class nothing else detects, since the board is resolved by
      // title, not by its stored node ID — see ADR-0032's 2026-07-22
      // Update).
      reporter.error(
        renameDetectionMessage(projects) ??
          `Project board "${HUB_PROJECT_TITLE}" not found — run with --init to create it.`,
      );
      reporter.finish();
      return { ok: false };
    }

    const roadmap = extractRoadmap(readDocFn(ROADMAP_PATH));
    const implementation = extractImplementation(
      readDocFn(IMPLEMENTATION_PATH),
    );
    const extractionErrors = [...roadmap.errors, ...implementation.errors];
    if (extractionErrors.length > 0) {
      for (const message of extractionErrors) reporter.error(message);
      reporter.finish();
      return { ok: false };
    }

    const { items, warnings } = actionableItems(roadmap, implementation);
    for (const message of warnings) reporter.warn(message);
    const itemByKey = indexItemsByKey(items);

    const hubIssues = loadHubIssues(runGhFn, reporter);
    if (hubIssues === null) {
      reporter.finish();
      return { ok: false };
    }
    const trackedIssues = hubIssues
      .map((issue) => toTrackedIssue(issue, itemByKey))
      .filter((issue) => issue !== null);

    const existingProjectItems = loadProjectItems(
      runGhFn,
      reporter,
      project.number,
    );
    if (existingProjectItems === null) {
      reporter.finish();
      return { ok: false };
    }

    const plan = planProjectSync(trackedIssues, existingProjectItems);

    printPlan(reporter, plan);

    if (!apply) {
      reporter.succeed(
        `Dry run — pass --apply to execute. Would add ${plan.add.length}, ` +
          `update status on ${plan.setStatus.length}, update priority on ` +
          `${plan.setPriority.length}, archive ${plan.archive.length}.`,
      );
      reporter.finish({
        applied: false,
        project: { number: project.number, title: project.title },
        board: {
          add: plan.add.length,
          setStatus: plan.setStatus.length,
          setPriority: plan.setPriority.length,
          archive: plan.archive.length,
        },
      });
      return { ok: true };
    }

    applyProjectPlan({
      runGh: runGhFn,
      reporter,
      projectNumber: project.number,
      plan,
    });

    reporter.succeed(
      `Applied: added ${plan.add.length}, updated status on ${plan.setStatus.length}, ` +
        `updated priority on ${plan.setPriority.length}, archived ${plan.archive.length}.`,
    );
    reporter.finish({
      applied: true,
      project: { number: project.number, title: project.title },
      board: {
        add: plan.add.length,
        setStatus: plan.setStatus.length,
        setPriority: plan.setPriority.length,
        archive: plan.archive.length,
      },
    });
    return { ok: true };
  } catch (cause) {
    reporter.error(
      `Project sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    reporter.finish();
    return { ok: false };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, argv } = parseJsonFlag();
  const apply = argv.includes("--apply");
  const init = argv.includes("--init");
  const pruneViews = argv.includes("--prune-views");
  const reporter = createReporter(json);

  const outcome = runProjectSync({
    runGh,
    reporter,
    apply,
    init,
    pruneViews,
    readDoc,
  });
  if (!outcome.ok) process.exit(1);
}
