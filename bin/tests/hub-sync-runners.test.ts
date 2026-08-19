import { describe, expect, test } from "vitest";
import { runIssueSync } from "../sync-hub-issues.mjs";
import { runProjectSync } from "../sync-hub-projects.mjs";
import { runPhases } from "../sync-hub.mjs";
import {
  actionableItems,
  buildIssuePayload,
  HUB_PROJECT_TITLE,
  hubMarker,
} from "../lib/hub-sync.mjs";
import { extractImplementation, extractRoadmap } from "../lib/project-hub.mjs";

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
// exactly one row (ADR-0035 rollout is deliberately zero-row, to keep this
// file's hardcoded item/milestone counts below unchanged), keeping the
// resulting plans small and predictable. Shapes copied from
// bin/tests/hub-sync.test.ts.
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What      | Status | Why now / Notes |
| ------- | ---------- | ------ | ------------------ |
| **P0A** | thing one  | To Do  | notes               |

## Priority 1

| Wave   | Scripts | Status | Depends on |
| ------ | ------- | ------ | ---------- |
| **W1** | \`svc\`   | To Do  | W0         |

## Priority 2

| Item                | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |
| **D1** gated thing    | Deferred | condition             |

## Governance follow-ups

| Item   | What              | Status | Notes   |
| ------ | ------------------ | ------ | ------- |
| **T1** | governance thing    | To Do  | pending owner |
`;

const IMPLEMENTATION_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status | Title & change    | Source / call-site |
| ------ | -------- | ------ | -------------------- | --------------------- |
| **F1** | P1       | To Do  | friction change       | site                   |

## ADR-0035 rollout — failure reporting & diagnostics

| Phase | Priority | Status | Change | Source / notes |
| ----- | -------- | ------ | ------ | ----------------- |

## Capability-deepening wave — ADR-0037/0038/0039

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Post-comparison hardening wave — ADR-0040/0041/0042/0043

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## m3l-cli build-out — ADR-0042 activation (issue #333)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Codified-procedure engine wave — ADR-0046/0047/0048/0049

| Item | Priority | Status | Change |
| ---- | -------- | ------ | ------- |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |
| \`x\`               | X             | Done   | aws/x                  | script                   | ADR                 |

## Gated library modules & deferred decisions (P2)

| ID                  | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |
| **D1** gated thing    | Deferred | condition             |
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

// Every section table below is present (so extraction never errors) but
// deliberately empty except Priority 0's — computes items via the real
// actionableItems/extract* pipeline (see computeItems below) rather than
// hand-transcribing a title/body/labels shape that would silently drift from
// buildIssuePayload's actual output.
const EMPTY_IMPLEMENTATION_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status | Title & change    | Source / call-site |
| ------ | -------- | ------ | -------------------- | --------------------- |

## ADR-0035 rollout — failure reporting & diagnostics

| Phase | Priority | Status | Change | Source / notes |
| ----- | -------- | ------ | ------ | ----------------- |

## Capability-deepening wave — ADR-0037/0038/0039

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Post-comparison hardening wave — ADR-0040/0041/0042/0043

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## m3l-cli build-out — ADR-0042 activation (issue #333)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Codified-procedure engine wave — ADR-0046/0047/0048/0049

| Item | Priority | Status | Change |
| ---- | -------- | ------ | ------- |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |

## Gated library modules & deferred decisions (P2)

| ID                  | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |
`;

// A single already-in-sync To-Do item — everything else in each tracker
// stays empty so the plan is trivially empty when the matching issue/
// milestone already exists (the `check` drift-gate "nothing to do" case).
const CHECK_EMPTY_ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What      | Status | Why now / Notes |
| ------- | ---------- | ------ | ------------------ |
| **CK1** | synced thing | To Do | notes |

## Priority 1

| Wave   | Scripts | Status | Depends on |
| ------ | ------- | ------ | ---------- |

## Priority 2

| Item                | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |

## Governance follow-ups

