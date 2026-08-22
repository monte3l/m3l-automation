// The declared vocabulary for the ADR-0032 visibility hub's GitHub Project
// board: its saved views, and its two single-select fields' option sets.
// Reconciled by bin/sync-hub-projects.mjs's --init path and asserted by
// bin/check-hub-views.mjs (ADR-0052, restructured by ADR-0073).
//
// The three option tables below moved here from bin/sync-hub-projects.mjs.
// They were the last declared-vocabulary facet still living inside a runner,
// while LABEL_DEFS, MILESTONE_DEFS and ISSUE_TYPE_DEFS all sit in bin/lib/
// read by both a runner and a gate. A gate cannot assert an option set it
// cannot import.
//
// The GraphQL API bounds what can be automated here: `CreateProjectV2ViewInput`
// takes only `name`, `layout`, and `configuration` (`visibleFieldIds`);
// `UpdateProjectV2ViewInput` adds `filter`. Neither accepts `groupByFields` or
// `sortByFields` — those are readable on `ProjectV2View` but not writable
// through either mutation (verified against the live schema, 2026-08-20).
// Reconciliation therefore covers name, layout, filter, and the
// visible-column set; sort order is a documented one-time manual step
// (docs/contributing/filing-work.md) that check:hub-views then asserts.
//
// A Roadmap view was dropped (the ADR-0052 Update): `ROADMAP_LAYOUT` rejects
// `configuration.visibleFieldIds` outright on both create and update
// ("Roadmap views do not support visible fields"), and its date-field pairing
// was never automatable either, leaving nothing this module could usefully
// manage.

/**
 * The board's saved views. **One** view, per ADR-0073 decision 2: a single
 * authoritative surface rather than a table view plus a board view that
 * drifted apart. The `Board` view is retired — deleting it is opt-in behind
 * `sync:hub-projects --prune-views`, never a side effect of `--init --apply`,
 * because a board view's group-by is not settable through any mutation and a
 * wrongly-deleted one can only be rebuilt by hand.
 *
 * `fields` names must match a live project field's `name` exactly (as
 * returned by `gh project field-list`), and the list is **ordered** —
 * `configuration.visibleFieldIds` is a full replace, so this array is the
 * board's column order, not a set of columns to add.
 */
export const VIEW_DEFS = [
  {
    name: "Backlog",
    layout: "TABLE_LAYOUT",
    filter: "is:open",
    // ADR-0073 decision 2's order: identity, then triage axes (Priority,
    // Type), then state, then placement (Milestone, Parent issue), then the
    // wide free-text tail. Every name here except "Type" is already a live
    // column; declaring the full set is what stops the next full-replace
    // update from stripping one (the 2026-08-22 near-miss: 6 declared
    // against 8 live would have dropped Created and Parent issue).
    fields: [
      "Title",
      "Priority",
      "Type",
      "Status",
      "Milestone",
      "Parent issue",
      "Labels",
      "Created",
      "Linked pull requests",
    ],
    // Not writable through either view mutation, but readable — recorded
    // here as data so check:hub-views can assert the manual step actually
    // happened and stayed. Oldest highest-priority item first.
    sort: [
      { field: "Priority", direction: "ASC" },
      { field: "Created", direction: "ASC" },
    ],
  },
];

/**
 * View field names that may legitimately be absent from the live board, so a
 * miss downgrades from a warning to an informational note.
 *
 * "Type" is the built-in Issue Type column. It does not exist on the board
 * until a human enables it via the project UI ("..." menu -> Settings ->
 * Fields), and the GraphQL API has no mutation to enable it
 * (`createProjectV2Field`'s `dataType` only accepts the custom-field types —
 * TEXT/SINGLE_SELECT/MULTI_SELECT/NUMBER/DATE/ITERATION, not a built-in like
 * ISSUE_TYPE). Without this exemption it would warn on every `--init` run
 * indefinitely; with it, the column is still declared, so it lands in the
 * visible set on the first run after a maintainer enables the field.
 *
 * Every OTHER declared name is mandatory: a name that fails to resolve skips
 * the view's update entirely rather than sending a short list into a
 * full-replace `visibleFieldIds`.
 */
