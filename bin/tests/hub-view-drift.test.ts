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

// There is deliberately no ISSUE_TYPE field fixture. No board can have one:
// ProjectV2FieldConfiguration has no issue-type member, so the built-in Type
// field is absent from every API read even while the board UI shows the column
// (ADR-0075). A fixture claiming one would model an impossible board and test
// behavior that can never run.

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
        // No "Type": the declared column exists on the real board but is
        // invisible to the API, so a live read never returns it.
        columns: ["Title", "Priority", "Status"],
      },
    ],
    liveFields: [statusField(), priorityField()],
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
          // The same visible columns, Priority and Title swapped.
          columns: ["Priority", "Title", "Status"],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0] ?? "";
    expect(finding).toMatch(/columns are \[Priority, Title, Status\]/);
    // "Type" is dropped from the EXPECTED list too — it is unconditionally
    // exempt, so the gate never asks the board for a column it cannot see.
    expect(finding).toMatch(/expected \[Title, Priority, Status\]/);
    // The reason the order matters is carried with the finding.
    expect(finding).toMatch(/not a set/);
    // And the remedy is by hand: no mutation writes columns on an existing
    // view any more.
    expect(finding).toMatch(/by hand/);
  });

  test("an optional column absent from the live board is not counted as column drift, and raises no finding at all", () => {
    // "Type" is declared but invisible to the API, so it is legitimately
    // missing from every live read. That is the normal steady state, not
    // drift -- and unlike the pre-ADR-0075 behavior there is no ISSUE_TYPE
    // finding standing in for it either, because no board could ever clear one.
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

    expect(findings).toEqual([]);
  });

  test("sort comparison is element-wise, not a rendered-string compare", () => {
    // Same separator ambiguity sameOrder removes for columns: a field name can
    // contain both a space and a comma, so comparing "A, B ASC" strings can
    // read two different sorts as equal.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      viewDefs: [
        {
          ...BACKLOG_DEF,
          sort: [{ field: "A, B", direction: "ASC" }],
        },
      ],
      liveViews: [
        {
          ...liveBacklog(board),
          sort: [
            { field: "A", direction: "ASC" },
            { field: "B", direction: "ASC" },
          ],
        },
      ],
    });

    expect(findings.some((message) => /sort is/.test(message))).toBe(true);
  });

  test("an unmapped optional column is reported ONCE, not once per declared view", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      viewDefs: [
        { ...BACKLOG_DEF, name: "One", fields: ["Title"] },
        { ...BACKLOG_DEF, name: "Two", fields: ["Title"] },
      ],
      liveViews: [
        { ...liveBacklog(board), name: "One", columns: ["Title"] },
        { ...liveBacklog(board), name: "Two", columns: ["Title"] },
      ],
      optionalFields: new Set(["Reviewers"]),
    });

    // A property of the DECLARATION, not of any one view.
    expect(
      findings.filter((message) => /no entry in/.test(message)),
    ).toHaveLength(1);
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

  test("an optional column is exempt by its own declared reason, not because the live view happens to lack it", () => {
    // The silent-miss this gate exists to close, restated for a permanently
    // exempt column. "Type" is exempt because OPTIONAL_COLUMN_EXEMPTIONS says
    // so, NOT because the live column list is short -- so a MANDATORY column
    // going missing beside it is still reported, and the expected list still
    // omits Type rather than quietly matching whatever the board returned.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        {
          ...liveBacklog(board),
          // "Status" -- mandatory -- removed by hand.
          columns: ["Title", "Priority"],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0] ?? "";
    expect(finding).toMatch(/columns are \[Title, Priority\]/);
    expect(finding).toMatch(/expected \[Title, Priority, Status\]/);
  });

  test("an unmapped optional column is reported rather than silently exempted", () => {
    // The rule that keeps the exemption table honest: declaring a column
    // optional is not enough, it needs a stated reason. Regression guard for
    // the one property ADR-0075 did NOT relax.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      optionalFields: new Set(["Type", "Assignees"]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0] ?? "").toMatch(
      /Column "Assignees" is in OPTIONAL_VIEW_FIELDS but has no entry/,
    );
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

  test("a view def with no declared sort means EXPECT no sort — it is not an opt-out", () => {
    // Omitting the key must not silently disable the assertion: sort is the one
    // facet no mutation can repair, so a blind spot here is the worst kind.
    const { sort: _sort, ...noSortDef } = BACKLOG_DEF;
    const board = compliantBoard();

    // Live board also has no sort — matches.
    expect(
      deriveViewDrift({
        ...board,
        viewDefs: [noSortDef],
        liveViews: [{ ...liveBacklog(board), sort: [] }],
      }),
    ).toEqual([]);

    // Live board HAS a sort the def doesn't declare — now reported, where
    // previously the assertion was skipped entirely.
    const findings = deriveViewDrift({
      ...board,
      viewDefs: [noSortDef],
      liveViews: [
        {
          ...liveBacklog(board),
          sort: [{ field: "Milestone", direction: "DESC" }],
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/sort is Milestone DESC, expected none/);
  });

  test("two live views sharing a name are reported — a name-keyed match would check only one", () => {
    // The API does not constrain view names to be unique, so the duplicate was
    // neither compared (shadowed in the Map) nor caught by the undeclared-view
    // check, since its name IS declared.
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveViews: [
        liveBacklog(board),
        { ...liveBacklog(board), id: "VIEW_DUP" },
      ],
    });

    const finding = required(
      findings.find((message) => /2 views named/.test(message)),
      "duplicate-name finding",
    );
    expect(finding).toContain('"Backlog"');
    expect(finding).toMatch(/only one of them is being checked/);
  });

  test("a missing and an undeclared single-select option are reported separately, each with its own remedy", () => {
    const board = compliantBoard();
    const findings = deriveViewDrift({
      ...board,
      liveFields: [
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
      liveFields: [statusField(), priorityField([{ name: "1-next" }])],
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
      liveFields: [],
    });

    expect(
      findings.filter((message) => /does not exist/.test(message)),
    ).toHaveLength(2);
    expect(
      findings.some((message) => /missing the declared option/.test(message)),
    ).toBe(false);
  });
});
