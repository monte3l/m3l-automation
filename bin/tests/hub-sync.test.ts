import { describe, expect, test } from "vitest";
import { extractImplementation, extractRoadmap } from "../lib/project-hub.mjs";
import {
  HUB_LABEL,
  HUB_PROJECT_TITLE,
  MILESTONE_TITLES,
  PRIORITY_LABELS,
  actionableItems,
  buildIssuePayload,
  hubMarker,
  parseHubMarker,
  planIssueSync,
  planMilestones,
  planProjectSync,
} from "../lib/hub-sync.mjs";

// ---------------------------------------------------------------------------
// Fixtures — headers copied verbatim from the real trackers per the PR 2
// contract so actionableItems is exercised against realistic markdown, built
// by running the REAL extractRoadmap/extractImplementation from
// project-hub.mjs (keeps the two libs contractually coupled in tests).
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What                          | Status      | Why now / Notes      |
| ------- | ------------------------------ | ----------- | ---------------------- |
| **P0A** | First priority zero item       | pending     | needs doing             |
| **P0B** | Second priority zero item      | done (#42)  | already shipped         |
| \`Multi/Word\`: Test!! | Punctuation-heavy item | pending | for slug testing |

## Priority 1

| Wave   | Scripts    | Status  | Depends on |
| ------ | ---------- | ------- | ---------- |
| **W3** | \`ecs-ops\`  | pending | W0         |
| **W4** | \`sqs-etl\`  | done    | W0         |

## Priority 2

| Item              | Unblock condition                     |
| ------------------ | ---------------------------------------- |
| **D4** SSM config  | a 2nd script hand-rolling SSM config     |

## Governance follow-ups

| Item   | What                  | Notes                           |
| ------ | ---------------------- | ---------------------------------- |
| **T1** | Rename script           | **done** — landed on branch        |
| **T8** | Getter-reality check     | pending — backlog only             |
`;

const ROADMAP_MISSING_GOVERNANCE_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What                    | Status  | Why now / Notes |
| ------- | ------------------------ | ------- | ------------------ |
| **P0A** | First priority zero item | pending | needs doing         |

## Priority 1

| Wave   | Scripts    | Status  | Depends on |
| ------ | ---------- | ------- | ---------- |
| **W3** | \`ecs-ops\`  | pending | W0         |

## Priority 2

| Item              | Unblock condition                    |
| ------------------ | --------------------------------------- |
| **D4** SSM config  | a 2nd script hand-rolling SSM config    |
`;

const IMPLEMENTATION_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status  | Title & change                                          | Source / call-site |
| ------ | -------- | ------- | ----------------------------------------------------------- | --------------------- |
| **F7** | P2       | pending | Opt-in \`onUnknownFormat\` tolerant a \\| b handling           | json-etl log F7        |
| **F9** | P1       | done    | Some other change entirely                                 | some other log         |

## AWS getter reality

| Provider getter | AWS service | Status  | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------- | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | wrapped | aws/s3                | s3-objects (done)         | ADR-0033            |

## Gated library modules & deferred decisions (P2)

| ID                  | Unblock condition                          |
| --------------------- | ---------------------------------------------- |
| **D4** SSM config      | a 2nd script hand-rolling SSM config fetch      |
`;

const IMPLEMENTATION_MISSING_GATED_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status  | Title & change      | Source / call-site |
| ------ | -------- | ------- | ---------------------- | --------------------- |
| **F7** | P2       | pending | still relevant          | json-etl log F7        |

## AWS getter reality

| Provider getter | AWS service | Status  | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------- | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | wrapped | aws/s3                | s3-objects (done)         | ADR-0033            |
`;

const IMPLEMENTATION_DEDUPE_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status  | Title & change            | Source / call-site |
| ------ | -------- | ------- | ---------------------------- | --------------------- |
| **F7** | P2       | pending | First title for F7             | first-call-site         |
| **F7** | P1       | done    | Second title for F7            | second-call-site        |

## AWS getter reality

| Provider getter | AWS service | Status  | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------- | -------------------- | ----------------------- | ------------------ |
| \`s3\`             | S3            | wrapped | aws/s3                | s3-objects (done)         | ADR-0033            |

## Gated library modules & deferred decisions (P2)

| ID                  | Unblock condition                          |
| --------------------- | ---------------------------------------------- |
| **D4** SSM config      | a 2nd script hand-rolling SSM config fetch      |
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
  status: "done" | "pending" | "in-review" | "other";
  priority: "p0" | "p1" | "p2" | "governance";
  sourcePath: string;
  sourceAnchor: string;
  detail: string;
}

function makeItem(overrides: Partial<TestItem> = {}): TestItem {
  return {
    key: "roadmap:p0:sample-item",
    title: "Sample item",
    status: "pending",
    priority: "p0",
    sourcePath: "docs/ROADMAP.md",
    sourceAnchor: "#priority-0",
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
    expect(HUB_PROJECT_TITLE).toBe("m3l-automation hub");
  });
});

describe("PRIORITY_LABELS", () => {
  test("maps every priority to its 'priority:<x>' label string", () => {
    expect(PRIORITY_LABELS).toMatchObject({
      p0: "priority:p0",
      p1: "priority:p1",
      p2: "priority:p2",
      governance: "priority:governance",
    });
  });
});

describe("MILESTONE_TITLES", () => {
  test("maps p0/p1/p2 to their milestone titles, with no governance entry", () => {
    expect(MILESTONE_TITLES).toMatchObject({
      p0: "Priority 0",
      p1: "Priority 1",
      p2: "Priority 2",
    });
    expect(
      (MILESTONE_TITLES as Record<string, string>)["governance"],
    ).toBeUndefined();
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
});

// ---------------------------------------------------------------------------
// actionableItems
// ---------------------------------------------------------------------------

describe("actionableItems", () => {
  test("emits the exact documented keys for P0/P1/governance/F-series rows", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];
    const keys = items.map((item) => item.key);

    expect(keys).toContain("roadmap:p0:p0a");
    expect(keys).toContain("roadmap:W3:ecs-ops");
    expect(keys).toContain("roadmap:gov:t1");
    expect(keys).toContain("impl:F7");
  });

  test("emits the gated (P2) item keyed off the slugged ID cell, priority p2", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];
    const gated = items.find((item) => item.key === "impl:d4-ssm-config");

    expect(gated).toBeDefined();
    expect(gated?.priority).toBe("p2");
    expect(gated?.status).toBe("pending");
    expect(gated?.detail).toContain("Unblock condition");
    expect(gated?.detail).toContain(
      "a 2nd script hand-rolling SSM config fetch",
    );
  });

  test("does NOT emit ROADMAP Priority 2 rows (the IMPLEMENTATION gated table is the source)", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];

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
    const items = actionableItems(roadmap, implementation) as TestItem[];

    const doneP0 = items.find((item) => item.key === "roadmap:p0:p0b");
    const doneW4 = items.find((item) => item.key === "roadmap:W4:sqs-etl");
    const doneF9 = items.find((item) => item.key === "impl:F9");

    expect(doneP0?.status).toBe("done");
    expect(doneW4?.status).toBe("done");
    expect(doneF9?.status).toBe("done");
  });

  test("governance status is classified from the Notes cell, not a Status column", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];

    const t1 = items.find((item) => item.key === "roadmap:gov:t1");
    const t8 = items.find((item) => item.key === "roadmap:gov:t8");

    expect(t1?.priority).toBe("governance");
    expect(t1?.status).toBe("done");
    expect(t8?.status).toBe("pending");
  });

  test("F-series title is '<ID> — <Title & change>' with markdown-stripped ID", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];

    const f7 = items.find((item) => item.key === "impl:F7");
    expect(f7?.title).toBe(
      "F7 — Opt-in `onUnknownFormat` tolerant a | b handling",
    );
    expect(f7?.priority).toBe("p2");
    expect(f7?.status).toBe("pending");
    expect(f7?.sourcePath).toBe("docs/plans/IMPLEMENTATION.md");
  });

  test("P1 key is 'roadmap:<Wave>:<slug(Scripts)>' and title is '<Wave> — <Scripts>'", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];

    const w3 = items.find((item) => item.key === "roadmap:W3:ecs-ops");
    expect(w3).toBeDefined();
    expect(w3?.priority).toBe("p1");
    expect(w3?.title).toContain("W3");
    expect(w3?.title).toContain("ecs-ops");
  });

  test("slug() strips markdown, backticks, and punctuation into single-dash segments", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];

    expect(
      items.some((item) => item.key === "roadmap:p0:multi-word-test"),
    ).toBe(true);
  });

  test("dedupes rows sharing a key: keeps the first row's fields, merges the later row's detail", () => {
    const roadmap = extractRoadmap(ROADMAP_FIXTURE);
    const implementation = extractImplementation(IMPLEMENTATION_DEDUPE_FIXTURE);
    const items = actionableItems(roadmap, implementation) as TestItem[];

    const f7Items = items.filter((item) => item.key === "impl:F7");
    expect(f7Items).toHaveLength(1);
    const f7 = f7Items[0];
    expect(f7?.title).toContain("First title for F7");
    expect(f7?.priority).toBe("p2");
    expect(f7?.status).toBe("pending");
    expect(f7?.detail).toContain("first-call-site");
    expect(f7?.detail).toContain("second-call-site");
  });

  test("skips null sections silently, without throwing", () => {
    const roadmap = extractRoadmap(ROADMAP_MISSING_GOVERNANCE_FIXTURE);
    const implementation = extractImplementation(
      IMPLEMENTATION_MISSING_GATED_FIXTURE,
    );
    expect(roadmap.governance).toBeNull();
    expect(implementation.gated).toBeNull();

    let items: TestItem[] = [];
    expect(() => {
      items = actionableItems(roadmap, implementation);
    }).not.toThrow();

    expect(items.some((item) => item.key.startsWith("roadmap:gov:"))).toBe(
      false,
    );
    expect(items.some((item) => item.key.startsWith("impl:d4"))).toBe(false);
    // The sections that ARE present must still be processed.
    expect(items.some((item) => item.key === "roadmap:p0:p0a")).toBe(true);
    expect(items.some((item) => item.key === "impl:F7")).toBe(true);
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
      sourceAnchor: "#priority-0",
    });
    const payload = buildIssuePayload(item) as { body: string };
    expect(payload.body).toContain("Derived — do not edit");
    expect(payload.body).toContain(
      "https://github.com/monte3l/m3l-automation/blob/main/docs/ROADMAP.md#priority-0",
    );
    expect(payload.body).toContain("pnpm sync:hub");
  });

  test("body ends with item.detail", () => {
    const item = makeItem({ detail: "**What:** a very specific detail" });
    const payload = buildIssuePayload(item) as { body: string };
    expect(payload.body).toContain("**What:** a very specific detail");
  });

  test("labels are exactly ['hub-sync', 'priority:<x>'] in that order", () => {
    const item = makeItem({ priority: "p1" });
    const payload = buildIssuePayload(item) as { labels: string[] };
    expect(payload.labels).toEqual(["hub-sync", "priority:p1"]);
  });

  test.each([
    ["p0", "Priority 0"],
    ["p1", "Priority 1"],
    ["p2", "Priority 2"],
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

  test("milestoneTitle is null for a governance item", () => {
    const item = makeItem({ priority: "governance" });
    const payload = buildIssuePayload(item) as {
      milestoneTitle: string | null;
      labels: string[];
    };
    expect(payload.milestoneTitle).toBeNull();
    expect(payload.labels).toEqual(["hub-sync", "priority:governance"]);
  });
});

// ---------------------------------------------------------------------------
// planMilestones
// ---------------------------------------------------------------------------

describe("planMilestones", () => {
  test("creates only the milestone titles missing from existingTitles", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p1" }),
      makeItem({ key: "c", priority: "p2" }),
    ];
    const result = planMilestones(items, ["Priority 0"]);
    expect(result.create).toEqual(["Priority 1", "Priority 2"]);
  });

  test("de-duplicates milestone titles required by multiple items", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p0" }),
      makeItem({ key: "c", priority: "p0" }),
    ];
    const result = planMilestones(items, []);
    expect(result.create).toEqual(["Priority 0"]);
  });

  test("never returns any milestone for governance items (no milestone exists)", () => {
    const items = [makeItem({ key: "gov", priority: "governance" })];
    const result = planMilestones(items, []);
    expect(result.create).toEqual([]);
  });

  test("is empty when every required milestone already exists", () => {
    const items = [
      makeItem({ key: "a", priority: "p0" }),
      makeItem({ key: "b", priority: "p1" }),
    ];
    const result = planMilestones(items, [
      "Priority 0",
      "Priority 1",
      "Priority 2",
    ]);
    expect(result.create).toEqual([]);
  });
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
}

interface IssueSyncResult {
  create: { key: string; payload: unknown }[];
  update: { number: number; key: string; payload: unknown }[];
  close: { number: number; key: string; comment: string }[];
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
  };
  return {
    number,
    title: payload.title,
    body: payload.body,
    state,
    labels: payload.labels,
  };
}

describe("planIssueSync", () => {
  test("fresh state: all non-done items go to create; a done item with no issue creates nothing", () => {
    const pendingItem = makeItem({ key: "roadmap:p0:a", status: "pending" });
    const doneItem = makeItem({ key: "roadmap:p0:b", status: "done" });
    const result = planIssueSync(
      [pendingItem, doneItem],
      [],
    ) as IssueSyncResult;

    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.key).toBe("roadmap:p0:a");
    expect(result.update).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("idempotency: re-running over issues built from the plan's own payloads yields empty create/update/close/reopen", () => {
    const items = [
      makeItem({ key: "roadmap:p0:a", status: "pending" }),
      makeItem({ key: "roadmap:p1:b", status: "pending", priority: "p1" }),
    ];
    const firstRun = planIssueSync(items, []) as IssueSyncResult;
    const rebuiltIssues: TestIssue[] = firstRun.create.map((entry, index) => ({
      number: index + 1,
      title: (entry.payload as { title: string }).title,
      body: (entry.payload as { body: string }).body,
      state: "open",
      labels: (entry.payload as { labels: string[] }).labels,
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
      status: "pending",
      priority: "governance",
      detail: "**Notes:** pending — needs owner",
    });
    const existingIssue = issueFromPayload(10, original, "open");

    const updated = makeItem({
      key: "roadmap:gov:t8",
      status: "in-review",
      priority: "governance",
      detail: "**Notes:** in-review — owner assigned",
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
    const original = makeItem({ key: "roadmap:p0:c", status: "pending" });
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
    expect(result.update).toEqual([]);
    expect(result.reopen).toEqual([]);
  });

  test("an issue whose marker key vanished from items closes, with a 'removed' comment", () => {
    const vanished = makeItem({
      key: "roadmap:p0:vanished",
      status: "pending",
    });
    const existingIssue = issueFromPayload(12, vanished, "open");

    const result = planIssueSync([], [existingIssue]) as IssueSyncResult;

    expect(result.close).toHaveLength(1);
    expect(result.close[0]?.number).toBe(12);
    expect(result.close[0]?.key).toBe("roadmap:p0:vanished");
    expect(result.close[0]?.comment).toMatch(/remov/i);
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

  test("a closed issue whose item regressed to non-done reopens (reopen + update in one entry)", () => {
    const item = makeItem({ key: "roadmap:p0:d" });
    const doneVersion = { ...item, status: "done" as const };
    const closedIssue = issueFromPayload(14, doneVersion, "closed");

    const pendingAgain = { ...item, status: "pending" as const };
    const result = planIssueSync(
      [pendingAgain],
      [closedIssue],
    ) as IssueSyncResult;

    expect(result.reopen).toHaveLength(1);
    expect(result.reopen[0]?.number).toBe(14);
    expect(result.reopen[0]?.key).toBe("roadmap:p0:d");
    expect(result.create).toEqual([]);
    expect(result.close).toEqual([]);
    expect(result.update).toEqual([]);
  });

  test("matching is by marker only: a markerless issue with an identical title is untouched, and the item still creates", () => {
    const item = makeItem({
      key: "roadmap:p0:dup",
      title: "Duplicate Title",
      status: "pending",
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
});

// ---------------------------------------------------------------------------
// planProjectSync
// ---------------------------------------------------------------------------

interface TrackedIssue {
  number: number;
  state: "open" | "closed";
  status: TestItem["status"];
}

interface ProjectItem {
  itemId: string;
  issueNumber: number;
  status: string | null;
}

describe("planProjectSync", () => {
  test("an open tracked issue absent from the board is added with its mapped status name", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 1, state: "open", status: "pending" },
    ];
    const result = planProjectSync(trackedIssues, []);

    expect(result.add).toEqual([{ issueNumber: 1, status: "Pending" }]);
    expect(result.setStatus).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test.each([
    ["pending", "Pending"],
    ["in-review", "In review"],
    ["done", "Done"],
    ["other", "Pending"],
  ] as const)(
    "maps tracked-issue status %s to the board option %j when adding",
    (status, expectedOption) => {
      const trackedIssues: TrackedIssue[] = [
        { number: 2, state: "open", status },
      ];
      const result = planProjectSync(trackedIssues, []);
      expect(result.add).toEqual([{ issueNumber: 2, status: expectedOption }]);
    },
  );

  test("a board item whose status drifted from the desired mapping is corrected via setStatus", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 3, state: "open", status: "in-review" },
    ];
    const existingProjectItems: ProjectItem[] = [
      { itemId: "PVTI_1", issueNumber: 3, status: "Pending" },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.setStatus).toEqual([
      { itemId: "PVTI_1", issueNumber: 3, status: "In review" },
    ]);
    expect(result.add).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("a board item whose tracked issue is closed is archived", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 4, state: "closed", status: "done" },
    ];
    const existingProjectItems: ProjectItem[] = [
      { itemId: "PVTI_2", issueNumber: 4, status: "Done" },
    ];
    const result = planProjectSync(trackedIssues, existingProjectItems);

    expect(result.archive).toEqual([{ itemId: "PVTI_2", issueNumber: 4 }]);
    expect(result.add).toEqual([]);
    expect(result.setStatus).toEqual([]);
  });

  test("a board item whose issueNumber is untracked is left alone entirely (never archives a human-added card)", () => {
    const existingProjectItems: ProjectItem[] = [
      { itemId: "PVTI_3", issueNumber: 999, status: "Pending" },
    ];
    const result = planProjectSync([], existingProjectItems);

    expect(result.add).toEqual([]);
    expect(result.setStatus).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  test("idempotency: re-running over the state its own plan produced yields empty add/setStatus/archive", () => {
    const trackedIssues: TrackedIssue[] = [
      { number: 5, state: "open", status: "pending" },
    ];
    const firstRun = planProjectSync(trackedIssues, []);
    expect(firstRun.add).toHaveLength(1);

    const appliedProjectItems: ProjectItem[] = [
      {
        itemId: "PVTI_5",
        issueNumber: firstRun.add[0]?.issueNumber ?? 5,
        status: firstRun.add[0]?.status ?? "Pending",
      },
    ];
    const secondRun = planProjectSync(trackedIssues, appliedProjectItems);

    expect(secondRun.add).toEqual([]);
    expect(secondRun.setStatus).toEqual([]);
    expect(secondRun.archive).toEqual([]);
  });
});
