import { describe, expect, test } from "vitest";
import { extractImplementation, extractRoadmap } from "../lib/project-hub.mjs";
import { LABEL_DEFS } from "../lib/label-defs.mjs";
import { MILESTONE_DEFS } from "../lib/milestone-defs.mjs";
import { ISSUE_TYPE_DEFS } from "../lib/issue-type-defs.mjs";
import {
  EPIC_KEYS,
  HUB_LABEL,
  HUB_PROJECT_TITLE,
  ISSUE_TYPES,
  MAJOR_BUMP_ITEM_KEYS,
  MILESTONE_TITLES,
  PRIORITY_LABELS,
  PRIORITY_TIERS,
  PROJECT_PRIORITY_OPTIONS,
  STATUS_LABELS,
  TYPE_KINDS,
  TYPE_LABELS,
  TYPE_VALUES,
  actionableItems,
  buildIssuePayload,
  countIssuesByType,
  epicPriority,
  epicStatus,
  hubMarker,
  indexItemsByKey,
  parseHubMarker,
  planBackfill,
  planClosedRetype,
  planIssueSync,
  planIssueTypes,
  planMilestones,
  planParentLinks,
  planProjectSync,
  slug,
  titleSimilarity,
} from "../lib/hub-sync.mjs";

// ---------------------------------------------------------------------------
// Fixtures — headers copied verbatim from the real trackers per the PR 2
// contract so actionableItems is exercised against realistic markdown, built
// by running the REAL extractRoadmap/extractImplementation from
// project-hub.mjs (keeps the two libs contractually coupled in tests).
//
// Status cells use the hub's 6-value badge vocabulary (Done / To Do /
// In Progress / Deferred / Blocked / Rejected); classifyStatus lowercases and
// hyphenates these into the kebab kind strings ("done" / "todo" /
// "in-progress" / "deferred" / "blocked" / "rejected") that Item.status and
// the planners below operate on.
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What                          | Status   | Why now / Notes      |
| ------- | ------------------------------ | -------- | ---------------------- |
| **P0A** | First priority zero item       | To Do    | needs doing             |
| **P0B** | Second priority zero item      | Done     | **PR:** #42. already shipped |
| \`Multi/Word\`: Test!! | Punctuation-heavy item | To Do | for slug testing |

## Priority 1

| Wave   | Scripts    | Status | Depends on |
| ------ | ---------- | ------ | ---------- |
| **W3** | \`ecs-ops\`  | To Do  | W0         |
| **W4** | \`sqs-etl\`  | Done   | W0         |

## Priority 2

| Item              | Status   | Unblock condition                     |
| ------------------ | -------- | ---------------------------------------- |
| **D4** SSM config  | Deferred | a 2nd script hand-rolling SSM config     |

## Governance follow-ups

| Item   | What                  | Status   | Notes                           |
| ------ | ---------------------- | -------- | ---------------------------------- |
| **T1** | Rename script           | Done     | landed on branch        |
| **T8** | Getter-reality check     | Deferred | backlog only             |
`;

const ROADMAP_MISSING_GOVERNANCE_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What                    | Status | Why now / Notes |
| ------- | ------------------------ | ------ | ------------------ |
| **P0A** | First priority zero item | To Do  | needs doing         |

## Priority 1

| Wave   | Scripts    | Status | Depends on |
| ------ | ---------- | ------ | ---------- |
| **W3** | \`ecs-ops\`  | To Do  | W0         |

## Priority 2

| Item              | Status   | Unblock condition                    |
| ------------------ | -------- | --------------------------------------- |
| **D4** SSM config  | Deferred | a 2nd script hand-rolling SSM config    |
`;

const IMPLEMENTATION_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change                                          | Source / call-site |
| ------ | -------- | -------- | ----------------------------------------------------------- | --------------------- |
| **F7** | Later    | Deferred | Opt-in \`onUnknownFormat\` tolerant a \\| b handling           | json-etl log F7        |
| **F9** | Next     | Done     | Some other change entirely                                 | some other log         |

## ADR-0035 rollout — failure reporting & diagnostics

| Phase  | Priority | Status   | Change                            | Source / notes         |
| ------ | -------- | -------- | ----------------------------------- | --------------------------- |
| **A7** | Later    | Rejected | Residual free-text redaction gaps    | Accepted per ADR update      |

## CLI evolution wave (U-series)

| Item                                  | Priority | Status | Change                          |
| --------------------------------------- | -------- | ------ | ------------------------------------ |
| **U2 — CLI structure + doc gates**       | Next     | To Do  | scaffold cli command structure        |

## Agent-operator wave (V-series)

| Item                                  | Priority | Status      | Change                       |
| --------------------------------------- | -------- | ----------- | --------------------------------- |
| **V4 — aws/bedrock-runtime wrapper**     | Now      | In Progress | typed Bedrock runtime wrapper       |

## m3l console wave (X-series)

| Item                                  | Priority | Status   | Change                      |
| --------------------------------------- | -------- | -------- | -------------------------------- |
| **X10 — run-launcher UI MVP**            | Later    | Deferred | console run-launcher screen       |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | Done   | aws/s3                | s3-objects (done)         | ADR-0033            |

## Gated library modules & deferred decisions (Later)

| ID                  | Status   | Unblock condition                          |
| --------------------- | -------- | ---------------------------------------------- |
| **D4** SSM config      | Deferred | a 2nd script hand-rolling SSM config fetch      |
`;

const IMPLEMENTATION_MISSING_GATED_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change      | Source / call-site |
| ------ | -------- | -------- | ---------------------- | --------------------- |
| **F7** | Later    | Deferred | still relevant          | json-etl log F7        |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | Done   | aws/s3                | s3-objects (done)         | ADR-0033            |
`;

const IMPLEMENTATION_DEDUPE_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change            | Source / call-site |
| ------ | -------- | -------- | ---------------------------- | --------------------- |
| **F7** | Later    | Deferred | First title for F7             | first-call-site         |
| **F7** | Next     | Done     | Second title for F7            | second-call-site        |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | Done   | aws/s3                | s3-objects (done)         | ADR-0033            |

## Gated library modules & deferred decisions (Later)

| ID                  | Status   | Unblock condition                          |
| --------------------- | -------- | ---------------------------------------------- |
| **D4** SSM config      | Deferred | a 2nd script hand-rolling SSM config fetch      |
`;

// A row whose Priority cell is a genuinely off-vocabulary value (P3 has no
// P3 tier, label, or milestone) — exercises actionableItems's warnings
// channel. Note: em-dash (—) is now the documented untiered placeholder
// and IS recognized (produces p2 with recognized: true, no warning); only a
// genuine non-P0/P1/P2/dash value like "P3" still warns.
const IMPLEMENTATION_BAD_PRIORITY_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change      | Source / call-site |
| ------ | -------- | -------- | ---------------------- | --------------------- |
| **F7** | P3       | Deferred | still relevant          | json-etl log F7        |
`;

// Exercises the two new capability-deepening / post-comparison-hardening
// wave sections actionableItems now handles.
const IMPLEMENTATION_WAVES_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change      | Source / call-site |
| ------ | -------- | -------- | ---------------------- | --------------------- |
| **F7** | Later    | Deferred | still relevant          | json-etl log F7        |

## Capability-deepening wave (ADR-0037/0038/0039)

| Item                    | Priority | Status | Change                    |
| ------------------------ | -------- | ------ | ---------------------------- |
| \`aws/rds-data\` Aurora    | Next     | To Do  | add RDS Data API wrapper      |

## Post-comparison hardening wave (ADR-0040/0041/0042/0043)

| Item                  | Priority | Status  | Change                     |
| ---------------------- | -------- | ------- | ------------------------------- |
| ReDoS hardening pass    | Now      | Blocked | close remaining regex risk       |

## m3l-cli build-out — ADR-0042 activation (issue #333)

| Item                             | Priority | Status | Change                     |
| ---------------------------------- | -------- | ------ | ------------------------------- |
| 8b — scaffold + discovery          | Later    | To Do  | packages/m3l-cli skeleton        |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | Done   | aws/s3                | s3-objects (done)         | ADR-0033            |
`;

// A Roadmap Priority-0 row whose Status cell is a board-side token ("In
// review") rather than one of the tracker's 6-value vocabulary — exercises
// actionableItems's resolveStatus warning channel with label "Roadmap".
const ROADMAP_BAD_STATUS_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What                      | Status    | Why now / Notes |
| ------- | -------------------------- | --------- | ------------------ |
| **P0A** | First priority zero item   | In review | needs doing         |
`;

// A Library-friction row whose Status cell is off-vocabulary — exercises
// actionableItems's resolveStatus warning channel with label "Implementation".
const IMPLEMENTATION_BAD_STATUS_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status    | Title & change      | Source / call-site |
| ------ | -------- | --------- | ---------------------- | --------------------- |
| **F7** | Later    | Reviewing | still relevant          | json-etl log F7        |
`;

