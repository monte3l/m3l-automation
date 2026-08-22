import { describe, expect, test } from "vitest";
import { deriveViewDrift } from "../lib/hub-view-drift.mjs";

// ---------------------------------------------------------------------------
// Synthetic fixtures — deliberately not the real bin/lib/hub-views.mjs
// values, mirroring bin/tests/label-drift.test.ts's split: deriveViewDrift is
// a pure diff and its behavior does not depend on the real ADR-0073
// declaration. bin/tests/check-hub-views.test.ts covers the real VIEW_DEFS
// integration.
// ---------------------------------------------------------------------------

const BACKLOG_DEF = {
  name: "Backlog",
  layout: "TABLE_LAYOUT",
  filter: "is:open",
  fields: ["Title", "Priority", "Type", "Status"],
  sort: [
    { field: "Priority", direction: "ASC" },
    { field: "Created", direction: "ASC" },
  ],
};

const STATUS_OPTIONS = [{ name: "To Do" }, { name: "Done" }];
const PRIORITY_OPTIONS = [{ name: "0-now" }, { name: "1-next" }];

const ISSUE_TYPE_FIELD = { name: "Type", dataType: "ISSUE_TYPE" };

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`hub-view-drift.test.ts: expected ${what}`);
  }
  return value;
}

/** The compliant board's single live view, for tests that vary one facet. */
function liveBacklog(board: ReturnType<typeof compliantBoard>) {
  return required(board.liveViews[0], "compliantBoard().liveViews[0]");
}

function statusField(options = STATUS_OPTIONS) {
  return { name: "Status", dataType: "SINGLE_SELECT", options };
}

function priorityField(options = PRIORITY_OPTIONS) {
  return { name: "Priority", dataType: "SINGLE_SELECT", options };
}

/** A board that matches BACKLOG_DEF in every asserted respect. */
function compliantBoard() {
  return {
    viewDefs: [BACKLOG_DEF],
    liveViews: [
      {
        id: "VIEW_1",
        name: "Backlog",
        layout: "TABLE_LAYOUT",
        filter: "is:open",
        sort: [
          { field: "Priority", direction: "ASC" },
          { field: "Created", direction: "ASC" },
        ],
        columns: ["Title", "Priority", "Type", "Status"],
      },
    ],
    liveFields: [ISSUE_TYPE_FIELD, statusField(), priorityField()],
    optionalFields: new Set(["Type"]),
    desiredStatusOptions: STATUS_OPTIONS,
    desiredPriorityOptions: PRIORITY_OPTIONS,
  };
}