| Item   | What              | Status | Notes   |
| ------ | ------------------ | ------ | ------- |
`;

// Two Done P0 rows with no prior marker anywhere — the --backfill target
// case. BF1 has no close title match among existingIssues (routes to
// planBackfill.create); BF2's title is engineered (in each test) to collide
// with an unmarked existing issue (routes to planBackfill.needsReview).
const BACKFILL_ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0

| Item    | What      | Status | Why now / Notes |
| ------- | ---------- | ------ | ------------------ |
| **BF1** | historical done thing | Done | notes |
| **BF2** | duplicate done thing | Done | notes |

## Priority 1

| Wave   | Scripts | Status | Depends on |
| ------ | ------- | ------ | ---------- |

## Priority 2

| Item                | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |

## Governance follow-ups

| Item   | What              | Status | Notes   |
| ------ | ------------------ | ------ | ------- |
`;

// Runs the exact same extraction + item-derivation pipeline runIssueSync
// itself uses internally, so a test's "current GitHub state" fixture (an
// existingIssues entry meant to already match a tracker row) is built from
// the real buildIssuePayload output — never a hand-typed guess at its
// title/body/labels shape, which would silently drift the moment that
// shape changes.
function computeItems(
  roadmap: string,
  implementation: string,
): ReturnType<typeof actionableItems>["items"] {
  return actionableItems(
    extractRoadmap(roadmap),
    extractImplementation(implementation),
  ).items;
}

// `noUncheckedIndexedAccess` makes every array index read `T | undefined`;
// guard instead of `!` (see .claude/rules/library-src.md) — a test fixture
// that fails this throws with a clear message rather than silently reading
// `undefined` deeper into the assertion chain.
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`test fixture: expected ${label} to be defined`);
  }
  return value;
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