// Exercises resolveType (ADR-0073): a friction table carrying the optional
// `Type` column, with one row naming a valid type (wins over the section
// default), one row using the dash placeholder (falls back to the section
// default, "Friction"), and one row with a genuinely off-vocabulary cell
// (falls back to the section default AND appends a warning).
const IMPLEMENTATION_TYPE_COLUMN_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Type   | Title & change    | Source / call-site |
| ------ | -------- | -------- | ------ | -------------------- | --------------------- |
| **F1** | Later    | Deferred | UI     | valid type row        | call-site-1            |
| **F2** | Later    | Deferred | —      | dash placeholder row  | call-site-2            |
| **F3** | Later    | Deferred | Widget | garbage type row      | call-site-3            |
`;

// ---------------------------------------------------------------------------
// makeItem — a well-formed Item builder for the planner-level tests, which
// don't need to route through actionableItems (that mapping is covered
// separately, and its title/detail composition for P0/governance/gated rows
// isn't pinned by the contract).
// ---------------------------------------------------------------------------

interface TestItem {
  key: string;
  title: string;
  status: "done" | "todo" | "in-progress" | "deferred" | "blocked" | "rejected";
  priority: "p0" | "p1" | "p2" | "p3" | "governance";
  type: (typeof ISSUE_TYPES)[keyof typeof ISSUE_TYPES];
  sourcePath: string;
  sourceAnchor: string;
  detail: string;
  legacyKeys?: string[];
  parentKey?: string;
  isEpic?: boolean;
}

function makeItem(overrides: Partial<TestItem> = {}): TestItem {
  return {
    key: "roadmap:p0:sample-item",
    title: "Sample item",
    status: "todo",
    priority: "p0",
    type: ISSUE_TYPES.libraryCapability,
    sourcePath: "docs/ROADMAP.md",
    sourceAnchor: "#priority-0--library-hardening-do-before-more-scripts",
    detail: "**What:** a sample item",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("HUB_LABEL", () => {
  test("is the fixed hub-sync label", () => {
    expect(HUB_LABEL).toBe("hub-sync");
  });
});

describe("HUB_PROJECT_TITLE", () => {
  test("is the fixed project board title", () => {
    expect(HUB_PROJECT_TITLE).toBe("m3l-automation");
  });
});

describe("PRIORITY_LABELS", () => {
  test("maps every tiered priority to its 'priority:<n>-<name>' label string", () => {
    expect(PRIORITY_LABELS).toMatchObject({
      p0: "priority:0-now",
      p1: "priority:1-next",
      p2: "priority:2-later",
      p3: "priority:3-gated",
    });
  });

  test("has no governance member — governance is a category, not a tier", () => {
    expect(PRIORITY_LABELS).not.toHaveProperty("governance");
  });
});

describe("PROJECT_PRIORITY_OPTIONS", () => {
  test("maps every priority tier plus governance to its board option label", () => {
    expect(PROJECT_PRIORITY_OPTIONS).toStrictEqual({
      p0: "0-now",
      p1: "1-next",
      p2: "2-later",
      p3: "3-gated",
      governance: "Governance",
    });
  });

  // The declaration order below is load-bearing, not cosmetic (ADR-0073): a
  // GitHub Projects single-select field sorts its options by the order they
  // are declared, and the board's Backlog view sorts by Priority ascending.
  // So "3-gated" sitting between "2-later" and "Governance" is where gated
  // work physically appears in that view. Reordering these keys — even an
  // innocuous alphabetical "tidy-up" — silently reorders the live board.
  test("declares keys p0, p1, p2, p3, governance in that exact order — reordering silently reorders the live Backlog view (ADR-0073)", () => {
    expect(Object.keys(PROJECT_PRIORITY_OPTIONS)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "governance",
    ]);
  });
});

describe("ISSUE_TYPES", () => {
  test("has exactly the ten ADR-0073 display-name values, in declaration order", () => {
    expect(Object.values(ISSUE_TYPES)).toEqual([
      "Library capability",
      "CLI capability",
      "Package capability",
      "UI",
      "Infrastructure",
      "Fleet retrofit",
      "Tooling & gates",
      "Consumer script",
      "Friction",
      "Governance",
    ]);
  });
});

describe("TYPE_VALUES", () => {
  test("matches Object.values(ISSUE_TYPES) exactly", () => {
    expect(TYPE_VALUES).toEqual(Object.values(ISSUE_TYPES));
  });

  test("is frozen", () => {
    expect(Object.isFrozen(TYPE_VALUES)).toBe(true);
  });
});

describe("TYPE_LABELS", () => {
  test("maps every ISSUE_TYPES display-name value to its 'type:<x>' label string", () => {
    expect(TYPE_LABELS).toEqual({
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
    });
  });

  test("is keyed by the ISSUE_TYPES display name, not the facet name, so TYPE_LABELS[item.type] resolves directly", () => {
    expect(TYPE_LABELS[ISSUE_TYPES.governance]).toBe("type:governance");
    expect(TYPE_LABELS.governance).toBeUndefined();
  });
});

describe("STATUS_LABELS", () => {
  test("maps all six statuses (todo/in-progress/deferred/blocked/done/rejected) to their status:<x> label", () => {
    expect(STATUS_LABELS).toEqual({
      todo: "status:todo",
      "in-progress": "status:in-progress",
      deferred: "status:deferred",
      blocked: "status:blocked",
      done: "status:done",
      rejected: "status:rejected",
    });
  });
});

describe("MILESTONE_TITLES", () => {
  test("maps p0/p1/p2/p3/governance to their milestone titles, plus a major bucket", () => {
    expect(MILESTONE_TITLES).toMatchObject({
      p0: "Now — unblock first",
      p1: "Next — scheduled",
      p2: "Later — not yet scheduled",
      p3: "Gated — awaiting trigger",
      governance: "Governance",
      major: "2.0 / breaking",
    });
  });

  // ADR-0073's rename of p1/p2 ("Next — consumer fleet" -> "Next —
  // scheduled", "Later — gated/deferred" -> "Later — not yet scheduled") is
  // only safe now that `planMilestones` has an in-place PATCH path driven by
  // `legacyTitles` (bin/lib/milestone-defs.mjs). This test replaces the
  // pre-ADR-0073 wording lock above: it asserts the successor invariant —
  // renaming a MILESTONE_TITLES entry without also recording its prior
  // wording in MILESTONE_DEFS' legacyTitles strands every issue on the old
  // milestone (28 open p1 issues, 31 open p2 issues at the time of the
  // rename), because `gh issue create/edit --milestone` resolves by title
  // and planMilestones can only PATCH a title it knows to look for.
  test("p1 and p2's new titles each have their pre-ADR-0073 wording recorded in MILESTONE_DEFS.legacyTitles", () => {
    expect(MILESTONE_TITLES.p1).toBe("Next — scheduled");
    expect(MILESTONE_TITLES.p2).toBe("Later — not yet scheduled");

    const p1Def = MILESTONE_DEFS.find((def) => def.key === "p1");
    const p2Def = MILESTONE_DEFS.find((def) => def.key === "p2");
    expect(p1Def?.legacyTitles).toContain("Next — consumer fleet");
    expect(p2Def?.legacyTitles).toContain("Later — gated/deferred");
  });
});

describe("MAJOR_BUMP_ITEM_KEYS", () => {
  test("contains exactly the F3 friction key and the AWSClientProvider getter-removal key", () => {
    // Keys are now namespaced by section: impl:<namespace>:<slug(identity)>.
    expect(MAJOR_BUMP_ITEM_KEYS.has(`impl:friction:${slug("F3")}`)).toBe(true);
    expect(
      MAJOR_BUMP_ITEM_KEYS.has(
        `impl:gated:${slug(
          "Removal of the 4 `@deprecated` `AWSClientProvider` convenience getters (`dynamoDBDocument`/`sqsOperations`/`eventBridgeOperations`/`requestSigner`)",
        )}`,
      ),
    ).toBe(true);
    expect(MAJOR_BUMP_ITEM_KEYS.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// hubMarker / parseHubMarker
// ---------------------------------------------------------------------------

describe("hubMarker", () => {
  test("wraps the key in the fixed HTML comment marker", () => {
    expect(hubMarker("roadmap:p0:foo")).toBe(
      "<!-- m3l-hub-sync:roadmap:p0:foo -->",
    );
  });
});

describe("parseHubMarker", () => {
  test.each(["roadmap:p0:foo", "impl:F7", "roadmap:W3:ecs-ops"])(
    "round-trips a pipe-free key %j through hubMarker",
    (key) => {
      const body = `${hubMarker(key)}\nsome other body content\n`;
      expect(parseHubMarker(body)).toBe(key);
    },
  );

  test("returns null when no marker is present", () => {
    expect(parseHubMarker("Just a regular issue body.\n")).toBeNull();
  });

  test("returns the first marker's key when two markers are present", () => {
    const body = `${hubMarker("first-key")}\n${hubMarker("second-key")}\n`;
    expect(parseHubMarker(body)).toBe("first-key");
  });

  test("tolerates leading whitespace before the marker line", () => {
    const body = `   ${hubMarker("indented-key")}\nrest of body\n`;
    expect(parseHubMarker(body)).toBe("indented-key");
  });

  test("returns null for an empty body", () => {
    expect(parseHubMarker("")).toBeNull();
  });

  test("returns null for an undefined body", () => {
    expect(parseHubMarker(undefined)).toBeNull();
  });

  test("returns null when the marker text is only quoted mid-line (regex is line-anchored)", () => {
    const body =
      "the text `<!-- m3l-hub-sync:impl:F7 -->` broke the earlier un-anchored regex";
    expect(parseHubMarker(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// actionableItems
// ---------------------------------------------------------------------------

describe("actionableItems", () => {
  test("emits the exact documented keys for P0/P1/governance/F-series rows", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);
    const keys = items.map((item) => item.key);

    expect(keys).toContain("roadmap:p0:p0a");
    expect(keys).toContain("roadmap:W3:ecs-ops");
    expect(keys).toContain("roadmap:gov:t1");
    // F-series keys are namespaced: impl:friction:<slug(ID)>
    expect(keys).toContain("impl:friction:f7");
  });

  // ADR-0073 moved the gated table's items from p2 to p3: the table has no
  // Priority column by design (the section IS the gated tier by
  // construction — every row is unscheduled until an external gate opens),
  // so its priority is hardcoded in actionableItems rather than read off a
  // cell. p2 now means "real work, not yet scheduled, nothing blocking it",
  // the opposite of what this section has always held.
  test("emits the gated (P3) item keyed off the slugged ID cell, priority p3", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);
    // Gated keys are namespaced: impl:gated:<slug(ID)>
    const gated = items.find((item) => item.key === "impl:gated:d4-ssm-config");

    expect(gated).toBeDefined();
    expect(gated?.priority).toBe("p3");
    expect(gated?.status).toBe("deferred");
    expect(gated?.detail).toContain("Unblock condition");
    expect(gated?.detail).toContain(
      "a 2nd script hand-rolling SSM config fetch",
    );
  });

  test("does NOT emit ROADMAP Priority 2 rows (the IMPLEMENTATION gated table is the source)", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    expect(items.some((item) => item.key === "roadmap:p2:d4-ssm-config")).toBe(
      false,
    );
    expect(items.some((item) => item.key.startsWith("roadmap:p2:"))).toBe(
      false,
    );
  });

  test("done rows are still emitted, with status 'done'", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    const doneP0 = items.find((item) => item.key === "roadmap:p0:p0b");
    const doneW4 = items.find((item) => item.key === "roadmap:W4:sqs-etl");
    // F-series keys are namespaced: impl:friction:<slug(ID)>
    const doneF9 = items.find((item) => item.key === "impl:friction:f9");

    expect(doneP0?.status).toBe("done");
    expect(doneW4?.status).toBe("done");
    expect(doneF9?.status).toBe("done");
  });

  test("governance status is classified from a Status column, not the Notes cell", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    const t1 = items.find((item) => item.key === "roadmap:gov:t1");
    const t8 = items.find((item) => item.key === "roadmap:gov:t8");

    expect(t1?.priority).toBe("governance");
    expect(t1?.status).toBe("done");
    expect(t8?.status).toBe("deferred");
  });

  test("F-series title is '<ID> — <Title & change>' with markdown-stripped ID", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    // F-series keys are namespaced: impl:friction:<slug(ID)>
    const f7 = items.find((item) => item.key === "impl:friction:f7");
    expect(f7?.title).toBe(
      "F7 — Opt-in `onUnknownFormat` tolerant a | b handling",
    );
    expect(f7?.priority).toBe("p2");
    expect(f7?.status).toBe("deferred");
    expect(f7?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
  });

  test("ADR-0035 rollout row is keyed 'impl:adr0035:<slug(Phase)>', titled '<Phase> — <Change>', priority/status from its own columns", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    // ADR-0035 rollout keys are namespaced: impl:adr0035:<slug(Phase)>
    const a7 = items.find((item) => item.key === "impl:adr0035:a7");
    expect(a7).toBeDefined();
    expect(a7?.title).toBe("A7 — Residual free-text redaction gaps");
    expect(a7?.priority).toBe("p2");
    expect(a7?.status).toBe("rejected");
    expect(a7?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
  });

  test("P1 key is 'roadmap:<Wave>:<slug(Scripts)>' and title is '<Wave> — <Scripts>'", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    const w3 = items.find((item) => item.key === "roadmap:W3:ecs-ops");
    expect(w3).toBeDefined();
    expect(w3?.priority).toBe("p1");
    expect(w3?.title).toContain("W3");
    expect(w3?.title).toContain("ecs-ops");
  });

  test("slug() strips markdown, backticks, and punctuation into single-dash segments", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    expect(
      items.some((item) => item.key === "roadmap:p0:multi-word-test"),
    ).toBe(true);
  });

  test("dedupes rows sharing a key: keeps the first row's fields, merges the later row's detail", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_DEDUPE_FIXTURE);
    // Both F7 rows are in the friction section → both derive impl:friction:f7.
    // The collision is recorded in duplicateKeys AND emits exactly one warning.
    const { items, warnings, duplicateKeys } = actionableItems(
      roadmap,
      implementation,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("impl:friction:f7");

    expect(duplicateKeys).toHaveLength(1);
    expect(duplicateKeys[0]).toMatchObject({
      key: "impl:friction:f7",
      first: "F7 — First title for F7",
      second: "F7 — Second title for F7",
    });

    const f7Items = items.filter((item) => item.key === "impl:friction:f7");
    expect(f7Items).toHaveLength(1);
    const f7 = f7Items[0];
    expect(f7?.title).toContain("First title for F7");
    expect(f7?.priority).toBe("p2");
    expect(f7?.status).toBe("deferred");
    expect(f7?.detail).toContain("first-call-site");
    expect(f7?.detail).toContain("second-call-site");
  });

  test("skips null sections silently, without throwing, and reports no warnings", () => {
    const roadmap = extractRoadmap(ROADMAP_MISSING_GOVERNANCE_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_MISSING_GATED_FIXTURE,
    );
    expect(roadmap.governance).toBeNull();
    expect(implementation.gated).toBeNull();

    let items: TestItem[] = [];
    let warnings: string[] = [];
    expect(() => {
      const result = actionableItems(roadmap, implementation);
      items = result.items;
      warnings = result.warnings;
    }).not.toThrow();

    expect(warnings).toEqual([]);
    expect(items.some((item) => item.key.startsWith("roadmap:gov:"))).toBe(
      false,
    );
    // Gated keys are namespaced impl:gated:*, not the old impl:d4 flat form.
    expect(items.some((item) => item.key.startsWith("impl:gated:"))).toBe(
      false,
    );
    // The sections that ARE present must still be processed.
    expect(items.some((item) => item.key === "roadmap:p0:p0a")).toBe(true);
    expect(items.some((item) => item.key === "impl:friction:f7")).toBe(true);
  });

  test("an unrecognized Priority cell defaults the item to p2 and appends exactly one warning naming the row's key and raw cell", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_BAD_PRIORITY_FIXTURE,
    );
    const { items, warnings } = actionableItems(roadmap, implementation);

    // F-series key is now namespaced: impl:friction:<slug(ID)>
    const f7 = items.find((item) => item.key === "impl:friction:f7");
    expect(f7?.priority).toBe("p2");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("impl:friction:f7");
    // The fixture uses "P3" — a genuine off-vocabulary cell (em-dash is now
    // recognized as the untiered placeholder, see classifyPriorityCell).
    expect(warnings[0]).toContain("P3");
  });

  test("the em-dash untiered placeholder is recognized: produces p2 with no warning", () => {
    // Verify classifyPriorityCell's new dash-is-recognized rule flows through
    // actionableItems end-to-end: a row with "—" Priority should emit the
    // item at p2 without adding any warning.
    const fixture = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change   | Source / call-site |
| ------ | -------- | -------- | ----------------- | --------------------- |
| **F7** | —        | Deferred | still relevant    | json-etl log F7       |
`;
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(fixture);
    const { items, warnings } = actionableItems(roadmap, implementation);

    const f7 = items.find((item) => item.key === "impl:friction:f7");
    expect(f7?.priority).toBe("p2");
    expect(warnings).toEqual([]);
  });

  test("an unrecognized Roadmap Status cell defaults the item to todo and appends a Roadmap-labeled warning", () => {
    const roadmap = extractRoadmap(ROADMAP_BAD_STATUS_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    const p0a = items.find((item) => item.key === "roadmap:p0:p0a");
    expect(p0a?.status).toBe("todo");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      'Roadmap: item "roadmap:p0:p0a" has an unrecognized Status cell ("In review") — treated as To Do.',
    );
  });

  test("an unrecognized Implementation Status cell defaults the item to todo and appends an Implementation-labeled warning", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_BAD_STATUS_FIXTURE,
    );
    const { items, warnings } = actionableItems(roadmap, implementation);

    // F-series key is now namespaced: impl:friction:<slug(ID)>
    const f7 = items.find((item) => item.key === "impl:friction:f7");
    expect(f7?.status).toBe("todo");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      'Implementation: item "impl:friction:f7" has an unrecognized Status cell ("Reviewing") — treated as To Do.',
    );
  });

  test("extracts capabilityDeepeningWave rows with key impl:capability:<slug(Item)>, priority/status from their own columns", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_WAVES_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    // Capability wave keys are namespaced: impl:capability:<slug(Item)>
    const wave = items.find(
      (item) => item.key === `impl:capability:${slug("`aws/rds-data` Aurora")}`,
    );
    expect(wave).toBeDefined();
    expect(wave?.priority).toBe("p1");
    expect(wave?.status).toBe("todo");
    expect(wave?.title).toContain("add RDS Data API wrapper");
    expect(wave?.sourceAnchor).toBe(
      "#capability-deepening-wave--adr-003700380039",
    );
    expect(warnings).toEqual([]);
  });

  test("extracts postComparisonHardeningWave rows with key impl:hardening:<slug(Item)>, priority/status from their own columns", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_WAVES_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    // Post-comparison hardening wave keys are namespaced: impl:hardening:<slug(Item)>
    const wave = items.find(
      (item) => item.key === `impl:hardening:${slug("ReDoS hardening pass")}`,
    );
    expect(wave).toBeDefined();
    expect(wave?.priority).toBe("p0");
    expect(wave?.status).toBe("blocked");
    expect(wave?.sourceAnchor).toBe(
      "#post-comparison-hardening-wave--adr-0040004100420043",
    );
    expect(warnings).toEqual([]);
  });

  test("extracts m3lCliBuildOut rows with key impl:cli:<slug(Item)>, priority/status from their own columns", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_WAVES_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    // m3l-cli build-out keys are namespaced: impl:cli:<slug(Item)>
    const wave = items.find(
      (item) => item.key === `impl:cli:${slug("8b — scaffold + discovery")}`,
    );
    expect(wave).toBeDefined();
    expect(wave?.priority).toBe("p2");
    expect(wave?.status).toBe("todo");
    expect(wave?.sourceAnchor).toBe(
      "#m3l-cli-build-out--adr-0042-activation-issue-333",
    );
    expect(warnings).toEqual([]);
  });

  // ADR-0073 split the old m3l-cli build-out section three ways
  // (cliEvolutionWave/agentOperatorWave/consoleWave). Each row keeps its own
  // section's namespace, anchor, and Issue-Type default — asserted per
  // section below.
  test("extracts cliEvolutionWave rows with key impl:cli-evolution:<slug(Item)>, sourceAnchor, sourcePath, and the section-default Issue Type", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    const u2Slug = slug("U2 — CLI structure + doc gates");
    const u2 = items.find(
      (item) => item.key === `impl:cli-evolution:${u2Slug}`,
    );
    expect(u2).toBeDefined();
    expect(u2?.priority).toBe("p1");
    expect(u2?.status).toBe("todo");
    expect(u2?.sourceAnchor).toBe("#cli-evolution-wave-u-series");
    expect(u2?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
    expect(u2?.type).toBe(ISSUE_TYPES.cliCapability);
    expect(
      warnings.some((warning) =>
        warning.includes(`impl:cli-evolution:${u2Slug}`),
      ),
    ).toBe(false);
  });

  test("extracts agentOperatorWave rows with key impl:agent-operator:<slug(Item)>, sourceAnchor, sourcePath, and the section-default Issue Type", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    const v4Slug = slug("V4 — aws/bedrock-runtime wrapper");
    const v4 = items.find(
      (item) => item.key === `impl:agent-operator:${v4Slug}`,
    );
    expect(v4).toBeDefined();
    expect(v4?.priority).toBe("p0");
    expect(v4?.status).toBe("in-progress");
    expect(v4?.sourceAnchor).toBe("#agent-operator-wave-v-series");
    expect(v4?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
    expect(v4?.type).toBe(ISSUE_TYPES.libraryCapability);
    expect(
      warnings.some((warning) =>
        warning.includes(`impl:agent-operator:${v4Slug}`),
      ),
    ).toBe(false);
  });

  test("extracts consoleWave rows with key impl:console:<slug(Item)>, sourceAnchor, sourcePath, and the section-default Issue Type", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    const x10Slug = slug("X10 — run-launcher UI MVP");
    const x10 = items.find((item) => item.key === `impl:console:${x10Slug}`);
    expect(x10).toBeDefined();
    expect(x10?.priority).toBe("p2");
    expect(x10?.status).toBe("deferred");
    expect(x10?.sourceAnchor).toBe("#m3l-console-wave-x-series");
    expect(x10?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
    expect(x10?.type).toBe(ISSUE_TYPES.packageCapability);
    expect(
      warnings.some((warning) => warning.includes(`impl:console:${x10Slug}`)),
    ).toBe(false);
  });

  // THE test that matters most in this file. Every row ADR-0073 moved out of
  // "m3l-cli build-out" into one of the three programme waves carries TWO
  // derived legacyKeys, in this exact order: `impl:cli:<slug>` (the key the
  // row was filed under before the split — every already-open GitHub issue
  // for these rows still carries THIS key in its hidden marker) and
  // `impl:<slug>` (the older, pre-namespacing flat key). If the first entry
  // is ever dropped, `indexItemsByKey`/`planIssueSync` can no longer resolve
  // an already-open issue for one of these ~39 rows back to its current
  // item: every one of them reads as "removed from the source trackers",
  // planIssueSync closes the live issue, and a duplicate gets filed on the
  // real repo. Do not "simplify" this to `toContain` — the ORDER and the
  // EXACT two-element shape are both load-bearing (see indexItemsByKey,
  // which indexes every legacyKey unconditionally, but a human reading a
  // GitHub issue body's marker cares which key is "current" vs "legacy").
  test("[ADR-0073 split] cliEvolutionWave/agentOperatorWave/consoleWave rows carry legacyKeys exactly [impl:cli:<slug>, impl:<slug>] in that order — dropping the first re-derives a 'vanished from trackers' false positive and files duplicate issues for every moved row", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    const u2Slug = slug("U2 — CLI structure + doc gates");
    const u2 = items.find(
      (item) => item.key === `impl:cli-evolution:${u2Slug}`,
    );
    expect(u2?.legacyKeys).toEqual([`impl:cli:${u2Slug}`, `impl:${u2Slug}`]);

    const v4Slug = slug("V4 — aws/bedrock-runtime wrapper");
    const v4 = items.find(
      (item) => item.key === `impl:agent-operator:${v4Slug}`,
    );
    expect(v4?.legacyKeys).toEqual([`impl:cli:${v4Slug}`, `impl:${v4Slug}`]);

    const x10Slug = slug("X10 — run-launcher UI MVP");
    const x10 = items.find((item) => item.key === `impl:console:${x10Slug}`);
    expect(x10?.legacyKeys).toEqual([`impl:cli:${x10Slug}`, `impl:${x10Slug}`]);
  });

  // The split kept m3lCliBuildOut in place for its own shipped 8b-8g
  // history: its rows must NOT gain the two-key derived legacyKeys pattern
  // the three moved sections above get, and must still key under the
  // original "impl:cli:" namespace (unmoved by ADR-0073).
  test("m3lCliBuildOut rows still key under impl:cli: and are not moved by the ADR-0073 split (single flat legacyKey, not the two-key derived pattern)", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_WAVES_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);
    expect(warnings).toEqual([]);

    const itemSlug = slug("8b — scaffold + discovery");
    const wave = items.find((item) => item.key === `impl:cli:${itemSlug}`);
    expect(wave).toBeDefined();
    expect(wave?.legacyKeys).toEqual([`impl:${itemSlug}`]);
  });

  test("resolveType: a row naming a valid Type cell wins over the section default", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_TYPE_COLUMN_FIXTURE,
    );
    const { items, warnings } = actionableItems(roadmap, implementation);

    const f1 = items.find((item) => item.key === "impl:friction:f1");
    expect(f1?.type).toBe("UI");
    // This fixture's f3 row deliberately has an unrecognized Type cell and
    // is expected to warn (covered separately below) — only assert this
    // row (f1) produced no warning of its own.
    expect(
      warnings.some((warning) => warning.includes("impl:friction:f1")),
    ).toBe(false);
  });

  test("resolveType: a dash placeholder Type cell falls back to the section default silently", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_TYPE_COLUMN_FIXTURE,
    );
    const { items, warnings } = actionableItems(roadmap, implementation);

    const f2 = items.find((item) => item.key === "impl:friction:f2");
    expect(f2?.type).toBe(ISSUE_TYPES.friction);
    // This fixture's f3 row deliberately has an unrecognized Type cell and
    // is expected to warn (covered separately below) — only assert this
    // row (f2) produced no warning of its own.
    expect(
      warnings.some((warning) => warning.includes("impl:friction:f2")),
    ).toBe(false);
  });

  test("resolveType: an unrecognized Type cell falls back to the section default AND appends a warning naming the row's key and raw cell", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_TYPE_COLUMN_FIXTURE,
    );
    const { items, warnings } = actionableItems(roadmap, implementation);

    const f3 = items.find((item) => item.key === "impl:friction:f3");
    expect(f3?.type).toBe(ISSUE_TYPES.friction);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("impl:friction:f3");
    expect(warnings[0]).toContain("Widget");
  });

  test("resolveType: a table with no Type column at all still resolves every row to its section default", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items, warnings } = actionableItems(roadmap, implementation);

    const f7 = items.find((item) => item.key === "impl:friction:f7");
    expect(f7?.type).toBe(ISSUE_TYPES.friction);
    expect(warnings).toEqual([]);
  });

  test("duplicateKeys is empty when no two rows share a key", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { duplicateKeys, warnings } = actionableItems(
      roadmap,
      implementation,
    );
    expect(warnings).toEqual([]);
    expect(duplicateKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// indexItemsByKey
// ---------------------------------------------------------------------------

describe("indexItemsByKey", () => {
  test("indexes every item by its current key", () => {
    const item = makeItem({ key: "impl:friction:f7" });
    const byKey = indexItemsByKey([item]);
    expect(byKey.get("impl:friction:f7")).toBe(item);
  });

  test("indexes every item by each of its legacyKeys", () => {
    const item = makeItem({
      key: "impl:friction:f7",
      legacyKeys: ["impl:F7"],
    });
    const byKey = indexItemsByKey([item]);
    // Both the current key and the legacy key resolve to the same item.
    expect(byKey.get("impl:friction:f7")).toBe(item);
    expect(byKey.get("impl:F7")).toBe(item);
  });

  test("a current key always wins over a legacy alias of another item for the same string", () => {
    // itemA holds "impl:old" as a legacy alias. itemB's CURRENT key is the
    // same string "impl:old". The current key must win — the alias is inert.
    const itemA = makeItem({ key: "impl:a", legacyKeys: ["impl:old"] });
    const itemB = makeItem({ key: "impl:old" });
    const byKey = indexItemsByKey([itemA, itemB]);
    expect(byKey.get("impl:old")).toBe(itemB);
    // itemA is still reachable via its own current key.
    expect(byKey.get("impl:a")).toBe(itemA);
  });

  test("an item with no legacyKeys is indexed without error", () => {
    const item = makeItem({ key: "roadmap:p0:x" });
    // No legacyKeys property on the item at all (makeItem doesn't add it by
    // default), so the ?? [] guard in indexItemsByKey must handle undefined.
    expect(() => indexItemsByKey([item])).not.toThrow();
    expect(indexItemsByKey([item]).get("roadmap:p0:x")).toBe(item);
  });
});

// ---------------------------------------------------------------------------
// buildIssuePayload
// ---------------------------------------------------------------------------

describe("buildIssuePayload", () => {
  test("the marker line is the first line of the body", () => {
    const item = makeItem({ key: "roadmap:p0:foo" });
    const payload = buildIssuePayload(item);
    expect(payload.body.split("\n")[0]).toBe(hubMarker("roadmap:p0:foo"));
  });

  test("title is item.title verbatim", () => {
    const item = makeItem({ title: "A distinctive title" });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe("A distinctive title");
  });

  test("body contains the 'Derived — do not edit' banner with a blobUrl link + anchor, and pnpm sync:hub", () => {
    const item = makeItem({
      sourcePath: "docs/ROADMAP.md",
      sourceAnchor: "#priority-0--library-hardening-do-before-more-scripts",
    });
    const payload = buildIssuePayload(item) as { body: string };
    expect(payload.body).toContain("Derived — do not edit");
    expect(payload.body).toContain(
      "https://github.com/monte3l/m3l-automation/blob/main/docs/ROADMAP.md#priority-0--library-hardening-do-before-more-scripts",
    );
    expect(payload.body).toContain("pnpm sync:hub");
  });

  test("body ends with item.detail", () => {
    const item = makeItem({ detail: "**What:** a very specific detail" });
    const payload = buildIssuePayload(item) as { body: string };
    expect(payload.body).toContain("**What:** a very specific detail");
  });

  // ADR-0052's 2026-08-20 Update: every Item status — not just deferred/
  // blocked — now resolves to a STATUS_LABELS entry unconditionally, applied
  // after the (unconditional, since the same Update) TYPE_LABELS entry.
  test.each([
    ["todo", "status:todo"],
    ["in-progress", "status:in-progress"],
    ["deferred", "status:deferred"],
    ["blocked", "status:blocked"],
    ["done", "status:done"],
    ["rejected", "status:rejected"],
  ] as const)(
    "labels always append the STATUS_LABELS entry for status %s (unconditional since ADR-0052)",
    (status, statusLabel) => {
      const item = makeItem({ priority: "p1", status });
      const payload = buildIssuePayload(item) as { labels: string[] };
      expect(payload.labels).toEqual([
        "hub-sync",
        "priority:1-next",
        "type:library-capability",
        statusLabel,
      ]);
    },
  );

  test.each([
    [ISSUE_TYPES.libraryCapability, "type:library-capability"],
    [ISSUE_TYPES.cliCapability, "type:cli-capability"],
    [ISSUE_TYPES.packageCapability, "type:package-capability"],
    [ISSUE_TYPES.ui, "type:ui"],
    [ISSUE_TYPES.infrastructure, "type:infrastructure"],
    [ISSUE_TYPES.fleetRetrofit, "type:fleet-retrofit"],
    [ISSUE_TYPES.toolingGates, "type:tooling-gates"],
    [ISSUE_TYPES.consumerScript, "type:consumer-script"],
    [ISSUE_TYPES.friction, "type:friction"],
    [ISSUE_TYPES.governance, "type:governance"],
  ] as const)(
    "labels always append the TYPE_LABELS entry for type %s",
    (type, typeLabel) => {
      const item = makeItem({ priority: "p1", status: "todo", type });
      const payload = buildIssuePayload(item) as { labels: string[] };
      expect(payload.labels).toContain(typeLabel);
      // Exactly one type:* label — never duplicated or omitted.
      expect(payload.labels.filter((l) => l.startsWith("type:"))).toEqual([
        typeLabel,
      ]);
    },
  );

  test("a 'Tooling & gates' item yields the 'type:tooling-gates' label", () => {
    const item = makeItem({ type: ISSUE_TYPES.toolingGates });
    const payload = buildIssuePayload(item) as { labels: string[] };
    expect(payload.labels).toContain("type:tooling-gates");
  });

  test("throws when item.type has no TYPE_LABELS entry", () => {
    const item = makeItem({
      type: "Bogus type" as unknown as (typeof ISSUE_TYPES)[keyof typeof ISSUE_TYPES],
    });
    expect(() => buildIssuePayload(item)).toThrowError(/no TYPE_LABELS entry/);
  });

  test("throws when item.status has no STATUS_LABELS entry", () => {
    const item = makeItem({
      status: "bogus-status" as unknown as TestItem["status"],
    });
    expect(() => buildIssuePayload(item)).toThrowError(
      /no STATUS_LABELS entry/,
    );
  });

  test.each([
    ["p0", "Now — unblock first"],
    ["p1", "Next — scheduled"],
    ["p2", "Later — not yet scheduled"],
    ["p3", "Gated — awaiting trigger"],
    ["governance", "Governance"],
  ] as const)(
    "milestoneTitle for priority %s is %j",
    (priority, expectedTitle) => {
      const item = makeItem({ priority });
      const payload = buildIssuePayload(item) as {
        milestoneTitle: string | null;
      };
      expect(payload.milestoneTitle).toBe(expectedTitle);
    },
  );

  test("a p3 item's labels carry priority:3-gated and its milestone is 'Gated — awaiting trigger'", () => {
    const item = makeItem({ priority: "p3" });
    const payload = buildIssuePayload(item) as {
      labels: string[];
      milestoneTitle: string | null;
    };
    expect(payload.labels).toContain("priority:3-gated");
    expect(payload.milestoneTitle).toBe("Gated — awaiting trigger");
  });

  test("milestoneTitle is never null for a governance item: it resolves to the Governance milestone", () => {
    const item = makeItem({
      priority: "governance",
      type: ISSUE_TYPES.governance,
      status: "todo",
    });
    const payload = buildIssuePayload(item) as {
      milestoneTitle: string | null;
      labels: string[];
    };
    expect(payload.milestoneTitle).toBe("Governance");
    // Governance never carries a priority:* label (ADR-0051), but does carry
    // the unconditional type + status labels (ADR-0052's 2026-08-20 Update).
    expect(payload.labels).toEqual([
      "hub-sync",
      "type:governance",
      "status:todo",
    ]);
  });

  test("milestoneTitle is '2.0 / breaking' for an item keyed impl:friction:f3, regardless of its priority", () => {
    // MAJOR_BUMP_ITEM_KEYS now contains impl:friction:f3 (namespaced), not impl:F3.
    const item = makeItem({
      key: `impl:friction:${slug("F3")}`,
      priority: "p2",
    });
    const payload = buildIssuePayload(item) as {
      milestoneTitle: string | null;
    };
    expect(payload.milestoneTitle).toBe("2.0 / breaking");
  });

  test("milestoneTitle is the normal priority-derived title for an item outside MAJOR_BUMP_ITEM_KEYS", () => {
    const item = makeItem({ key: "impl:F4", priority: "p2" });
    const payload = buildIssuePayload(item) as {
      milestoneTitle: string | null;
    };
    expect(payload.milestoneTitle).toBe("Later — not yet scheduled");
  });

  test("item.type flows into payload.type verbatim (ADR-0052 Issue Type)", () => {
    const item = makeItem({ type: ISSUE_TYPES.friction });
    const payload = buildIssuePayload(item) as { type: string };
    expect(payload.type).toBe(ISSUE_TYPES.friction);
  });
});

// ---------------------------------------------------------------------------
// buildIssuePayload — title normalization (stripTitleMarkdown, private,
// exercised indirectly via payload.title)
// ---------------------------------------------------------------------------

describe("buildIssuePayload title normalization", () => {
  test("resolves a markdown link to its label", () => {
    const item = makeItem({
      title: "See [the doc](https://example.com/docs) for details",
    });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe("See the doc for details");
  });

  test("strips backticks around inline code, keeping the inner text", () => {
    const item = makeItem({ title: "Fix `onUnknownFormat` handling" });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe("Fix onUnknownFormat handling");
  });

  test("strips paired **bold** emphasis, keeping the inner text", () => {
    const item = makeItem({ title: "**F7** — Opt-in tolerant handling" });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe("F7 — Opt-in tolerant handling");
  });

  test("strips paired __bold__ emphasis, keeping the inner text", () => {
    const item = makeItem({ title: "__F9__ — Some other change" });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe("F9 — Some other change");
  });

  test("preserves bare underscores in an identifier (not a paired emphasis marker)", () => {
    const item = makeItem({
      title: "Rename M3L_EXIT_CODES and SENSITIVE_KEY_NAMES",
    });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe("Rename M3L_EXIT_CODES and SENSITIVE_KEY_NAMES");
  });

  test("preserves a bare single asterisk not part of a paired emphasis marker", () => {
    const item = makeItem({
      title: "Compute a*b before applying the C pointer syntax int* value",
    });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe(
      "Compute a*b before applying the C pointer syntax int* value",
    );
  });
});

// ---------------------------------------------------------------------------
// buildIssuePayload — title truncation (truncateTitle/MAX_TITLE_LENGTH,
// private, exercised indirectly via payload.title)
// ---------------------------------------------------------------------------

describe("buildIssuePayload title truncation", () => {
  test("is a no-op when the title is exactly at the 120-char cap", () => {
    const exactly120 = "A".repeat(120);
    const item = makeItem({ title: exactly120 });
    const payload = buildIssuePayload(item) as { title: string };
    expect(payload.title).toBe(exactly120);
    expect(payload.title).not.toContain("…");
  });

  test("truncates a long title at a word boundary, never mid-word", () => {
    const words = Array.from({ length: 30 }, () => "lorem");
    const longTitle = words.join(" ");
    const item = makeItem({ title: longTitle });
    const payload = buildIssuePayload(item) as { title: string };

    expect(payload.title.length).toBeLessThanOrEqual(120);
    expect(payload.title.endsWith("…")).toBe(true);
    const core = payload.title.slice(0, -1);
    expect(core).toBe(words.slice(0, 20).join(" "));
  });

  test("trims trailing punctuation right before the truncation point before appending the ellipsis", () => {
    const prefix = `${"A".repeat(118)},`;
    const rest =
      "and a long tail of words that push this well past the one hundred twenty character title cap for sure";
    const item = makeItem({ title: `${prefix} ${rest}` });
    const payload = buildIssuePayload(item) as { title: string };

    expect(payload.title).toBe(`${"A".repeat(118)}…`);
    expect(payload.title).not.toContain(",…");
  });

  test("truncates a realistic long tracker-row title (issue #249 style) without mangling it", () => {
    const item = makeItem({
      title:
        "Opt-in `onUnknownFormat` tolerant handling for unparseable rows so a single malformed record no longer aborts the entire batch import run silently",
    });
    const payload = buildIssuePayload(item) as { title: string };

    expect(payload.title.length).toBeLessThanOrEqual(120);
    expect(payload.title.endsWith("…")).toBe(true);
    expect(payload.title).not.toContain("`");
  });
});

// ---------------------------------------------------------------------------
// buildIssuePayload — idempotency and title/body independence
// ---------------------------------------------------------------------------

describe("buildIssuePayload determinism", () => {
  test("is idempotent: repeated calls on the same Item produce the identical title", () => {
    const item = makeItem({
      title:
        "**F7** — `onUnknownFormat` tolerant handling for a very long row of prose that exceeds the one hundred twenty character title cap by a wide margin",
    });
    const first = buildIssuePayload(item) as { title: string };
    const second = buildIssuePayload(item) as { title: string };
    expect(second.title).toBe(first.title);
  });

  test("truncating the title does not affect the body: item.detail still appears verbatim and untruncated", () => {
    const longDetail = `**What:** ${"word ".repeat(40).trim()}`;
    const item = makeItem({
      title: "A".repeat(200),
      detail: longDetail,
    });
    const payload = buildIssuePayload(item) as { title: string; body: string };

    expect(payload.title.length).toBeLessThan(200);
    expect(payload.body).toContain(longDetail);
  });
});

// ---------------------------------------------------------------------------
// planMilestones
// ---------------------------------------------------------------------------

// A live GitHub milestone fixture — { number, title, description, state } —
// matching planMilestones' `existingMilestones` shape. `state` defaults to
// "open" since none of these tests exercise closed-milestone handling.
function makeMilestone(overrides: {
  number: number;
  title: string;
  description: string | null;
  state?: "open" | "closed";
}): {
  number: number;
  title: string;
  description: string | null;
  state: string;
} {
  return { state: "open", ...overrides };
}

// The `major` def as MILESTONE_DEFS actually declares it, reused by the
// title-match-beats-legacy test below so that test tracks the real def
// rather than a hand-typed copy of its description.
const MAJOR_DEF = MILESTONE_DEFS.find((def) => def.key === "major");
if (MAJOR_DEF === undefined) {
  throw new Error("MILESTONE_DEFS has no 'major' entry — fixture is stale.");
}

describe("planMilestones", () => {
  test("create: only titles needed by items and absent (by title or legacy title) from existingMilestones", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p1" }),
      makeItem({ key: "c", priority: "p2" }),
    ];
    const existingMilestones = [
      makeMilestone({
        number: 1,
        title: MILESTONE_TITLES.p0,
        description: PRIORITY_TIERS.p0.description,
      }),
    ];
    const result = planMilestones(items, existingMilestones, MILESTONE_DEFS);
    expect(result.create).toEqual([MILESTONE_TITLES.p1, MILESTONE_TITLES.p2]);
  });

  test("create: de-duplicates when multiple items need the same tier's milestone", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p0" }),
      makeItem({ key: "c", priority: "p0" }),
    ];
    const result = planMilestones(items, [], MILESTONE_DEFS);
    expect(result.create).toEqual([MILESTONE_TITLES.p0]);
  });

  test("create: plans the Governance milestone for governance items (no longer milestone-less)", () => {
    const items = [makeItem({ key: "gov", priority: "governance" })];
    const result = planMilestones(items, [], MILESTONE_DEFS);
    expect(result.create).toEqual([MILESTONE_TITLES.governance]);
  });

  test("create: empty when every needed milestone already exists under its current title", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p1" }),
    ];
    const existingMilestones = [
      makeMilestone({
        number: 1,
        title: MILESTONE_TITLES.p0,
        description: PRIORITY_TIERS.p0.description,
      }),
      makeMilestone({
        number: 2,
        title: MILESTONE_TITLES.p1,
        description: PRIORITY_TIERS.p1.description,
      }),
    ];
    const result = planMilestones(items, existingMilestones, MILESTONE_DEFS);
    expect(result.create).toEqual([]);
    expect(result.rename).toEqual([]);
    expect(result.describe).toEqual([]);
  });

  test("rename: a legacy-titled milestone is PATCHed to the def's current title when that title isn't already live", () => {
    const items = [makeItem({ key: "a", priority: "p1" })];
    const existingMilestones = [
      makeMilestone({
        number: 5,
        title: "Next — consumer fleet",
        description: null,
      }),
    ];
    const result = planMilestones(items, existingMilestones, MILESTONE_DEFS);
    expect(result.rename).toEqual([
      { number: 5, from: "Next — consumer fleet", to: MILESTONE_TITLES.p1 },
    ]);
    // Renamed in place, not created anew.
    expect(result.create).toEqual([]);
  });

  test("describe: a resolved milestone (by title or by rename) whose live description drifted from the def's is queued for a PATCH", () => {
    const existingMilestones = [
      makeMilestone({
        number: 1,
        title: MILESTONE_TITLES.p0,
        description: "some stale wording from before the tier existed",
      }),
    ];
    const result = planMilestones([], existingMilestones, MILESTONE_DEFS);
    expect(result.describe).toEqual([
      {
        number: 1,
        title: MILESTONE_TITLES.p0,
        description: PRIORITY_TIERS.p0.description,
      },
    ]);
  });

  test("orphan: a live milestone matching no def's title or legacyTitles is named, not deleted", () => {
    const existingMilestones = [
      makeMilestone({
        number: 99,
        title: "Some Unrelated Milestone",
        description: null,
      }),
    ];
    const result = planMilestones([], existingMilestones, MILESTONE_DEFS);
    expect(result.orphan).toEqual([
      { number: 99, title: "Some Unrelated Milestone" },
    ]);
  });

  // Regression guard, not a hypothetical: MILESTONE_DEFS records this as the
  // live state of the `major` def today (both "Breaking" and "2.0 /
  // breaking" exist). Title match must win over the legacy match — GitHub
  // rejects a PATCH that would duplicate an existing title — so the
  // legacy-titled sibling is reported as an orphan instead of renamed.
  test("title-match-beats-legacy: when a def's current title AND one of its legacyTitles both exist live, the legacy one orphans rather than renaming (major's real 'Breaking' + '2.0 / breaking' state)", () => {
    const existingMilestones = [
      makeMilestone({
        number: 10,
        title: MAJOR_DEF.title,
        description: MAJOR_DEF.description,
      }),
      makeMilestone({ number: 11, title: "Breaking", description: null }),
    ];
    const result = planMilestones([], existingMilestones, MILESTONE_DEFS);
    expect(result.rename).toEqual([]);
    expect(result.orphan).toContainEqual({ number: 11, title: "Breaking" });
  });

  // Applies plan1's create/rename/describe to a starting live state, then
  // re-plans against the result: the reconciled facets (create/rename/
  // describe) must all go empty, since nothing about the live state still
  // drifts from MILESTONE_DEFS. `orphan` is the deliberate exception —
  // nothing in planMilestones ever deletes an orphan, so it must persist
  // across the re-plan rather than disappearing or being re-reported as
  // something else.
  test("idempotency: applying the plan and re-planning yields empty create/rename/describe, with orphan persisting", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p1" }),
      makeItem({ key: "c", priority: "p2" }),
      makeItem({ key: "d", priority: "p3" }),
      makeItem({ key: "e", priority: "governance" }),
    ];
    const initial = [
      makeMilestone({
        number: 1,
        title: MILESTONE_TITLES.p0,
        description: "wrong wording",
      }),
      makeMilestone({
        number: 2,
        title: "Next — consumer fleet", // p1's legacy title
        description: null,
      }),
      makeMilestone({
        number: 10,
        title: MAJOR_DEF.title,
        description: MAJOR_DEF.description,
      }),
      makeMilestone({ number: 11, title: "Breaking", description: null }),
    ];

    const plan1 = planMilestones(items, initial, MILESTONE_DEFS);
    expect(plan1.create.length).toBeGreaterThan(0);
    expect(plan1.rename.length).toBeGreaterThan(0);
    expect(plan1.describe.length).toBeGreaterThan(0);
    expect(plan1.orphan).toEqual([{ number: 11, title: "Breaking" }]);

    // Apply the plan: renames update the live title, describes update the
    // live description, creates become brand-new live entries with the
    // def's own description. Orphans are left untouched.
    const applied = initial.map((m) => ({ ...m }));
    for (const r of plan1.rename) {
      const target = applied.find((m) => m.number === r.number);
      if (target !== undefined) target.title = r.to;
    }
    for (const d of plan1.describe) {
      const target = applied.find((m) => m.number === d.number);
      if (target !== undefined) target.description = d.description;
    }
    let nextNumber = 1000;
    for (const title of plan1.create) {
      const def = MILESTONE_DEFS.find((d) => d.title === title);
      applied.push({
        number: nextNumber++,
        title,
        description: def?.description ?? null,
        state: "open",
      });
    }

    const plan2 = planMilestones(items, applied, MILESTONE_DEFS);
    expect(plan2.create).toEqual([]);
    expect(plan2.rename).toEqual([]);
    expect(plan2.describe).toEqual([]);
    expect(plan2.orphan).toEqual([{ number: 11, title: "Breaking" }]);
  });
});