describe("deriveViewDrift", () => {
  test("a board matching the declaration in every respect reports no drift", () => {
    expect(deriveViewDrift(compliantBoard())).toEqual([]);
  });

  test("a declared view that does not exist is reported once, with the --init remedy, and its other facets are not also reported", () => {
    const findings = deriveViewDrift({ ...compliantBoard(), liveViews: [] });

    // Exactly one view finding — a missing view must not cascade into layout,
    // filter, column and sort findings for a view that isn't there.
    const viewFindings = findings.filter((message) =>
      /view "Backlog"/i.test(message),
    );
    expect(viewFindings).toHaveLength(1);
    expect(viewFindings[0]).toMatch(/does not exist on the board/);
    expect(viewFindings[0]).toMatch(/--init --apply/);
  });

  test("an undeclared view still on the board is reported, naming --prune-views and its irreversibility", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        ...board.liveViews,
        {
          id: "VIEW_2",
          name: "Board",
          layout: "BOARD_LAYOUT",
          filter: "is:open",
          sort: [],
          columns: [],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0] ?? "";
    expect(finding).toContain('"Board"');
    expect(finding).toMatch(/--prune-views --apply/);
    expect(finding).toMatch(/irreversible/);
  });

  test("a drifted layout and a drifted filter are reported separately", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        {
          ...liveBacklog(board),
          layout: "BOARD_LAYOUT",
          filter: "is:closed",
        },
      ],
    });

    expect(
      findings.some((message) => /layout BOARD_LAYOUT/.test(message)),
    ).toBe(true);
    expect(
      findings.some((message) => /filter is "is:closed"/.test(message)),
    ).toBe(true);
  });

  test("columns are asserted in ORDER — the same set in a different order is drift", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        {
          ...liveBacklog(board),
          // Same four columns, Priority and Title swapped.
          columns: ["Priority", "Title", "Type", "Status"],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0] ?? "";
    expect(finding).toMatch(/columns are \[Priority, Title, Type, Status\]/);
    expect(finding).toMatch(/expected \[Title, Priority, Type, Status\]/);
    // The reason the order matters is carried with the finding.
    expect(finding).toMatch(/not a set/);
  });

  test("an optional column absent from the live board is not counted as column drift", () => {
    // "Type" is declared but the field isn't enabled, so it is legitimately
    // missing from both the field list and the view's columns. The ISSUE_TYPE
    // finding covers that cause; a column finding would name it twice.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        {
          ...liveBacklog(board),
          columns: ["Title", "Priority", "Status"],
        },
      ],
      liveFields: [statusField(), priorityField()],
    });

    expect(findings.some((message) => /columns are/.test(message))).toBe(false);
    expect(
      findings.some((message) => /no ISSUE_TYPE field/.test(message)),
    ).toBe(true);
  });

  test("an optional column with no stated exemption reason is reported, not silently exempted", () => {
    // A gate must not grow blind spots by declaration alone: adding a name to
    // OPTIONAL_VIEW_FIELDS without saying WHY it may be absent would otherwise
    // exempt it from the column assertion forever.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      viewDefs: [{ ...BACKLOG_DEF, fields: ["Title", "Reviewers"] }],
      liveViews: [{ ...liveBacklog(board), columns: ["Title"] }],
      optionalFields: new Set(["Reviewers"]),
    });

    const finding = required(
      findings.find((message) => /no entry in/.test(message)),
      "unmapped-exemption finding",
    );
    expect(finding).toContain("Reviewers");
    expect(finding).toMatch(/OPTIONAL_COLUMN_EXEMPTIONS/);
    expect(finding).toMatch(/untested blind spot/);
  });

  test("column comparison is element-wise, so a split name is not read as equal to a spaced one", () => {
    // Declared names contain spaces ("Parent issue", "Linked pull requests"),
    // so a joined-string compare would read ["Parent issue"] and
    // ["Parent", "issue"] as identical.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      viewDefs: [{ ...BACKLOG_DEF, fields: ["Parent issue"] }],
      liveViews: [{ ...liveBacklog(board), columns: ["Parent", "issue"] }],
    });

    expect(findings.some((message) => /columns are/.test(message))).toBe(true);
  });

  test("an optional column removed BY HAND while its field IS enabled is reported — the exemption is not unconditional", () => {
    // The silent-miss this gate exists to close. The exemption previously keyed
    // on the live column's absence, so with the ISSUE_TYPE field enabled and
    // the "Type" column deleted from the view, neither the column check nor the
    // ISSUE_TYPE check fired and the board read as clean.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        {
          ...liveBacklog(board),
          columns: ["Title", "Priority", "Status"],
        },
      ],
      // Field present — so "Type" is mandatory, not exempt.
      liveFields: [ISSUE_TYPE_FIELD, statusField(), priorityField()],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0] ?? "";
    expect(finding).toMatch(/columns are \[Title, Priority, Status\]/);
    expect(finding).toMatch(/expected \[Title, Priority, Type, Status\]/);
    // And NOT the ISSUE_TYPE message — the field is there; the column isn't.
    expect(
      findings.some((message) => /no ISSUE_TYPE field/.test(message)),
    ).toBe(false);
  });

  test("a cleared sort is reported as a MANUAL fix, never as something a sync can repair", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [{ ...liveBacklog(board), sort: [] }],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0] ?? "";
    expect(finding).toMatch(/sort is none/);
    expect(finding).toContain("Priority ASC, Created ASC");
    expect(finding).toMatch(/NOT writable/);
    // Crucially it must NOT suggest a sync — no mutation can set a sort.
    expect(finding).not.toMatch(/--init --apply/);
  });

  test("a sort in the right fields but the wrong direction is drift", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        {
          ...liveBacklog(board),
          sort: [
            { field: "Priority", direction: "ASC" },
            { field: "Created", direction: "DESC" },
          ],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/Created DESC/);
  });

  test("a view def with no declared sort does not assert one", () => {
    const { sort: _sort, ...noSortDef } = BACKLOG_DEF;
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      viewDefs: [noSortDef],
      liveViews: [{ ...liveBacklog(board), sort: [] }],
    });

    expect(findings).toEqual([]);
  });

  test('a missing ISSUE_TYPE field is matched on dataType, not on the name "Type"', () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      // A field literally NAMED "Type" but of the wrong dataType must not
      // satisfy the assertion — that would pass for a hand-made single-select
      // masquerading as the built-in.
      liveFields: [
        { name: "Type", dataType: "SINGLE_SELECT", options: [] },
        statusField(),
        priorityField(),
      ],
    });

    expect(
      findings.some((message) => /no ISSUE_TYPE field/.test(message)),
    ).toBe(true);
  });

  test("a missing and an undeclared single-select option are reported separately, each with its own remedy", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveFields: [
        ISSUE_TYPE_FIELD,
        statusField([{ name: "To Do" }, { name: "Archived" }]),
        priorityField(),
      ],
    });

    expect(
      findings.some((message) =>
        /missing the declared option "Done"/.test(message),
      ),
    ).toBe(true);
    const extra = findings.find((message) =>
      /undeclared option "Archived"/.test(message),
    );
    expect(extra).toBeDefined();
    // The full-REPLACE warning travels with the finding: that is the 2026-08-20
    // hazard, and the reason reconciling relies on own-name-first id lookup.
    expect(extra).toMatch(/full REPLACE/);
  });

  test("the right options in the wrong ORDER are drift, because a single-select sorts by declared order", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveFields: [
        ISSUE_TYPE_FIELD,
        statusField(),
        priorityField([{ name: "1-next" }, { name: "0-now" }]),
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/wrong order/);
    expect(findings[0]).toMatch(/single-select sorts by declared option order/);
  });

  test("an order complaint is suppressed while the sets themselves still differ", () => {
    // Otherwise every missing/extra option would also produce an order
    // finding restating the same difference.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveFields: [
        ISSUE_TYPE_FIELD,
        statusField(),
        priorityField([{ name: "1-next" }]),
      ],
    });

    expect(findings.some((message) => /wrong order/.test(message))).toBe(false);
    expect(
      findings.some((message) => /missing the declared option/.test(message)),
    ).toBe(true);
  });

  test("a missing Status or Priority field is reported without also reporting every option as missing", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveFields: [ISSUE_TYPE_FIELD],
    });

    expect(
      findings.filter((message) => /does not exist/.test(message)),
    ).toHaveLength(2);
    expect(
      findings.some((message) => /missing the declared option/.test(message)),
    ).toBe(false);
  });
});