// `state=all` (not the API's `open` default) so a closed milestone doesn't
// look absent and get re-`POST`ed — see loadExistingMilestoneTitles.
function milestonesGetRule(titles: string[]): GhRule {
  return {
    match: (a) =>
      a[0] === "api" && a[1] === `repos/${REPO}/milestones?state=all`,
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

// createIssue() now parses the created issue's number out of `gh issue
// create`'s printed URL — an empty stdout no longer parses, so every scripted
// create response must look like the real CLI's output. `number` defaults to
// an arbitrary placeholder for callers that don't care about the parsed value.
function issueCreateRule(number = 1): GhRule {
  return {
    match: (a) => a[0] === "issue" && a[1] === "create",
    respond: () => `https://github.com/${REPO}/issues/${String(number)}\n`,
  };
}

// Matches only an unfiltered `gh issue list` (no `--label` token) — used by
// the --backfill collision guard's loadAllIssues, distinct from the
// hub-sync-label-filtered read issueListSyncRule answers.
function issueListAllRule(issues: unknown[]): GhRule {
  return {
    match: (a) =>
      a[0] === "issue" &&
      a[1] === "list" &&
      a.includes("number,title,body,state,labels") &&
      !a.includes("--label"),
    respond: () => JSON.stringify(issues),
  };
}

// Matches only the hub-sync-label-filtered `gh issue list` read
// (loadExistingIssues) — the counterpart to issueListAllRule above, needed
// once a single test scripts both reads with different fixtures.
function issueListLabeledRule(issues: unknown[]): GhRule {
  return {
    match: (a) =>
      a[0] === "issue" &&
      a[1] === "list" &&
      a.includes("number,title,body,state,labels") &&
      a.includes("--label"),
    respond: () => JSON.stringify(issues),
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
      milestones: { create: 4 },
      issues: { create: 5, update: 0, close: 0, reopen: 0, untouched: 0 },
    });
  });

  test("dry run: queries milestones with state=all so a closed milestone isn't re-created", () => {
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
    expect(
      calls.some(
        (args) =>
          args[0] === "api" && args[1] === `repos/${REPO}/milestones?state=all`,
      ),
    ).toBe(true);
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
    // HUB_LABEL + 4 priority labels + 2 status labels (deferred/blocked) + triage.
    expect(labelCalls).toHaveLength(8);
    // Priority 0, Priority 1, Governance, Priority 2 — one per priority
    // actually present among this fixture's items.
    expect(milestoneCreateCalls).toHaveLength(4);
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

| Item   | What                  | Status | Why now / Notes |
| ------ | ---------------------- | ------ | ------------------ |
| **UA** | update-target thing     | To Do  | notes               |
| **UB** | close-target thing      | Done   | notes               |
| **UC** | reopen-target thing     | To Do  | notes               |

## Priority 1

| Wave   | Scripts | Status | Depends on |
| ------ | ------- | ------ | ---------- |
| **W1** | \`svc\`   | To Do  | W0         |

## Priority 2

| Item                | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |
| **D1** gated thing    | Deferred | condition             |

## Governance follow-ups

| Item   | What              | Status | Notes   |
| ------ | ------------------ | ------ | ------- |
| **T1** | governance thing    | To Do  | pending owner |
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
      [
        "issue",
        "close",
        "302",
        "-R",
        REPO,
        "--comment",
        expect.any(String),
        "--reason",
        "completed",
      ],
    ]);
    expect(closeCalls[0]?.[6]).toMatch(/done/i);
    expect(closeCalls[0]?.[8]).toBe("completed");
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
    const brokenRoadmap = `# Roadmap — m3l-automation\n\n## Priority 0\n\n| Item | What | Status | Why now / Notes |\n| --- | --- | --- | --- |\n| **P0A** | thing | To Do | notes |\n`;
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

  // -------------------------------------------------------------------------
  // check mode — the CI drift gate. Mutually exclusive with --apply (enforced
  // in the main-guard, not runIssueSync itself); a plain dry run (check:
  // false, the default) keeps its always-{ ok: true } preview contract.
  // -------------------------------------------------------------------------

  test("check: true with a non-empty plan returns { ok: false } and reports drift, without mutating anything", () => {
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
      check: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors.some((message) => /drift/i.test(message))).toBe(
      true,
    );
    expect(reporter.succeeded).toEqual([]);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 4 },
      issues: { create: 5 },
    });
  });

  test("check: true with an empty plan (everything already synced) returns { ok: true } with a distinct success message, without mutating anything", () => {
    const items = computeItems(
      CHECK_EMPTY_ROADMAP_FIXTURE,
      EMPTY_IMPLEMENTATION_FIXTURE,
    );
    const payload = buildIssuePayload(required(items[0], "items[0]"));
    const existingIssues = [
      {
        number: 701,
        title: payload.title,
        body: payload.body,
        state: "OPEN",
        labels: payload.labels.map((name) => ({ name })),
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule(["Priority 0"]),
      issueListSyncRule(existingIssues),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: false,
      check: true,
      readDoc: makeReadDoc(
        CHECK_EMPTY_ROADMAP_FIXTURE,
        EMPTY_IMPLEMENTATION_FIXTURE,
      ),
    });

    expect(outcome.ok).toBe(true);
    expect(reporter.errors).toEqual([]);
    expect(
      reporter.succeeded.some((message) => /drift check passed/i.test(message)),
    ).toBe(true);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 0 },
      issues: { create: 0, update: 0, close: 0, reopen: 0, untouched: 1 },
    });
  });

  // -------------------------------------------------------------------------
  // backfill mode — the one-time historical-record pass (planBackfill). Never
  // touches an item planIssueSync already tracks (marker present); only
  // resolved (Done/Rejected) rows with no marker at all are candidates.
  // -------------------------------------------------------------------------

  test("backfill: true dry run reports a backfill summary and makes no mutating gh calls", () => {
    const duplicateTitle = buildIssuePayload(
      required(
        computeItems(BACKFILL_ROADMAP_FIXTURE, EMPTY_IMPLEMENTATION_FIXTURE)[1],
        "backfill items[1]",
      ),
    ).title;
    const allIssues = [
      {
        number: 900,
        title: duplicateTitle,
        body: "",
        state: "OPEN",
        labels: [],
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListLabeledRule([]),
      issueListAllRule(allIssues),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: false,
      backfill: true,
      readDoc: makeReadDoc(
        BACKFILL_ROADMAP_FIXTURE,
        EMPTY_IMPLEMENTATION_FIXTURE,
      ),
    });

    expect(outcome.ok).toBe(true);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      backfill: { create: 1, needsReview: 1 },
    });
  });

  test("backfill: true --apply creates+closes a create-bucket entry (using the parsed issue number), warns (no gh call) for a needsReview entry", () => {
    const duplicateTitle = buildIssuePayload(
      required(
        computeItems(BACKFILL_ROADMAP_FIXTURE, EMPTY_IMPLEMENTATION_FIXTURE)[1],
        "backfill items[1]",
      ),
    ).title;
    const allIssues = [
      {
        number: 900,
        title: duplicateTitle,
        body: "",
        state: "OPEN",
        labels: [],
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListLabeledRule([]),
      issueListAllRule(allIssues),
      labelCreateRule(),
      milestoneCreateRule(),
      issueCreateRule(266),
      issueCloseRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      backfill: true,
      readDoc: makeReadDoc(
        BACKFILL_ROADMAP_FIXTURE,
        EMPTY_IMPLEMENTATION_FIXTURE,
      ),
    });

    expect(outcome.ok).toBe(true);

    const createCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "create",
    );
    const closeCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    // Only BF1 (planBackfill.create) is ever created — BF2 (needsReview)
    // never reaches a `gh issue create` call.
    expect(createCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);

    const createIndex = calls.indexOf(
      required(createCalls[0], "createCalls[0]"),
    );
    const closeIndex = calls.indexOf(required(closeCalls[0], "closeCalls[0]"));
    expect(createIndex).toBeLessThan(closeIndex);
    // The close call targets the number createIssue() parsed out of the
    // scripted "https://…/issues/266" stdout, not a hand-picked stand-in.
    expect(closeCalls[0]?.[2]).toBe("266");

    expect(
      reporter.changes.some(
        (entry) =>
          entry.kind === "created" && /backfilled, closed:/.test(entry.file),
      ),
    ).toBe(true);
    expect(
      reporter.warnings.some((message) => /Backfill skipped/.test(message)),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // staleManagedLabels — now also strips a stale status:* label (previously
  // only priority:*), used by editIssue's --remove-label loop.
  // -------------------------------------------------------------------------

  test("--apply: editing an issue whose item regressed off Blocked removes the stale status:blocked label", () => {
    const roadmapWithRegressedStatus = `# Roadmap — m3l-automation

## Priority 0

| Item   | What                  | Status | Why now / Notes |
| ------ | ---------------------- | ------ | ------------------ |
| **UE** | no-longer-blocked thing | To Do  | notes               |

## Priority 1

| Wave   | Scripts | Status | Depends on |
| ------ | ------- | ------ | ---------- |

## Priority 2

| Item                | Status   | Unblock condition |
| --------------------- | -------- | -------------------- |

## Governance follow-ups

| Item   | What              | Status | Notes   |
| ------ | ------------------ | ------ | ------- |
`;
    const existingIssues = [
      {
        number: 801,
        title: "no-longer-blocked thing (stale)",
        body: `${hubMarker("roadmap:p0:ue")}\nstale body\n`,
        state: "OPEN",
        labels: [
          { name: "hub-sync" },
          { name: "priority:p0" },
          { name: "status:blocked" },
        ],
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([]),
      issueListSyncRule(existingIssues),
      labelCreateRule(),
      milestoneCreateRule(),
      issueEditRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(
        roadmapWithRegressedStatus,
        EMPTY_IMPLEMENTATION_FIXTURE,
      ),
    });

    expect(outcome.ok).toBe(true);
    const editCall = calls.find((a) => a[0] === "issue" && a[1] === "edit");
    expect(editCall).toBeDefined();
    // Read every "--remove-label <value>" pair positionally, rather than
    // checking flag/value tokens independently — arrayContaining would pass
    // even if "priority:p0" merely appeared elsewhere in argv (e.g. paired
    // with --add-label), which is exactly what a correct edit call does.
    const removedLabels = (editCall ?? [])
      .map((arg, index) => (arg === "--remove-label" ? index : -1))
      .filter((index) => index !== -1)
      .map((index) => editCall?.[index + 1]);
    expect(removedLabels).toEqual(["status:blocked"]);
    expect(removedLabels).not.toContain("priority:p0");
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
