// Pure sync planners for the ADR-0032 visibility hub's write-back (issues,
// milestones, and the project board). No fs/child_process/process/Date
// imports here — every function is string/model in, plan-object out, so it
// is trivially unit-testable and reusable by the runner scripts
// (bin/sync-hub-issues.mjs, bin/sync-hub-projects.mjs), which supply the
// `gh` execution, auth preflight, and dry-run printing this module never does.
//
// Reuses classifyStatus/columnIndex/blobUrl from ./project-hub.mjs rather
// than duplicating tracker-table parsing semantics.
import { blobUrl, classifyStatus, columnIndex } from "./project-hub.mjs";

/**
 * The fixed label every hub-sync-managed issue carries, so a maintainer can
 * filter the tracker for "everything the hub owns."
 *
 * @example
 * ```js
 * import { HUB_LABEL } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * HUB_LABEL; // "hub-sync"
 * ```
 */
export const HUB_LABEL = "hub-sync";

/**
 * The fixed title of the GitHub Project (v2) board the hub keeps in sync.
 *
 * @example
 * ```js
 * import { HUB_PROJECT_TITLE } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * HUB_PROJECT_TITLE; // "m3l-automation hub"
 * ```
 */
export const HUB_PROJECT_TITLE = "m3l-automation hub";

/**
 * Maps every {@link Item} priority to the GitHub label string that encodes it.
 *
 * @example
 * ```js
 * import { PRIORITY_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * PRIORITY_LABELS.p1; // "priority:p1"
 * ```
 */
export const PRIORITY_LABELS = {
  p0: "priority:p0",
  p1: "priority:p1",
  p2: "priority:p2",
  governance: "priority:governance",
};

/**
 * Maps p0/p1/p2 priorities to their GitHub milestone title. Governance items
 * have no milestone — {@link buildIssuePayload} returns `null` for them.
 *
 * @example
 * ```js
 * import { MILESTONE_TITLES } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * MILESTONE_TITLES.p0; // "Priority 0"
 * ```
 */
export const MILESTONE_TITLES = {
  p0: "Priority 0",
  p1: "Priority 1",
  p2: "Priority 2",
};

const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";

const ROADMAP_ANCHORS = {
  p0: "#priority-0",
  p1: "#priority-1",
  governance: "#governance-follow-ups",
};

const IMPLEMENTATION_ANCHORS = {
  friction: "#library-friction-f-series",
  gated: "#gated-library-modules--deferred-decisions-p2",
};

