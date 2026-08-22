#!/usr/bin/env node
// Verifies the ADR-0032 visibility hub's GitHub Project board matches what
// bin/lib/hub-views.mjs declares: its view set (both directions), each view's
// layout, filter, ordered columns and sort, the presence of the built-in
// Issue Type field, and the Status/Priority option sets.
//
// Why a gate at all. check:hub-drift compares each ISSUE against its tracker
// row; check:label-drift compares each LABEL OBJECT against LABEL_DEFS.
// Neither looks at the board, so its own surface had no gate. Two facets are
// UI-only — a view's sort is readable but not writable through any mutation,
// and the built-in Type field has no createProjectV2Field counterpart — and
// for those, prose was the only enforcement. That is exactly how the live
// board's sort came to differ from the runner's own MANUAL_VIEW_STEPS.
//
// Push-only in CI (ci.yml, mirroring "Check hub drift" and "Check label
// drift"), never on lefthook's pre-push: it needs a `gh` session with the
// `project` OAuth scope, which most contributors won't have.
//
// The Actions GITHUB_TOKEN cannot read Projects v2 at all. That is a MISSING
// CAPABILITY, not drift, so it is a loud graceful skip — print exactly what
// went unverified, exit 0. Same reasoning that keeps the Issue-Type preflight
// off the --check path: a gate that fails for a reason the contributor cannot
// fix teaches people to ignore it.
//
// Usage:
//   node bin/check-hub-views.mjs
//   pnpm check:hub-views
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HUB_PROJECT_TITLE } from "./lib/hub-sync.mjs";
import {
  DESIRED_PRIORITY_OPTIONS,
  DESIRED_STATUS_OPTIONS,
  OPTIONAL_VIEW_FIELDS,
  VIEW_DEFS,
} from "./lib/hub-views.mjs";
import { deriveViewDrift } from "./lib/hub-view-drift.mjs";
import { createReporter, parseJsonFlag } from "./lib/report.mjs";

const OWNER = "monte3l";

// The GraphQL connection windows. A result whose length REACHES its window
// means the page was silently truncated, and an undeclared view (or a field)
// past it would be invisible to a gate that asserts the set in both
// directions. Mirrors LIST_LIMIT's convention in bin/sync-hub-projects.mjs:
// reaching the window is a hard error, never a silent under-read.
const VIEW_WINDOW = 20;
const FIELD_WINDOW = 50;
const SORT_WINDOW = 10;
const PROJECT_WINDOW = 100;

/**
 * The single injected `gh` execution seam: every call in this file goes
 * through this function (or a test double shaped like it), mirroring
 * `bin/check-label-drift.mjs`'s `runGh` so nothing here shells out directly
 * in `bin/tests/**`.
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

/**
 * True when a `gh` failure is "this token may not read Projects v2" rather
 * than real drift or a real outage.
 *
 * Matched on message text because there is nothing better to match on: `gh`
 * exits 1 for every failure and the GraphQL scope refusal carries no
 * distinguishable status code. Kept deliberately narrow — a broad match would
 * turn every outage into a silent pass, which is the failure mode this gate
 * exists to prevent.
 */
export function isScopeError(message) {
  return [
    // GraphQL's own wording when the token lacks read:project.
    /not been granted the required scopes/i,
    /requires one of the following scopes/i,
    // The Actions GITHUB_TOKEN's wording.
    /resource not accessible by integration/i,
    // `gh` itself, when no auth is present at all.
    /gh auth login/i,
    /authentication token/i,
    /must be authenticated/i,
  ].some((pattern) => pattern.test(message));
}

/**
 * One view's sort pairs, guarding its connection window.
 *
 * A truncated sort is the worst of the under-read cases: deriveViewDrift would
 * emit a confident "sort is X, expected Y" finding whose only remedy is a
 * manual UI edit, sending the maintainer to "fix" a sort that is already
 * correct.
 */
function viewSort(view) {
  const nodes = view.sortByFields?.nodes ?? [];
  if (nodes.length >= SORT_WINDOW) {
    throw new Error(
      `View "${view.name}" returned ${nodes.length} sort entries, reaching the ` +
        `first:${SORT_WINDOW} window — its sort may be truncated, which would ` +
        `produce a misleading sort finding whose only remedy is a manual UI ` +
        `edit. Raise SORT_WINDOW.`,
    );
  }
  return nodes.map((entry) => ({
    field: entry?.field?.name ?? null,
    direction: entry?.direction ?? null,
  }));
}

/**
 * One view's visible column names, guarding the per-view connection window.
 *
 * Same convention as the two top-level windows: reaching it is a hard error,
 * never a silent under-read. Truncating a view's column list here would be
 * worse than a bare under-read — it would produce a confident, MISLEADING
 * column-drift finding naming columns the view actually shows.
 */
