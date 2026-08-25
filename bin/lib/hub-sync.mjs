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
  classifyTypeCell,
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
 * HUB_PROJECT_TITLE; // "m3l-automation"
 * ```
 */
export const HUB_PROJECT_TITLE = "m3l-automation";

/**
 * Maps every non-governance {@link Item} priority to the GitHub label string
 * that encodes it — the numbered-semantic vocabulary adopted by ADR-0051
 * (superseding the bare `p0`/`p1`/`p2` names ADR-0032 originally picked). The
 * leading digit is deliberate: GitHub sorts labels alphabetically, and
 * without it a semantic name (`now`/`next`/`later`) would not sort in tier
 * order in the label sidebar. `governance` has no entry here — see
 * {@link TYPE_LABELS}.
 *
 * `p3` was added by ADR-0073, splitting `p2`'s original "gated/deferred"
 * meaning in two: `p2` is now real work that simply isn't scheduled, `p3` is
 * work that *cannot start* until an external gate opens. Before the split,
 * 31 of 60 open board items sat in `p2`, which made the tier unreadable.
 *
 * @example
 * ```js
 * import { PRIORITY_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * PRIORITY_LABELS.p1; // "priority:1-next"
 * ```
 */
/**
 * One description per priority tier, read by **both** `LABEL_DEFS` (as the
 * `priority:*` label description) and `MILESTONE_DEFS` (as the milestone
 * description). ADR-0073 made milestones a declared, described facet; sharing
 * the string is what makes "a tier's label and its milestone say the same
 * thing" true by construction rather than by a reviewer noticing.
 *
 * Held to the label side's asserted 100-character limit
 * (`LABEL_DESCRIPTION_MAX_LENGTH`), the tighter of the two consumers —
 * GitHub allows far more on a milestone, but a shared string can only be as
 * long as its strictest reader.
 *
 * @example
 * ```js
 * import { PRIORITY_TIERS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * PRIORITY_TIERS.p1.description; // "Next — the near-term scheduled wave."
 * ```
 */
export const PRIORITY_TIERS = {
  p0: {
    description: "Now — unblock-first work; do before more consumer scripts.",
  },
  p1: { description: "Next — the near-term scheduled wave." },
  p2: {
    description:
      "Later — real work, not yet scheduled; nothing external is blocking it.",
  },
  p3: {
    description:
      "Gated — cannot start until an external gate or future ADR opens.",
  },
};

export const PRIORITY_LABELS = {
  p0: "priority:0-now",
  p1: "priority:1-next",
  p2: "priority:2-later",
  p3: "priority:3-gated",
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
 * ADR-0073 added `p3`, the milestone behind the new gated tier. A brand-new
 * title is safe to add here because {@link planMilestones} creates what is
 * missing.
 *
 * `p1` and `p2` were then renamed, once {@link planMilestones} grew the
 * in-place `PATCH` path this needed: `Next — consumer fleet` was already
 * wrong (of the 28 open `p1` items exactly 2 are consumer scripts), and
 * `Later — gated/deferred` became wrong the moment `p3` existed.
 *
 * **Editing a title here is still not self-applying.**
 * `gh issue create/edit --milestone` resolves by *title* and
 * {@link planIssueSync}'s `isDirty` does not compare milestones, so a title
 * changed here without a matching `legacyTitles` entry in
 * `bin/lib/milestone-defs.mjs` makes the sync CREATE the new milestone and
 * strand every issue on the old one — 28 and 31 open issues respectively, at
 * the time of the rename. Change the two together, always.
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
  p1: "Next — scheduled",
  p2: "Later — not yet scheduled",
  p3: "Gated — awaiting trigger",
  governance: "Governance",
  major: "Breaking",
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
/**
 * The GitHub-org Issue Type every {@link Item} is assigned, one level
 * coarser than {@link PRIORITY_LABELS}/{@link TYPE_LABELS}: it answers "what
 * kind of work is this" (capability work, a consumer script, a friction
 * report, a governance follow-up) rather than "how urgent." Assigned to the
 * `monte3l` org's Issue Types via `gh issue edit --type`, not a label — see
 * ADR-0052. Derived per tracker *section* ({@link TYPE_BY_ROADMAP_SECTION} /
 * {@link TYPE_BY_IMPLEMENTATION_SECTION}), never hand-picked per item, the
 * same shape {@link IMPLEMENTATION_ANCHORS}/{@link IMPLEMENTATION_NAMESPACES}
 * already use.
 *
 * @example
 * ```js
 * import { ISSUE_TYPES } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * ISSUE_TYPES.friction; // "Friction"
 * ```
 */
export const ISSUE_TYPES = {
  libraryCapability: "Library capability",
  cliCapability: "CLI capability",
  packageCapability: "Package capability",
  ui: "UI",
  infrastructure: "Infrastructure",
  fleetRetrofit: "Fleet retrofit",
  toolingGates: "Tooling & gates",
  consumerScript: "Consumer script",
  friction: "Friction",
  governance: "Governance",
};

/**
 * One description **and** one GitHub Issue-Type colour per {@link ISSUE_TYPES}
 * kind, read by **both** `LABEL_DEFS` (as the `type:*` label description) and
 * `ISSUE_TYPE_DEFS` (as the org Issue Type's description/colour). Exactly the
 * {@link PRIORITY_TIERS} pattern, applied to the other axis: a kind's label and
 * its Issue Type now say the same thing by construction.
 *
 * The drift this closes was live and measurable. Before ADR-0073 the org's
 * four Issue Types carried descriptions written by hand
 * (`Capability` → "Library capability work (A/B/C-series)."), while the
 * matching `type:*` labels carried different prose for the same idea — two
 * surfaces describing one concept, with nothing comparing them.
 *
 * Descriptions are held to the label side's asserted 100-character limit
 * (`LABEL_DESCRIPTION_MAX_LENGTH`) for the same reason `PRIORITY_TIERS` is:
 * a shared string can only be as long as its strictest reader.
 *
 * `color` is an `IssueTypeColor` **enum** value, not the hex a label uses —
 * two different systems, so the two colours are deliberately not shared. The
 * enum has 8 values for 10 kinds, so exactly two pairs must share one; the
 * pairs chosen are the two semantically closest, keeping the chip informative
 * even where it is not unique: (`Infrastructure`, `Tooling & gates`) are both
 * substrate/plumbing, and (`Consumer script`, `Fleet retrofit`) are both
 * `scripts/*` fleet work.
 *
 * @example
 * ```js
 * import { TYPE_KINDS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * TYPE_KINDS.ui.color; // "PINK"
 * ```
 */
export const TYPE_KINDS = {
  libraryCapability: {
    description: "Library capability — packages/m3l-common (core/, aws/).",
    color: "BLUE",
  },
  cliCapability: {
    description: "CLI capability — packages/m3l-cli.",
    color: "ORANGE",
  },
  packageCapability: {
    description:
      "Package capability — creating or building out another workspace package.",
    color: "GREEN",
  },
  ui: { description: "UI — a browser-facing surface.", color: "PINK" },
  infrastructure: {
    description:
      "Infrastructure — deployment, packaging, or runtime substrate.",
    color: "GRAY",
  },
  fleetRetrofit: {
    description:
      "Fleet retrofit — changes to existing consumers under scripts/*.",
    color: "YELLOW",
  },
  toolingGates: {
    description: "Tooling & gates — bin/, .github/, .claude/.",
    color: "GRAY",
  },
  consumerScript: {
    description: "A new consumer script under scripts/*.",
    color: "YELLOW",
  },
  friction: {
    description: "Library friction / defect report (F-series).",
    color: "RED",
  },
  governance: {
    description:
      "Governance follow-up (ADR/process work); outside the priority tiers.",
    color: "PURPLE",
  },
};

/**
 * The eight values GitHub's `IssueTypeColor` GraphQL enum accepts, introspected
 * from the live schema (2026-08-22). Exported so `ISSUE_TYPE_DEFS`' load-time
 * assertion rejects a typo'd colour here rather than at the `createIssueType`
 * mutation, which fails the whole provisioning run partway through.
 */
export const ISSUE_TYPE_COLORS = Object.freeze([
  "GRAY",
  "BLUE",
  "GREEN",
  "YELLOW",
  "ORANGE",
  "RED",
  "PINK",
  "PURPLE",
]);

// Every ISSUE_TYPES kind must have exactly one TYPE_KINDS entry, in both
// directions. Asserted at module load, next to the table itself, because both
// consumers (LABEL_DEFS, ISSUE_TYPE_DEFS) index INTO it by key — a missing
// entry would otherwise surface as `undefined.description` deep inside a
// label bootstrap or a GraphQL mutation, long after the real mistake.
{
  const kindKeys = Object.keys(TYPE_KINDS);
  const typeKeys = Object.keys(ISSUE_TYPES);
  for (const key of typeKeys) {
    if (!Object.hasOwn(TYPE_KINDS, key)) {
      throw new Error(
        `hub-sync.mjs: ISSUE_TYPES.${key} has no TYPE_KINDS entry — every kind needs a ` +
          `description and colour, since LABEL_DEFS and ISSUE_TYPE_DEFS both read them from here.`,
      );
    }
  }
  for (const key of kindKeys) {
    if (!Object.hasOwn(ISSUE_TYPES, key)) {
      throw new Error(
        `hub-sync.mjs: TYPE_KINDS.${key} names no ISSUE_TYPES kind — a stale entry left ` +
          `behind by a rename, which nothing reads.`,
      );
    }
  }
}

/**
 * Every {@link ISSUE_TYPES} value as a flat, frozen array — the vocabulary
 * {@link classifyTypeCell} validates a tracker `Type` cell against, and
 * `bin/check-tracker-status.mjs` gates on. Exported so neither re-derives
 * `Object.values(ISSUE_TYPES)` independently and drifts.
 *
 * @example
 * ```js
 * import { TYPE_VALUES } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * TYPE_VALUES.includes("UI"); // true
 * ```
 */
export const TYPE_VALUES = Object.freeze(Object.values(ISSUE_TYPES));

/**
 * GitHub label string for every {@link ISSUE_TYPES} value (ADR-0052's
 * 2026-08-20 Update) — keyed by the {@link ISSUE_TYPES} *display name*
 * (how {@link Item.type} actually stores it), so `TYPE_LABELS[item.type]`
 * resolves directly with no reverse lookup. `governance` predates the
 * other three (ADR-0051): it was previously `priority:governance`, but
 * {@link classifyPriorityCell} has never had a governance branch (a
 * governance row's Priority cell is always the untiered dash placeholder)
 * — filing it under the `priority:` prefix claimed it was a fourth tier
 * when it never behaved like one. A governance item carries
 * {@link TYPE_LABELS}["Governance"] instead of any {@link PRIORITY_LABELS}
 * entry (see {@link facetLabel}); it keeps its own {@link MILESTONE_TITLES}
 * entry unchanged.
 *
 * @example
 * ```js
 * import { TYPE_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * TYPE_LABELS[ISSUE_TYPES.friction]; // "type:friction"
 * ```
 */
export const TYPE_LABELS = {
  [ISSUE_TYPES.libraryCapability]: "type:library-capability",
  [ISSUE_TYPES.cliCapability]: "type:cli-capability",
  [ISSUE_TYPES.packageCapability]: "type:package-capability",
  [ISSUE_TYPES.ui]: "type:ui",
  [ISSUE_TYPES.infrastructure]: "type:infrastructure",
  [ISSUE_TYPES.fleetRetrofit]: "type:fleet-retrofit",
  [ISSUE_TYPES.toolingGates]: "type:tooling-gates",
  [ISSUE_TYPES.consumerScript]: "type:consumer-script",
  [ISSUE_TYPES.friction]: "type:friction",
  [ISSUE_TYPES.governance]: "type:governance",
};

export const ROADMAP_ANCHORS = {
  p0: "#priority-0--library-hardening-do-before-more-scripts",
  p1: "#priority-1--consumer-fleet",
  governance: "#governance-follow-ups-adr-0028--adr-0029",
};

// The {@link ISSUE_TYPES} value every ROADMAP.md section's items are
// assigned, keyed identically to ROADMAP_ANCHORS above so a new ROADMAP
// section cannot gain an anchor without also gaining a type (mirrors the
// IMPLEMENTATION_ANCHORS/IMPLEMENTATION_NAMESPACES pairing below).
const TYPE_BY_ROADMAP_SECTION = {
  p0: ISSUE_TYPES.libraryCapability,
  p1: ISSUE_TYPES.consumerScript,
  governance: ISSUE_TYPES.governance,
};

export const IMPLEMENTATION_ANCHORS = {
  friction: "#library-friction-f-series",
  adr0035Rollout: "#adr-0035-rollout--failure-reporting--diagnostics",
  capabilityDeepeningWave: "#capability-deepening-wave--adr-003700380039",
  postComparisonHardeningWave:
    "#post-comparison-hardening-wave--adr-0040004100420043",
  m3lCliBuildOut: "#m3l-cli-build-out--adr-0042-activation-issue-333",
  cliEvolutionWave: "#cli-evolution-wave-u-series",
  agentOperatorWave: "#agent-operator-wave-v-series",
  consoleWave: "#m3l-console-wave-x-series",
  codifiedProcedureWave:
    "#codified-procedure-engine-wave--adr-0046004700480049",
  gated: "#gated-library-modules--deferred-decisions-later",
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
export const IMPLEMENTATION_NAMESPACES = {
  friction: "friction",
  adr0035Rollout: "adr0035",
  capabilityDeepeningWave: "capability",
  postComparisonHardeningWave: "hardening",
  m3lCliBuildOut: "cli",
  // ADR-0073's three programme namespaces. Every row moved out of the `cli`
  // namespace carries its old `impl:cli:<slug>` key as a legacyKey (see the
  // section blocks below), so an issue whose marker still holds the old key
  // resolves to its item instead of reading as vanished — which planIssueSync
  // would close as "removed from source trackers".
  cliEvolutionWave: "cli-evolution",
  agentOperatorWave: "agent-operator",
  consoleWave: "console",
  codifiedProcedureWave: "procedure",
  gated: "gated",
};

// The {@link ISSUE_TYPES} value every IMPLEMENTATION.md section's items are
// assigned, keyed identically to IMPLEMENTATION_ANCHORS/IMPLEMENTATION_NAMESPACES
// above so a new section cannot gain an anchor without also gaining a type.
//
// This is a *default*, not a verdict: ADR-0073 added an optional per-row
// `Type` cell that overrides it (see resolveType), which is what finally
// answers the admission the previous version of this comment made — that
// `gated`'s entries are "individually mixed (a deferred toolchain chore
// alongside genuine capability gaps)" and were all typed Capability anyway,
// "with the nuance carried in the row's own detail text rather than a
// per-item type override." The override now exists, so the nuance lives in
// the Type cell where a filter can see it.
//
// The defaults below name each section's *predominant* layer. `gated` keeps
// the library default because its D4/D5 intake rows are library work; its
// toolchain-chore rows carry an explicit `Tooling & gates` cell instead.
export const TYPE_BY_IMPLEMENTATION_SECTION = {
  friction: ISSUE_TYPES.friction,
  adr0035Rollout: ISSUE_TYPES.libraryCapability,
  capabilityDeepeningWave: ISSUE_TYPES.libraryCapability,
  postComparisonHardeningWave: ISSUE_TYPES.libraryCapability,
  m3lCliBuildOut: ISSUE_TYPES.cliCapability,
  cliEvolutionWave: ISSUE_TYPES.cliCapability,
  agentOperatorWave: ISSUE_TYPES.libraryCapability,
  consoleWave: ISSUE_TYPES.packageCapability,
  codifiedProcedureWave: ISSUE_TYPES.libraryCapability,
  gated: ISSUE_TYPES.libraryCapability,
};

/**
 * {@link Item} keys routed to the `MILESTONE_TITLES.major` ("Breaking")
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
 * Maps every {@link Item} status to a GitHub label (ADR-0052's 2026-08-20
 * Update — originally Deferred/Blocked only, so Deferred/Blocked/To Do were
 * visually identical on GitHub: same open state, same priority label, and
 * the Status column itself excluded from the derived issue body). A Done/
 * Rejected item's issue is still closed by {@link planIssueSync} — the
 * label is additional, not a substitute for the closed state — and
 * {@link planIssueSync}'s close path syncs it via a dedicated label-only
 * edit before closing, since `gh issue close` cannot set labels itself.
 *
 * @example
 * ```js
 * import { STATUS_LABELS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * STATUS_LABELS.blocked; // "status:blocked"
 * ```
 */
export const STATUS_LABELS = {
  todo: "status:todo",
  "in-progress": "status:in-progress",
  deferred: "status:deferred",
  blocked: "status:blocked",
  done: "status:done",
  rejected: "status:rejected",
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
 * The derived epic issue each tracker section rolls its items up into
 * (ADR-0073). Keyed by declared *section*, not by issue-key namespace —
 * ROADMAP Priority 1's rows namespace themselves per wave (`roadmap:W3:...`,
 * from each row's own Wave cell), so keying epics off the namespace would
 * scatter one documented section across seven epics.
 *
 * The `epic:` prefix keeps these outside every `impl:`/`roadmap:` namespace,
 * so an epic can never collide with a real tracker row's key.
 *
 * @example
 * ```js
 * import { EPIC_KEYS } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * EPIC_KEYS.consoleWave; // "epic:impl:console"
 * ```
 */
export const EPIC_KEYS = {
  roadmapP0: "epic:roadmap:p0",
  roadmapP1: "epic:roadmap:p1",
  roadmapGovernance: "epic:roadmap:gov",
  friction: "epic:impl:friction",
  adr0035Rollout: "epic:impl:adr0035",
  capabilityDeepeningWave: "epic:impl:capability",
  postComparisonHardeningWave: "epic:impl:hardening",
  m3lCliBuildOut: "epic:impl:cli",
  cliEvolutionWave: "epic:impl:cli-evolution",
  agentOperatorWave: "epic:impl:agent-operator",
  consoleWave: "epic:impl:console",
  codifiedProcedureWave: "epic:impl:procedure",
  gated: "epic:impl:gated",
};

// One def per EPIC_KEYS entry. `type` is the section's own default Issue
// Type, so an epic reads as the same kind of work it groups.
const EPIC_DEFS = [
  {
    key: EPIC_KEYS.roadmapP0,
    title: "Epic — Priority 0: library hardening",
    type: TYPE_BY_ROADMAP_SECTION.p0,
    sourcePath: ROADMAP_PATH,
    sourceAnchor: ROADMAP_ANCHORS.p0,
  },
  {
    key: EPIC_KEYS.roadmapP1,
    title: "Epic — Priority 1: consumer fleet",
    type: TYPE_BY_ROADMAP_SECTION.p1,
    sourcePath: ROADMAP_PATH,
    sourceAnchor: ROADMAP_ANCHORS.p1,
  },
  {
    key: EPIC_KEYS.roadmapGovernance,
    title: "Epic — Governance follow-ups",
    type: TYPE_BY_ROADMAP_SECTION.governance,
    sourcePath: ROADMAP_PATH,
    sourceAnchor: ROADMAP_ANCHORS.governance,
  },
  ...[
    ["friction", "Epic — Library friction (F-series)"],
    ["adr0035Rollout", "Epic — ADR-0035 rollout"],
    ["capabilityDeepeningWave", "Epic — Capability-deepening wave"],
    ["postComparisonHardeningWave", "Epic — Post-comparison hardening wave"],
    ["m3lCliBuildOut", "Epic — m3l-cli build-out"],
    ["cliEvolutionWave", "Epic — CLI evolution wave (U-series)"],
    ["agentOperatorWave", "Epic — Agent-operator wave (V-series)"],
    ["consoleWave", "Epic — m3l console wave (X-series)"],
    ["codifiedProcedureWave", "Epic — Codified-procedure engine wave"],
    ["gated", "Epic — Gated library modules & deferred decisions"],
  ].map(([section, title]) => ({
    key: EPIC_KEYS[section],
    title,
    type: TYPE_BY_IMPLEMENTATION_SECTION[section],
    sourcePath: IMPLEMENTATION_PATH,
    sourceAnchor: IMPLEMENTATION_ANCHORS[section],
  })),
];

// Every EPIC_KEYS entry needs a def, or a section's items would carry a
// parentKey pointing at an epic nothing ever emits — leaving planParentLinks
// reporting them `pending` forever. Asserted at module load.
for (const key of Object.values(EPIC_KEYS)) {
  if (!EPIC_DEFS.some((def) => def.key === key)) {
    throw new Error(
      `EPIC_KEYS has "${key}" with no EPIC_DEFS entry — items pointing at it ` +
        `would wait on an epic that is never emitted.`,
    );
  }
}

// A status is "resolved" when its item needs no further work: the two states
// planIssueSync closes an issue for.
const RESOLVED_STATUSES = new Set(["done", "rejected"]);

/**
 * Fold an epic's children into the epic's own status: whichever unresolved
 * state comes first in `in-progress` -> `todo` -> `blocked` -> `deferred`.
 * The order answers "is there startable work here", which is what a reader
 * scanning the board wants from a grouping row.
 *
 * Never returns a resolved status, because an epic with no unresolved
 * children is not emitted at all (see {@link actionableItems}) — so `done`
 * is unreachable by construction rather than merely unused.
 *
 * @param {{ status: string }[]} children
 * @returns {"in-progress" | "todo" | "blocked" | "deferred"}
 * @example
 * ```js
 * import { epicStatus } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * epicStatus([{ status: "done" }, { status: "blocked" }]); // "blocked"
 * ```
 */
export function epicStatus(children) {
  const unresolved = children
    .map((child) => child.status)
    .filter((status) => !RESOLVED_STATUSES.has(status));
  for (const candidate of ["in-progress", "todo", "blocked", "deferred"]) {
    if (unresolved.includes(candidate)) return candidate;
  }
  return "todo";
}

// Tier order for epicPriority's fold. Governance ranks last because it is a
// category rather than a tier (ADR-0051) — an epic mixing governance rows
// with real tiered work should read as the tiered work.
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3, governance: 4 };

/**
 * Fold an epic's children into the epic's own priority: the most urgent tier
 * any **unresolved** child carries. Resolved children are excluded so a
 * finished `p0` item cannot keep an epic pinned at the top of a
 * Priority-ascending board view long after its remaining work dropped to
 * `p2`.
 *
 * @param {{ status: string, priority: string }[]} children
 * @returns {"p0" | "p1" | "p2" | "p3" | "governance"}
 * @example
 * ```js
 * import { epicPriority } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * epicPriority([{ status: "todo", priority: "p2" }, { status: "todo", priority: "p1" }]); // "p1"
 * ```
 */
export function epicPriority(children) {
  const unresolved = children.filter(
    (child) => !RESOLVED_STATUSES.has(child.status),
  );
  const pool = unresolved.length > 0 ? unresolved : children;
  let best = "governance";
  for (const child of pool) {
    if (PRIORITY_RANK[child.priority] < PRIORITY_RANK[best]) {
      best = child.priority;
    }
  }
  return best;
}

/**
 * @typedef {{
 *   key: string,
 *   title: string,
 *   status: "done" | "todo" | "in-progress" | "deferred" | "blocked" | "rejected",
 *   priority: "p0" | "p1" | "p2" | "p3" | "governance",
 *   type: (typeof ISSUE_TYPES)[keyof typeof ISSUE_TYPES],
 *   sourcePath: string,
 *   sourceAnchor: string,
 *   detail: string,
 *   legacyKeys?: string[],
 *   isEpic?: boolean,
 *   parentKey?: string,
 * }} Item
 *
 * `type` is derived from {@link ISSUE_TYPES} rather than spelled out as a
 * literal union: ADR-0073 took the vocabulary from four values to ten, and
 * the hardcoded copy that used to live here went stale silently — a typedef
 * is not covered by the module-load assertions that keep
 * {@link TYPE_LABELS} and `LABEL_DEFS` honest.
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

  // Resolve one row's Issue Type: the section default unless the table
  // carries an optional `Type` column AND this row's cell names a real type
  // (ADR-0073). Three distinct cases collapse to the default, deliberately:
  // no column at all (every table today), a dash placeholder ("use the
  // default"), and an unrecognized cell. Only the last one warns —
  // check:tracker-status is the hard gate that makes it an authoring-time
  // error rather than a silent default, exactly as it already does for
  // Status and Priority.
  function resolveType(header, row, sectionDefault, key) {
    const typeIndex = columnIndex(header, "Type");
    if (typeIndex === -1) return sectionDefault;
    const cell = row[typeIndex] ?? "";
    const { type, recognized, placeholder } = classifyTypeCell(
      cell,
      TYPE_VALUES,
    );
    if (placeholder) return sectionDefault;
    if (!recognized) {
      warnings.push(
        `Implementation: item "${key}" has an unrecognized Type cell ("${cell}") — defaulted to ${sectionDefault}.`,
      );
      return sectionDefault;
    }
    return type;
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
        parentKey: EPIC_KEYS.roadmapP0,
        type: resolveType(header, row, TYPE_BY_ROADMAP_SECTION.p0, key),
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
        parentKey: EPIC_KEYS.roadmapP1,
        type: resolveType(header, row, TYPE_BY_ROADMAP_SECTION.p1, key),
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
        parentKey: EPIC_KEYS.roadmapGovernance,
        type: resolveType(header, row, TYPE_BY_ROADMAP_SECTION.governance, key),
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
        parentKey: EPIC_KEYS.friction,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.friction,
          key,
        ),
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
        parentKey: EPIC_KEYS.adr0035Rollout,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.adr0035Rollout,
          key,
        ),
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
        parentKey: EPIC_KEYS.capabilityDeepeningWave,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.capabilityDeepeningWave,
          key,
        ),
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
        parentKey: EPIC_KEYS.postComparisonHardeningWave,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.postComparisonHardeningWave,
          key,
        ),
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
        parentKey: EPIC_KEYS.m3lCliBuildOut,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.m3lCliBuildOut,
          key,
        ),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.m3lCliBuildOut,
        legacyKeys: [`impl:${slug(row[itemIndex] ?? "")}`],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.cliEvolutionWave) {
    // Both legacyKeys are DERIVED, never hand-typed, so they cannot drift
    // from the real key-generation logic above: the first is the
    // `impl:cli:<slug>` key every one of these rows was filed under before
    // ADR-0073 split this section three ways, the second the pre-namespacing
    // flat key that predates issue #480 / F13. Without the first, every
    // already-open issue for these rows reads as an item that vanished from
    // the trackers, and planIssueSync closes it as "removed from source
    // trackers" and files a duplicate. The acceptance test is a `sync:hub`
    // dry run reporting `Issues to close (0)`.
    const { header, rows } = implementation.cliEvolutionWave;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const itemSlug = slug(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.cliEvolutionWave}:${itemSlug}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        parentKey: EPIC_KEYS.cliEvolutionWave,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.cliEvolutionWave,
          key,
        ),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.cliEvolutionWave,
        legacyKeys: [
          `impl:${IMPLEMENTATION_NAMESPACES.m3lCliBuildOut}:${itemSlug}`,
          `impl:${itemSlug}`,
        ],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.agentOperatorWave) {
    const { header, rows } = implementation.agentOperatorWave;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const itemSlug = slug(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.agentOperatorWave}:${itemSlug}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        parentKey: EPIC_KEYS.agentOperatorWave,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.agentOperatorWave,
          key,
        ),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.agentOperatorWave,
        legacyKeys: [
          `impl:${IMPLEMENTATION_NAMESPACES.m3lCliBuildOut}:${itemSlug}`,
          `impl:${itemSlug}`,
        ],
        detail: buildDetail(header, row, new Set([itemIndex, statusIndex])),
      });
    }
  }

  if (implementation.consoleWave) {
    const { header, rows } = implementation.consoleWave;
    const itemIndex = columnIndex(header, "Item");
    const priorityIndex = columnIndex(header, "Priority");
    const statusIndex = columnIndex(header, "Status");
    const changeIndex = columnIndex(header, "Change");
    for (const row of rows) {
      const strippedItem = stripMarkdown(row[itemIndex] ?? "");
      const itemSlug = slug(row[itemIndex] ?? "");
      const key = `impl:${IMPLEMENTATION_NAMESPACES.consoleWave}:${itemSlug}`;
      addItem({
        key,
        title: `${strippedItem} — ${row[changeIndex] ?? ""}`,
        status: resolveStatus(row[statusIndex], key, "Implementation"),
        priority: resolvePriority(row[priorityIndex], key),
        parentKey: EPIC_KEYS.consoleWave,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.consoleWave,
          key,
        ),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.consoleWave,
        legacyKeys: [
          `impl:${IMPLEMENTATION_NAMESPACES.m3lCliBuildOut}:${itemSlug}`,
          `impl:${itemSlug}`,
        ],
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
        parentKey: EPIC_KEYS.codifiedProcedureWave,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.codifiedProcedureWave,
          key,
        ),
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
        // Hardcoded, because this table has no Priority column by design: the
        // section IS the gated tier, so every row in it is gate-blocked by
        // construction ("Deliberately unscheduled until the gate opens", per
        // the section's own preamble). ADR-0073 moved it from p2 to p3, the
        // tier that finally means what this section always did — p2 now means
        // "real work, not yet scheduled, nothing blocking it", which is the
        // opposite of every row here.
        priority: "p3",
        parentKey: EPIC_KEYS.gated,
        type: resolveType(
          header,
          row,
          TYPE_BY_IMPLEMENTATION_SECTION.gated,
          key,
        ),
        sourcePath: IMPLEMENTATION_PATH,
        sourceAnchor: IMPLEMENTATION_ANCHORS.gated,
        legacyKeys: [`impl:${slug(idCell)}`],
        detail: buildDetail(header, row, new Set([idIndex, statusIndex])),
      });
    }
  }

  // Derived epics, appended after every section so each can see its children.
  //
  // Emitted only when a section still has UNRESOLVED work. The alternative —
  // emit whenever a section has any child — was measured against the real
  // trackers and produces 19 epics, 12 of which would be created and closed
  // in the same breath because their sections are fully shipped. Those 12
  // never appear on the board (its view filters `is:open`), so they are pure
  // issue-feed noise. With this guard the same trackers yield 7 epics, all of
  // them grouping live work.
  //
  // The trade-off, stated because it is not obvious: when a section's last
  // item lands, its epic stops being emitted, so planIssueSync closes it via
  // the vanished-item path and its close comment reads "removed from source
  // trackers" rather than "completed". The behaviour is right (a grouping row
  // with nothing left to group should close); only the reason string is
  // imprecise, and an epic is derived scaffolding rather than tracked work.
  for (const def of EPIC_DEFS) {
    const children = items.filter((item) => item.parentKey === def.key);
    const unresolved = children.filter(
      (child) => !RESOLVED_STATUSES.has(child.status),
    );
    if (unresolved.length === 0) continue;

    addItem({
      key: def.key,
      title: def.title,
      status: epicStatus(children),
      priority: epicPriority(children),
      type: def.type,
      sourcePath: def.sourcePath,
      sourceAnchor: def.sourceAnchor,
      isEpic: true,
      // Deliberately does NOT enumerate its children. GitHub renders the
      // sub-issue list and progress bar itself, and an enumeration here
      // would make every child edit rewrite this epic's body.
      detail:
        `Derived grouping issue for this tracker section — not itself a unit of work. ` +
        `Its children are linked as sub-issues by \`pnpm sync:hub-issues --apply\`; ` +
        `GitHub renders the list and progress. Closes when the section has no ` +
        `unresolved rows left.`,
    });
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
 * body. `labels` always carries {@link HUB_LABEL}, a {@link TYPE_LABELS}
 * entry, and a {@link STATUS_LABELS} entry (ADR-0052's 2026-08-20 Update —
 * every {@link Item} now resolves to both, unconditionally), plus the
 * item's {@link PRIORITY_LABELS} entry for p0/p1/p2 only — governance is a
 * category, not a tier (ADR-0051), so it never carries a `priority:*`
 * label; {@link TYPE_LABELS}["Governance"] already identifies it. The
 * milestone is {@link MAJOR_BUMP_ITEM_KEYS}'s `major` bucket when the item's
 * key is in that set, else the priority's {@link MILESTONE_TITLES} entry —
 * every item now resolves to a real milestone, including governance ones.
 *
 * @param {Item} item
 * @returns {{ title: string, body: string, labels: string[], milestoneTitle: string | null, type: string }}
 * @example
 * ```js
 * import { buildIssuePayload } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * buildIssuePayload({
 *   key: "impl:F7",
 *   title: "F7 — Opt-in tolerant handling",
 *   status: "deferred",
 *   priority: "p2",
 *   type: "Friction",
 *   sourcePath: "docs/plans/IMPLEMENTATION.md",
 *   sourceAnchor: "#library-friction-f-series",
 *   detail: "**Source / call-site:** json-etl log F7",
 * });
 * ```
 */
// The priority label for an item, or `undefined` for governance — split out
// of buildIssuePayload so the "governance never gets a priority:* label"
// rule (ADR-0051) lives in exactly one place. The type label that used to
// stand in for it (TYPE_LABELS.governance) is now applied unconditionally
// to every item via buildIssuePayload's own typeLabel lookup, not here.
function facetLabel(priority) {
  return priority === "governance" ? undefined : PRIORITY_LABELS[priority];
}

export function buildIssuePayload(item) {
  const banner = `**Derived — do not edit.** Authored source: [${item.sourcePath}](${blobUrl(item.sourcePath)}${item.sourceAnchor}); re-synced by \`pnpm sync:hub\`.`;
  const body = [hubMarker(item.key), "", banner, "", item.detail].join("\n");
  const milestoneTitle = MAJOR_BUMP_ITEM_KEYS.has(item.key)
    ? MILESTONE_TITLES.major
    : MILESTONE_TITLES[item.priority];
  const title = truncateTitle(stripTitleMarkdown(item.title));
  const priorityLabel = facetLabel(item.priority);

  // Exhaustiveness throws (matching projectStatusOption/projectPriorityOption
  // below) — every item is now expected to always resolve both a type and a
  // status label, so a table gap must fail loud at sync time, not silently
  // omit a label an operator would otherwise never notice is missing.
  const typeLabel = TYPE_LABELS[item.type];
  if (typeLabel === undefined) {
    throw new Error(
      `buildIssuePayload: no TYPE_LABELS entry for type "${item.type}" — item "${item.key}".`,
    );
  }
  const statusLabel = STATUS_LABELS[item.status];
  if (statusLabel === undefined) {
    throw new Error(
      `buildIssuePayload: no STATUS_LABELS entry for status "${item.status}" — item "${item.key}".`,
    );
  }

  return {
    title,
    body,
    labels: [
      HUB_LABEL,
      ...(priorityLabel ? [priorityLabel] : []),
      typeLabel,
      statusLabel,
    ],
    milestoneTitle,
    type: item.type,
  };
}

/**
 * Reconcile the repo's milestones against `MILESTONE_DEFS`: create what is
 * missing, rename in place what is living under a former title, describe what
 * has drifted, and *name* — never delete — anything left over.
 *
 * ADR-0073 widened this from create-only. The create-only version was why
 * every live milestone carried a `null` description, and why the `major` tier
 * ended up with two milestones: `Breaking` already served it, but the declared
 * title was `2.0 / breaking`, so the sync kept planning to create that one
 * instead of describing or renaming what was already there. With no rename or
 * describe path, neither drift was expressible, so neither was ever reported.
 *
 * **Title match beats legacy match.** A def whose current title already
 * exists live resolves to that milestone, and any milestone holding one of
 * that def's `legacyTitles` becomes an `orphan` instead of a rename —
 * because GitHub rejects a `PATCH` that would duplicate an existing title.
 * This is not hypothetical: `major` is in exactly that state, with both
 * `Breaking` and `2.0 / breaking` present. ADR-0074 made `Breaking` the
 * declared title precisely so the match lands on the milestone carrying the
 * closed breaking work, leaving the empty `2.0 / breaking` as the orphan.
 * Declared the other way round — as it was until ADR-0074 — the orphan is the
 * milestone holding every breaking issue, and since `orphan` is never deleted
 * that split is permanent. Read the two directions before reversing this.
 *
 * **`orphan` is report-only.** A milestone matching no def is named so a
 * maintainer can decide, never deleted — it may still carry closed issues,
 * and deleting a milestone strips it from every issue that ever held it.
 * `orphan` is deliberately excluded from `planIsEmpty`'s drift verdict for
 * the same reason: an unclaimed milestone nobody intends to remove would
 * otherwise make `check:hub-drift` permanently unfixable. `2.0 / breaking` is
 * the one current orphan and holds no issues at all, open or closed, which is
 * the entire reason ADR-0074 could sanction deleting it by hand.
 *
 * A `create` is only planned for a milestone some item actually needs, so an
 * unused tier costs nothing; `rename` and `describe` apply to every def, since
 * a mis-titled milestone is wrong whether or not this run has work in it.
 *
 * @param {Item[]} items
 * @param {{ number: number, title: string, description: string | null, state: string }[]} existingMilestones
 * @param {{ key: string, title: string, description: string, legacyTitles: string[] }[]} milestoneDefs
 * @returns {{ create: string[], rename: { number: number, from: string, to: string }[], describe: { number: number, title: string, description: string }[], orphan: { number: number, title: string }[] }}
 * @example
 * ```js
 * import { planMilestones } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 * import { MILESTONE_DEFS } from "@m3l-automation/workspace/bin/lib/milestone-defs.mjs";
 *
 * planMilestones(items, liveMilestones, MILESTONE_DEFS);
 * // { create: ["Gated — awaiting trigger"], rename: [...], describe: [...], orphan: [...] }
 * ```
 */
export function planMilestones(items, existingMilestones, milestoneDefs) {
  const byTitle = new Map(existingMilestones.map((m) => [m.title, m]));
  const create = [];
  const rename = [];
  const describe = [];
  const claimedNumbers = new Set();

  // Which milestone titles this run's items actually need.
  const needed = new Set();
  for (const item of items) {
    const { milestoneTitle } = buildIssuePayload(item);
    if (milestoneTitle !== null) needed.add(milestoneTitle);
  }

  for (const def of milestoneDefs) {
    const exact = byTitle.get(def.title);
    if (exact !== undefined) {
      claimedNumbers.add(exact.number);
      // A legacy-titled sibling cannot be renamed into an occupied title;
      // leaving it unclaimed is what surfaces it as an orphan below.
      if ((exact.description ?? "") !== def.description) {
        describe.push({
          number: exact.number,
          title: def.title,
          description: def.description,
        });
      }
      continue;
    }

    const legacy = def.legacyTitles
      .map((title) => byTitle.get(title))
      .find(
        (found) => found !== undefined && !claimedNumbers.has(found.number),
      );
    if (legacy !== undefined) {
      claimedNumbers.add(legacy.number);
      rename.push({ number: legacy.number, from: legacy.title, to: def.title });
      if ((legacy.description ?? "") !== def.description) {
        describe.push({
          number: legacy.number,
          title: def.title,
          description: def.description,
        });
      }
      continue;
    }

    // Nothing to rename and nothing to describe: only create it if this run
    // has an item that needs it.
    if (needed.has(def.title)) create.push(def.title);
  }

  const orphan = existingMilestones
    .filter((m) => !claimedNumbers.has(m.number))
    .map((m) => ({ number: m.number, title: m.title }));

  return { create, rename, describe, orphan };
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
 * Reconciles the `monte3l` org's GitHub Issue Types against
 * {@link ISSUE_TYPE_DEFS}. Pure: the caller reads the live types and the issue
 * census, this decides what to do about them.
 *
 * Three outputs rather than two, because retiring a type is the only
 * irreversible half and it needs a precondition the planner can actually
 * check:
 *
 * - `create` — a declared def with no live type of that name. This is also
 *   what the apply-path **preflight** reads: a non-empty `create` means
 *   `gh issue create --type` would 422 partway through a ~50-issue batch, so
 *   the sync refuses to start rather than fail half-applied.
 * - `retire` — a live type outside the declared vocabulary that **no issue
 *   still carries**. Derived, never a hardcoded name list, so a type retired
 *   from `ISSUE_TYPES` needs no second edit here.
 * - `blocked` — a live type outside the vocabulary that issues still carry,
 *   with the count. Report-only. ADR-0073 originally sequenced this as
 *   "delete `Capability` after the retype pass"; a zero-issue precondition is
 *   the same intent expressed as a condition the runner can verify, instead of
 *   an ordering a human has to remember.
 *
 * Deliberately **no `describe`/recolour output.** `updateIssueType` exists, so
 * drift there is fixable, but nothing gates it — adding a silent repair path
 * with no check behind it is how the milestone descriptions went five-null and
 * unnoticed (ADR-0073). Left for the gate that would assert it.
 *
 * @param {{ id: string, name: string }[]} liveTypes org Issue Types as read
 *   from `organization.issueTypes`
 * @param {{ key: string, name: string, description: string, color: string }[]} typeDefs
 *   normally {@link ISSUE_TYPE_DEFS}
 * @param {Map<string, number>} issueCountsByType how many issues (any state)
 *   currently carry each type name; a name absent from the map counts as 0
 * @returns {{ create: { key: string, name: string, description: string, color: string }[], retire: { id: string, name: string }[], blocked: { id: string, name: string, count: number }[] }}
 * @example
 * ```js
 * import { planIssueTypes } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 * import { ISSUE_TYPE_DEFS } from "@m3l-automation/workspace/bin/lib/issue-type-defs.mjs";
 *
 * planIssueTypes(
 *   [{ id: "IT_1", name: "Capability" }],
 *   ISSUE_TYPE_DEFS,
 *   new Map([["Capability", 0]]),
 * ).retire; // [{ id: "IT_1", name: "Capability" }]
 * ```
 */
export function planIssueTypes(liveTypes, typeDefs, issueCountsByType) {
  const liveByName = new Map(liveTypes.map((type) => [type.name, type]));
  const declaredNames = new Set(typeDefs.map((def) => def.name));

  const create = typeDefs.filter((def) => !liveByName.has(def.name));

  const retire = [];
  const blocked = [];
  for (const type of liveTypes) {
    if (declaredNames.has(type.name)) continue;
    const count = issueCountsByType.get(type.name) ?? 0;
    if (count === 0) retire.push({ id: type.id, name: type.name });
    else blocked.push({ id: type.id, name: type.name, count });
  }

  return { create, retire, blocked };
}

/**
 * How many issues carry each Issue Type name, counting **both** open and
 * closed. Closed issues matter as much as open ones here: they are the
 * majority of the repo's issues, `planIssueSync` never revisits a
 * closed-and-resolved one, and a single closed issue still carrying a type is
 * enough to make retiring it destructive.
 *
 * @param {{ type: string | null }[]} issues normally `loadAllIssues`' output
 * @returns {Map<string, number>} keyed by type name; untyped issues are not counted
 * @example
 * ```js
 * import { countIssuesByType } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * countIssuesByType([{ type: "Friction" }, { type: null }]).get("Friction"); // 1
 * ```
 */
export function countIssuesByType(issues) {
  const counts = new Map();
  for (const issue of issues) {
    if (issue.type === null || issue.type === undefined) continue;
    counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  }
  return counts;
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
 * Plan the GitHub sub-issue links that make each item a child of its
 * section's epic (ADR-0073).
 *
 * `Parent issue` on the board needs **no board write at all** — it is a
 * read-only projection of the issue's own parent relationship, so setting the
 * link is enough for the column to fill in.
 *
 * Returns three buckets:
 *
 * - `set` — the issue exists, its epic exists, and its current parent differs
 *   from the epic (including having none).
 * - `clear` — the issue has a parent but its item declares none, so the link
 *   is stale.
 * - `pending` — the item's epic has no issue yet, typically because this is
 *   the run that will create it. **Not drift.** Callers must keep it out of
 *   any is-the-plan-empty test: a pending link always coexists with a
 *   non-empty create plan, so counting it would double-report, and counting
 *   it when the epic genuinely cannot be resolved would make the drift gate
 *   unfixable. Each entry carries the child's own issue `number` so an
 *   `--apply` run can link it the moment it files the epic, converging in one
 *   run instead of requiring a second.
 *
 * Epics themselves are skipped — an epic never gets a parent, so the
 * hierarchy stays exactly two levels deep.
 *
 * Resolution goes through {@link indexItemsByKey}, so an issue whose marker
 * still carries a legacy key resolves to its current item rather than reading
 * as parentless.
 *
 * @param {Item[]} items
 * @param {{ number: number, body: string, state: string, parentNumber: number | null }[]} existingIssues
 * @returns {{ set: { number: number, key: string, parentNumber: number, parentKey: string }[], clear: { number: number, key: string }[], pending: { number: number, key: string, parentKey: string }[] }}
 * @example
 * ```js
 * import { planParentLinks } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * planParentLinks(items, existingIssues);
 * // { set: [{ number: 526, key: "impl:cli-evolution:u2", parentNumber: 700, parentKey: "epic:impl:cli-evolution" }], clear: [], pending: [] }
 * ```
 */
export function planParentLinks(items, existingIssues) {
  const itemByKey = indexItemsByKey(items);

  // Marker -> issue number, for every marker-bearing issue. Built from the
  // resolved item's CURRENT key so a legacy-marker issue is still findable as
  // its item's parent target.
  const numberByKey = new Map();
  const issueByKey = new Map();
  for (const issue of existingIssues) {
    const marker = parseHubMarker(issue.body);
    if (marker === null) continue;
    const item = itemByKey.get(marker);
    const key = item ? item.key : marker;
    numberByKey.set(key, issue.number);
    issueByKey.set(key, issue);
  }

  const set = [];
  const clear = [];
  const pending = [];

  for (const item of items) {
    if (item.isEpic) continue;

    const issue = issueByKey.get(item.key);
    // No issue yet: its create will carry --parent, so there is nothing to
    // reconcile here.
    if (issue === undefined) continue;
    // A closed issue's parent is left alone — relinking historical issues is
    // churn with no reader.
    if (issue.state === "closed") continue;

    const parentKey = item.parentKey;
    if (parentKey === undefined) {
      if (issue.parentNumber !== null) {
        clear.push({ number: issue.number, key: item.key });
      }
      continue;
    }

    const parentNumber = numberByKey.get(parentKey);
    if (parentNumber === undefined) {
      pending.push({ number: issue.number, key: item.key, parentKey });
      continue;
    }
    if (issue.parentNumber !== parentNumber) {
      set.push({
        number: issue.number,
        key: item.key,
        parentNumber,
        parentKey,
      });
    }
  }

  return { set, clear, pending };
}

/**
 * Plan the create/update/close/reopen actions that bring `existingIssues`
 * into sync with `items`. Matching is **only** by
 * `parseHubMarker(issue.body) === item.key` — never by title or label — so a
 * human-filed issue (even one labeled `hub-sync`) can never be edited or
 * closed by this planner.
 *
 * Idempotency law: calling this again over the issue state its own plan
 * produced yields empty `create`/`update`/`close`/`reopen`. `staleTracker`
 * is exempt — those entries are never applied (see the runner's `--apply`
 * loop), so the issue state they were computed from is unchanged, and the
 * identical entry reproduces on every subsequent run until a human fixes
 * the tracker row it names.
 *
 * Dirty (triggers `update`) on a title/body change, a managed-label
 * drift (see {@link managedLabelsDiffer}) — the latter so a status-only
 * change (e.g. To Do → Deferred, same title/body) still reaches `editIssue`
 * and gets its {@link STATUS_LABELS} entry applied, not just its milestone —
 * **or** a changed/absent GitHub Issue Type, so `check:hub-drift` catches a
 * hand-cleared {@link Item.type}.
 *
 * A close entry for an item transitioning to Done/Rejected (not one for an
 * issue whose item vanished entirely — that case has no `item` to build a
 * payload from) carries `payload` and `labelsStale`
 * (`managedLabelsDiffer(issue.labels, payload)`) — `gh issue close` cannot
 * set labels itself, so the runner syncs labels via a separate edit call
 * before closing, but only when `labelsStale` is true, avoiding an
 * unconditional extra API call on every close (ADR-0052's 2026-08-20
 * Update — every {@link STATUS_LABELS} value is now labeled, including
 * `done`/`rejected`, so a closed issue's prior open-state status label
 * would otherwise go stale).
 *
 * `staleTracker` catches the case where GitHub and the trackers have two
 * independent writers of issue state: a merged PR's `Closes #N` keyword
 * closes the issue directly, but nothing in that PR necessarily flipped the
 * matching tracker row's Status cell. Without this bucket, an item that is
 * still unresolved on a closed-and-merged-PR issue reads exactly like a
 * genuine manual close of unfinished work and gets `reopen`ed — silently
 * re-opening work that already shipped (issue #577 / F24 was reopened this
 * way after PR #649 merged without updating the tracker). The distinguishing
 * signal is `issue.mergedClosingPrNumber`: present only when a `gh pr view`
 * lookup (done by the caller, not here — this function stays pure) confirmed
 * a referenced closing PR actually merged. A closed issue with no such PR
 * still reaches `reopen` — a real accidental/manual close of unfinished work
 * must still reopen, which is the behavior `reopen` exists for.
 *
 * @param {Item[]} items
 * @param {{ number: number, title: string, body: string, state: "open" | "closed", labels: string[], type: string | null, mergedClosingPrNumber?: number | null }[]} existingIssues
 * @returns {{
 *   create: { key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   update: { number: number, key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   close: { number: number, key: string, comment: string, reason: "completed" | "not planned", payload?: ReturnType<typeof buildIssuePayload>, labelsStale?: boolean }[],
 *   reopen: { number: number, key: string, payload: ReturnType<typeof buildIssuePayload> }[],
 *   staleTracker: { number: number, key: string, prNumber: number, sourcePath: string, sourceAnchor: string }[],
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
  const staleTracker = [];
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
      managedLabelsDiffer(issue.labels, payload) ||
      issue.type !== payload.type;

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
      } else if (issue.mergedClosingPrNumber != null) {
        // Closed by a merged PR's `Closes #N`, but the item is still
        // unresolved — the tracker row, not GitHub, is out of date. See the
        // `staleTracker` doc above; #577/F24 is the case that motivated this.
        staleTracker.push({
          number: issue.number,
          key: item.key,
          prNumber: issue.mergedClosingPrNumber,
          sourcePath: item.sourcePath,
          sourceAnchor: item.sourceAnchor,
        });
      } else {
        reopen.push({ number: issue.number, key: item.key, payload });
      }
      continue;
    }

    if (!isResolved(item.status) && issue.mergedClosingPrNumber != null) {
      // Mirror of the closed-branch case above, for an issue a maintainer
      // (or a prior stale-tracker-unaware run) already reopened: GitHub
      // still remembers the merged closing PR even after a reopen, so this
      // stays caught rather than falling through to `update`/`untouched`
      // and re-asserting an open, unresolved-looking state forever.
      staleTracker.push({
        number: issue.number,
        key: item.key,
        prNumber: issue.mergedClosingPrNumber,
        sourcePath: item.sourcePath,
        sourceAnchor: item.sourceAnchor,
      });
      continue;
    }

    if (isResolved(item.status)) {
      close.push({
        number: issue.number,
        key: item.key,
        comment: CLOSE_REASON[item.status],
        reason: CLOSE_STATE_REASON[item.status],
        payload,
        labelsStale: managedLabelsDiffer(issue.labels, payload),
      });
    } else if (isDirty) {
      update.push({ number: issue.number, key: item.key, payload });
    } else {
      untouched.push({ number: issue.number, reason: "in sync" });
    }
  }

  for (const item of items) {
    if (matchedKeys.has(item.key) || isResolved(item.status)) continue;
    // `isEpic` and `parentKey` ride along so the runner can create epics
    // first and pass `--parent` on each child's create — a link established
    // at create time needs no follow-up reconciliation pass.
    create.push({
      key: item.key,
      payload: buildIssuePayload(item),
      ...(item.isEpic === true && { isEpic: true }),
      ...(item.parentKey !== undefined && { parentKey: item.parentKey }),
    });
  }

  return { create, update, close, reopen, staleTracker, untouched };
}

// The board's single-select "Status" field carries the tracker's own
// 6-value vocabulary one-for-one (ADR-0052; widened from the original
// 3-value Pending/In review/Done ADR-0032 board, which collapsed Deferred
// and Blocked into an indistinguishable "Pending"). Every Item status now
// maps directly onto its own board option — no lossy collapsing.
const PROJECT_STATUS_OPTIONS = {
  todo: "To Do",
  "in-progress": "In Progress",
  deferred: "Deferred",
  blocked: "Blocked",
  done: "Done",
  rejected: "Rejected",
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

// Maps an Item priority (p0/p1/p2/governance) to the board Priority
// single-select's option name. p0/p1/p2/p3 mirror PRIORITY_LABELS' own
// "0-now"/"1-next"/"2-later"/"3-gated" vocabulary exactly, so the label and
// the board field never drift into two different spellings of the same tier.
// `governance` maps to its own dedicated "Governance" option (ADR-0052's
// 2026-08-20 Update) rather than a null-cleared field or a reused tier —
// ADR-0051's "governance is a category, not a tier" rule still holds
// (there is deliberately no `priority:governance` *label*), but leaving the
// board's Priority column blank for every governance row read as
// "forgotten" rather than "intentionally categorical," and reusing "2-later"
// would have conflated governance rows with real Later-tier roadmap work
// under any Priority-column sort/filter — exactly the conflation ADR-0051
// eliminated at the label layer.
export const PROJECT_PRIORITY_OPTIONS = {
  p0: "0-now",
  p1: "1-next",
  p2: "2-later",
  // Declaration ORDER is load-bearing, not cosmetic: a board single-select
  // sorts by the order its options are declared, and the Backlog view sorts
  // Priority ascending — so `3-gated` sitting between `2-later` and
  // `Governance` *is* where gated work lands in the view. Moving it would
  // silently reorder the board (ADR-0073).
  p3: "3-gated",
  governance: "Governance",
};

function projectPriorityOption(priority) {
  if (!Object.hasOwn(PROJECT_PRIORITY_OPTIONS, priority)) {
    throw new Error(
      `projectPriorityOption: no board option mapped for priority "${priority}" — ` +
        `PROJECT_PRIORITY_OPTIONS is missing an entry for a new priority value.`,
    );
  }
  return PROJECT_PRIORITY_OPTIONS[priority];
}

/**
 * A one-shot pass over **closed** hub-sync issues whose GitHub Issue Type does
 * not match their tracker row's. Pure.
 *
 * This exists because {@link planIssueSync} deliberately never recomputes a
 * closed-and-resolved issue's payload — the gap ADR-0032's 2026-07-28 Update
 * records, kept because reopening that door risks the idempotency law for
 * cosmetic corrections. A type is not cosmetic once `Type` is a board column
 * and a search facet, but it is also not worth loosening that rule for: hence a
 * separate, opt-in, run-once planner rather than a new branch inside
 * `planIssueSync`.
 *
 * Measured on the live repo (ADR-0073's 2026-08-22 Update): of 136 closed
 * marker-bearing issues, **131 carry no Issue Type at all** — `--type` reached
 * `createIssue`/`editIssue` long after most of them were filed and closed. So
 * this is overwhelmingly a *backfill*, not a re-classification; only one closed
 * issue carries the retired `Capability`.
 *
 * - `set` — the retype list. `from` is the live type (`null` when untyped),
 *   `to` the item's. Only ever emitted when the two differ, so re-running over
 *   its own applied output yields an empty `set`.
 * - `unmatched` — a closed marker-bearing issue whose marker resolves to no
 *   current tracker row, so nothing can supply its type. **Report-only**: the
 *   row was removed from the trackers, and inventing a type for it would be a
 *   guess. One exists live (#359, a W4 row dropped per ADR-0031).
 *
 * A **markerless** issue is skipped entirely and appears in neither bucket —
 * the same safety property `planIssueSync` has: match is by marker only, so a
 * hand-filed issue that happens to carry the `hub-sync` label is never written
 * to. Open issues are likewise ignored; the routine `--apply` owns those,
 * because `planIssueSync`'s `isDirty` already compares `issue.type`.
 *
 * @param {Item[]} items every tracker-derived item, resolved ones included
 * @param {{ number: number, body: string, state: "open" | "closed", type: string | null }[]} allIssues
 *   normally `loadAllIssues`' output — the UNFILTERED read, since a closed
 *   issue predating the `hub-sync` label still carries its marker
 * @returns {{ set: { number: number, key: string, from: string | null, to: string }[], unmatched: { number: number, key: string, from: string | null }[] }}
 * @example
 * ```js
 * import { planClosedRetype } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * planClosedRetype(items, [
 *   { number: 7, body: hubMarker("impl:friction:f1"), state: "closed", type: null },
 * ]).set; // [{ number: 7, key: "impl:friction:f1", from: null, to: "Friction" }]
 * ```
 */
export function planClosedRetype(items, allIssues) {
  const set = [];
  const unmatched = [];
  const itemByKey = indexItemsByKey(items);

  for (const issue of allIssues) {
    if (issue.state !== "closed") continue;

    const key = parseHubMarker(issue.body);
    if (key === null) continue;

    const item = itemByKey.get(key);
    const from = issue.type ?? null;
    if (!item) {
      unmatched.push({ number: issue.number, key, from });
      continue;
    }

    // Keyed on the marker, so an issue still filed under a legacy key retypes
    // correctly without its body being rewritten — the marker migration is
    // planIssueSync's job, and doing both here would make one --retype-closed
    // run indistinguishable from a full re-sync of the closed backlog.
    if (from !== item.type) {
      set.push({ number: issue.number, key: item.key, from, to: item.type });
    }
  }

  return { set, unmatched };
}

/**
 * Plan the add/setStatus/setPriority/archive actions that bring
 * `existingProjectItems` into sync with `trackedIssues` — the board is a
 * view over the issues hub-sync already owns, so it never adds a card for
 * anything not in `trackedIssues`, and a board item whose `issueNumber` is
 * absent from `trackedIssues` entirely (a human-added card) is always left
 * alone.
 *
 * Idempotency law: calling this again over the board state its own plan
 * produced yields empty `add`/`setStatus`/`setPriority`/`archive`.
 *
 * @param {{ number: number, state: "open" | "closed", status: Item["status"], priority: Item["priority"] }[]} trackedIssues
 * @param {{ itemId: string, issueNumber: number, status: string | null, priority: string | null }[]} existingProjectItems
 * @returns {{
 *   add: { issueNumber: number, status: string, priority: string | null }[],
 *   setStatus: { itemId: string, issueNumber: number, status: string }[],
 *   setPriority: { itemId: string, issueNumber: number, priority: string | null }[],
 *   archive: { itemId: string, issueNumber: number }[],
 * }}
 * @example
 * ```js
 * import { planProjectSync } from "@m3l-automation/workspace/bin/lib/hub-sync.mjs";
 *
 * planProjectSync(
 *   [{ number: 1, state: "open", status: "todo", priority: "p0" }],
 *   [],
 * );
 * // { add: [{ issueNumber: 1, status: "To Do", priority: "0-now" }], setStatus: [], setPriority: [], archive: [] }
 * ```
 */
export function planProjectSync(trackedIssues, existingProjectItems) {
  const add = [];
  const setStatus = [];
  const setPriority = [];
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
    const desiredPriority = projectPriorityOption(issue.priority);

    if (!projectItem) {
      add.push({
        issueNumber: issue.number,
        status: desiredStatus,
        priority: desiredPriority,
      });
      continue;
    }

    if (projectItem.status !== desiredStatus) {
      setStatus.push({
        itemId: projectItem.itemId,
        issueNumber: issue.number,
        status: desiredStatus,
      });
    }
    if ((projectItem.priority ?? null) !== desiredPriority) {
      setPriority.push({
        itemId: projectItem.itemId,
        issueNumber: issue.number,
        priority: desiredPriority,
      });
    }
  }

  return { add, setStatus, setPriority, archive };
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

  // Epics are derived scaffolding, never historical work: an epic is only
  // emitted while its section still has unresolved rows, so a "historical"
  // epic cannot exist by construction. Backfilling one would file a closed
  // issue for a grouping row that never had a life of its own, and the fuzzy
  // title match below would happily pair "Epic — Library friction" with a
  // real friction issue.
  const backfillable = items.filter((item) => item.isEpic !== true);

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

  for (const item of backfillable) {
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