describe("PRIORITY_TIERS parity with LABEL_DEFS", () => {
  test.each(["p0", "p1", "p2", "p3"] as const)(
    "the priority:*-tier label for %s carries the identical PRIORITY_TIERS description",
    (tier) => {
      const label = LABEL_DEFS.find(
        (def) => def.name === PRIORITY_LABELS[tier],
      );
      expect(label?.description).toBe(PRIORITY_TIERS[tier].description);
    },
  );
});

// ---------------------------------------------------------------------------
// planIssueSync
// ---------------------------------------------------------------------------

interface TestIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  type?: string | null;
}

interface IssueSyncResult {
  create: {
    key: string;
    payload: unknown;
    isEpic?: boolean;
    parentKey?: string;
  }[];
  update: { number: number; key: string; payload: unknown }[];
  close: {
    number: number;
    key: string;
    comment: string;
    reason: "completed" | "not planned";
    payload?: { labels: string[] };
    labelsStale?: boolean;
  }[];
  reopen: { number: number; key: string; payload: unknown }[];
  untouched: { number: number; reason: string }[];
}

function issueFromPayload(
  number: number,
  item: TestItem,
  state: "open" | "closed",
): TestIssue {
  const payload = buildIssuePayload(item) as {
    title: string;
    body: string;
    labels: string[];
    type: string;
  };
  return {
    number,
    title: payload.title,
    body: payload.body,
    state,
    labels: payload.labels,
    type: payload.type,
  };
}

