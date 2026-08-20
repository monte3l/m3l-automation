// View definitions for the ADR-0032 visibility hub's GitHub Project board,
// reconciled by bin/sync-hub-projects.mjs's --init path (ADR-0052).
//
// The GraphQL API bounds what can be automated here: `CreateProjectV2ViewInput`
// takes only `name`, `layout`, and `configuration` (`visibleFieldIds`);
// `UpdateProjectV2ViewInput` adds `filter`. Neither accepts `groupByFields`,
// `sortByFields`, or a Roadmap view's paired date fields — those are readable
// on `ProjectV2View` but not writable through either mutation (verified
// against the live schema, 2026-08-20). Reconciliation therefore covers name,
// layout, filter, and the visible-column set; the rest is a documented
// one-time manual step (docs/contributing/filing-work.md).
//
// `fields` names must match a live project field's `name` exactly (as
// returned by `gh project field-list`) — the runner resolves each to its id
// and silently drops (with a warning) any name that doesn't currently
// resolve, since the built-in "Type" field is enabled per-board via the
// project UI ("..." menu -> Settings -> Fields) and does not exist until a
// human turns it on.

export const VIEW_DEFS = [
  {
    name: "Backlog",
    // The board's pre-ADR-0052 default table view is named "User" (created
    // by `gh project create`, never renamed). Reconciliation matches on this
    // name too, so the one pre-existing view is renamed and updated in
    // place rather than left orphaned beside a brand-new fourth view.
    legacyName: "User",
    layout: "TABLE_LAYOUT",
    filter: "is:open",
    fields: [
      "Title",
      "Type",
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
    fields: ["Title", "Type", "Priority", "Milestone"],
  },
  {
    name: "Timeline",
    layout: "ROADMAP_LAYOUT",
    filter: "is:open",
    fields: ["Title", "Type", "Priority", "Status"],
  },
];

/**
 * The one-time manual steps the GraphQL view mutations cannot perform,
 * shown after `--init` reconciles what it can. Also surfaced in
 * docs/contributing/filing-work.md so a maintainer running the UI steps
 * doesn't need to re-derive them from source.
 */
export const MANUAL_VIEW_STEPS = [
  'Enable the built-in "Type" field (Project "..." menu -> Settings -> Fields -> Type) if it is not already on — it does not exist as a field until a human turns it on, so no view can show it until this step runs once.',
  "Board view: verify it groups by Status (Board layout defaults to grouping by the first single-select field it has, which should already be Status).",
  "Backlog view: sort by Priority ascending, then Status — not settable via the API.",
  "Timeline view: pair the roadmap to the built-in Created (start) and Updated (target) date fields, and set the zoom level — date-field pairing is not settable via the API.",
];