function viewColumns(view) {
  const nodes = view.fields?.nodes ?? [];
  if (nodes.length >= FIELD_WINDOW) {
    throw new Error(
      `View "${view.name}" returned ${nodes.length} visible columns, reaching ` +
        `the first:${FIELD_WINDOW} window — its column list may be truncated, ` +
        `which would produce a misleading column-drift finding. Raise ` +
        `FIELD_WINDOW.`,
    );
  }
  const names = nodes.map((field) => field?.name);
  if (names.some((name) => typeof name !== "string")) {
    throw new Error(
      `View "${view.name}" returned a visible column with no name. Dropping it ` +
        `would yield a confident but WRONG column-drift finding, so this fails ` +
        `instead — the same reason the window guards above are hard errors.`,
    );
  }
  return names;
}

/**
 * Read the board's views and fields in one GraphQL round trip.
 *
 * Fields come from GraphQL rather than `gh project field-list` because the
 * gate needs each field's `dataType` to spot the built-in ISSUE_TYPE field by
 * type instead of by name — a name match would break under localization, and
 * `field-list`'s JSON does not carry the option ORDER guarantee this gate
 * asserts on.
 *
 * @returns {{ views: import("./lib/hub-view-drift.mjs").LiveView[], fields: import("./lib/hub-view-drift.mjs").LiveField[] }}
 */
export function readBoard(runGhFn, projectId) {
  const query =
    `query { node(id: ${JSON.stringify(projectId)}) { ... on ProjectV2 { ` +
    `views(first: ${VIEW_WINDOW}) { nodes { id name layout filter ` +
    `sortByFields(first: ${SORT_WINDOW}) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } } ` +
    `fields(first: ${FIELD_WINDOW}) { nodes { ... on ProjectV2FieldCommon { name } } } } } ` +
    `fields(first: ${FIELD_WINDOW}) { nodes { ... on ProjectV2FieldCommon { name dataType } ` +
    `... on ProjectV2SingleSelectField { options { name } } } } } } }`;
  const raw = runGhFn(["api", "graphql", "-f", `query=${query}`]);
  const node = JSON.parse(raw)?.data?.node;

  // `{"data":{"node":null}}` is a real response: the board can be deleted, or
  // its id become unreadable, between the `project view` call and this query.
  // Dereferencing it blind surfaced as "Cannot read properties of null
  // (reading 'views')" -- technically a failure, but not a board-shaped
  // diagnostic the reader can act on.
  if (!node) {
    throw new Error(
      `The board (id ${projectId}) returned no data — it may have been deleted, ` +
        `or this token may not be able to read it. Re-run to re-resolve the ` +
        `board by title.`,
    );
  }

  const viewNodes = node.views?.nodes ?? [];
  const fieldNodes = node.fields?.nodes ?? [];
  if (viewNodes.length >= VIEW_WINDOW) {
    throw new Error(
      `The board returned ${viewNodes.length} views, reaching the ` +
        `first:${VIEW_WINDOW} window — the page may be truncated, so an ` +
        `undeclared view past it would go unreported. Raise VIEW_WINDOW.`,
    );
  }
  if (fieldNodes.length >= FIELD_WINDOW) {
    throw new Error(
      `The board returned ${fieldNodes.length} fields, reaching the ` +
        `first:${FIELD_WINDOW} window — the page may be truncated, so a ` +
        `missing field would go unreported. Raise FIELD_WINDOW.`,
    );
  }

  const views = viewNodes.map((view) => ({
    id: view.id,
    name: view.name,
    layout: view.layout,
    filter: view.filter,
    sort: viewSort(view),
    columns: viewColumns(view),
  }));

  const fields = fieldNodes.map((field) => ({
    name: field.name,
    dataType: field.dataType,
    options: field.options ?? [],
  }));

  return { views, fields };
}

/**
 * Resolve the hub board's node id from its title, so the gate never hardcodes
 * a project number — the same title-based resolution
 * `bin/sync-hub-projects.mjs` uses, and the same reason: a board is renamed
 * far more often than it is recreated.
 *
 * @returns {{ id: string | null, unverifiable: boolean }} the node id; `id` is
 *   `null` when no board carries the title, and `unverifiable` is true when the
 *   read could not prove the token sees projects at all (an empty list), which
 *   the caller must treat as a skip rather than a failure
 */
export function resolveBoardId(runGhFn) {
  const listed = JSON.parse(
    runGhFn([
      "project",
      "list",
      "--owner",
      OWNER,
      "--format",
      "json",
      "--limit",
      String(PROJECT_WINDOW),
    ]),
  );
  const projects = Array.isArray(listed) ? listed : (listed.projects ?? []);
  if (projects.length === 0) {
    // Not "the board is missing" — this cannot tell that from "the token sees
    // no projects". `gh` does not always THROW on an unauthorized Projects v2
    // read; a filtered empty list is a documented shape for the Actions
    // GITHUB_TOKEN. Failing here would break the graceful-skip contract that
    // makes this gate safe to wire push-only.
    return { id: null, unverifiable: true };
  }
  if (projects.length >= PROJECT_WINDOW) {
    throw new Error(
      `\`gh project list\` returned ${projects.length} projects, reaching the ` +
        `--limit ${PROJECT_WINDOW} window — the board may be past it and would ` +
        `be misreported as missing. Raise PROJECT_WINDOW.`,
    );
  }
  const match = projects.find((project) => project.title === HUB_PROJECT_TITLE);
  if (!match) return { id: null, unverifiable: false };

  const viewed = JSON.parse(
    runGhFn([
      "project",
      "view",
      String(match.number),
      "--owner",
      OWNER,
      "--format",
      "json",
    ]),
  );
  // `?? null`, not the bare `.id`: the caller tests `=== null`, so an absent id
  // would otherwise pass as `undefined` and JSON.stringify would interpolate
  // the literal token `undefined` into the query — surfacing as a raw GraphQL
  // parse error instead of the board-shaped diagnostic below.
  return { id: viewed?.id ?? null, unverifiable: false };
}

