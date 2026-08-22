import { describe, expect, test } from "vitest";
import { HUB_PROJECT_TITLE } from "../lib/hub-sync.mjs";
import {
  DESIRED_PRIORITY_OPTIONS,
  DESIRED_STATUS_OPTIONS,
  OPTIONAL_VIEW_FIELDS,
  VIEW_DEFS,
} from "../lib/hub-views.mjs";
import { deriveViewDrift } from "../lib/hub-view-drift.mjs";
import { isScopeError, runHubViewsCheck } from "../check-hub-views.mjs";

// bin/check-hub-views.mjs exports its seams (unlike check-label-drift.mjs,
// which keeps everything behind the main guard) specifically so the
// graceful-skip branch is assertable: that branch exits 0, so a regression in
// it would otherwise look identical to a clean board and the gate would go
// quietly dead.

// Mirrors createReporter's full surface, not just the methods this gate
// happens to call: a partial double is a type error at the call site, and
// (worse) an invented or missing method reads as a passing test until the real
// reporter throws on it -- which is how a `change("deleted", ...)` crash
// reached PR 6.
interface FakeReporter {
  errors: string[];
  warnings: string[];
  infos: string[];
  changes: { kind: string; file: string }[];
  succeeded: string[];
  finishedWith: Record<string, unknown>;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  change: (
    kind: "updated" | "created" | "removed",
    file: string,
    note?: string,
  ) => void;
  succeed: (message: string) => void;
  finish: (extra?: Record<string, unknown>) => Record<string, unknown>;
}

function createFakeReporter(): FakeReporter {
  const reporter: FakeReporter = {
    errors: [],
    warnings: [],
    infos: [],
    changes: [],
    succeeded: [],
    finishedWith: {},
    error(message) {
      reporter.errors.push(message);
    },
    warn(message) {
      reporter.warnings.push(message);
    },
    info(message) {
      reporter.infos.push(message);
    },
    change(kind, file) {
      reporter.changes.push({ kind, file });
    },
    succeed(message) {
      reporter.succeeded.push(message);
    },
    finish(extra = {}) {
      reporter.finishedWith = extra;
      return { ...extra };
    },
  };
  return reporter;
}