export const OPTIONAL_VIEW_FIELDS = new Set(["Type"]);

/**
 * The one-time manual steps the GraphQL view mutations cannot perform,
 * shown after `--init` reconciles what it can. Also surfaced in
 * docs/contributing/filing-work.md so a maintainer running the UI steps
 * doesn't need to re-derive them from source.
 */
export const MANUAL_VIEW_STEPS = [
  "Backlog view: sort by Priority ascending, then Created ascending — not settable via the API. check:hub-views asserts it, so a cleared sort is caught rather than silently lost.",
  'Enable the built-in "Type" field (Project "..." menu -> Settings -> Fields -> Type) so it resolves to an id and lands in the Backlog view\'s columns — the field itself has no enabling mutation, but the column is declared in VIEW_DEFS and syncs automatically once it exists.',
];

// The Status single-select's desired options — the tracker's own 6-value
// vocabulary, one-for-one (ADR-0052; matches PROJECT_STATUS_OPTIONS in
// bin/lib/hub-sync.mjs). Widened from the original 3-value Pending/In
// review/Done ADR-0032 board, which could not distinguish Deferred or
// Blocked from a plain not-yet-started item.
export const DESIRED_STATUS_OPTIONS = [
  { name: "To Do", color: "GRAY", description: "" },
  { name: "In Progress", color: "GRAY", description: "" },
  { name: "Blocked", color: "GRAY", description: "" },
  { name: "Deferred", color: "GRAY", description: "" },
  { name: "Done", color: "GRAY", description: "" },
  { name: "Rejected", color: "GRAY", description: "" },
];

// Maps each ADR-0052 Status option name back to the pre-rename name it
// replaces, so migrating the field preserves every item's current value —
// updateSingleSelectOptions passes the old option's own id when renaming
// rather than dropping and recreating it. A freshly `--init`'d board has no
// option under the old name, so this lookup is a harmless no-op there.
export const STATUS_OPTION_RENAME_SOURCE = {
  "To Do": "Pending",
  "In Progress": "In review",
  Done: "Done",
};

// The Priority single-select's desired options: the four tiers mirroring
// PRIORITY_LABELS' own "0-now"/"1-next"/"2-later"/"3-gated" vocabulary
// exactly (ADR-0052, fourth tier added by ADR-0073), plus a dedicated
// "Governance" option (ADR-0052's 2026-08-20
// Update) — governance items get this instead of a null-cleared field or a
// reused tier, so the board's Priority column is never blank and never
// conflates governance rows with real Later-tier work under a sort/filter
// (see PROJECT_PRIORITY_OPTIONS in bin/lib/hub-sync.mjs for the full
// rationale). "Governance" is board-only, with no `priority:*` label
// counterpart — ADR-0051's "governance is a category, not a tier" rule is
// unaffected.
export const DESIRED_PRIORITY_OPTIONS = [
  { name: "0-now", color: "RED", description: "Now — unblock-first work." },
  {
    name: "1-next",
    color: "ORANGE",
    description: "Next — the near-term consumer-fleet wave.",
  },
  {
    name: "2-later",
    color: "YELLOW",
    description: "Later — gated or deferred backlog.",
  },
  // Order is load-bearing: a board single-select sorts by declared option
  // order and the Backlog view sorts Priority ascending, so "3-gated" sitting
  // here — after 2-later, before Governance — is where gated work lands in
  // the view. Must stay in lockstep with PROJECT_PRIORITY_OPTIONS in
  // bin/lib/hub-sync.mjs: that table is what resolves an item's option NAME,
  // and setItemSingleSelect throws if the name isn't on the live board, so a
  // tier present there but missing here breaks the first --apply that meets
  // a Gated row.
  {
    name: "3-gated",
    color: "GRAY",
    description: "Gated — cannot start until an external gate opens.",
  },
  {
    name: "Governance",
    color: "PURPLE",
    description:
      "Governance — ADR/process follow-up work; outside the priority tiers.",
  },
];