/**
 * Run the gate against an injected `gh` seam. Returns the outcome rather than
 * calling `process.exit`, so tests can assert every branch — including the
 * scope-error skip, which must be indistinguishable from success to CI but
 * clearly distinguishable to a reader.
 *
 * @param {{ runGh: typeof runGh, reporter: ReturnType<typeof createReporter> }} deps
 * @returns {{ ok: boolean, skipped: boolean, findings: string[] }}
 */
export function runHubViewsCheck({ runGh: runGhFn, reporter }) {
  try {
    const { id: projectId, unverifiable } = resolveBoardId(runGhFn);
    if (unverifiable) {
      return reportSkip(
        reporter,
        `\`gh project list\` returned no projects at all, so this session may ` +
          `not be able to see GitHub Projects v2 — which is indistinguishable ` +
          `from the board being absent. Treated as unverified rather than as ` +
          `drift.`,
      );
    }
    if (projectId === null) {
      reporter.error(
        `No project board titled "${HUB_PROJECT_TITLE}" under owner ` +
          `${OWNER} — run \`pnpm sync:hub-projects -- --init --apply\` to ` +
          `create it, or check whether it was renamed (this gate resolves the ` +
          `board by title, not by stored id).`,
      );
      reporter.finish({ findings: [], skipped: false });
      return { ok: false, skipped: false, findings: [] };
    }

    const { views, fields } = readBoard(runGhFn, projectId);

    const findings = deriveViewDrift({
      viewDefs: VIEW_DEFS,
      liveViews: views,
      liveFields: fields,
      optionalFields: OPTIONAL_VIEW_FIELDS,
      desiredStatusOptions: DESIRED_STATUS_OPTIONS,
      desiredPriorityOptions: DESIRED_PRIORITY_OPTIONS,
    });

    for (const message of findings) reporter.error(message);

    if (findings.length > 0) {
      reporter.finish({ findings, skipped: false });
      return { ok: false, skipped: false, findings };
    }

    reporter.succeed(
      `Board "${HUB_PROJECT_TITLE}" matches its declaration: ` +
        `${VIEW_DEFS.map((def) => `"${def.name}" (${def.fields.length} column(s))`).join(", ")}, ` +
        `plus the Status/Priority option sets (ADR-0073 board surface).`,
    );
    reporter.finish({ findings, skipped: false });
    return { ok: true, skipped: false, findings };
  } catch (cause) {
    const message = ghErrorMessage(cause);

    if (isScopeError(message)) {
      return reportSkip(
        reporter,
        `this \`gh\` session cannot read GitHub Projects v2 (${message}). The ` +
          `Actions GITHUB_TOKEN never can, so this is expected in CI on a fork ` +
          `or without the \`project\` scope.`,
      );
    }

    // Keep the stack for an UNEXPECTED failure: `message` alone is enough for a
    // `gh` error (ghErrorMessage prefers stderr), but a TypeError from an
    // unforeseen payload shape is only debuggable with its stack.
    const stack = cause instanceof Error ? cause.stack : undefined;
    reporter.error(
      stack && !stack.startsWith(`Error: ${message}`)
        ? `Board check failed: ${message}\n${stack}`
        : `Board check failed: ${message}`,
    );
    reporter.finish({ findings: [], skipped: false });
    return { ok: false, skipped: false, findings: [] };
  }
}

/**
 * The one graceful-skip exit: loud, itemised, and `ok: true` so CI stays green
 * for a missing capability. A reader must be able to tell "not checked" from
 * "checked and clean" without opening the source, which is why it enumerates
 * every facet rather than printing one line.
 */
function reportSkip(reporter, why) {
  reporter.warn(`Skipping the board check: ${why}`);
  for (const unverified of [
    `the view set (declared: ${VIEW_DEFS.map((def) => def.name).join(", ")})`,
    "each view's layout and filter",
    "each view's ordered visible columns",
    "each view's sort order (UI-only; no mutation can repair it)",
    "the built-in ISSUE_TYPE field's presence",
    "the Status and Priority option sets and their order",
  ]) {
    reporter.warn(`NOT verified: ${unverified}.`);
  }
  reporter.warn(
    "Run `pnpm check:hub-views` locally with a `gh` session carrying the " +
      "`project` scope to verify these.",
  );
  reporter.succeed("Board check skipped — see the warnings above.");
  reporter.finish({ findings: [], skipped: true });
  return { ok: true, skipped: true, findings: [] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);
  const outcome = runHubViewsCheck({ runGh, reporter });
  if (!outcome.ok) process.exit(1);
}
