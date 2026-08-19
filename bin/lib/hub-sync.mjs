// Pure sync planners for the ADR-0032 visibility hub's write-back (issues,
// milestones, and the project board). No fs/child_process/process/Date
// imports here — every function is string/model in, plan-object out, so it
// is trivially unit-testable and reusable by the runner scripts
// (bin/sync-hub-issues.mjs, bin/sync-hub-projects.mjs), which supply the
// `gh` execution, auth preflight, and dry-run printing this module never does.
//
// Reuses classifyStatusCell/classifyPriorityCell/columnIndex/blobUrl from
// ./project-hub.mjs rather than duplicating tracker-table parsing semantics.
import {
  blobUrl,
  classifyPriorityCell,
  classifyStatusCell,
  columnIndex,
} from "./project-hub.mjs";

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
 * Maps every non-governance {@link Item} priority to the GitHub label string
 * that encodes it — the numbered-semantic vocabulary adopted by ADR-0051
 * (superseding the bare `p0`/`p1`/`p2` names ADR-0032 originally picked). The
 * leading digit is deliberate: GitHub sorts labels alphabetically, and
 * without it a semantic name (`now`/`next`/`later`) would not sort in tier
 * order in the label sidebar. `governance` has no entry here — see
 * {@link TYPE_LABELS}.
 *
 * @example
 * ```js
 * import { PRIORITY_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * PRIORITY_LABELS.p1; // "priority:1-next"
 * ```
 */
export const PRIORITY_LABELS = {
  p0: "priority:0-now",
  p1: "priority:1-next",
  p2: "priority:2-later",
};

/**
 * GitHub label strings for {@link Item} facets that are a *category*, not a
 * priority tier. `governance` moved here under ADR-0051: it was previously
 * `priority:governance`, but {@link classifyPriorityCell} has never had a
 * governance branch (a governance row's Priority cell is always the
 * untiered dash placeholder) — filing it under the `priority:` prefix
 * claimed it was a fourth tier when it never behaved like one. A governance
 * item now carries {@link TYPE_LABELS}.governance instead of any
 * {@link PRIORITY_LABELS} entry; it keeps its own {@link MILESTONE_TITLES}
 * entry unchanged.
 *
 * @example
 * ```js
 * import { TYPE_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * TYPE_LABELS.governance; // "type:governance"
 * ```
 */
export const TYPE_LABELS = {
  governance: "type:governance",
};

/**
 * Maps p0/p1/p2/governance priorities to their GitHub milestone title, plus
 * the `major` bucket {@link MAJOR_BUMP_ITEM_KEYS} routes specific items to
 * regardless of their priority. Every {@link Item} now resolves to a real
 * milestone — governance items previously had none
 * ({@link buildIssuePayload} returned `null`), which left issue #194 the
 * only milestone-less issue while the "Priority 0" milestone held zero; see
 * the dated ADR-0032 Update for the rationale. Titles renamed under ADR-0051
 * to match the {@link PRIORITY_LABELS} vocabulary; `governance` and `major`
 * are untouched by that rename — governance was never a tier, and `major` was
 * always its own semantic bucket.
 *
 * @example
 * ```js
 * import { MILESTONE_TITLES } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * MILESTONE_TITLES.p0; // "Now — unblock first"
 * ```
 */
export const MILESTONE_TITLES = {
  p0: "Now — unblock first",
  p1: "Next — consumer fleet",
  p2: "Later — gated/deferred",
  governance: "Governance",
  major: "2.0 / breaking",
};

const ROADMAP_PATH = "docs/ROADMAP.md";
const IMPLEMENTATION_PATH = "docs/plans/IMPLEMENTATION.md";

// Deep-link anchors into docs/ROADMAP.md's own `## Priority 0` / `## Priority 1`
// / `## Governance follow-ups (...)` headings — unrenamed by ADR-0051 (only the
// GitHub-side label/milestone/tracker-cell vocabulary moved, not the ROADMAP
// headings themselves). Corrected here to GitHub's actual anchor slug, which
// includes the full heading text after the em dash/parenthetical — the prior
// `#priority-0`/`#priority-1` values never matched a real anchor and every
// synced deep-link for those two sections landed at the top of the file.
export const ROADMAP_ANCHORS = {
  p0: "#priority-0--library-hardening-do-before-more-scripts",
  p1: "#priority-1--consumer-fleet",
  governance: "#governance-follow-ups-adr-0028--adr-0029",
};

