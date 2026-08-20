// View definitions for the ADR-0032 visibility hub's GitHub Project board,
// reconciled by bin/sync-hub-projects.mjs's --init path (ADR-0052, trimmed by
// its 2026-08-20 Update).
//
// The GraphQL API bounds what can be automated here: `CreateProjectV2ViewInput`
// takes only `name`, `layout`, and `configuration` (`visibleFieldIds`);
// `UpdateProjectV2ViewInput` adds `filter`. Neither accepts `groupByFields` or
// `sortByFields` — those are readable on `ProjectV2View` but not writable
// through either mutation (verified against the live schema, 2026-08-20).
// Reconciliation therefore covers name, layout, filter, and the
// visible-column set; the rest is a documented one-time manual step
// (docs/contributing/filing-work.md).
//
// Two views only — a Roadmap view was dropped (see the ADR-0052 Update):
// `ROADMAP_LAYOUT` rejects `configuration.visibleFieldIds` outright on both
// create and update ("Roadmap views do not support visible fields"), and its
// date-field pairing was never automatable either, leaving nothing this
// module could usefully manage.
//
// `fields` names must match a live project field's `name` exactly (as
// returned by `gh project field-list`). The built-in "Type" field does not
// exist on the board until a human enables it via the project UI ("..." menu
// -> Settings -> Fields), and the GraphQL API has no mutation to enable it
// (`createProjectV2Field`'s `dataType` only accepts the custom-field types —
// TEXT/SINGLE_SELECT/MULTI_SELECT/NUMBER/DATE/ITERATION, not a built-in like
// ISSUE_TYPE) — so requesting it here would warn on every `--init` run
// indefinitely. It is deliberately left out of every `fields` list; add it
// as a column by hand after enabling the field, if wanted.

export const VIEW_DEFS = [
  {
    name: "Backlog",
    // The board's pre-ADR-0052 default table view is named "User" (created
    // by `gh project create`, never renamed). Reconciliation matches on this
    // name too, so the one pre-existing view is renamed and updated in
    // place rather than left orphaned beside a brand-new view.
    legacyName: "User",
    layout: "TABLE_LAYOUT",
    filter: "is:open",
    fields: [
      "Title",
      "Priority",
      "Status",
      "Milestone",
      "Labels",
      "Linked pull requests",
    ],
  },
  {
    name: "Board",
    layout: "BOARD_LAYOUT",
    filter: "is:open",
    fields: ["Title", "Priority", "Milestone"],
  },
];

/**
 * The one-time manual steps the GraphQL view mutations cannot perform,
 * shown after `--init` reconciles what it can. Also surfaced in
 * docs/contributing/filing-work.md so a maintainer running the UI steps
 * doesn't need to re-derive them from source.
 */
export const MANUAL_VIEW_STEPS = [
  "Board view: verify it groups by Status (Board layout defaults to grouping by the first single-select field it has, which should already be Status).",
  "Backlog view: sort by Priority ascending, then Status — not settable via the API.",
  'Optional: to show item Type as a column, enable the built-in "Type" field (Project "..." menu -> Settings -> Fields -> Type) and add it to a view by hand — neither step is settable via the API, and sync:hub does not manage this column.',
];