function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`check-hub-views.test.ts: expected ${what}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// A live board built FROM the real declaration, so the compliant fixture can
// never drift away from VIEW_DEFS and quietly stop asserting anything.
// ---------------------------------------------------------------------------

const DECLARED = required(VIEW_DEFS[0], "VIEW_DEFS[0]");

/** Every declared column except the ones legitimately absent until enabled. */
const MANDATORY_COLUMNS = DECLARED.fields.filter(
  (name: string) => !OPTIONAL_VIEW_FIELDS.has(name),
);

function statusFieldPayload(): unknown {
  return {
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: DESIRED_STATUS_OPTIONS.map((option) => ({ name: option.name })),
  };
}

function priorityFieldPayload(): unknown {
  return {
    name: "Priority",
    dataType: "SINGLE_SELECT",
    options: DESIRED_PRIORITY_OPTIONS.map((option) => ({ name: option.name })),
  };
}

function viewPayload(columns: string[]): unknown {
  return {
    id: "VIEW_1",
    name: DECLARED.name,
    layout: DECLARED.layout,
    filter: DECLARED.filter,
    sortByFields: {
      nodes: (DECLARED.sort ?? []).map(
        (pair: { field: string; direction: string }) => ({
          direction: pair.direction,
          field: { name: pair.field },
        }),
      ),
    },
    fields: { nodes: columns.map((name) => ({ name })) },
  };
}

/**
 * A board that matches the declaration in every asserted respect: the
 * ISSUE_TYPE field enabled AND every declared column shown. The two travel
 * together — an optional column is exempt only while its field cannot exist,
 * so a payload claiming the field but omitting the column is drift, not a
 * clean board.
 */
function compliantBoardPayload(
  overrides: { views?: unknown[]; fields?: unknown[] } = {},
): string {
  const views = overrides.views ?? [viewPayload([...DECLARED.fields])];
  const fields = overrides.fields ?? [
    statusFieldPayload(),
    priorityFieldPayload(),
    { name: "Type", dataType: "ISSUE_TYPE" },
  ];
  return JSON.stringify({
    data: { node: { views: { nodes: views }, fields: { nodes: fields } } },
  });
}

/**
 * A `gh` stub answering the three reads the gate makes: project list, project
 * view (for the node id), and the single board GraphQL query. Any other call
 * throws, so a test reaching further fails loudly.
 */
function boardGh(
  boardPayload: string,
  {
    projects = [{ number: 2, title: HUB_PROJECT_TITLE }],
    throwOn,
  }: {
    projects?: unknown[];
    throwOn?: { match: RegExp; message: string };
  } = {},
): { runGh: (args: string[]) => string; calls: string[][] } {
  const calls: string[][] = [];
  function runGh(args: string[]): string {
    calls.push(args);
    const joined = args.join(" ");
    if (throwOn && throwOn.match.test(joined)) {
      throw new Error(throwOn.message);
    }
    if (args[0] === "project" && args[1] === "list") {
      return JSON.stringify(projects);
    }
    if (args[0] === "project" && args[1] === "view") {
      return JSON.stringify({ id: "PROJECT_NODE_ID" });
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return boardPayload;
    }
    throw new Error(
      `check-hub-views.test.ts: unscripted gh call: ${JSON.stringify(args)}`,
    );
  }
  return { runGh, calls };
}

// ---------------------------------------------------------------------------
// isScopeError
// ---------------------------------------------------------------------------

describe("isScopeError", () => {
  test.each([
    "your token has not been granted the required scopes to execute this query",
    "This endpoint requires one of the following scopes: read:project",
    "Resource not accessible by integration",
    "gh: To get started with GitHub CLI, please run: gh auth login",
    "error connecting to api.github.com: no authentication token",
    "You must be authenticated to access this resource",
  ])("treats %s as a missing capability", (message) => {
    expect(isScopeError(message)).toBe(true);
  });

  test.each([
    "HTTP 502: Bad gateway",
    "Could not resolve to a node with the global id of 'PVT_x'",
    "connect ETIMEDOUT 140.82.121.6:443",
    "GraphQL: Field 'sortByFields' doesn't exist on type 'ProjectV2View'",
  ])("does NOT treat %s as a missing capability", (message) => {
    // A broad match here would turn every outage into a silent pass — the one
    // failure mode a graceful-skip gate must not have.
    expect(isScopeError(message)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runHubViewsCheck
// ---------------------------------------------------------------------------

describe("runHubViewsCheck", () => {
  test("a board matching the real VIEW_DEFS passes with no findings", () => {
    const { runGh } = boardGh(compliantBoardPayload());
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome).toMatchObject({ ok: true, skipped: false, findings: [] });
    expect(reporter.errors).toEqual([]);
    expect(reporter.succeeded).toHaveLength(1);
  });

  test("a board with the ISSUE_TYPE field NOT yet enabled and the optional column absent is also clean", () => {
    // The exemption path, as its own fixture rather than as a property of the
    // compliant one: before a human enables the field, neither the field nor
    // the column can exist, and the ISSUE_TYPE finding alone names that cause.
    const { runGh } = boardGh(
      compliantBoardPayload({
        views: [viewPayload(MANDATORY_COLUMNS)],
        fields: [statusFieldPayload(), priorityFieldPayload()],
      }),
    );
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    // Exactly one finding, and it is the ISSUE_TYPE one — no column complaint
    // piled on top naming the same cause.
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatch(/no ISSUE_TYPE field/);
  });

  test("the two fixtures actually differ, so neither passes for the wrong reason", () => {
    expect(OPTIONAL_VIEW_FIELDS.size).toBeGreaterThan(0);
    expect(MANDATORY_COLUMNS.length).toBeLessThan(DECLARED.fields.length);
  });

  test("drift fails the gate, reporting one error per finding and returning them", () => {
    const { runGh } = boardGh(
      compliantBoardPayload({
        views: [
          {
            ...(viewPayload([...DECLARED.fields]) as Record<string, unknown>),
            sortByFields: { nodes: [] },
          },
          {
            id: "VIEW_2",
            name: "Board",
            layout: "BOARD_LAYOUT",
            filter: "is:open",
            sortByFields: { nodes: [] },
            fields: { nodes: [] },
          },
        ],
      }),
    );
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(false);
    // The cleared sort AND the undeclared view.
    expect(outcome.findings).toHaveLength(2);
    expect(reporter.errors).toHaveLength(2);
    expect(reporter.finishedWith).toMatchObject({ skipped: false });
  });

  test("a scope error is a LOUD graceful skip: ok, skipped, exit-0 shaped, and it names every unverified facet", () => {
    const { runGh } = boardGh(compliantBoardPayload(), {
      throwOn: {
        match: /api graphql/,
        message:
          "your token has not been granted the required scopes to execute this query",
      },
    });
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    // ok:true is what keeps CI green for a missing capability...
    expect(outcome.ok).toBe(true);
    // ...and skipped:true is what stops that being indistinguishable from a
    // verified-clean board.
    expect(outcome.skipped).toBe(true);
    expect(reporter.errors).toEqual([]);
    expect(reporter.finishedWith).toMatchObject({ skipped: true });

    const warnings = reporter.warnings.join("\n");
    expect(warnings).toMatch(/cannot read GitHub Projects v2/);
    for (const facet of [
      "the view set",
      "layout and filter",
      "ordered visible columns",
      "sort order",
      "ISSUE_TYPE",
      "Status and Priority option sets",
    ]) {
      expect(warnings).toContain(facet);
    }
    // And it says how to actually verify them.
    expect(warnings).toMatch(/`project` scope/);
  });

  test("a NON-scope failure fails the gate rather than skipping it", () => {
    const { runGh } = boardGh(compliantBoardPayload(), {
      throwOn: { match: /api graphql/, message: "HTTP 502: Bad gateway" },
    });
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome).toMatchObject({ ok: false, skipped: false });
    expect(reporter.errors.some((message) => /502/.test(message))).toBe(true);
    expect(reporter.warnings).toEqual([]);
  });

  test("a null `node` in the GraphQL response fails with a board-shaped diagnostic, not a TypeError", () => {
    // A real response: the board can be deleted, or its id become unreadable,
    // between the `project view` call and this query. Dereferencing it blind
    // surfaced as "Cannot read properties of null (reading 'views')".
    const { runGh } = boardGh(JSON.stringify({ data: { node: null } }));
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome).toMatchObject({ ok: false, skipped: false });
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toMatch(/returned no data/);
    expect(message).toMatch(/may have been deleted/);
    expect(message).not.toMatch(/Cannot read properties/);
    // A missing board is a failure, never a graceful skip.
    expect(reporter.warnings).toEqual([]);
  });

  test("a view page that reaches its window fails loudly rather than under-reading", () => {
    // An undeclared view past the window would be invisible to the
    // both-directions assertion, so reaching it is a hard error -- the same
    // convention LIST_LIMIT uses in bin/sync-hub-projects.mjs.
    const overflowing = Array.from({ length: 20 }, (_unused, index) => ({
      id: `VIEW_${index}`,
      name: index === 0 ? DECLARED.name : `Extra ${index}`,
      layout: "TABLE_LAYOUT",
      filter: "is:open",
      sortByFields: { nodes: [] },
      fields: { nodes: [] },
    }));
    const { runGh } = boardGh(compliantBoardPayload({ views: overflowing }));
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome).toMatchObject({ ok: false, skipped: false });
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toMatch(/reaching the first:20 window/);
    expect(message).toMatch(/would go unreported/);
  });

  // Every exit path, not one of them. The earlier version of this test
  // exercised only the non-scope failure, which is exactly why the
  // board-title-miss path kept shipping without the keys the test claims are
  // universal.
  test.each([
    ["clean", () => boardGh(compliantBoardPayload()), { skipped: false }],
    [
      "drift",
      () =>
        boardGh(
          compliantBoardPayload({
            views: [
              {
                ...(viewPayload([...DECLARED.fields]) as Record<
                  string,
                  unknown
                >),
                sortByFields: { nodes: [] },
              },
            ],
          }),
        ),
      { skipped: false },
    ],
    [
      "scope-error skip",
      () =>
        boardGh(compliantBoardPayload(), {
          throwOn: {
            match: /api graphql/,
            message: "not been granted the required scopes",
          },
        }),
      { findings: [], skipped: true },
    ],
    [
      "non-scope failure",
      () =>
        boardGh(compliantBoardPayload(), {
          throwOn: { match: /api graphql/, message: "HTTP 502: Bad gateway" },
        }),
      { findings: [], skipped: false },
    ],
    [
      "board title miss",
      () =>
        boardGh(compliantBoardPayload(), {
          projects: [{ number: 9, title: "m3l-automation hub" }],
        }),
      { findings: [], skipped: false },
    ],
  ])(
    "the %s path's finish() payload carries both findings and skipped",
    (_label, makeGh, expected) => {
      const { runGh } = makeGh();
      const reporter = createFakeReporter();

      runHubViewsCheck({ runGh, reporter });

      expect(reporter.finishedWith).toHaveProperty("findings");
      expect(reporter.finishedWith).toHaveProperty("skipped");
      expect(reporter.finishedWith).toMatchObject(expected);
    },
  );

  test("a view whose own column connection reaches its window fails loudly rather than reporting misleading column drift", () => {
    // Under-reading a view's columns is worse than a bare under-read: it
    // produces a confident column-drift finding naming columns the view
    // actually shows.
    const { runGh } = boardGh(
      compliantBoardPayload({
        views: [
          viewPayload(
            Array.from({ length: 50 }, (_unused, index) => `Column ${index}`),
          ),
        ],
      }),
    );
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome).toMatchObject({ ok: false, skipped: false });
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toMatch(/reaching the first:50 window/);
    expect(message).toMatch(/misleading column-drift/);
    // Must NOT have produced a column-drift finding instead.
    expect(outcome.findings).toEqual([]);
  });

  test("a board title miss fails with a rename hint, and never reads the board", () => {
    const { runGh, calls } = boardGh(compliantBoardPayload(), {
      projects: [{ number: 9, title: "m3l-automation hub" }],
    });
    const reporter = createFakeReporter();

    const outcome = runHubViewsCheck({ runGh, reporter });

    expect(outcome.ok).toBe(false);
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toContain(HUB_PROJECT_TITLE);
    expect(message).toMatch(/renamed/);
    // Resolution is by title, so it must not have gone on to query a board.
    expect(
      calls.some((args) => args[0] === "api" && args[1] === "graphql"),
    ).toBe(false);
  });

  test("every gh call is an argv array, never a shell string", () => {
    const { runGh, calls } = boardGh(compliantBoardPayload());
    const reporter = createFakeReporter();

    runHubViewsCheck({ runGh, reporter });

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(Array.isArray(args)).toBe(true);
      for (const token of args) expect(typeof token).toBe("string");
    }
  });

  test("the gate makes no mutating call on any path", () => {
    const { runGh, calls } = boardGh(compliantBoardPayload());
    const reporter = createFakeReporter();

    runHubViewsCheck({ runGh, reporter });

    for (const args of calls) {
      expect(args.join(" ")).not.toMatch(/mutation \{/);
      expect(args).not.toContain("--apply");
    }
  });
});

// ---------------------------------------------------------------------------
// The real declaration, wired through the real derivation — the integration
// half, mirroring bin/tests/check-label-drift.test.ts.
// ---------------------------------------------------------------------------

describe("check-hub-views: the real VIEW_DEFS against a live board payload", () => {
  test("VIEW_DEFS declares exactly one view (ADR-0073's single authoritative surface)", () => {
    expect(VIEW_DEFS).toHaveLength(1);
    expect(DECLARED.name).toBe("Backlog");
    expect(DECLARED.layout).toBe("TABLE_LAYOUT");
  });

  test("the declared sort is Priority ASC then Created ASC — oldest highest-priority first", () => {
    expect(DECLARED.sort).toEqual([
      { field: "Priority", direction: "ASC" },
      { field: "Created", direction: "ASC" },
    ]);
  });

  test("Created and Parent issue are declared — the two live columns a 6-name declaration would have stripped", () => {
    // The 2026-08-22 near-miss: visibleFieldIds is a full replace, so a
    // declaration short of the live column set deletes the difference.
    expect(DECLARED.fields).toContain("Created");
    expect(DECLARED.fields).toContain("Parent issue");
  });

  test("an empty board reports the full set of findings, each carrying a remedy", () => {
    const findings = deriveViewDrift({
      viewDefs: VIEW_DEFS,
      liveViews: [],
      liveFields: [],
      optionalFields: OPTIONAL_VIEW_FIELDS,
      desiredStatusOptions: DESIRED_STATUS_OPTIONS,
      desiredPriorityOptions: DESIRED_PRIORITY_OPTIONS,
    });

    // Missing view, missing ISSUE_TYPE field, missing Status, missing Priority.
    expect(findings).toHaveLength(4);
    // Every finding must tell the reader what to do, not just what is wrong.
    for (const finding of findings) {
      expect(finding).toMatch(/run `pnpm|enable it by hand|by hand/);
    }
  });
});