const IMPLEMENTATION_ANCHORS = {
  friction: "#library-friction-f-series",
  adr0035Rollout: "#adr-0035-rollout--failure-reporting--diagnostics",
  capabilityDeepeningWave: "#capability-deepening-wave--adr-003700380039",
  postComparisonHardeningWave:
    "#post-comparison-hardening-wave--adr-0040004100420043",
  m3lCliBuildOut: "#m3l-cli-build-out--adr-0042-activation-issue-333",
  codifiedProcedureWave:
    "#codified-procedure-engine-wave--adr-0046004700480049",
  gated: "#gated-library-modules--deferred-decisions-p2",
};

// The key namespace each docs/plans/IMPLEMENTATION.md section's items live
// in, keyed identically to IMPLEMENTATION_ANCHORS above so a new section
// cannot gain an anchor without also gaining a namespace.
//
// An item label is only unique WITHIN its own table — the ADR-0035 rollout
// and codified-procedure wave tables both restart at A1, so A1/A2/A3/A5/A6
// each denote two entirely different items. A flat `impl:<label>` key made
// those five pairs collide, and `addItem` merges a duplicate key silently,
// so one of each pair would have been dropped from the planner while its
// GitHub issue got closed as "removed from source trackers". (They did not
// actually collide in practice, but only by accident: the rollout table was
// the one table not passing its label through `slug()`, so its keys stayed
// upper-case and the case-sensitive marker match kept them apart. Making
// key derivation consistent — an obvious cleanup — would have triggered all
// five at once.) docs/ROADMAP.md's keys were already namespaced this way
// (`roadmap:p0:` / `roadmap:<wave>:` / `roadmap:gov:`); this brings
// IMPLEMENTATION.md's in line. See issue #480 / F13 and ADR-0032's dated
// Update.
const IMPLEMENTATION_NAMESPACES = {
  friction: "friction",
  adr0035Rollout: "adr0035",
  capabilityDeepeningWave: "capability",
  postComparisonHardeningWave: "hardening",
  m3lCliBuildOut: "cli",
  codifiedProcedureWave: "procedure",
  gated: "gated",
};

/**
 * {@link Item} keys routed to the `MILESTONE_TITLES.major` ("2.0 / breaking")
 * milestone regardless of their table-derived priority — work explicitly
 * recorded as needing a major-version bump before it can be built (F3's own
 * text: "Re-file against a real 2.0 milestone if one is ever opened"; the
 * `@deprecated` `AWSClientProvider` getter-removal row is the same class).
 * Keys are computed via {@link slug} and each section's IMPLEMENTATION_NAMESPACES
 * entry, not hand-typed, so this can never independently drift from the real
 * key-generation logic in {@link actionableItems} — only from the tracker
 * row's own identity-cell wording, which is the same dependency every
 * {@link hubMarker} key already has.
 *
 * @example
 * ```js
 * import { MAJOR_BUMP_ITEM_KEYS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * MAJOR_BUMP_ITEM_KEYS.has("impl:friction:f3"); // true
 * ```
 */
export const MAJOR_BUMP_ITEM_KEYS = new Set([
  `impl:${IMPLEMENTATION_NAMESPACES.friction}:${slug("F3")}`,
  `impl:${IMPLEMENTATION_NAMESPACES.gated}:${slug(
    "Removal of the 4 `@deprecated` `AWSClientProvider` convenience getters (`dynamoDBDocument`/`sqsOperations`/`eventBridgeOperations`/`requestSigner`)",
  )}`,
]);

/**
 * Maps a Deferred/Blocked {@link Item} status to the GitHub label that makes
 * it visually distinguishable from a plain "not yet started" To Do issue.
 * Without this, Deferred, Blocked, and To Do were identical on GitHub — same
 * open state, same priority label — and the Status column itself is
 * excluded from the derived issue body, so a reader had no way to tell a
 * blocked item from an actionable one. `done`/`rejected` issues are closed
 * by {@link planIssueSync} instead of labeled; `todo`/`in-progress` carry no
 * status label — they already are the two "actionable now" states.
 *
 * @example
 * ```js
 * import { STATUS_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * STATUS_LABELS.blocked; // "status:blocked"
 * ```
 */
export const STATUS_LABELS = {
  deferred: "status:deferred",
  blocked: "status:blocked",
};

