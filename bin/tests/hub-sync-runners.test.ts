import { describe, expect, test } from "vitest";
import { runIssueSync } from "../sync-hub-issues.mjs";
import { runProjectSync } from "../sync-hub-projects.mjs";
import { runPhases } from "../sync-hub.mjs";
import { HUB_PROJECT_TITLE, hubMarker } from "../lib/hub-sync.mjs";

// ---------------------------------------------------------------------------
// Fixed identifiers the two runners hard-code internally (bin/sync-hub-issues.mjs,
// bin/sync-hub-projects.mjs) — mirrored here so scripted `gh` responses and
// argv assertions line up with the real call shapes.
// ---------------------------------------------------------------------------

const REPO = "monte3l/m3l-automation";
const OWNER = "monte3l";

// ---------------------------------------------------------------------------
// Minimal tracker fixtures — every section extractRoadmap/extractImplementation
// require is present (so extraction never errors) but each table carries
// exactly one row, keeping the resulting plans small and predictable. Shapes
// copied from bin/tests/hub-sync.test.ts.
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What      | Status  | Why now / Notes |
| ------- | ---------- | ------- | ------------------ |
| **P0A** | thing one  | pending | notes               |

## Priority 1

| Wave   | Scripts | Status  | Depends on |
| ------ | ------- | ------- | ---------- |
| **W1** | \`svc\`   | pending | W0         |

## Priority 2

| Item                | Unblock condition |
| --------------------- | -------------------- |
| **D1** gated thing    | condition             |

## Governance follow-ups

| Item   | What              | Notes   |
| ------ | ------------------ | ------- |
| **T1** | governance thing    | pending |
`;

const IMPLEMENTATION_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status  | Title & change    | Source / call-site |
| ------ | -------- | ------- | -------------------- | --------------------- |
| **F1** | P1       | pending | friction change       | site                   |

## AWS getter reality

| Provider getter | AWS service | Status  | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------- | -------------------- | ----------------------- | ------------------ |
| \`x\`               | X             | wrapped | aws/x                  | script                   | ADR                 |

## Gated library modules & deferred decisions (P2)

| ID                  | Unblock condition |
| --------------------- | -------------------- |
| **D1** gated thing    | condition             |
`;

function makeReadDoc(
  roadmap: string = ROADMAP_FIXTURE,
  implementation: string = IMPLEMENTATION_FIXTURE,
): (relativePath: string) => string {
  return (relativePath: string): string => {
    if (relativePath === "docs/ROADMAP.md") return roadmap;
    if (relativePath === "docs/plans/IMPLEMENTATION.md") return implementation;
    throw new Error(`unexpected readDoc path in test fixture: ${relativePath}`);
  };
}

// ---------------------------------------------------------------------------
// Fake reporter — captures every call instead of touching the console, so
// assertions read the exact messages/counts a runner produced. Mirrors the
// method surface of bin/lib/report.mjs createReporter().
// ---------------------------------------------------------------------------

interface FakeChange {
  kind: "updated" | "created" | "removed";
  file: string;
  note?: string | undefined;
}

interface FakeReporter {
  errors: string[];
  warnings: string[];
  changes: FakeChange[];
  infos: string[];
  succeeded: string[];
  finishedWith: Record<string, unknown> | undefined;
  error(message: string): void;
  warn(message: string): void;
  change(
    kind: "updated" | "created" | "removed",
    file: string,
    note?: string,
  ): void;
  info(message: string): void;
  succeed(message: string): void;
  finish(extra?: Record<string, unknown>): Record<string, unknown>;
}