describe("planIssueSync", () => {
  test("fresh state: all non-resolved items go to create; a done item with no issue creates nothing", () => {
    const todoItem = makeItem({ key: "roadmap:p0:a", status: "todo" });
    const doneItem = makeItem({ key: "roadmap:p0:b", status: "done" });
    const result = planIssueSync([todoItem, doneItem], []) as IssueSyncResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.key).toBe("roadmap:p0:a");
    expect(result.update).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("a rejected item with no issue also creates nothing", () => {
    const rejectedItem = makeItem({
      key: "roadmap:p0:rejected-item",
      status: "rejected",
    });
    const result = planIssueSync([rejectedItem], []) as IssueSyncResult;

    expect(result.create).toEqual([]);
    expect(result.update).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("idempotency: re-running over issues built from the plan's own payloads yields empty create/update/close/reopen", () => {
    const items = [
      makeItem({ key: "roadmap:p0:a", status: "todo" }),
      makeItem({ key: "roadmap:p1:b", status: "todo", priority: "p1" }),
    ];
    const firstRun = planIssueSync(items, []) as IssueSyncResult;
    const rebuiltIssues: TestIssue[] = firstRun.create.map((entry, index) => ({
      number: index + 1,
      title: (entry.payload as { title: string }).title,
      body: (entry.payload as { body: string }).body,
      state: "open",
      labels: (entry.payload as { labels: string[] }).labels,
      type: (entry.payload as { type: string }).type,
    }));

    const secondRun = planIssueSync(items, rebuiltIssues) as IssueSyncResult;
    expect(secondRun.create).toEqual([]);
    expect(secondRun.update).toEqual([]);
    expect(secondRun.close).toEqual([]);
    expect(secondRun.reopen).toEqual([]);
    expect(secondRun.untouched).toHaveLength(2);
  });

  test("a status change that alters the desired body triggers update", () => {
    const original = makeItem({
      key: "roadmap:gov:t8",
      status: "todo",
      priority: "governance",
      detail: "**Notes:** todo — needs owner",
    });
    const existingIssue = issueFromPayload(10, original, "open");

    const updated = makeItem({
      key: "roadmap:gov:t8",
      status: "in-progress",
      priority: "governance",
      detail: "**Notes:** in-progress — owner assigned",
    });
    const result = planIssueSync([updated], [existingIssue]) as IssueSyncResult;

    expect(result.update).toHaveLength(1);
    expect(result.update[0]?.number).toBe(10);
    expect(result.update[0]?.key).toBe("roadmap:gov:t8");
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("an item that is now done closes its matched open issue, with an explanatory comment", () => {
    const original = makeItem({ key: "roadmap:p0:c", status: "todo" });
    const existingIssue = issueFromPayload(11, original, "open");

    const doneItem = makeItem({ key: "roadmap:p0:c", status: "done" });
    const result = planIssueSync(
      [doneItem],
      [existingIssue],
    ) as IssueSyncResult;

    expect(result.close).toHaveLength(1);
    expect(result.close[0]?.number).toBe(11);
    expect(result.close[0]?.key).toBe("roadmap:p0:c");
    expect(result.close[0]?.comment).toMatch(/done/i);
    expect(result.close[0]?.reason).toBe("completed");
    // The existing issue still carries "status:todo" (the open item's label),
    // stale relative to the closing payload's "status:done" — labelsStale is
    // true, and payload is the full buildIssuePayload output (ADR-0052's
    // 2026-08-20 Update — gh issue close cannot set labels itself, so the
    // runner syncs labels via a separate edit before closing whenever true).
    expect(result.close[0]?.labelsStale).toBe(true);
    expect(result.close[0]?.payload?.labels).toContain("status:done");
    expect(result.update).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("an item that is now rejected closes its matched open issue, with an explanatory comment", () => {
    const original = makeItem({ key: "roadmap:p0:rej", status: "todo" });
    const existingIssue = issueFromPayload(16, original, "open");

    const rejectedItem = makeItem({
      key: "roadmap:p0:rej",
      status: "rejected",
    });
    const result = planIssueSync(
      [rejectedItem],
      [existingIssue],
    ) as IssueSyncResult;

    expect(result.close).toHaveLength(1);
    expect(result.close[0]?.number).toBe(16);
    expect(result.close[0]?.key).toBe("roadmap:p0:rej");
    expect(result.close[0]?.comment).toMatch(/rejected/i);
    expect(result.close[0]?.reason).toBe("not planned");
    expect(result.update).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("closing an item whose current labels already match the closing payload sets labelsStale: false", () => {
    const item = makeItem({
      key: "roadmap:p0:already-labeled",
      status: "done",
    });
    // Hand-crafted: an open issue that already carries the FULL closing
    // payload's labels (as if a prior partial apply already synced them),
    // even though it hasn't been closed yet — proves managedLabelsDiffer
    // correctly reports no drift when the labels are already in sync,
    // distinct from the common case (previous test) where the open item's
    // stale "status:todo" label triggers labelsStale: true.
    const existingIssue = issueFromPayload(18, item, "open");

    const result = planIssueSync([item], [existingIssue]) as IssueSyncResult;

    expect(result.close).toHaveLength(1);
    expect(result.close[0]?.number).toBe(18);
    expect(result.close[0]?.labelsStale).toBe(false);
    expect(result.close[0]?.payload?.labels).toContain("status:done");
  });

  test("an issue whose marker key vanished from items closes, with a 'removed' comment", () => {
    const vanished = makeItem({
      key: "roadmap:p0:vanished",
      status: "todo",
    });
    const existingIssue = issueFromPayload(12, vanished, "open");

    const result = planIssueSync([], [existingIssue]) as IssueSyncResult;

    expect(result.close).toHaveLength(1);
    expect(result.close[0]?.number).toBe(12);
    expect(result.close[0]?.key).toBe("roadmap:p0:vanished");
    expect(result.close[0]?.comment).toMatch(/remov/i);
    expect(result.close[0]?.reason).toBe("not planned");
    // The "item vanished" close path has no `item` to build a payload from —
    // distinct from the isResolved() close path above, which always carries
    // both fields.
    expect(result.close[0]?.payload).toBeUndefined();
    expect(result.close[0]?.labelsStale).toBeUndefined();
    expect(result.create).toEqual([]);
  });

  test("a markerless issue labeled hub-sync is untouched, with reason 'no marker'", () => {
    const humanIssue: TestIssue = {
      number: 13,
      title: "A human-filed hub-sync issue",
      body: "No marker in this body at all.",
      state: "open",
      labels: ["hub-sync"],
    };
    const result = planIssueSync([], [humanIssue]) as IssueSyncResult;

    expect(result.untouched).toEqual([{ number: 13, reason: "no marker" }]);
    expect(result.create).toEqual([]);
    expect(result.update).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("a closed issue whose item regressed to non-resolved reopens (reopen + update in one entry)", () => {
    const item = makeItem({ key: "roadmap:p0:d" });
    const doneVersion = { ...item, status: "done" as const };
    const closedIssue = issueFromPayload(14, doneVersion, "closed");

    const todoAgain = { ...item, status: "todo" as const };
    const result = planIssueSync([todoAgain], [closedIssue]) as IssueSyncResult;

    expect(result.reopen).toHaveLength(1);
    expect(result.reopen[0]?.number).toBe(14);
    expect(result.reopen[0]?.key).toBe("roadmap:p0:d");
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.update).toEqual([]);
  });

  test("a closed issue whose item is now rejected stays untouched (both are resolved states)", () => {
    const item = makeItem({ key: "roadmap:p0:e" });
    const doneVersion = { ...item, status: "done" as const };
    const closedIssue = issueFromPayload(17, doneVersion, "closed");

    const rejectedNow = { ...item, status: "rejected" as const };
    const result = planIssueSync(
      [rejectedNow],
      [closedIssue],
    ) as IssueSyncResult;

    expect(result.untouched).toEqual([{ number: 17, reason: "in sync" }]);
    expect(result.reopen).toEqual([]);
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.update).toEqual([]);
  });

  test("matching is by marker only: a markerless issue with an identical title is untouched, and the item still creates", () => {
    const item = makeItem({
      key: "roadmap:p0:dup",
      title: "Duplicate Title",
      status: "todo",
    });
    const lookalikeIssue: TestIssue = {
      number: 15,
      title: "Duplicate Title",
      body: "No marker here, just a title collision.",
      state: "open",
      labels: [],
    };

    const result = planIssueSync([item], [lookalikeIssue]) as IssueSyncResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.key).toBe("roadmap:p0:dup");
    expect(result.untouched).toEqual([{ number: 15, reason: "no marker" }]);
    expect(result.update.some((entry) => entry.number === 15)).toBe(false);
    expect(result.close.some((entry) => entry.number === 15)).toBe(false);
  });

  test("same title/body but different managed labels (e.g. a missing STATUS_LABELS entry) triggers update, not untouched", () => {
    const item = makeItem({
      key: "roadmap:p0:label-drift",
      status: "deferred",
    });
    const payload = buildIssuePayload(item) as {
      title: string;
      body: string;
      labels: string[];
    };
    // Stale: title/body match the desired payload, but the labels predate
    // STATUS_LABELS — no "status:deferred" entry.
    const staleIssue: TestIssue = {
      number: 20,
      title: payload.title,
      body: payload.body,
      state: "open",
      labels: [HUB_LABEL, PRIORITY_LABELS.p0],
    };

    const result = planIssueSync([item], [staleIssue]) as IssueSyncResult;

    expect(result.update).toHaveLength(1);
    expect(result.update[0]?.number).toBe(20);
    expect(result.update[0]?.key).toBe("roadmap:p0:label-drift");
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.untouched).toEqual([]);
  });

  test("an extra human-added label outside HUB_LABEL/priority:*/status:* never triggers dirtiness", () => {
    const item = makeItem({ key: "roadmap:p0:human-label", status: "todo" });
    const payload = buildIssuePayload(item) as {
      title: string;
      body: string;
      labels: string[];
      type: string;
    };
    const issueWithHumanLabel: TestIssue = {
      number: 21,
      title: payload.title,
      body: payload.body,
      state: "open",
      labels: [...payload.labels, "needs-triage"],
      type: payload.type,
    };

    const result = planIssueSync(
      [item],
      [issueWithHumanLabel],
    ) as IssueSyncResult;

    expect(result.untouched).toEqual([{ number: 21, reason: "in sync" }]);
    expect(result.update).toEqual([]);
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
  });

  test("an issue whose Issue Type differs from the item's is dirty and reaches update, even with identical title/body/labels", () => {
    const item = makeItem({
      key: "roadmap:p0:type-drift",
      status: "todo",
      type: ISSUE_TYPES.libraryCapability,
    });
    const payload = buildIssuePayload(item) as {
      title: string;
      body: string;
      labels: string[];
      type: string;
    };
    // Title/body/labels are all identical to the desired payload; only the
    // Issue Type has drifted (e.g. hand-cleared on GitHub).
    const typeDriftedIssue: TestIssue = {
      number: 22,
      title: payload.title,
      body: payload.body,
      state: "open",
      labels: payload.labels,
      type: ISSUE_TYPES.friction,
    };

    const result = planIssueSync([item], [typeDriftedIssue]) as IssueSyncResult;

    expect(result.update).toHaveLength(1);
    expect(result.update[0]?.number).toBe(22);
    expect(result.update[0]?.key).toBe("roadmap:p0:type-drift");
    expect(result.untouched).toEqual([]);
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Legacy-marker cases (issue #480 / F13 — namespaced keys)
  // -------------------------------------------------------------------------

  test("an OPEN issue with a legacy marker lands in update (not close), with the item's current key", () => {
    // An issue whose body still carries the old flat impl:F7 marker must
    // resolve to the friction item, not be treated as "removed" (which would
    // close it as "not planned").
    const item = makeItem({
      key: "impl:friction:f7",
      status: "todo",
      legacyKeys: ["impl:F7"],
    });
    const issueBody = `${hubMarker("impl:F7")}\nsome body\n`;
    const legacyIssue: TestIssue = {
      number: 50,
      title: "old title",
      body: issueBody,
      state: "open",
      labels: [HUB_LABEL, PRIORITY_LABELS.p2],
    };
    const result = planIssueSync([item], [legacyIssue]) as IssueSyncResult;

    // Must be an update (to rewrite the marker), never a close.
    expect(result.update).toHaveLength(1);
    expect(result.update[0]?.number).toBe(50);
    // The reported key is the CURRENT key, not the legacy one.
    expect(result.update[0]?.key).toBe("impl:friction:f7");
    expect(result.close).toEqual([]);
    expect(result.create).toEqual([]);
  });

  test("a CLOSED+resolved issue with a legacy marker lands in update (marker migration), with the item's current key", () => {
    // The narrow exception in the closed-and-resolved branch: even a resolved
    // issue needs its stale marker rewritten so the alias can eventually retire.
    const item = makeItem({
      key: "impl:friction:f7",
      status: "done",
      legacyKeys: ["impl:F7"],
    });
    const issueBody = `${hubMarker("impl:F7")}\nsome body\n`;
    const legacyClosedIssue: TestIssue = {
      number: 51,
      title: "old title",
      body: issueBody,
      state: "closed",
      labels: [HUB_LABEL, PRIORITY_LABELS.p2],
    };
    const result = planIssueSync(
      [item],
      [legacyClosedIssue],
    ) as IssueSyncResult;

    expect(result.update).toHaveLength(1);
    expect(result.update[0]?.number).toBe(51);
    expect(result.update[0]?.key).toBe("impl:friction:f7");
    expect(result.untouched).toEqual([]);
    expect(result.close).toEqual([]);
  });

  test("the same closed+resolved issue with a CURRENT marker is untouched (idempotency after migration)", () => {
    // After the marker-migration update above, the body now opens with the
    // current key. Re-running planIssueSync must take the untouched path.
    const item = makeItem({
      key: "impl:friction:f7",
      status: "done",
      legacyKeys: ["impl:F7"],
    });
    // Use buildIssuePayload to build the "already-migrated" issue body.
    const currentIssue = issueFromPayload(52, item, "closed");
    const result = planIssueSync([item], [currentIssue]) as IssueSyncResult;

    expect(result.untouched).toEqual([{ number: 52, reason: "in sync" }]);
    expect(result.update).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("an issue whose marker matches no item is still closed as 'removed', with the raw marker key", () => {
    // Contrast with the legacy-marker case: a key that is genuinely absent
    // from both current keys and legacyKeys has no item to migrate to —
    // it was actually removed from the source trackers.
    const issueBody = `${hubMarker("impl:friction:gone")}\nsome body\n`;
    const removedIssue: TestIssue = {
      number: 53,
      title: "gone item",
      body: issueBody,
      state: "open",
      labels: [HUB_LABEL],
    };
    const result = planIssueSync([], [removedIssue]) as IssueSyncResult;

    expect(result.close).toHaveLength(1);
    expect(result.close[0]?.number).toBe(53);
    // The reported key is the RAW marker key, since there is no item to name.
    expect(result.close[0]?.key).toBe("impl:friction:gone");
    expect(result.close[0]?.comment).toMatch(/remov/i);
    expect(result.update).toEqual([]);
    expect(result.create).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// titleSimilarity
// ---------------------------------------------------------------------------

describe("titleSimilarity", () => {
  test("identical strings score 1", () => {
    expect(
      titleSimilarity(
        "F7 — Opt-in tolerant handling",
        "F7 — Opt-in tolerant handling",
      ),
    ).toBe(1);
  });

  test("is case-insensitive", () => {
    expect(titleSimilarity("Some Title", "some title")).toBe(1);
  });

  test("completely different equal-length strings score 0", () => {
    expect(titleSimilarity("aaaa", "bbbb")).toBe(0);
  });

  test("both-empty strings score 1 (the maxLength-0 guard)", () => {
    expect(titleSimilarity("", "")).toBe(1);
  });

  test("a near-match (one character off) scores strictly between 0 and 1", () => {
    const similarity = titleSimilarity(
      "F7 — Opt-in tolerant handling",
      "F7 — Opt-in tolerant handlng",
    );
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// planBackfill
// ---------------------------------------------------------------------------

interface BackfillIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
}

interface BackfillResult {
  create: {
    key: string;
    payload: unknown;
    comment: string;
    reason: "completed" | "not planned";
  }[];
  needsReview: {
    key: string;
    payload: unknown;
    candidateNumber: number;
    candidateTitle: string;
    similarity: number;
  }[];
}

describe("planBackfill", () => {
  test("a resolved 'done' item with no marker and no similar existing title lands in create with the done comment/reason", () => {
    const item = makeItem({ key: "roadmap:p0:backfill-done", status: "done" });
    const result = planBackfill([item], []) as BackfillResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.key).toBe("roadmap:p0:backfill-done");
    expect(result.create[0]?.comment).toMatch(/done/i);
    expect(result.create[0]?.reason).toBe("completed");
    expect(result.needsReview).toEqual([]);
  });

  test("a resolved 'rejected' item with no marker and no similar existing title lands in create with the rejected comment/reason", () => {
    const item = makeItem({
      key: "roadmap:p0:backfill-rejected",
      status: "rejected",
    });
    const result = planBackfill([item], []) as BackfillResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.key).toBe("roadmap:p0:backfill-rejected");
    expect(result.create[0]?.comment).toMatch(/rejected/i);
    expect(result.create[0]?.reason).toBe("not planned");
    expect(result.needsReview).toEqual([]);
  });

  test("a resolved item with no marker but a highly similar existing issue title routes to needsReview instead of create", () => {
    const item = makeItem({
      key: "roadmap:p0:backfill-similar",
      status: "done",
      title: "F7 — Opt-in tolerant handling for unparseable rows",
    });
    const payload = buildIssuePayload(item) as { title: string };
    const similarIssue: BackfillIssue = {
      number: 30,
      title: payload.title,
      body: "No marker in this body.",
      state: "open",
    };

    const result = planBackfill([item], [similarIssue]) as BackfillResult;

    expect(result.create).toEqual([]);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsReview[0]?.key).toBe("roadmap:p0:backfill-similar");
    expect(result.needsReview[0]?.candidateNumber).toBe(30);
    expect(result.needsReview[0]?.candidateTitle).toBe(payload.title);
    expect(result.needsReview[0]?.similarity).toBeGreaterThanOrEqual(0.85);
  });

  test("a resolved item that already has a marker match anywhere in existingIssues is untouched by this planner", () => {
    const item = makeItem({
      key: "roadmap:p0:already-tracked",
      status: "done",
    });
    const trackedIssue = issueFromPayload(31, item, "closed");

    const result = planBackfill([item], [trackedIssue]) as BackfillResult;

    expect(result.create).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });

  test("a not-resolved item (e.g. 'todo') is never considered, even with no marker anywhere", () => {
    const item = makeItem({ key: "roadmap:p0:still-open", status: "todo" });

    const result = planBackfill([item], []) as BackfillResult;

    expect(result.create).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });

  test("a custom lower threshold routes a borderline-similarity pair to needsReview that the default threshold would create", () => {
    const item = makeItem({
      key: "roadmap:p0:borderline-low",
      status: "done",
      title: "Improve retry backoff jitter handling",
    });
    const candidateIssue: BackfillIssue = {
      number: 32,
      title: "Improve retry timeout jitter handling",
      body: "No marker.",
      state: "open",
    };

    const defaultResult = planBackfill(
      [item],
      [candidateIssue],
    ) as BackfillResult;
    const lowThresholdResult = planBackfill([item], [candidateIssue], {
      threshold: 0.8,
    }) as BackfillResult;

    expect(defaultResult.create).toHaveLength(1);
    expect(defaultResult.needsReview).toEqual([]);
    expect(lowThresholdResult.create).toEqual([]);
    expect(lowThresholdResult.needsReview).toHaveLength(1);
  });

  test("a custom higher threshold routes a normally-needsReview pair to create instead", () => {
    const item = makeItem({
      key: "roadmap:p0:borderline-high",
      status: "done",
      title: "Add RDS Data API wrapper for read-only queries",
    });
    const candidateIssue: BackfillIssue = {
      number: 33,
      title: "Add RDS Data API wrapper for read-write queries",
      body: "No marker.",
      state: "open",
    };

    const defaultResult = planBackfill(
      [item],
      [candidateIssue],
    ) as BackfillResult;
    const highThresholdResult = planBackfill([item], [candidateIssue], {
      threshold: 0.95,
    }) as BackfillResult;

    expect(defaultResult.create).toEqual([]);
    expect(defaultResult.needsReview).toHaveLength(1);
    expect(highThresholdResult.create).toHaveLength(1);
    expect(highThresholdResult.needsReview).toEqual([]);
  });

  test("a resolved item whose existing issue carries only a LEGACY marker is not re-filed (create is empty)", () => {
    // planBackfill must resolve each existing marker through indexItemsByKey so
    // an item already tracked under its old key is not backfilled a second time.
    const item = makeItem({
      key: "impl:friction:f7",
      status: "done",
      legacyKeys: ["impl:F7"],
    });
    // The issue's body has the OLD marker — exactly what happens to pre-#480
    // issues that have not yet been migrated by planIssueSync.
    const legacyBody = `${hubMarker("impl:F7")}\nsome body\n`;
    const trackedWithLegacyMarker: BackfillIssue = {
      number: 60,
      title: "old title",
      body: legacyBody,
      state: "closed",
    };
    const result = planBackfill(
      [item],
      [trackedWithLegacyMarker],
    ) as BackfillResult;

    // The item resolves through its legacy key → already tracked → no create.
    expect(result.create).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// planProjectSync
// ---------------------------------------------------------------------------

interface TrackedIssue {
  number: number;
  state: "open" | "closed";
  status: TestItem["status"];
  priority: TestItem["priority"];
}

interface ProjectItem {
  itemId: string;
  issueNumber: number;
  status: string | null;
  priority: string | null;
}

describe("planProjectSync", () => {
  test("an open tracked issue absent from the board is added with its mapped status name", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 1, state: "open", status: "todo", priority: "p0" },
    ];
    const result = planProjectSync(trackedIssues, []);

    expect(result.add).toEqual([
      { issueNumber: 1, status: "To Do", priority: "0-now" },
    ]);
    expect(result.setStatus).toEqual([]);
    expect(result.setPriority).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test.each([
    ["todo", "To Do"],
    ["in-progress", "In Progress"],
    ["deferred", "Deferred"],
    ["blocked", "Blocked"],
    ["done", "Done"],
    ["rejected", "Rejected"],
  ] as const)(
    "maps tracked-issue status %s to the board option %j when adding",
    (status, expectedOption) => {
      const trackedIssues: TrackedIssue[] = [
        { number: 2, state: "open", status, priority: "p1" },
      ];
      const result = planProjectSync(trackedIssues, []);
      expect(result.add).toEqual([
        { issueNumber: 2, status: expectedOption, priority: "1-next" },
      ]);
    },
  );

  test("a board item whose status drifted from the desired mapping is corrected via setStatus", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 3, state: "open", status: "in-progress", priority: "p1" },
    ];
    const existingProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_1",
        issueNumber: 3,
        status: "To Do",
        priority: "1-next",
      },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.setStatus).toEqual([
      { itemId: "PVTI_1", issueNumber: 3, status: "In Progress" },
    ]);
    expect(result.setPriority).toEqual([]);
    expect(result.add).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("a board item whose Priority option differs from desired appears in setPriority", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 30, state: "open", status: "todo", priority: "p2" },
    ];
    const existingProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_30",
        issueNumber: 30,
        status: "To Do",
        priority: "0-now",
      },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.setPriority).toEqual([
      { itemId: "PVTI_30", issueNumber: 30, priority: "2-later" },
    ]);
    expect(result.setStatus).toEqual([]);
    expect(result.add).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("adding a governance item resolves priority to 'Governance' (a real 4th board option, ADR-0052's 2026-08-20 Update)", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 31, state: "open", status: "todo", priority: "governance" },
    ];
    const result = planProjectSync(trackedIssues, []);

    expect(result.add).toEqual([
      { issueNumber: 31, status: "To Do", priority: "Governance" },
    ]);
  });

  test("a governance item whose board Priority is stale (some other leftover value) gets setPriority to 'Governance'", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 32, state: "open", status: "todo", priority: "governance" },
    ];
    const existingProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_32",
        issueNumber: 32,
        status: "To Do",
        priority: "1-next",
      },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.setPriority).toEqual([
      { itemId: "PVTI_32", issueNumber: 32, priority: "Governance" },
    ]);
    expect(result.setStatus).toEqual([]);
  });

  test("a governance item whose board Priority is still null (stale from before ADR-0052) gets setPriority to correct it to 'Governance'", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 33, state: "open", status: "todo", priority: "governance" },
    ];
    const existingProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_33",
        issueNumber: 33,
        status: "To Do",
        priority: null,
      },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.setPriority).toEqual([
      { itemId: "PVTI_33", issueNumber: 33, priority: "Governance" },
    ]);
    expect(result.setStatus).toEqual([]);
  });

  test("a governance item whose board Priority is already 'Governance' is not re-planned", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 34, state: "open", status: "todo", priority: "governance" },
    ];
    const existingProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_34",
        issueNumber: 34,
        status: "To Do",
        priority: "Governance",
      },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.setPriority).toEqual([]);
    expect(result.setStatus).toEqual([]);
  });

  test("a board item whose tracked issue is closed is archived", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 4, state: "closed", status: "done", priority: "p0" },
    ];
    const existingProjectItems: ProjectItem[] = [
      { itemId: "PVTI_2", issueNumber: 4, status: "Done", priority: "0-now" },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.archive).toEqual([{ itemId: "PVTI_2", issueNumber: 4 }]);
    expect(result.add).toEqual([]);
    expect(result.setStatus).toEqual([]);
    expect(result.setPriority).toEqual([]);
  });

  test("a board item whose issueNumber is untracked is left alone entirely (never archives a human-added card)", () => {
    const existingProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_3",
        issueNumber: 999,
        status: "To Do",
        priority: "0-now",
      },
    ];
    const result = planProjectSync([], existingProjectItems);

    expect(result.add).toEqual([]);
    expect(result.setStatus).toEqual([]);
    expect(result.setPriority).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("idempotency: re-running over the state its own plan produced yields empty add/setStatus/setPriority/archive", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 5, state: "open", status: "todo", priority: "p0" },
    ];
    const firstRun = planProjectSync(trackedIssues, []);
    expect(firstRun.add).toHaveLength(1);

    const appliedProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_5",
        issueNumber: firstRun.add[0]?.issueNumber ?? 5,
        status: firstRun.add[0]?.status ?? "To Do",
        priority: firstRun.add[0]?.priority ?? "0-now",
      },
    ];
    const secondRun = planProjectSync(trackedIssues, appliedProjectItems);

    expect(secondRun.add).toEqual([]);
    expect(secondRun.setStatus).toEqual([]);
    expect(secondRun.setPriority).toEqual([]);
    expect(secondRun.archive).toEqual([]);
  });

  test("an unmapped status value throws instead of silently defaulting to Pending (defensive: unreachable through the public Item/TrackedIssue type, only reachable by casting past it)", () => {
    const trackedIssues: TrackedIssue[] = [
      {
        number: 6,
        state: "open",
        status: "bogus" as unknown as TestItem["status"],
        priority: "p0",
      },
    ];
    expect(() => planProjectSync(trackedIssues, [])).toThrow(
      /no board option mapped for status "bogus"/,
    );
  });
});