// Strip markdown links (keeping the label), backticks, and emphasis markers
// from a cell, preserving case and internal spacing — used for identity
// cells (Item/Wave/ID) that feed both keys and titles.
function stripMarkdown(text) {
  const linkless = text.replace(/\[([^[\]]+)\]\([^()]+\)/g, "$1");
  return linkless.replace(/[`*_]/g, "").trim();
}

/**
 * Slugify a tracker-table identity cell into the lowercase, dash-separated
 * form used inside an Item key: markdown links/backticks/emphasis are
 * stripped first (keeping a link's label), then everything but `[a-z0-9]+`
 * is collapsed into a single "-", with leading/trailing dashes trimmed.
 * Exported so a caller can derive a `gated`-table item's exact key from its
 * literal ID-cell text (see {@link MAJOR_BUMP_ITEM_KEYS}) without
 * hand-computing — and risking drifting from — the same transform.
 *
 * @param {string} text
 * @returns {string}
 * @example
 * ```js
 * import { slug } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * slug("`aws/rds-data` Aurora PostgreSQL"); // "aws-rds-data-aurora-postgresql"
 * ```
 */
export function slug(text) {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Strip markdown from a GitHub issue *title* specifically: links (keeping
// the label), backticks, and paired **bold**/__bold__ emphasis. Deliberately
// narrower than stripMarkdown above — that helper also deletes bare `*`/`_`
// characters, which would mangle identifiers that commonly appear in a
// tracker title (e.g. `M3L_EXIT_CODES`, `SENSITIVE_KEY_NAMES`).
function stripTitleMarkdown(text) {
  const linkless = text.replace(/\[([^[\]]+)\]\([^()]+\)/g, "$1");
  const unbolded = linkless
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1");
  return unbolded.replace(/`/g, "").trim();
}

// GitHub's own issue-title cap is 256 characters; this stays well under it
// so a title reads as a label, not the row's full "Title & change" cell.
const MAX_TITLE_LENGTH = 120;

// Truncate a stripped title to MAX_TITLE_LENGTH at the last word boundary at
// or before the limit (never mid-word), trimming trailing punctuation before
// appending an ellipsis. A no-op when the title already fits. Deterministic
// — required for planIssueSync's idempotency law (re-running over synced
// state must plan zero changes).
function truncateTitle(text) {
  if (text.length <= MAX_TITLE_LENGTH) return text;
  const sliced = text.slice(0, MAX_TITLE_LENGTH);
  const lastSpaceIndex = sliced.lastIndexOf(" ");
  const boundary =
    lastSpaceIndex > 0 ? sliced.slice(0, lastSpaceIndex) : sliced;
  return `${boundary.replace(/[\s.,;:!?—–-]+$/, "")}…`;
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
  // Anchored to occupy its own line (only leading/trailing whitespace
  // allowed) so a human issue that merely QUOTES the marker text mid-line
  // or mid-paragraph is never mistaken for a hub-sync-owned issue.
  const match = /^\s*<!-- m3l-hub-sync:(.+?) -->\s*$/m.exec(body);
  return match ? match[1] : null;
}

/**
 * @typedef {{
 *   key: string,
 *   title: string,
 *   status: "done" | "todo" | "in-progress" | "deferred" | "blocked" | "rejected",
 *   priority: "p0" | "p1" | "p2" | "governance",
 *   sourcePath: string,
 *   sourceAnchor: string,
 *   detail: string,
 *   legacyKeys?: string[],
 * }} Item
 *
 * `legacyKeys` lists every key this item used to be filed under, so an issue
 * whose marker still carries an older key is matched to it instead of being
 * read as an item that vanished from the trackers (which
 * {@link planIssueSync} closes as "removed from source trackers"). Populated
 * when `docs/plans/IMPLEMENTATION.md`'s keys were namespaced by section
 * (issue #480 / F13). Resolution goes through {@link indexItemsByKey}, and
 * matching on a legacy key is what makes an issue dirty, so the next
 * `--apply` rewrites its marker to the current key and the alias goes inert.
 */

/**
 * Map the ROADMAP.md/IMPLEMENTATION.md sections extracted by
 * `extractRoadmap`/`extractImplementation` (in `./project-hub.mjs`) into the
 * flat, actionable {@link Item} list the sync planners operate on.
 *
 * Emits ROADMAP Priority 0, Priority 1, and Governance follow-ups rows, plus
 * IMPLEMENTATION's Library friction (F-series), ADR-0035 rollout,
 * capability-deepening wave, post-comparison hardening wave, and Gated
 * modules (P2) rows. ROADMAP Priority 2 is never emitted — the IMPLEMENTATION
 * gated table is that content's item source, to avoid duplicate issues.
 * ROADMAP's own nested "ADR-0035 rollout" subsection (under Priority 0), and
 * its two nested wave subsections under Priority 0, are skipped for the same
 * reason: each is a coarse subset of the fuller IMPLEMENTATION table that is
 * this content's item source. Done rows ARE
 * emitted (closes downstream are driven by them). Rows that produce the same
 * key are deduped: the first row's fields win, and later rows only
 * contribute additional detail lines. A `null` section (extractor found no
 * table) is skipped silently — the extractor's own `errors` array is the
 * loud-failure channel.
 *
 * @param {ReturnType<typeof import("./project-hub.mjs").extractRoadmap>} roadmap
 * @param {ReturnType<typeof import("./project-hub.mjs").extractImplementation>} implementation
 * @returns {{ items: Item[], warnings: string[], duplicateKeys: { key: string, first: string, second: string }[] }} `warnings` reports a
 *   friction/wave-table row whose Priority cell was off-vocabulary (see
 *   `classifyPriorityCell` — the untiered dash placeholder counts as
 *   recognized) and was defaulted to p2, a row whose Status cell was
 *   off-vocabulary, and two rows deriving the same {@link Item} key — all
 *   loud rather than silent, since each one silently mis-files real work.
 *   `pnpm check:tracker-status` and `pnpm check:hub-keys` are the hard
 *   gates behind these warnings; a warning alone is the channel that let
 *   issue #204 sit wrong for weeks (ADR-0032's 2026-08-15 Update).
 *   `duplicateKeys` carries the same collisions structurally
 *   (`{ key, first, second }`, naming both colliding rows' titles) so
 *   `check:hub-keys` can gate on them without parsing warning prose.
 * @example
 * ```js
 * import { extractImplementation, extractRoadmap } from "@m3l-automation/workspace/bin/lib/project-hub.mjs";
 * import { actionableItems } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * const { items, warnings } = actionableItems(
 *   extractRoadmap(roadmapMarkdown),
 *   extractImplementation(implementationMarkdown),
 * );
 * ```
 */
export function actionableItems(roadmap, implementation) {
  const items = [];
  const warnings = [];
  const duplicateKeys = [];
  const byKey = new Map();

  // First row with a given key wins every field; a later row with the same
  // key only contributes extra detail lines. That merge is deliberate (two
  // tracker rows genuinely describing one item), but it used to be entirely
  // silent — so a key COLLISION (two unrelated rows that happen to derive
  // the same key) was indistinguishable from it, and the loser simply
  // stopped being planned while its GitHub issue got closed as removed.
  // Namespacing the keys by section makes a collision far less likely; this
  // warning is what makes the remaining case visible, and
  // `pnpm check:hub-keys` is the hard gate behind it.
  function addItem(item) {
    const existing = byKey.get(item.key);
    if (existing) {
      duplicateKeys.push({
        key: item.key,
        first: existing.title,
        second: item.title,
      });
      warnings.push(
        `Duplicate item key "${item.key}" — "${existing.title}" and ` +
          `"${item.title}" derive the same key; the first row's fields win and ` +
          `the second only contributes detail lines. Give the two rows ` +
          `distinct labels, or namespace their sections apart.`,
      );
      existing.detail = `${existing.detail}\n\n${item.detail}`;
      return;
    }
    byKey.set(item.key, item);
    items.push(item);
  }

  // Resolve a friction/wave-table row's Priority cell, appending a warning
  // when it wasn't recognized (see classifyPriorityCell — the dash
  // placeholder IS recognized, so only a genuine off-vocabulary cell warns).
  function resolvePriority(cell, key) {
    const { priority, recognized } = classifyPriorityCell(cell ?? "");
    if (!recognized) {
      warnings.push(
        `Implementation: item "${key}" has an unrecognized Priority cell ("${cell ?? ""}") — defaulted to p2.`,
      );
    }
    return priority;
  }

  // Resolve any tracker row's Status cell, appending a warning when it
  // wasn't recognized (see classifyStatusCell). `label` names the tracker
  // section in the warning ("Roadmap" or "Implementation") the way
  // resolvePriority hardcodes "Implementation" for its friction/wave-only
  // callers.
  function resolveStatus(cell, key, label) {
    const { kind, recognized } = classifyStatusCell(cell ?? "");
    if (!recognized) {
      warnings.push(
        `${label}: item "${key}" has an unrecognized Status cell ("${cell ?? ""}") — treated as To Do.`,
      );
    }
    return kind;
  }

  if (roadmap.priority0) {
    const { header, rows } = roadmap.priority0;
    const itemIndex = columnIndex(header, "Item");
    const whatIndex = columnIndex(header, "What");
    const statusIndex = columnIndex(header, "Status");
    for (const row of rows) {
      const itemCell = row[itemIndex] ?? "";
      const strippedItem = stripMarkdown(itemCell);
      const key = `roadmap:p0:${slug(itemCell)}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[whatIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Roadmap"),
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
      const key = `roadmap:${wave}:${slug(row[scriptsIndex] ?? "")}`;
      addItem({
        key,
        title: `${wave} — ${scripts}`,
        status: resolveStatus(row[statusIndex], key, "Roadmap"),
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
    const statusIndex = columnIndex(header, "Status");
    for (const row of rows) {
      const itemCell = row[itemIndex] ?? "";
      const strippedItem = stripMarkdown(itemCell);
      const key = `roadmap:gov:${slug(itemCell)}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[whatIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Roadmap"),
        priority: "governance",
        sourcePath: ROADMAP_PATH,
        sourceAnchor: ROADMAP_ANCHORS.governance,
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
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
      const key = `impl:${IMPLEMENTATION_NAMESPACES.friction}:${slug(strippedId)}`;
      addItem({
        key,
        title: `${strippedId} — ${row[titleIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.friction,
        legacyKeys: [`impl:${strippedId}`],
        detail: buildDetail(header, row, new Set([idIndex, statusIndex])),
      });
    }
  }

  if (implementation.adr0035Rollout) {
    const { header, rows } = implementation.adr0035Rollout;
    const phaseIndex = columnIndex(header, "Phase");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedPhase = stripMarkdown(row[phaseIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.adr0035Rollout}:${slug(strippedPhase)}`;
      addItem({
        key,
        title: `${strippedPhase} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.adr0035Rollout,
        legacyKeys: [`impl:${strippedPhase}`],
        detail: buildDetail(header, row, new Set([phaseIndex, statusIndex])),
      });
    }
  }

  if (implementation.capabilityDeepeningWave) {
    const { header, rows } = implementation.capabilityDeepeningWave;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.capabilityDeepeningWave}:${slug(row[itemIndex] ?? "")}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.capabilityDeepeningWave,
        legacyKeys: [`impl:${slug(row[itemIndex] ?? "")}`],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.postComparisonHardeningWave) {
    const { header, rows } = implementation.postComparisonHardeningWave;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.postComparisonHardeningWave}:${slug(row[itemIndex] ?? "")}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.postComparisonHardeningWave,
        legacyKeys: [`impl:${slug(row[itemIndex] ?? "")}`],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.m3lCliBuildOut) {
    const { header, rows } = implementation.m3lCliBuildOut;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.m3lCliBuildOut}:${slug(row[itemIndex] ?? "")}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.m3lCliBuildOut,
        legacyKeys: [`impl:${slug(row[itemIndex] ?? "")}`],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.codifiedProcedureWave) {
    const { header, rows } = implementation.codifiedProcedureWave;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.codifiedProcedureWave}:${slug(row[itemIndex] ?? "")}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.codifiedProcedureWave,
        legacyKeys: [`impl:${slug(row[itemIndex] ?? "")}`],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.gated) {
    const { header, rows } = implementation.gated;
    const idIndex = columnIndex(header, "ID");
    const statusIndex = columnIndex(header, "Status");
    for (const row of rows) {
      const idCell = row[idIndex] ?? "";
      const key = `impl:${IMPLEMENTATION_NAMESPACES.gated}:${slug(idCell)}`;
      addItem({
        key,
        title: stripMarkdown(idCell),
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: "p2",
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.gated,
        legacyKeys: [`impl:${slug(idCell)}`],
        detail: buildDetail(header, row, new Set([idIndex, statusIndex])),
      });
    }
  }

  return { items, warnings, duplicateKeys };
}

/**
 * Build the desired GitHub issue payload for one {@link Item}: the body
 * opens with the {@link hubMarker} (so {@link parseHubMarker} can recover the
 * item's key from a fetched issue), then a "Derived — do not edit" banner
 * linking back to the authored source via `blobUrl`, then `item.detail`. The
 * title is normalized via {@link stripTitleMarkdown} then capped at
 * `MAX_TITLE_LENGTH` — a tracker row's "Title & change" cell can run to
 * several sentences, and GitHub issue titles are meant to be scanned as
 * labels, not read as prose; the untruncated detail always survives in the
 * body. `labels` always carries {@link HUB_LABEL} plus either the item's
 * {@link PRIORITY_LABELS} entry (p0/p1/p2) or {@link TYPE_LABELS}.governance
 * (governance is a category, not a tier, so it never carries both), plus a
 * {@link STATUS_LABELS} entry when the item is Deferred/Blocked. The
 * milestone is {@link MAJOR_BUMP_ITEM_KEYS}'s `major` bucket when the item's
 * key is in that set, else the priority's {@link MILESTONE_TITLES} entry —
 * every item now resolves to a real milestone, including governance ones.
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
 *   status: "deferred",
 *   priority: "p2",
 *   sourcePath: "docs/plans/IMPLEMENTATION.md",
 *   sourceAnchor: "#library-friction-f-series",
 *   detail: "**Source / call-site:** json-etl log F7",
 * });
 * ```
 */
// The priority/category label for an item — governance is a category
// (TYPE_LABELS.governance), every other priority is a tier (PRIORITY_LABELS
// entry). Split out of buildIssuePayload so the "governance never gets a
// priority:* label" rule lives in exactly one place.
function facetLabel(priority) {
  return priority === "governance"
    ? TYPE_LABELS.governance
    : PRIORITY_LABELS[priority];
}

export function buildIssuePayload(item) {
  const banner = `**Derived — do not edit.** Authored source: [${item.sourcePath}](${blobUrl(item.sourcePath)}${item.sourceAnchor}); re-synced by \`pnpm sync:hub\`.`;
  const body = [hubMarker(item.key), "", banner, "", item.detail].join("\n");
  const milestoneTitle = MAJOR_BUMP_ITEM_KEYS.has(item.key)
    ? MILESTONE_TITLES.major
    : MILESTONE_TITLES[item.priority];
  const title = truncateTitle(stripTitleMarkdown(item.title));
  const statusLabel = STATUS_LABELS[item.status];

  return {
    title,
    body,
    labels: [
      HUB_LABEL,
      facetLabel(item.priority),
      ...(statusLabel ? [statusLabel] : []),
    ],
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
 * planMilestones(items, ["Now — unblock first"]); // { create: ["Next — consumer fleet", "Later — gated/deferred"] }
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

// Comment text explaining a planned close, for the three distinct reasons a
// hub-sync-managed issue closes.
const CLOSE_REASON = {
  done: "Item marked done in source trackers.",
  rejected: "Item marked rejected in source trackers.",
  removed: "Item removed from source trackers.",
};

// GitHub's `gh issue close --reason` value for each of the same three
// closes. "done" is genuinely completed work; "rejected" and "removed" are
// both a decision that the item will not be built, so both close as
// "not planned" — leaving them at the `gh` CLI default ("completed") would
// misrepresent a deliberate rejection as delivered work.
const CLOSE_STATE_REASON = {
  done: "completed",
  rejected: "not planned",
  removed: "not planned",
};

// An Item whose status is "done" or "rejected" is resolved: it should never
// have an open issue, and never gets a new one created — the "done" half was
// always true; "rejected" (explicitly decided against, not merely deferred)
// closes the same way.
function isResolved(status) {
  return status === "done" || status === "rejected";
}

// The label families planIssueSync's dirty-check tracks for drift — HUB_LABEL,
// priority:*, type:* (governance), status:*. Anything else on an issue (a
// human-added label) is outside hub-sync's authority and never inspected here.
function isManagedLabel(label) {
  return (
    label === HUB_LABEL ||
    label.startsWith("priority:") ||
    label.startsWith("type:") ||
    label.startsWith("status:")
  );
}

// Whether `currentLabels`' managed subset (see isManagedLabel) differs from
// `payload.labels` — order-independent set comparison. Without this,
// planIssueSync's dirty-check only ever compared title/body, so an item
// whose STATUS_LABELS entry changed (or was newly added) with no title/body
// change would never reach editIssue and the label would silently never
// apply. Found adding STATUS_LABELS: issue #207 (already open, Blocked,
// unchanged title/body) would otherwise never have received
// `status:blocked`.
function managedLabelsDiffer(currentLabels, payload) {
  const current = new Set(currentLabels.filter(isManagedLabel));
  const desired = new Set(payload.labels);
  if (current.size !== desired.size) return true;
  for (const label of desired) {
    if (!current.has(label)) return true;
  }
  return false;
}

/**
 * Index `items` by every key an issue marker might legitimately carry: each
 * item's current `key`, plus each of its {@link Item} `legacyKeys`. Shared
 * by {@link planIssueSync}, {@link planBackfill}, and
 * `bin/sync-hub-projects.mjs` so the three marker consumers cannot resolve a
 * marker differently from one another.
 *
 * Precedence is deterministic and one-directional: a **current** key always
 * wins, and a legacy key never overwrites an existing entry. So an alias that
 * happens to collide with some other item's real key is inert rather than
 * hijacking it. That case is not merely tolerated here — it is a hard failure
 * of `pnpm check:hub-keys` (`bin/check-hub-keys.mjs`), which is where key
 * collisions are meant to be caught, before the planner ever runs.
 *
 * @param {Item[]} items
 * @returns {Map<string, Item>}
 * @example
 * ```js
 * import { indexItemsByKey } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * const byKey = indexItemsByKey(items);
 * const item = byKey.get(parseHubMarker(issue.body));
 * const viaLegacy = item !== undefined && item.key !== parseHubMarker(issue.body);
 * ```
 */
export function indexItemsByKey(items) {
  const byKey = new Map();
  for (const item of items) byKey.set(item.key, item);
  for (const item of items) {
    for (const legacy of item.legacyKeys ?? []) {
      if (!byKey.has(legacy)) byKey.set(legacy, item);
    }
  }
  return byKey;
}

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
 * Dirty (triggers `update`) on a title/body change **or** a managed-label
 * drift (see {@link managedLabelsDiffer}) — the latter so a status-only
 * change (e.g. To Do → Deferred, same title/body) still reaches `editIssue`
 * and gets its {@link STATUS_LABELS} entry applied, not just its milestone.
 *
 * @param {Item[]} items
 * @param {{ number: number, title: string, body: string, state: "open" | "closed", labels: string[] }[]} existingIssues
 * @returns {{
 *   create: { key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   update: { number: number, key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   close: { number: number, key: string, comment: string, reason: "completed" | "not planned" }[],
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

  const itemByKey = indexItemsByKey(items);
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
          reason: CLOSE_STATE_REASON.removed,
        });
      } else {
        untouched.push({ number: issue.number, reason: "in sync" });
      }
      continue;
    }

    matchedKeys.add(item.key);
    // The issue's marker is an older key this item used to be filed under
    // (see Item.legacyKeys). Its body therefore still opens with the stale
    // marker, so it needs rewriting to the current one.
    const viaLegacy = key !== item.key;
    const payload = buildIssuePayload(item);
    const isDirty =
      issue.title !== payload.title ||
      issue.body !== payload.body ||
      managedLabelsDiffer(issue.labels, payload);

    if (issue.state === "closed") {
      if (isResolved(item.status)) {
        // A closed-and-resolved issue is normally left completely alone —
        // its payload is never recomputed, dirty or not (the deliberate gap
        // ADR-0032's 2026-07-28 Update records, kept because reopening that
        // door risks the idempotency law for cosmetic corrections). A stale
        // marker is the one exception: it is not cosmetic, it is the join
        // key, and the overwhelming majority of hub-sync issues are closed,
        // so without this the aliases could never retire. Idempotent by
        // construction — once rewritten the marker is current, so the very
        // next run matches on `item.key`, `viaLegacy` is false, and this
        // falls through to "in sync".
        if (viaLegacy) {
          update.push({ number: issue.number, key: item.key, payload });
        } else {
          untouched.push({ number: issue.number, reason: "in sync" });
        }
      } else {
        reopen.push({ number: issue.number, key: item.key, payload });
      }
      continue;
    }

    if (isResolved(item.status)) {
      close.push({
        number: issue.number,
        key: item.key,
        comment: CLOSE_REASON[item.status],
        reason: CLOSE_STATE_REASON[item.status],
      });
    } else if (isDirty) {
      update.push({ number: issue.number, key: item.key, payload });
    } else {
      untouched.push({ number: issue.number, reason: "in sync" });
    }
  }

  for (const item of items) {
    if (matchedKeys.has(item.key) || isResolved(item.status)) continue;
    create.push({ key: item.key, payload: buildIssuePayload(item) });
  }

  return { create, update, close, reopen, untouched };
}

// The board's single-select "Status" field carries only these three options
// (never extended to match the tracker's 6-value vocabulary one-for-one —
// that would need a board schema change this planner doesn't make). Every
// Item status maps conservatively onto the closest of the three: "todo" /
// "deferred" / "blocked" (all not-yet-actionable-or-waiting) collapse to
// Pending, "in-progress" to In review, and "done" / "rejected" (both
// resolved — a rejected item's issue is closed by planIssueSync, so this
// mapping is only reached defensively) to Done.
const PROJECT_STATUS_OPTIONS = {
  todo: "Pending",
  "in-progress": "In review",
  deferred: "Pending",
  blocked: "Pending",
  done: "Done",
  rejected: "Done",
};

// Map an Item/tracked-issue status to its board single-select option name.
// `status` is always one of the six kinds classifyStatusCell/resolveStatus
// produce (a closed set — see the Item/trackedIssues type above), so a miss
// here is a programming error (e.g. a new badge kind added without a
// matching PROJECT_STATUS_OPTIONS entry), not off-vocabulary tracker data —
// that case is now caught earlier and loudly, by resolveStatus's warning and
// check:tracker-status's hard gate (bin/check-tracker-status.mjs). Throwing
// instead of silently defaulting to Pending keeps this table's exhaustiveness
// enforced rather than assumed.
function projectStatusOption(status) {
  const option = PROJECT_STATUS_OPTIONS[status];
  if (option === undefined) {
    throw new Error(
      `projectStatusOption: no board option mapped for status "${status}" — ` +
        `PROJECT_STATUS_OPTIONS is missing an entry for a new badge kind.`,
    );
  }
  return option;
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
 * planProjectSync([{ number: 1, state: "open", status: "todo" }], []);
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

// Plain Levenshtein edit distance between two strings — no dependency (this
// repo's minimal-runtime-deps rule extends to bin/ tooling); O(a.length *
// b.length) is fine at GitHub-issue-title scale (<=120 chars after
// truncateTitle, at most a few hundred existing issues).
function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[rows - 1][cols - 1];
}

/**
 * Case-insensitive title similarity in `[0, 1]` — `1` is identical, `0` is
 * maximally different (every character differs, `levenshteinDistance` equals
 * the longer string's length). Only used by {@link planBackfill}'s collision
 * guard; not a general-purpose fuzzy-match utility.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 * @example
 * ```js
 * import { titleSimilarity } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * titleSimilarity("F7 — Opt-in tolerant handling", "f7 — opt-in tolerant handling"); // 1
 * ```
 */
export function titleSimilarity(a, b) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

/**
 * Plan a **one-time** backfill of GitHub issues for tracker rows that were
 * already Done/Rejected before `sync:hub` ever ran against them — the
 * go-forward-only gap {@link planIssueSync} accepts by design (a resolved
 * item with no marker is silently skipped there, never created). Every
 * backfilled issue is created **and immediately closed** with the same
 * done/rejected reason a live resolved item's close uses, so the historical
 * record exists on GitHub without ever appearing as open work.
 *
 * Only considers items with **no existing marker match at all** — an item
 * {@link planIssueSync} already tracks (marker present, regardless of
 * open/closed state) is never touched here, so running this after
 * `planIssueSync` never double-plans the same row.
 *
 * **Collision guard:** because a pre-existing row never carried a marker, a
 * naive backfill could refile something a maintainer already created by hand
 * under a slightly different title. Before planning a create, every
 * candidate title is fuzzy-matched ({@link titleSimilarity}) against every
 * existing issue title (open or closed, marker or not); the single best
 * match at or above `threshold` routes the item to `needsReview` instead of
 * `create`, so a human confirms it rather than risking a duplicate.
 *
 * @param {Item[]} items
 * @param {{ number: number, title: string, body: string, state: "open" | "closed" }[]} existingIssues
 * @param {{ threshold?: number }} [options] `threshold` (default `0.85`) is
 *   the minimum {@link titleSimilarity} that routes a candidate to
 *   `needsReview` — tuned high so genuinely distinct same-family rows (e.g.
 *   F8 vs. F8-adopt, which share boilerplate wording) don't false-positive.
 * @returns {{
 *   create: { key: string, payload: ReturnType<typeof buildIssuePayload>, comment: string, reason: "completed" | "not planned" }[],
 *   needsReview: { key: string, payload: ReturnType<typeof buildIssuePayload>, candidateNumber: number, candidateTitle: string, similarity: number }[],
 * }}
 * @example
 * ```js
 * import { planBackfill } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * const plan = planBackfill(items, existingIssues);
 * plan.create.forEach(({ payload }) => console.log(payload.title));
 * ```
 */
export function planBackfill(items, existingIssues, { threshold = 0.85 } = {}) {
  const create = [];
  const needsReview = [];

  const markedKeys = new Set(
    existingIssues
      .map((issue) => parseHubMarker(issue.body))
      .filter((key) => key !== null),
  );

  // An item whose issue still carries an OLD key is already filed, so it must
  // not be backfilled a second time — resolve each marker through the shared
  // index rather than comparing raw strings to `item.key`.
  const itemByKey = indexItemsByKey(items);
  const markedItemKeys = new Set(
    [...markedKeys]
      .map((key) => itemByKey.get(key)?.key)
      .filter((key) => key !== undefined),
  );

  for (const item of items) {
    if (!isResolved(item.status) || markedItemKeys.has(item.key)) continue;

    const payload = buildIssuePayload(item);
    let bestMatch = null;
    for (const issue of existingIssues) {
      const similarity = titleSimilarity(payload.title, issue.title);
      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = { number: issue.number, title: issue.title, similarity };
      }
    }

    if (bestMatch && bestMatch.similarity >= threshold) {
      needsReview.push({
        key: item.key,
        payload,
        candidateNumber: bestMatch.number,
        candidateTitle: bestMatch.title,
        similarity: bestMatch.similarity,
      });
      continue;
    }

    create.push({
      key: item.key,
      payload,
      comment: CLOSE_REASON[item.status],
      reason: CLOSE_STATE_REASON[item.status],
    });
  }

  return { create, needsReview };
}