function createFakeReporter(): FakeReporter {
  const reporter: FakeReporter = {
    errors: [],
    warnings: [],
    changes: [],
    infos: [],
    succeeded: [],
    finishedWith: undefined,
    error(message) {
      reporter.errors.push(message);
    },
    warn(message) {
      reporter.warnings.push(message);
    },
    change(kind, file, note) {
      reporter.changes.push({ kind, file, note });
    },
    info(message) {
      reporter.infos.push(message);
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

// ---------------------------------------------------------------------------
// Scripted `gh` stub — records every argv array received (never a shell
// string) and answers with canned JSON per call-shape rule. An unscripted
// call throws immediately, so a test that reaches further than intended
// fails loudly instead of silently returning `undefined`.
// ---------------------------------------------------------------------------

interface GhRule {
  match: (args: string[]) => boolean;
  respond: (args: string[]) => string;
}

function scriptedGh(rules: GhRule[]): {
  runGh: (args: string[]) => string;
  calls: string[][];
} {
  const calls: string[][] = [];
  function runGh(args: string[]): string {
    calls.push(args);
    const rule = rules.find((candidate) => candidate.match(args));
    if (!rule) {
      throw new Error(
        `hub-sync-runners.test.ts: unscripted gh call: ${JSON.stringify(args)}`,
      );
    }
    return rule.respond(args);
  }
  return { runGh, calls };
}

// -- issue-sync rules --------------------------------------------------------

function authOkRule(): GhRule {
  return {
    match: (a) => a[0] === "auth" && a[1] === "status",
    respond: () => "",
  };
}

function authFailRule(message = "not logged in"): GhRule {
  return {
    match: (a) => a[0] === "auth" && a[1] === "status",
    respond: () => {
      throw new Error(message);
    },
  };
}

function milestonesGetRule(titles: string[]): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      a[1] === `repos/${REPO}/milestones` &&
      !a.includes("-X"),
    respond: () => JSON.stringify(titles.map((title) => ({ title }))),
  };
}

function milestoneCreateRule(): GhRule {
  return {
    match: (a) =>
      a[0] === "api" && a[1] === `repos/${REPO}/milestones` && a.includes("-X"),
    respond: () => "",
  };
}

function issueListSyncRule(issues: unknown[]): GhRule {
  return {
    match: (a) =>
      a[0] === "issue" &&
      a[1] === "list" &&
      a.includes("number,title,body,state,labels"),
    respond: () => JSON.stringify(issues),
  };
}

function labelCreateRule(): GhRule {
  return {
    match: (a) => a[0] === "label" && a[1] === "create",
    respond: () => "",
  };
}

function issueCreateRule(): GhRule {
  return {
    match: (a) => a[0] === "issue" && a[1] === "create",
    respond: () => "",
  };
}

function issueEditRule(): GhRule {
  return {
    match: (a) => a[0] === "issue" && a[1] === "edit",
    respond: () => "",
  };
}

function issueCloseRule(): GhRule {
  return {
    match: (a) => a[0] === "issue" && a[1] === "close",
    respond: () => "",
  };
}

function issueReopenRule(): GhRule {
  return {
    match: (a) => a[0] === "issue" && a[1] === "reopen",
    respond: () => "",
  };
}

// -- project-sync rules -------------------------------------------------------

function projectListRule(projects: unknown[]): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "list",
    respond: () => JSON.stringify(projects),
  };
}

function projectCreateRule(project: unknown): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "create",
    respond: () => JSON.stringify(project),
  };
}

function projectFieldListRule(field: unknown): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "field-list",
    respond: () => JSON.stringify([field]),
  };
}

function graphqlRule(): GhRule {
  return {
    match: (a) => a[0] === "api" && a[1] === "graphql",
    respond: () => "",
  };
}

function issueListProjectsRule(issues: unknown[]): GhRule {
  return {
    match: (a) =>
      a[0] === "issue" && a[1] === "list" && a.includes("number,body,state"),
    respond: () => JSON.stringify(issues),
  };
}

function projectItemListRule(items: unknown[]): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "item-list",
    respond: () => JSON.stringify(items),
  };
}

function projectViewRule(id: string): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "view",
    respond: () => JSON.stringify({ id }),
  };
}

function projectItemAddRule(id: string): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "item-add",
    respond: () => JSON.stringify({ id }),
  };
}

function projectItemEditRule(): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "item-edit",
    respond: () => "",
  };
}

function projectItemArchiveRule(): GhRule {
  return {
    match: (a) => a[0] === "project" && a[1] === "item-archive",
    respond: () => "",
  };
}

// ---------------------------------------------------------------------------
// Mutating-call predicates, so a "no mutation" assertion doesn't have to
// enumerate every read-only shape by hand.
// ---------------------------------------------------------------------------

function isMutatingIssueCall(args: string[]): boolean {
  if (args[0] === "label" && args[1] === "create") return true;
  if (
    args[0] === "issue" &&
    ["create", "edit", "close", "reopen"].includes(args[1] ?? "")
  ) {
    return true;
  }
  if (args[0] === "api" && args.includes("-X")) return true;
  return false;
}