// ---------------------------------------------------------------------------
// epicStatus (ADR-0073)
// ---------------------------------------------------------------------------

describe("epicStatus", () => {
  test.each<[string, { status: string }[], string]>([
    [
      "in-progress beats todo/blocked/deferred",
      [
        { status: "deferred" },
        { status: "blocked" },
        { status: "todo" },
        { status: "in-progress" },
      ],
      "in-progress",
    ],
    [
      "todo beats blocked/deferred when no in-progress child exists",
      [{ status: "deferred" }, { status: "blocked" }, { status: "todo" }],
      "todo",
    ],
    [
      "blocked beats deferred when no in-progress/todo child exists",
      [{ status: "deferred" }, { status: "blocked" }],
      "blocked",
    ],
    [
      "deferred is the floor when nothing more urgent exists",
      [{ status: "deferred" }],
      "deferred",
    ],
  ])("%s", (_label, children, expected) => {
    expect(epicStatus(children)).toBe(expected);
  });

  test("a resolved-only child set (done/rejected) never yields a resolved status", () => {
    const result = epicStatus([{ status: "done" }, { status: "rejected" }]);
    expect(result).not.toBe("done");
    expect(result).not.toBe("rejected");
  });

  test("done/rejected children are ignored when an unresolved child exists", () => {
    expect(epicStatus([{ status: "done" }, { status: "blocked" }])).toBe(
      "blocked",
    );
  });
});

