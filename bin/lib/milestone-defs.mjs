// The single definition of every GitHub milestone the ADR-0032 visibility hub
// manages, mirroring bin/lib/label-defs.mjs' shape and role. Split out for the
// same reason: bin/sync-hub-issues.mjs applies these and a drift check reads
// them, so both must derive from one source rather than one re-deriving what
// the other last wrote.
//
// Milestones were the last facet of the ADR-0051 vocabulary with no
// declaration at all (ADR-0073): labels had LABEL_DEFS plus a byte-for-byte
// check:label-drift gate, the board's single-selects had DESIRED_*_OPTIONS
// reconciled by --init, and milestones had a bare title string in
// MILESTONE_TITLES and a create-only planner. The consequence was visible on
// the live repo: all five milestones carried a null description, and the
// `major` tier had accumulated two milestones -- "Breaking" and
// "2.0 / breaking" -- because a create-only planner could never describe or
// rename its way back to one.
import { MILESTONE_TITLES, PRIORITY_TIERS } from "./hub-sync.mjs";

/**
 * Every hub-managed milestone, keyed to a {@link MILESTONE_TITLES} entry.
 *
 * `legacyTitles` mirrors `Item.legacyKeys`: it names the titles this milestone
 * has previously been called, so a rename is an in-place `PATCH` by number
 * that preserves every issue association rather than a create-plus-abandon
 * that would strand them. Two entries carry one because ADR-0073 renamed
 * them — `Next — consumer fleet` was already wrong (of the 28 open `p1` items
 * exactly 2 were consumer scripts) and `Later — gated/deferred` became wrong
 * the moment the `3-gated` tier existed. A third, `major`, carries one because
 * ADR-0074 reverted its title rather than renaming it forward.
 *
 * A `legacyTitles` entry is **not** a promise to rename: if the def's current
 * title already exists live, that milestone is the match and the
 * legacy-titled one is an orphan, because GitHub rejects a `PATCH` that would
 * duplicate an existing title. That is the live situation for `major` — both
 * `Breaking` and `2.0 / breaking` exist — and it is why `planMilestones`
 * prefers a title match over a legacy match rather than renaming blindly.
 * ADR-0074 chose `Breaking` as the declared title so that match lands on the
 * milestone actually holding the closed breaking work, not the empty one.
 *
 * Descriptions for the four priority tiers come from {@link PRIORITY_TIERS},
 * the same table `LABEL_DEFS` reads, so a tier's label and its milestone
 * cannot drift into two different descriptions of one thing.
 *
 * @type {{ key: string, title: string, description: string, legacyTitles: string[] }[]}
 * @example
 * ```js
 * import { MILESTONE_DEFS } from "@m3l-automation/workspace/bin/lib/milestone-defs.mjs";
 *
 * MILESTONE_DEFS.find((def) => def.key === "p3").title; // "Gated — awaiting trigger"
 * ```
 */
export const MILESTONE_DEFS = [
  {
    key: "p0",
    title: MILESTONE_TITLES.p0,
    description: PRIORITY_TIERS.p0.description,
    legacyTitles: [],
  },
  {
    key: "p1",
    title: MILESTONE_TITLES.p1,
    description: PRIORITY_TIERS.p1.description,
    legacyTitles: ["Next — consumer fleet"],
  },
  {
    key: "p2",
    title: MILESTONE_TITLES.p2,
    description: PRIORITY_TIERS.p2.description,
    legacyTitles: ["Later — gated/deferred"],
  },
  {
    key: "p3",
    title: MILESTONE_TITLES.p3,
    description: PRIORITY_TIERS.p3.description,
    legacyTitles: [],
  },
  {
    key: "governance",
    title: MILESTONE_TITLES.governance,
    description:
      "Governance — ADR/process follow-up work; outside the priority tiers.",
    legacyTitles: [],
  },
  {
    key: "major",
    title: MILESTONE_TITLES.major,
    description: "Work that needs a major version bump before it can be built.",
    // ADR-0074 reverted this to "Breaking". `m3l-common` is at 4.x, so "2.0"
    // named no reachable version — ADR-0044 found the same thing back at
    // 2.4.0 — and every other title here is a horizon, not a version. Both
    // titles exist live, so this resolves as an orphan report rather than a
    // rename, and the title match is the milestone carrying the closed
    // breaking work. See the note above.
    legacyTitles: ["2.0 / breaking"],
  },
];

// Every MILESTONE_TITLES key must have exactly one def, or buildIssuePayload
// could resolve an item to a milestone title this module never describes or
// creates — the milestone-side twin of LABEL_DEFS' managed-label assertion.
// Asserted at module load, before any `gh` call, rather than discovered as a
// half-applied migration.
const definedKeys = MILESTONE_DEFS.map((def) => def.key);
for (const key of Object.keys(MILESTONE_TITLES)) {
  const matches = definedKeys.filter((defined) => defined === key);
  if (matches.length !== 1) {
    throw new Error(
      `MILESTONE_TITLES.${key} has ${matches.length} MILESTONE_DEFS entries (expected exactly 1) — ` +
        `planMilestones would never create, rename, or describe this tier's milestone.`,
    );
  }
}

// A title claimed by two defs' legacyTitles would make a rename
// order-dependent: whichever def the planner reached first would win the live
// milestone and the other would silently create a duplicate.
const claimed = new Map();
for (const def of MILESTONE_DEFS) {
  for (const legacy of def.legacyTitles) {
    const owner = claimed.get(legacy);
    if (owner !== undefined) {
      throw new Error(
        `"${legacy}" appears in legacyTitles for both "${owner}" and "${def.key}" — ` +
          `a rename would be order-dependent. A legacy title belongs to exactly one def.`,
      );
    }
    claimed.set(legacy, def.key);
  }
}

// A def whose own current title also appears as some def's legacy title would
// make the planner's title-match-first rule ambiguous.
for (const def of MILESTONE_DEFS) {
  if (claimed.has(def.title)) {
    throw new Error(
      `"${def.title}" is both MILESTONE_DEFS["${def.key}"].title and a legacyTitles entry ` +
        `for "${claimed.get(def.title)}" — resolve which def owns that title.`,
    );
  }
}