// Strip markdown links (keeping the label), backticks, and emphasis markers
// from a cell, preserving case and internal spacing — used for identity
// cells (Item/Wave/ID) that feed both keys and titles.
function stripMarkdown(text) {
  const linkless = text.replace(/\[([^[\]]+)\]\([^()]+\)/g, "$1");
  return linkless.replace(/[`*_]/g, "").trim();
}

// Slugify a tracker-table identity cell into the lowercase, dash-separated
// form used inside an Item key: markdown links/backticks/emphasis are
// stripped first (keeping a link's label), then everything but [a-z0-9]+ is
// collapsed into a single "-", with leading/trailing dashes trimmed.
function slug(text) {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Build the "**<Header>:** <cell>" detail lines for every header column
// index NOT in `excludeIndices` (the columns already consumed for identity
// or status), joined with a blank line between entries.
function buildDetail(header, row, excludeIndices) {
  return header
    .map((label, index) =>
      excludeIndices.has(index) ? null : `**${label}:** ${row[index] ?? ""}`,
    )
    .filter((line) => line !== null)
    .join("\n\n");
}

// Map an F-series row's raw Priority cell ("P0"/"P1"/"P2", possibly
// markdown-wrapped) to an Item priority, falling back to "p2" for anything
// unrecognized.
function mapFrictionPriority(cell) {
  const normalized = stripMarkdown(cell).toUpperCase();
  switch (normalized) {
    case "P0":
      return "p0";
    case "P1":
      return "p1";
    case "P2":
      return "p2";
    default:
      return "p2";
  }
}

/**
 * Build the fixed HTML-comment marker embedded as the first line of every
 * hub-sync-managed issue body, identifying the {@link Item} `key` it tracks.
 *
 * @param {string} key
 * @returns {string}
 * @example
 * ```js
 * import { hubMarker } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * hubMarker("roadmap:p0:foo"); // "<!-- m3l-hub-sync:roadmap:p0:foo -->"
 * ```
 */
export function hubMarker(key) {
  return `<!-- m3l-hub-sync:${key} -->`;
}

/**
 * Recover the `key` from the first {@link hubMarker} occurrence in an issue
 * body, tolerating leading whitespace on the marker's line. Returns `null`
 * when no marker is present, or when `body` is empty/undefined — a
 * markerless issue is never a hub-sync match, by construction.
 *
 * @param {string | undefined} body
 * @returns {string | null}
 * @example
 * ```js
 * import { hubMarker, parseHubMarker } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * parseHubMarker(`${hubMarker("impl:F7")}\nrest of body\n`); // "impl:F7"
 * ```
 */
export function parseHubMarker(body) {
  if (!body) return null;
  const match = /<!-- m3l-hub-sync:(.+?) -->/.exec(body);
  return match ? match[1] : null;
}

/**
 * @typedef {{
 *   key: string,
 *   title: string,
 *   status: "done" | "pending" | "in-review" | "other",
 *   priority: "p0" | "p1" | "p2" | "governance",
 *   sourcePath: string,
 *   sourceAnchor: string,
 *   detail: string,
 * }} Item
 */

/**
 * Map the ROADMAP.md/IMPLEMENTATION.md sections extracted by
 * `extractRoadmap`/`extractImplementation` (in `./project-hub.mjs`) into the
 * flat, actionable {@link Item} list the sync planners operate on.
 *
 * Emits ROADMAP Priority 0, Priority 1, and Governance follow-ups rows, plus
 * IMPLEMENTATION's Library friction (F-series) and Gated modules (P2) rows.
 * ROADMAP Priority 2 is never emitted — the IMPLEMENTATION gated table is
 * that content's item source, to avoid duplicate issues. Done rows ARE
 * emitted (closes downstream are driven by them). Rows that produce the same
 * key are deduped: the first row's fields win, and later rows only
 * contribute additional detail lines. A `null` section (extractor found no
 * table) is skipped silently — the extractor's own `errors` array is the
 * loud-failure channel.
 *
 * @param {ReturnType<typeof import("./project-hub.mjs").extractRoadmap>} roadmap
 * @param {ReturnType<typeof import("./project-hub.mjs").extractImplementation>} implementation
 * @returns {Item[]}
 * @example
 * ```js
 * import { extractImplementation, extractRoadmap } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 * import { actionableItems } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * const items = actionableItems(
 *   extractRoadmap(roadmapMarkdown),
 *   extractImplementation(implementationMarkdown),
 * );
 * ```
 */
export function actionableItems(roadmap, implementation) {
  const items = [];
  const byKey = new Map();

  function addItem(item) {
    const existing = byKey.get(item.key);
    if (existing) {
      existing.detail = `${existing.detail}\n\n${item.detail}`;
      return;
    }
    byKey.set(item.key, item);
    items.push(item);
  }

  if (roadmap.priority0) {
    const { header, rows } = roadmap.priority0;
    const itemIndex = columnIndex(header, "Item");
    const whatIndex = columnIndex(header, "What");
    const statusIndex = columnIndex(header, "Status");
    for (const row of rows) {
      const itemCell = row[itemIndex] ?? "";
      const strippedItem = stripMarkdown(itemCell);
      addItem({
        key: `roadmap:p0:${slug(itemCell)}`,
        title: `${strippedItem} — ${row[whatIndex] ?? ""}`,
        status: classifyStatus(row[statusIndex] ?? ""),
        priority: "p0",
        sourcePath: ROADMAP_PATH,
        sourceAnchor: ROADMAP_ANCHORS.p0,
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (roadmap.priority1) {
    const { header, rows } = roadmap.priority1;
    const waveIndex = columnIndex(header, "Wave");
    const scriptsIndex = columnIndex(header, "Scripts");
    const statusIndex = columnIndex(header, "Status");
    for (const row of rows) {
      const wave = stripMarkdown(row[waveIndex] ?? "");
      const scripts = stripMarkdown(row[scriptsIndex] ?? "");
      addItem({
        key: `roadmap:${wave}:${slug(row[scriptsIndex] ?? "")}`,
        title: `${wave} — ${scripts}`,
        status: classifyStatus(row[statusIndex] ?? ""),
        priority: "p1",
        sourcePath: ROADMAP_PATH,
        sourceAnchor: ROADMAP_ANCHORS.p1,
        detail: buildDetail(
          header,
          row,
          new Set([waveIndex, scriptsIndex, statusIndex]),
        ),
      });
    }
  }

  if (roadmap.governance) {
    const { header, rows } = roadmap.governance;
    const itemIndex = columnIndex(header, "Item");
    const whatIndex = columnIndex(header, "What");
    const notesIndex = columnIndex(header, "Notes");
    for (const row of rows) {
      const itemCell = row[itemIndex] ?? "";
      const strippedItem = stripMarkdown(itemCell);
      addItem({
        key: `roadmap:gov:${slug(itemCell)}`,
        title: `${strippedItem} — ${row[whatIndex] ?? ""}`,
        status: classifyStatus(row[notesIndex] ?? ""),
        priority: "governance",
        sourcePath: ROADMAP_PATH,
        sourceAnchor: ROADMAP_ANCHORS.governance,
        detail: buildDetail(header, row, new Set([itemIndex])),
      });
    }
  }

  if (implementation.friction) {
    const { header, rows } = implementation.friction;
    const idIndex = columnIndex(header, "ID");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const titleIndex = columnIndex(header, "Title & change");
    for (const row of rows) {
      const strippedId = stripMarkdown(row[idIndex] ?? "");
      addItem({
        key: `impl:${strippedId}`,
        title: `${strippedId} — ${row[titleIndex] ?? ""}`,
        status: classifyStatus(row[statusIndex] ?? ""),
        priority: mapFrictionPriority(row[priorityIndex] ?? ""),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.friction,
        detail: buildDetail(header, row, new Set([idIndex, statusIndex])),
      });
    }
  }

  if (implementation.gated) {
    const { header, rows } = implementation.gated;
    const idIndex = columnIndex(header, "ID");
    for (const row of rows) {
      const idCell = row[idIndex] ?? "";
      addItem({
        key: `impl:${slug(idCell)}`,
        title: stripMarkdown(idCell),
        status: "pending",
        priority: "p2",
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.gated,
        detail: buildDetail(header, row, new Set([idIndex])),
      });
    }
  }

  return items;
}

/**
 * Build the desired GitHub issue payload for one {@link Item}: the body
 * opens with the {@link hubMarker} (so {@link parseHubMarker} can recover the
 * item's key from a fetched issue), then a "Derived — do not edit" banner
 * linking back to the authored source via `blobUrl`, then `item.detail`.
 *
 * @param {Item} item
 * @returns {{ title: string, body: string, labels: string[], milestoneTitle: string | null }}
 * @example
 * ```js
 * import { buildIssuePayload } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * buildIssuePayload({
 *   key: "impl:F7",
 *   title: "F7 — Opt-in tolerant handling",
 *   status: "pending",
 *   priority: "p2",
 *   sourcePath: "docs/plans/IMPLEMENTATION.md",
 *   sourceAnchor: "#library-friction-f-series",
 *   detail: "**Source / call-site:** json-etl log F7",
 * });
 * ```
 */
export function buildIssuePayload(item) {
  const banner = `**Derived — do not edit.** Authored source: [${item.sourcePath}](${blobUrl(item.sourcePath)}${item.sourceAnchor}); re-synced by \`pnpm sync:hub\`.`;
  const body = [hubMarker(item.key), "", banner, "", item.detail].join("\n");
  const milestoneTitle =
    item.priority === "governance" ? null : MILESTONE_TITLES[item.priority];

  return {
    title: item.title,
    body,
    labels: [HUB_LABEL, PRIORITY_LABELS[item.priority]],
    milestoneTitle,
  };
}

/**
 * Plan the milestones that need creating: the unique milestone titles
 * required by `items` (via {@link buildIssuePayload}) that are not already in
 * `existingTitles`, in first-needed order. Never plans a delete/close — a
 * milestone no longer required by any item is left alone.
 *
 * @param {Item[]} items
 * @param {string[]} existingTitles
 * @returns {{ create: string[] }}
 * @example
 * ```js
 * import { planMilestones } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * planMilestones(items, ["Priority 0"]); // { create: ["Priority 1", "Priority 2"] }
 * ```
 */
export function planMilestones(items, existingTitles) {
  const existing = new Set(existingTitles);
  const seen = new Set();
  const create = [];

  for (const item of items) {
    const { milestoneTitle } = buildIssuePayload(item);
    if (milestoneTitle === null) continue;
    if (existing.has(milestoneTitle) || seen.has(milestoneTitle)) continue;
    seen.add(milestoneTitle);
    create.push(milestoneTitle);
  }

  return { create };
}

// Comment text explaining a planned close, for the two distinct reasons a
// hub-sync-managed issue closes.
const CLOSE_REASON = {
  done: "Item marked done in source trackers.",
  removed: "Item removed from source trackers.",
};

/**
 * Plan the create/update/close/reopen actions that bring `existingIssues`
 * into sync with `items`. Matching is **only** by
 * `parseHubMarker(issue.body) === item.key` — never by title or label — so a
 * human-filed issue (even one labeled `hub-sync`) can never be edited or
 * closed by this planner.
 *
 * Idempotency law: calling this again over the issue state its own plan
 * produced yields empty `create`/`update`/`close`/`reopen`.
 *
 * @param {Item[]} items
 * @param {{ number: number, title: string, body: string, state: "open" | "closed", labels: string[] }[]} existingIssues
 * @returns {{
 *   create: { key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   update: { number: number, key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   close: { number: number, key: string, comment: string }[],
 *   reopen: { number: number, key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   untouched: { number: number, reason: string }[],
 * }}
 * @example
 * ```js
 * import { planIssueSync } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * const plan = planIssueSync(items, existingIssues);
 * plan.create.forEach(({ payload }) => console.log(payload.title));
 * ```
 */
export function planIssueSync(items, existingIssues) {
  const create = [];
  const update = [];
  const close = [];
  const reopen = [];
  const untouched = [];

  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const matchedKeys = new Set();

  for (const issue of existingIssues) {
    const key = parseHubMarker(issue.body);
    if (key === null) {
      untouched.push({ number: issue.number, reason: "no marker" });
      continue;
    }

    const item = itemByKey.get(key);
    if (!item) {
      if (issue.state === "open") {
        close.push({
          number: issue.number,
          key,
          comment: CLOSE_REASON.removed,
        });
      } else {
        untouched.push({ number: issue.number, reason: "in sync" });
      }
      continue;
    }

    matchedKeys.add(item.key);
    const payload = buildIssuePayload(item);
    const isDirty =
      issue.title !== payload.title || issue.body !== payload.body;

    if (issue.state === "closed") {
      if (item.status === "done") {
        untouched.push({ number: issue.number, reason: "in sync" });
      } else {
        reopen.push({ number: issue.number, key, payload });
      }
      continue;
    }

    if (item.status === "done") {
      close.push({ number: issue.number, key, comment: CLOSE_REASON.done });
    } else if (isDirty) {
      update.push({ number: issue.number, key, payload });
    } else {
      untouched.push({ number: issue.number, reason: "in sync" });
    }
  }

  for (const item of items) {
    if (matchedKeys.has(item.key) || item.status === "done") continue;
    create.push({ key: item.key, payload: buildIssuePayload(item) });
  }

  return { create, update, close, reopen, untouched };
}

const PROJECT_STATUS_OPTIONS = {
  pending: "Pending",
  "in-review": "In review",
  done: "Done",
  other: "Pending",
};

// Map an Item/tracked-issue status to its board single-select option name.
function projectStatusOption(status) {
  switch (status) {
    case "pending":
    case "in-review":
    case "done":
    case "other":
      return PROJECT_STATUS_OPTIONS[status];
    default:
      return PROJECT_STATUS_OPTIONS.other;
  }
}

/**
 * Plan the add/setStatus/archive actions that bring `existingProjectItems`
 * into sync with `trackedIssues` — the board is a view over the issues
 * hub-sync already owns, so it never adds a card for anything not in
 * `trackedIssues`, and a board item whose `issueNumber` is absent from
 * `trackedIssues` entirely (a human-added card) is always left alone.
 *
 * Idempotency law: calling this again over the board state its own plan
 * produced yields empty `add`/`setStatus`/`archive`.
 *
 * @param {{ number: number, state: "open" | "closed", status: Item["status"] }[]} trackedIssues
 * @param {{ itemId: string, issueNumber: number, status: string | null }[]} existingProjectItems
 * @returns {{
 *   add: { issueNumber: number, status: string }[],
 *   setStatus: { itemId: string, issueNumber: number, status: string }[],
 *   archive: { itemId: string, issueNumber: number }[],
 * }}
 * @example
 * ```js
 * import { planProjectSync } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * planProjectSync([{ number: 1, state: "open", status: "pending" }], []);
 * // { add: [{ issueNumber: 1, status: "Pending" }], setStatus: [], archive: [] }
 * ```
 */
export function planProjectSync(trackedIssues, existingProjectItems) {
  const add = [];
  const setStatus = [];
  const archive = [];

  const projectByIssueNumber = new Map(
    existingProjectItems.map((projectItem) => [
      projectItem.issueNumber,
      projectItem,
    ]),
  );

  for (const issue of trackedIssues) {
    const projectItem = projectByIssueNumber.get(issue.number);

    if (issue.state === "closed") {
      if (projectItem) {
        archive.push({
          itemId: projectItem.itemId,
          issueNumber: issue.number,
        });
      }
      continue;
    }

    const desiredStatus = projectStatusOption(issue.status);
    if (!projectItem) {
      add.push({ issueNumber: issue.number, status: desiredStatus });
    } else if (projectItem.status !== desiredStatus) {
      setStatus.push({
        itemId: projectItem.itemId,
        issueNumber: issue.number,
        status: desiredStatus,
      });
    }
  }

  return { add, setStatus, archive };
}