// ---------------------------------------------------------------------------
// epicPriority (ADR-0073)
// ---------------------------------------------------------------------------

describe("epicPriority", () => {
  test.each<[string, { status: string; priority: string }[], string]>([
    [
      "p0 beats p1/p2 among unresolved children",
      [
        { status: "todo", priority: "p2" },
        { status: "todo", priority: "p0" },
        { status: "todo", priority: "p1" },
      ],
      "p0",
    ],
    [
      "p2 beats p3 among unresolved children",
      [
        { status: "todo", priority: "p3" },
        { status: "todo", priority: "p2" },
      ],
      "p2",
    ],
    [
      "p3 beats governance among unresolved children",
      [
        { status: "todo", priority: "governance" },
        { status: "todo", priority: "p3" },
      ],
      "p3",
    ],
    [
      "governance is the floor when nothing more urgent exists",
      [{ status: "todo", priority: "governance" }],
      "governance",
    ],
  ])("%s", (_label, children, expected) => {
    expect(epicPriority(children)).toBe(expected);
  });

  // The important one: a finished urgent item must not pin the epic to the
  // top of the board's Priority-ascending sort long after its remaining
  // work dropped to a lower tier.
  test("a done p0 child alongside an open p2 child yields p2, not p0 — a finished urgent item cannot pin the epic to the top of the board", () => {
    const children = [
      { status: "done", priority: "p0" },
      { status: "todo", priority: "p2" },
    ];
    expect(epicPriority(children)).toBe("p2");
  });

  test("an empty child list falls back to governance", () => {
    expect(epicPriority([])).toBe("governance");
  });
});

