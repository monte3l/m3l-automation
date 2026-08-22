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
// Reconciliation therefore covers name, layout and filter. The
// visible-column set is written only when CREATING a view: on an existing one
// a full-replace `visibleFieldIds` would strip the built-in Type column, which
// is invisible to GraphQL and so cannot be included in the replacement
// (ADR-0075). Column order and sort order are both documented one-time manual
// steps (docs/contributing/filing-work.md) that `check:hub-views` then asserts.
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
 * There is deliberately no `legacyName` fallback. The board's original
 * `gh project create` view was named "User"; that rename to "Backlog" has
 * already run, verified live on 2026-08-22 (the board carries exactly
 * "Backlog" and "Board" — no "User" view exists). Keeping a stale alias would
 * widen the match surface of a path that can now delete. Re-check this before
 * pointing the runner at a DIFFERENT board: on one where the rename never ran,
 * `--init --apply` would create a second view beside the orphaned "User", and
 * `--prune-views --apply` would then delete "User" outright.
 *
 * `fields` names must match a live project field's `name` exactly (as
 * returned by `gh project field-list`), and the list is **ordered** — it is
 * the board's column order, not a set of columns to add. It is the order
 * `check:hub-views` ASSERTS; it is written only on view creation (ADR-0075),
 * so on the live board it is maintained by hand.
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
    // happened and stayed — the runner's own before/after capture only sees a
    // sort cleared BY a sync run, so the gate is what catches one cleared by
    // hand. Oldest highest-priority item first.
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
 * "Type" is the built-in Issue Type column, and it is absent from the API's
 * view of the board **permanently** — not "until a human enables it".
 * `ProjectV2FieldConfiguration` has no issue-type member, so the field appears
 * in neither `ProjectV2.fields` nor `configuration.visibleFields` even while
 * the board UI renders the column, and `projectV2.field(name: "Type")` answers
 * NOT_FOUND (verified 2026-08-23, ADR-0075). It is therefore added by hand from
 * the view's field picker and can never be resolved to an id, synced, or
 * asserted.
 *
 * It stays declared here so the intended column order is recorded in one place
 * and `check:hub-views` treats its absence as expected rather than as drift.
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
  "Backlog view: sort by Priority ascending, then Created ascending — not settable via the API. check:hub-views catches one cleared by hand.",
  'Backlog view: add the built-in "Type" column from the view\'s field picker. It is invisible to GraphQL (ADR-0075), so it cannot be synced and no gate can confirm it is there — check the board by eye.',
  "Backlog view: keep the columns in VIEW_DEFS order. Only a newly CREATED view gets its columns written; on an existing one a full-replace write would strip the Type column, so check:hub-views asserts the order and you fix it from the field picker.",
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