function isMutatingProjectCall(args: string[]): boolean {
  if (
    args[0] === "project" &&
    ["create", "item-add", "item-edit", "item-archive"].includes(args[1] ?? "")
  ) {
    return true;
  }
  if (args[0] === "api" && args[1] === "graphql") return true;
  return false;
}

function expectEveryCallIsAnArgvArray(calls: string[][]): void {
  for (const args of calls) {
    expect(Array.isArray(args)).toBe(true);
    for (const token of args) expect(typeof token).toBe("string");
  }
}

// ---------------------------------------------------------------------------
// runIssueSync
// ---------------------------------------------------------------------------

describe("runIssueSync", () => {
  test("dry run: returns { ok: true }, records only read-only gh calls, and reports plan counts", () => {
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListSyncRule([]),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expectEveryCallIsAnArgvArray(calls);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.errors).toEqual([]);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 3 },
      issues: { create: 5, update: 0, close: 0, reopen: 0, untouched: 0 },
    });
  });

  test("--apply: records mutating calls in order (label bootstrap, then milestones, then issue create), each argv an array", () => {
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListSyncRule([]),
      labelCreateRule(),
      milestoneCreateRule(),
      issueCreateRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expectEveryCallIsAnArgvArray(calls);

    const labelCalls = calls.filter((a) => a[0] === "label");
    const milestoneCreateCalls = calls.filter(
      (a) => a[0] === "api" && a.includes("-X"),
    );
    const issueCreateCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "create",
    );
    expect(labelCalls).toHaveLength(5);
    expect(milestoneCreateCalls).toHaveLength(3);
    expect(issueCreateCalls).toHaveLength(5);

    const firstLabelIndex = calls.findIndex((a) => a[0] === "label");
    const firstMilestoneCreateIndex = calls.findIndex(
      (a) => a[0] === "api" && a.includes("-X"),
    );
    const firstIssueCreateIndex = calls.findIndex(
      (a) => a[0] === "issue" && a[1] === "create",
    );
    expect(firstLabelIndex).toBeLessThan(firstMilestoneCreateIndex);
    expect(firstMilestoneCreateIndex).toBeLessThan(firstIssueCreateIndex);

    expect(reporter.finishedWith).toMatchObject({ applied: true });
  });

  test("--apply: an already-tracked issue is updated when dirty, closed when its item is done, and reopened when its item regresses — in create, update, close, reopen order", () => {
    const roadmapWithAllActions = `# Roadmap — m3l-automation

## Priority 0

| Item   | What                  | Status  | Why now / Notes |
| ------ | ---------------------- | ------- | ------------------ |
| **UA** | update-target thing     | pending | notes               |
| **UB** | close-target thing      | done    | notes               |
| **UC** | reopen-target thing     | pending | notes               |

## Priority 1

| Wave   | Scripts | Status  | Depends on |
| ------ | ------- | ------- | ---------- |
| **W1** | \`svc\`   | pending | W0         |

## Priority 2

| Item                | Unblock condition |
| --------------------- | -------------------- |
| **D1** gated thing    | condition             |

## Governance follow-ups

| Item   | What              | Notes   |
| ------ | ------------------ | ------- |
| **T1** | governance thing    | pending |
`;
    const existingIssues = [
      {
        number: 301,
        title: "Stale UA title",
        body: `${hubMarker("roadmap:p0:ua")}\nstale body\n`,
        state: "OPEN",
        labels: [{ name: "hub-sync" }, { name: "priority:p0" }],
      },
      {
        number: 302,
        title: "UB current title",
        body: `${hubMarker("roadmap:p0:ub")}\nwhatever\n`,
        state: "OPEN",
        labels: [{ name: "hub-sync" }, { name: "priority:p0" }],
      },
      {
        number: 303,
        title: "UC current title",
        body: `${hubMarker("roadmap:p0:uc")}\nwhatever\n`,
        state: "CLOSED",
        labels: [{ name: "hub-sync" }, { name: "priority:p0" }],
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListSyncRule(existingIssues),
      labelCreateRule(),
      milestoneCreateRule(),
      issueCreateRule(),
      issueEditRule(),
      issueCloseRule(),
      issueReopenRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(roadmapWithAllActions),
    });

    expect(outcome.ok).toBe(true);
    expectEveryCallIsAnArgvArray(calls);

    const createCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "create",
    );
    const editCalls = calls.filter((a) => a[0] === "issue" && a[1] === "edit");
    const closeCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    const reopenCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "reopen",
    );
    // W1, T1, F1, D1-gated-thing have no matched issue yet.
    expect(createCalls).toHaveLength(4);
    // UA's stale body/title (1) + UC's reopen-triggered re-edit (1).
    expect(editCalls).toHaveLength(2);
    expect(closeCalls).toEqual([
      ["issue", "close", "302", "-R", REPO, "--comment", expect.any(String)],
    ]);
    expect(closeCalls[0]?.[6]).toMatch(/done/i);
    expect(reopenCalls).toEqual([["issue", "reopen", "303", "-R", REPO]]);

    const firstCreateIndex = calls.findIndex(
      (a) => a[0] === "issue" && a[1] === "create",
    );
    const firstEditIndex = calls.findIndex(
      (a) => a[0] === "issue" && a[1] === "edit",
    );
    const firstCloseIndex = calls.findIndex(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    const firstReopenIndex = calls.findIndex(
      (a) => a[0] === "issue" && a[1] === "reopen",
    );
    expect(firstCreateIndex).toBeLessThan(firstEditIndex);
    expect(firstEditIndex).toBeLessThan(firstCloseIndex);
    expect(firstCloseIndex).toBeLessThan(firstReopenIndex);

    expect(reporter.finishedWith).toMatchObject({
      applied: true,
      issues: { create: 4, update: 1, close: 1, reopen: 1 },
    });
  });

  test("auth preflight failure: returns { ok: false }, reports the error, and makes no further gh calls", () => {
    const { runGh, calls } = scriptedGh([authFailRule("not logged in")]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors).toHaveLength(1);
    expect(reporter.errors[0]).toMatch(/gh auth login/);
    expect(calls).toHaveLength(1);
  });

  test("tracker extraction errors: returns { ok: false }, reports the errors, and makes no gh calls beyond auth", () => {
    const brokenRoadmap = `# Roadmap — m3l-automation\n\n## Priority 0\n\n| Item | What | Status | Why now / Notes |\n| --- | --- | --- | --- |\n| **P0A** | thing | pending | notes |\n`;
    const { runGh, calls } = scriptedGh([authOkRule()]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(brokenRoadmap, IMPLEMENTATION_FIXTURE),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors.length).toBeGreaterThan(0);
    expect(reporter.errors.some((message) => /Priority 1/i.test(message))).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
  });

  test("truncated issue-list window: returns { ok: false }, reports the limit error, and makes no mutation", () => {
    const truncatedIssues = Array.from({ length: 500 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      body: "",
      state: "OPEN",
      labels: [],
    }));
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListSyncRule(truncatedIssues),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors.some((message) => /limit/i.test(message))).toBe(
      true,
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runProjectSync
// ---------------------------------------------------------------------------

describe("runProjectSync", () => {
  test("board missing without --init: returns { ok: false } with the run-with---init error, no further calls", () => {
    const { runGh, calls } = scriptedGh([projectListRule([])]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: false,
      init: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors.some((message) => /--init/.test(message))).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  });

  test("--init without --apply: returns { ok: true }, zero mutating calls, and previews the would-do plan", () => {
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      projectFieldListRule({
        name: "Status",
        id: "FIELD_1",
        options: [
          { name: "Pending", id: "opt-pending" },
          { name: "In review", id: "opt-in-review" },
          { name: "Done", id: "opt-done" },
        ],
      }),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: false,
      init: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expectEveryCallIsAnArgvArray(calls);
    expect(calls.every((args) => !isMutatingProjectCall(args))).toBe(true);
    expect(
      reporter.infos.some((message) => /reuse existing project/i.test(message)),
    ).toBe(true);
    expect(reporter.finishedWith).toMatchObject({ applied: false });
  });

  test("--init --apply: creates the board when missing, recording a project create call", () => {
    const createdProject = { number: 9, title: HUB_PROJECT_TITLE };
    const { runGh, calls } = scriptedGh([
      projectListRule([]),
      projectCreateRule(createdProject),
      projectFieldListRule({ name: "Status", id: "FIELD_1", options: [] }),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    const createCall = calls.find(
      (args) => args[0] === "project" && args[1] === "create",
    );
    expect(createCall).toEqual([
      "project",
      "create",
      "--owner",
      OWNER,
      "--title",
      HUB_PROJECT_TITLE,
      "--format",
      "json",
    ]);
    expect(
      reporter.changes.some(
        (entry) => entry.kind === "created" && /project board/.test(entry.file),
      ),
    ).toBe(true);
  });

  test("steady-state dry run with a board present: returns { ok: true } and makes no mutating calls", () => {
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      issueListProjectsRule([]),
      projectItemListRule([]),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: false,
      init: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(calls.every((args) => !isMutatingProjectCall(args))).toBe(true);
    expect(
      reporter.infos.some((message) =>
        /Board items to add \(0\)/.test(message),
      ),
    ).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      board: { add: 0, setStatus: 0, archive: 0 },
    });
  });

  test("steady-state --apply: records item-add, item-edit (status), and item-archive calls", () => {
    const hubIssues = [
      { number: 101, body: `${hubMarker("roadmap:p0:p0a")}\n`, state: "OPEN" },
      { number: 102, body: `${hubMarker("impl:F1")}\n`, state: "OPEN" },
      {
        number: 103,
        body: `${hubMarker("roadmap:gov:t1")}\n`,
        state: "CLOSED",
      },
    ];
    const existingProjectItems = [
      { id: "PVTI_102", content: { number: 102 }, status: "Done" },
      { id: "PVTI_103", content: { number: 103 }, status: "Pending" },
    ];
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      issueListProjectsRule(hubIssues),
      projectItemListRule(existingProjectItems),
      projectViewRule("PROJECT_ID"),
      projectFieldListRule({
        name: "Status",
        id: "FIELD_1",
        options: [
          { name: "Pending", id: "opt-pending" },
          { name: "In review", id: "opt-in-review" },
          { name: "Done", id: "opt-done" },
        ],
      }),
      projectItemAddRule("PVTI_NEW"),
      projectItemEditRule(),
      projectItemArchiveRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    const addCalls = calls.filter(
      (a) => a[0] === "project" && a[1] === "item-add",
    );
    const editCalls = calls.filter(
      (a) => a[0] === "project" && a[1] === "item-edit",
    );
    const archiveCalls = calls.filter(
      (a) => a[0] === "project" && a[1] === "item-archive",
    );
    expect(addCalls).toHaveLength(1);
    expect(editCalls.length).toBeGreaterThanOrEqual(2);
    expect(archiveCalls).toHaveLength(1);
    expect(reporter.finishedWith).toMatchObject({
      applied: true,
      board: { add: 1, setStatus: 1, archive: 1 },
    });
  });

  test("truncated project item-list window: returns { ok: false } and reports the limit error", () => {
    const truncatedItems = Array.from({ length: 500 }, (_, index) => ({
      id: `PVTI_${index}`,
      content: { number: index + 1 },
      status: "Pending",
    }));
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      issueListProjectsRule([]),
      projectItemListRule(truncatedItems),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: false,
      init: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors.some((message) => /limit/i.test(message))).toBe(
      true,
    );
    expect(calls.every((args) => !isMutatingProjectCall(args))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runPhases
// ---------------------------------------------------------------------------

describe("runPhases", () => {
  test("forwards the same argv (including --apply) to both phases, issues before projects", () => {
    const calls: [string, string[]][] = [];
    const spawn = (script: string, args: string[]): number => {
      calls.push([script, args]);
      return 0;
    };
    const argv = ["--apply", "--json"];

    const code = runPhases(argv, spawn);

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["sync-hub-issues.mjs", argv],
      ["sync-hub-projects.mjs", argv],
    ]);
  });

  test("stops at the first non-zero exit and returns that code, without running the second phase", () => {
    const invoked: string[] = [];
    const spawn = (script: string): number => {
      invoked.push(script);
      return script === "sync-hub-issues.mjs" ? 3 : 0;
    };

    const code = runPhases(["--apply"], spawn);

    expect(code).toBe(3);
    expect(invoked).toEqual(["sync-hub-issues.mjs"]);
  });

  test("happy path: returns 0 when both phases succeed", () => {
    const invoked: string[] = [];
    const spawn = (script: string): number => {
      invoked.push(script);
      return 0;
    };

    expect(runPhases([], spawn)).toBe(0);
    expect(invoked).toEqual(["sync-hub-issues.mjs", "sync-hub-projects.mjs"]);
  });
});