// ---------------------------------------------------------------------------
// Epic emission via actionableItems (ADR-0073)
// ---------------------------------------------------------------------------

describe("actionableItems: epic emission", () => {
  test("a section with at least one unresolved row yields exactly one grouping epic, with isEpic/type/sourcePath set", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items } = actionableItems(roadmap, implementation);

    // Library friction (F-series) has F7 (Deferred) alongside F9 (Done) —
    // at least one unresolved row, so the epic is emitted exactly once.
    const frictionEpics = items.filter(
      (item) => item.key === EPIC_KEYS.friction,
    );
    expect(frictionEpics).toHaveLength(1);
    const epic = frictionEpics[0];
    expect(epic?.isEpic).toBe(true);
    expect(epic?.type).toBe(ISSUE_TYPES.friction);
    expect(epic?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
  });

  // Named for the 19-vs-7 measurement in ADR-0073: emitting on "any child"
  // instead of "any UNRESOLVED child" would create-and-immediately-close 12
  // epics whose sections already shipped in full — pure issue-feed noise
  // that never shows on the board's `is:open` view.
  test("[19-vs-7] a section whose every row is already Done/Rejected emits no epic", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items } = actionableItems(roadmap, implementation);

    // ADR-0035 rollout's only row (A7) is Rejected — a fully-resolved
    // section with nothing left to group.
    expect(items.some((item) => item.key === EPIC_KEYS.adr0035Rollout)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// parentKey (ADR-0073)
// ---------------------------------------------------------------------------

describe("parentKey", () => {
  test("items from a given section carry that section's EPIC_KEYS value", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items } = actionableItems(roadmap, implementation);

    const f7 = items.find((item) => item.key === "impl:friction:f7");
    expect(f7?.parentKey).toBe(EPIC_KEYS.friction);
  });

  // The decision this pins: ROADMAP Priority 1 namespaces its OWN item keys
  // per wave ("roadmap:W3:...", not "roadmap:p1:..."), but its parentKey
  // still resolves to the single Priority-1 epic — keyed by declared
  // *section*, not by the row's own key namespace.
  test("a ROADMAP Priority 1 row carries EPIC_KEYS.roadmapP1 even though its own key is namespaced by wave, not by section", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const { items } = actionableItems(roadmap, implementation);

    const w3 = items.find((item) => item.key === "roadmap:W3:ecs-ops");
    expect(w3).toBeDefined();
    expect(w3?.key.startsWith("roadmap:p1:")).toBe(false);
    expect(w3?.parentKey).toBe(EPIC_KEYS.roadmapP1);
  });
});

// ---------------------------------------------------------------------------
// planParentLinks (ADR-0073)
// ---------------------------------------------------------------------------

interface ParentLinkIssue {
  number: number;
  body: string;
  state: "open" | "closed";
  parentNumber: number | null;
}

function issueWithParent(
  number: number,
  key: string,
  state: "open" | "closed",
  parentNumber: number | null,
): ParentLinkIssue {
  return { number, body: hubMarker(key), state, parentNumber };
}

describe("planParentLinks", () => {
  const epicItem = makeItem({ key: EPIC_KEYS.friction, isEpic: true });
  const childItem = makeItem({
    key: "impl:friction:f7",
    parentKey: EPIC_KEYS.friction,
  });

  test("set: an open issue whose current parent differs from its item's epic gets the epic's issue number", () => {
    const epicIssue = issueWithParent(100, epicItem.key, "open", null);
    const childIssue = issueWithParent(200, childItem.key, "open", null);

    const result = planParentLinks(
      [epicItem, childItem],
      [epicIssue, childIssue],
    );

    expect(result.set).toEqual([
      {
        number: 200,
        key: childItem.key,
        parentNumber: 100,
        parentKey: EPIC_KEYS.friction,
      },
    ]);
    expect(result.clear).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  test("clear: an issue with a parent whose item now declares none is cleared", () => {
    const epicIssue = issueWithParent(101, epicItem.key, "open", null);
    const orphanedChild = makeItem({ key: "impl:friction:f9" });
    const childIssue = issueWithParent(201, orphanedChild.key, "open", 101);

    const result = planParentLinks(
      [epicItem, orphanedChild],
      [epicIssue, childIssue],
    );

    expect(result.clear).toEqual([{ number: 201, key: orphanedChild.key }]);
    expect(result.set).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  test("pending: the epic has no issue yet, so the child's link waits, carrying the child's own issue number", () => {
    const childIssue = issueWithParent(202, childItem.key, "open", null);

    const result = planParentLinks([epicItem, childItem], [childIssue]);

    expect(result.pending).toEqual([
      { number: 202, key: childItem.key, parentKey: EPIC_KEYS.friction },
    ]);
    expect(result.set).toEqual([]);
    expect(result.clear).toEqual([]);
  });

  test("an epic is never given a parent, even when it declares one itself", () => {
    const epicWithParentKey = makeItem({
      key: EPIC_KEYS.friction,
      isEpic: true,
      parentKey: EPIC_KEYS.gated,
    });
    const parentEpicIssue = issueWithParent(300, EPIC_KEYS.gated, "open", null);
    const epicIssue = issueWithParent(301, epicWithParentKey.key, "open", null);

    const result = planParentLinks(
      [epicWithParentKey],
      [parentEpicIssue, epicIssue],
    );

    expect(result.set).toEqual([]);
    expect(result.clear).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  test("a closed issue's parent link is left alone, even when it would otherwise need a set", () => {
    const epicIssue = issueWithParent(102, epicItem.key, "open", null);
    const closedChildIssue = issueWithParent(
      203,
      childItem.key,
      "closed",
      null,
    );

    const result = planParentLinks(
      [epicItem, childItem],
      [epicIssue, closedChildIssue],
    );

    expect(result.set).toEqual([]);
    expect(result.clear).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  test("a legacy-marker issue still resolves to its item for parent linking", () => {
    const legacyChild = makeItem({
      key: "impl:friction:f7",
      parentKey: EPIC_KEYS.friction,
      legacyKeys: ["impl:F7"],
    });
    const epicIssue = issueWithParent(103, epicItem.key, "open", null);
    const legacyMarkerIssue = issueWithParent(204, "impl:F7", "open", null);

    const result = planParentLinks(
      [epicItem, legacyChild],
      [epicIssue, legacyMarkerIssue],
    );

    expect(result.set).toEqual([
      {
        number: 204,
        key: legacyChild.key,
        parentNumber: 103,
        parentKey: EPIC_KEYS.friction,
      },
    ]);
  });

  test("idempotency: applying the plan's set and re-planning yields empty set/clear", () => {
    const epicIssue = issueWithParent(104, epicItem.key, "open", null);
    const childIssue = issueWithParent(205, childItem.key, "open", null);

    const firstRun = planParentLinks(
      [epicItem, childItem],
      [epicIssue, childIssue],
    );
    expect(firstRun.set).toHaveLength(1);

    const appliedChildIssue: ParentLinkIssue = {
      ...childIssue,
      parentNumber: firstRun.set[0]?.parentNumber ?? null,
    };
    const secondRun = planParentLinks(
      [epicItem, childItem],
      [epicIssue, appliedChildIssue],
    );

    expect(secondRun.set).toEqual([]);
    expect(secondRun.clear).toEqual([]);
    expect(secondRun.pending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// planIssueSync create entries: isEpic / parentKey (ADR-0073)
// ---------------------------------------------------------------------------

describe("planIssueSync create entries carry isEpic/parentKey", () => {
  test("an epic item's create entry has isEpic: true", () => {
    const epicItem = makeItem({
      key: EPIC_KEYS.friction,
      isEpic: true,
      status: "todo",
    });
    const result = planIssueSync([epicItem], []) as IssueSyncResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.isEpic).toBe(true);
  });

  test("a child item's create entry carries its parentKey", () => {
    const childItem = makeItem({
      key: "impl:friction:f7",
      parentKey: EPIC_KEYS.friction,
      status: "todo",
    });
    const result = planIssueSync([childItem], []) as IssueSyncResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.parentKey).toBe(EPIC_KEYS.friction);
  });

  test("a plain item's create entry carries neither isEpic nor parentKey (conditionally spread, not present as undefined)", () => {
    const plainItem = makeItem({ key: "roadmap:p0:plain", status: "todo" });
    const result = planIssueSync([plainItem], []) as IssueSyncResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]).not.toHaveProperty("isEpic");
    expect(result.create[0]).not.toHaveProperty("parentKey");
  });
});

// ---------------------------------------------------------------------------
// planBackfill skips epics (ADR-0073)
// ---------------------------------------------------------------------------

describe("planBackfill skips epics", () => {
  test("a Done epic item is never backfilled, even with no marker anywhere", () => {
    const doneEpic = makeItem({
      key: EPIC_KEYS.friction,
      isEpic: true,
      status: "done",
    });
    const result = planBackfill([doneEpic], []) as BackfillResult;

    expect(result.create).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });

  test("a Done non-epic item with the same status is still backfilled", () => {
    const doneItem = makeItem({
      key: "roadmap:p0:backfill-done-non-epic",
      status: "done",
    });
    const result = planBackfill([doneItem], []) as BackfillResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.key).toBe("roadmap:p0:backfill-done-non-epic");
  });
});

// ---------------------------------------------------------------------------
// planIssueTypes (ADR-0073) — Issue Type provisioning/retirement plan
// ---------------------------------------------------------------------------

describe("planIssueTypes", () => {
  test("a declared type with no live type of that name lands in create, carrying its description and color", () => {
    const result = planIssueTypes([], ISSUE_TYPE_DEFS, new Map());

    expect(result.create).toEqual(ISSUE_TYPE_DEFS);
    const friction = result.create.find((def) => def.name === "Friction");
    expect(friction?.description).toBe(TYPE_KINDS.friction.description);
    expect(friction?.color).toBe(TYPE_KINDS.friction.color);
  });

  test("idempotent: a live type whose name is declared lands in neither create nor retire", () => {
    const liveTypes = [{ id: "IT_1", name: "Friction" }];
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, new Map());

    expect(result.create.some((def) => def.name === "Friction")).toBe(false);
    expect(result.retire.some((type) => type.name === "Friction")).toBe(false);
  });

  test("an undeclared live type with count 0 retires, carrying its id (what deleteIssueType needs)", () => {
    const liveTypes = [{ id: "IT_LEGACY", name: "Capability" }];
    const counts = new Map([["Capability", 0]]);
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, counts);

    expect(result.retire).toEqual([{ id: "IT_LEGACY", name: "Capability" }]);
  });

  test("an undeclared live type absent from the counts map is treated as 0 and retires (absence means no issues carry it, not unknown)", () => {
    const liveTypes = [{ id: "IT_LEGACY", name: "Capability" }];
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, new Map());

    expect(result.retire).toEqual([{ id: "IT_LEGACY", name: "Capability" }]);
  });

  test("an undeclared live type with count > 0 is blocked, not retired — this guard keeps retirement non-destructive", () => {
    const liveTypes = [{ id: "IT_LEGACY", name: "Capability" }];
    const counts = new Map([["Capability", 48]]);
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, counts);

    expect(result.blocked).toEqual([
      { id: "IT_LEGACY", name: "Capability", count: 48 },
    ]);
    expect(result.retire).toEqual([]);
  });

  test("a declared live type is never retired even with zero issues (a freshly provisioned kind legitimately has none yet)", () => {
    const liveTypes = [{ id: "IT_NEW", name: "UI" }];
    const counts = new Map([["UI", 0]]);
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, counts);

    expect(result.retire).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  test("realistic live state: 4 live types incl. undeclared Capability at 48 issues -> 7 to create, none to retire, Capability blocked", () => {
    const liveTypes = [
      { id: "IT_CAP", name: "Capability" },
      { id: "IT_FRI", name: "Friction" },
      { id: "IT_CS", name: "Consumer script" },
      { id: "IT_GOV", name: "Governance" },
    ];
    const counts = new Map([["Capability", 48]]);
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, counts);

    expect(result.create).toHaveLength(7);
    expect(result.retire).toEqual([]);
    expect(result.blocked).toEqual([
      { id: "IT_CAP", name: "Capability", count: 48 },
    ]);
  });

  test("idempotency law: feeding the post-apply state (all declared types live, nothing undeclared) plans nothing in any bucket", () => {
    const liveTypes = ISSUE_TYPE_DEFS.map((def, index) => ({
      id: `IT_${index}`,
      name: def.name,
    }));
    const result = planIssueTypes(liveTypes, ISSUE_TYPE_DEFS, new Map());

    expect(result).toEqual({ create: [], retire: [], blocked: [] });
  });
});

// ---------------------------------------------------------------------------
// planClosedRetype
// ---------------------------------------------------------------------------

describe("planClosedRetype", () => {
  test("a closed, untyped, marker-bearing issue backfills to its item's type — the dominant live case (131 of 136), a backfill rather than a re-classification", () => {
    const item = makeItem({
      key: "impl:friction:f1",
      type: ISSUE_TYPES.friction,
    });
    const issue = {
      number: 7,
      body: hubMarker("impl:friction:f1"),
      state: "closed" as const,
      type: null,
    };

    const result = planClosedRetype([item], [issue]);

    expect(result.set).toEqual([
      {
        number: 7,
        key: "impl:friction:f1",
        from: null,
        to: ISSUE_TYPES.friction,
      },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  test("idempotency law: a closed issue whose live type already equals its item's type lands in neither bucket", () => {
    const item = makeItem({
      key: "impl:friction:f2",
      type: ISSUE_TYPES.friction,
    });
    const issue = {
      number: 8,
      body: hubMarker("impl:friction:f2"),
      state: "closed" as const,
      type: ISSUE_TYPES.friction,
    };

    const result = planClosedRetype([item], [issue]);

    expect(result.set).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  test("a closed issue carrying the retired 'Capability' type retypes to its item's current type — the one live genuine re-classification (#474 -> Library capability)", () => {
    const item = makeItem({
      key: "impl:library:c1",
      type: ISSUE_TYPES.libraryCapability,
    });
    const issue = {
      number: 474,
      body: hubMarker("impl:library:c1"),
      state: "closed" as const,
      type: "Capability",
    };

    const result = planClosedRetype([item], [issue]);

    expect(result.set).toEqual([
      {
        number: 474,
        key: "impl:library:c1",
        from: "Capability",
        to: ISSUE_TYPES.libraryCapability,
      },
    ]);
  });

  test("an open issue is ignored entirely, even with a wrong type — planIssueSync's isDirty already owns open issues' type", () => {
    const item = makeItem({
      key: "impl:friction:f3",
      type: ISSUE_TYPES.friction,
    });
    const issue = {
      number: 9,
      body: hubMarker("impl:friction:f3"),
      state: "open" as const,
      type: null,
    };

    const result = planClosedRetype([item], [issue]);

    expect(result.set).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  test("a closed, markerless issue is ignored entirely — match is by marker only, so a hand-filed issue is never written to", () => {
    const item = makeItem({
      key: "impl:friction:f4",
      type: ISSUE_TYPES.friction,
    });
    const issue = {
      number: 10,
      body: "A hand-filed issue with no hub-sync marker at all.",
      state: "closed" as const,
      type: null,
    };

    const result = planClosedRetype([item], [issue]);

    expect(result.set).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  test("a closed issue whose marker resolves to no item lands in unmatched, keyed on the marker — nothing can supply a type for a removed row (live: #359)", () => {
    const issue = {
      number: 359,
      body: hubMarker("roadmap:w4:removed-row"),
      state: "closed" as const,
      type: null,
    };

    const result = planClosedRetype([], [issue]);

    expect(result.unmatched).toEqual([
      { number: 359, key: "roadmap:w4:removed-row", from: null },
    ]);
    expect(result.set).toEqual([]);
  });

  test("a closed issue whose marker is a legacy key still retypes, and the emitted key is the item's current key, not the legacy marker matched on", () => {
    const item = makeItem({
      key: "impl:cli:c2",
      type: ISSUE_TYPES.cliCapability,
      legacyKeys: ["impl:c2"],
    });
    const issue = {
      number: 11,
      body: hubMarker("impl:c2"),
      state: "closed" as const,
      type: null,
    };

    const result = planClosedRetype([item], [issue]);

    expect(result.set).toEqual([
      {
        number: 11,
        key: "impl:cli:c2",
        from: null,
        to: ISSUE_TYPES.cliCapability,
      },
    ]);
  });

  test("a mixed batch partitions correctly: backfill, already-correct, re-classified, open, markerless, and unmatched each land where expected without cross-contamination", () => {
    const backfillItem = makeItem({
      key: "impl:friction:f1",
      type: ISSUE_TYPES.friction,
    });
    const correctItem = makeItem({
      key: "impl:friction:f2",
      type: ISSUE_TYPES.friction,
    });
    const reclassifiedItem = makeItem({
      key: "impl:library:c1",
      type: ISSUE_TYPES.libraryCapability,
    });

    const issues = [
      {
        number: 7,
        body: hubMarker("impl:friction:f1"),
        state: "closed" as const,
        type: null,
      },
      {
        number: 8,
        body: hubMarker("impl:friction:f2"),
        state: "closed" as const,
        type: ISSUE_TYPES.friction,
      },
      {
        number: 474,
        body: hubMarker("impl:library:c1"),
        state: "closed" as const,
        type: "Capability",
      },
      {
        number: 9,
        body: hubMarker("impl:friction:f3"),
        state: "open" as const,
        type: null,
      },
      {
        number: 10,
        body: "A hand-filed issue with no hub-sync marker at all.",
        state: "closed" as const,
        type: null,
      },
      {
        number: 359,
        body: hubMarker("roadmap:w4:removed-row"),
        state: "closed" as const,
        type: null,
      },
    ];

    const result = planClosedRetype(
      [backfillItem, correctItem, reclassifiedItem],
      issues,
    );

    expect(result.set).toEqual([
      {
        number: 7,
        key: "impl:friction:f1",
        from: null,
        to: ISSUE_TYPES.friction,
      },
      {
        number: 474,
        key: "impl:library:c1",
        from: "Capability",
        to: ISSUE_TYPES.libraryCapability,
      },
    ]);
    expect(result.unmatched).toEqual([
      { number: 359, key: "roadmap:w4:removed-row", from: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// countIssuesByType
// ---------------------------------------------------------------------------

describe("countIssuesByType", () => {
  test("untyped issues (type: null) are excluded, and a name absent from the input is absent from the Map (not 0)", () => {
    const counts = countIssuesByType([{ type: "Friction" }, { type: null }]);

    expect(counts.get("Friction")).toBe(1);
    expect(counts.has("Governance")).toBe(false);
    expect(counts.get("Governance")).toBeUndefined();
  });

  test("sums repeats across both open and closed issues", () => {
    const counts = countIssuesByType([
      { type: "Capability" },
      { type: "Capability" },
      { type: "Capability" },
      { type: "Friction" },
    ]);

    expect(counts.get("Capability")).toBe(3);
    expect(counts.get("Friction")).toBe(1);
  });
});
