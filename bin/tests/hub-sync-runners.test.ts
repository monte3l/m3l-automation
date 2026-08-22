import { describe, expect, test } from "vitest";
import {
  runClosedRetype,
  runIssueSync,
  runIssueTypeInit,
} from "../sync-hub-issues.mjs";
import { runProjectSync } from "../sync-hub-projects.mjs";
import { runPhases } from "../sync-hub.mjs";
import {
  actionableItems,
  buildIssuePayload,
  HUB_PROJECT_TITLE,
  hubMarker,
  ISSUE_TYPES,
} from "../lib/hub-sync.mjs";
import { extractImplementation, extractRoadmap } from "../lib/project-hub.mjs";
import { MILESTONE_DEFS } from "../lib/milestone-defs.mjs";
import { ISSUE_TYPE_DEFS } from "../lib/issue-type-defs.mjs";
import { OPTIONAL_VIEW_FIELDS, VIEW_DEFS } from "../lib/hub-views.mjs";

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
| **F1** | Next     | To Do  | friction change       | site                   |

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

## CLI evolution wave (U-series)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Agent-operator wave (V-series)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## m3l console wave (X-series)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Codified-procedure engine wave — ADR-0046/0047/0048/0049

| Item | Priority | Status | Change |
| ---- | -------- | ------ | ------- |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |
| \`x\`               | X             | Done   | aws/x                  | script                   | ADR                 |

## Gated library modules & deferred decisions (Later)

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

## CLI evolution wave (U-series)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Agent-operator wave (V-series)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## m3l console wave (X-series)

| Item | Priority | Status | Change | Source / notes |
| ---- | -------- | ------ | ------ | ----------------- |

## Codified-procedure engine wave — ADR-0046/0047/0048/0049

| Item | Priority | Status | Change |
| ---- | -------- | ------ | ------- |

## AWS getter reality

| Provider getter | AWS service | Status | Wrapper submodule | Consuming script(s) | ADR / precedent |
| ----------------- | ------------- | ------ | -------------------- | ----------------------- | ------------------ |

## Gated library modules & deferred decisions (Later)

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

// The apply path's Issue-Type preflight read (bin/sync-hub-issues.mjs
// loadOrgIssueTypes) — org-scoped, GraphQL-only, and it now runs before the
// first mutation on every --apply, so every --apply fixture must answer it or
// the runner refuses to start. Defaults to the full declared vocabulary, i.e.
// "the org is already provisioned", which is what an --apply test asserting
// something else entirely wants.
function orgIssueTypesGraphqlRule(
  types: { id: string; name: string }[] = ISSUE_TYPE_DEFS.map((def, i) => ({
    id: `IT_${i}`,
    name: def.name,
  })),
  ownerId = "O_ORG",
): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      a[1] === "graphql" &&
      typeof a[3] === "string" &&
      a[3].includes("issueTypes(first: 50)"),
    respond: () =>
      JSON.stringify({
        data: { organization: { id: ownerId, issueTypes: { nodes: types } } },
      }),
  };
}

// A single live GitHub milestone, shaped like loadExistingMilestones' own
// mapped output (ADR-0073 widened this from a bare title string) — `number`
// is what makes a rename/describe PATCH addressable at all, so every
// scripted fixture must carry one, not just a title.
interface ScriptedMilestone {
  number: number;
  title: string;
  description?: string | null;
  state?: "open" | "closed";
}

// `state=all` (not the API's `open` default) so a closed milestone doesn't
// look absent and get re-`POST`ed — see loadExistingMilestones.
function milestonesGetRule(milestones: ScriptedMilestone[]): GhRule {
  return {
    match: (a) =>
      a[0] === "api" && a[1] === `repos/${REPO}/milestones?state=all`,
    respond: () =>
      JSON.stringify(
        milestones.map((m) => ({
          number: m.number,
          title: m.title,
          description: m.description ?? null,
          state: m.state ?? "open",
        })),
      ),
  };
}

function milestoneCreateRule(): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      a[1] === `repos/${REPO}/milestones` &&
      a.includes("-X") &&
      a.includes("POST"),
    respond: () => "",
  };
}

// The in-place PATCH-by-number path patchMilestone() calls for both a
// rename (title=) and a description-only fix (description=) — matched by
// path shape rather than by exact number, so one rule serves every test
// regardless of which milestone number it patches.
function milestonePatchRule(): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      typeof a[1] === "string" &&
      a[1].startsWith(`repos/${REPO}/milestones/`) &&
      a.includes("-X") &&
      a.includes("PATCH"),
    respond: () => "",
  };
}

/** Look up one MILESTONE_DEFS entry by key, failing loudly if it's missing. */
function milestoneDef(key: string): (typeof MILESTONE_DEFS)[number] {
  return required(
    MILESTONE_DEFS.find((def) => def.key === key),
    `MILESTONE_DEFS entry for key "${key}"`,
  );
}

function issueListSyncRule(issues: unknown[]): GhRule {
  return {
    match: (a) =>
      a[0] === "issue" &&
      a[1] === "list" &&
      a.includes("number,title,body,state,labels,issueType,parent"),
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
      a.includes("number,title,body,state,labels,issueType,parent") &&
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
      a.includes("number,title,body,state,labels,issueType,parent") &&
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

// `field-list` returns every field on the project in one call (never
// filtered by name server-side) — accepts either a single field object
// (wrapped in a 1-element array, the pre-ADR-0052 single-Status-field
// shape) or an array of fields (needed once a stub must resolve BOTH
// "Status" and "Priority" in the same test).
function projectFieldListRule(field: unknown): GhRule {
  const payload = Array.isArray(field) ? field : [field];
  return {
    match: (a) => a[0] === "project" && a[1] === "field-list",
    respond: () => JSON.stringify(payload),
  };
}

// Generic graphql fallback — safe only for mutations whose response is never
// parsed (updateProjectV2Field, updateProjectV2View,
// clearProjectV2ItemFieldValue). Place AFTER the shape-specific view rules
// below in a rules array, since scriptedGh uses the first match.
function graphqlRule(): GhRule {
  return {
    match: (a) => a[0] === "api" && a[1] === "graphql",
    respond: () => "",
  };
}

// Extracts one option's `{id: "...", name: "...", ...}` GraphQL literal out
// of an updateProjectV2Field mutation string, by finding the `{` immediately
// before that option's `name: "<optionName>"` field and the next `}` after
// it — each option is a flat, non-nested object literal, so this is exact
// without needing to know the option's color/description text (kept out of
// scope here on purpose: this helper exists only to prove id-preservation,
// not to pin the whole literal shape).
function optionLiteral(mutationQuery: string, optionName: string): string {
  const marker = `name: ${JSON.stringify(optionName)}`;
  const markerIndex = mutationQuery.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      `hub-sync-runners.test.ts: option literal for "${optionName}" not found in: ${mutationQuery}`,
    );
  }
  const openBrace = mutationQuery.lastIndexOf("{", markerIndex);
  const closeBrace = mutationQuery.indexOf("}", markerIndex);
  return mutationQuery.slice(openBrace, closeBrace + 1);
}

// listExistingViews's read — `query { node(id: ...) { ... on ProjectV2 {
// views(first: 20) { nodes { id name layout } } } } }`.
function viewsListGraphqlRule(nodes: unknown[] = []): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      a[1] === "graphql" &&
      typeof a[3] === "string" &&
      a[3].includes("views(first: 20)"),
    respond: () => JSON.stringify({ data: { node: { views: { nodes } } } }),
  };
}

// createView's mutation — response shape createView's own JSON.parse reads.
function createViewGraphqlRule(viewId = "VIEW_NEW"): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      a[1] === "graphql" &&
      typeof a[3] === "string" &&
      a[3].includes("createProjectV2View"),
    respond: () =>
      JSON.stringify({
        data: { createProjectV2View: { projectV2View: { id: viewId } } },
      }),
  };
}

// deleteView's mutation. MUST be placed BEFORE graphqlRule() in a rules
// array: scriptedGh is first-match-wins and the generic fallback matches any
// `gh api graphql`, so behind it this rule never fires and a test asserting
// "nothing was deleted" would pass vacuously — the same trap the
// isMutatingProjectCall fix hit.
function deleteViewGraphqlRule(): GhRule {
  return {
    match: (a) =>
      a[0] === "api" &&
      a[1] === "graphql" &&
      typeof a[3] === "string" &&
      a[3].includes("deleteProjectV2View"),
    respond: () => JSON.stringify({ data: { deleteProjectV2View: {} } }),
  };
}

// Every call recorded by a stub that carries a deleteProjectV2View mutation,
// so a "no deletion" assertion never has to spell the shape out again.
function deleteViewCalls(calls: string[][]): string[][] {
  return calls.filter(
    (args) =>
      args[0] === "api" &&
      args[1] === "graphql" &&
      typeof args[3] === "string" &&
      args[3].includes("deleteProjectV2View"),
  );
}

// A field-list payload resolving every MANDATORY name in VIEW_DEFS[0].fields
// — i.e. all of them except the ones in OPTIONAL_VIEW_FIELDS. Built off the
// declaration rather than hardcoded, so adding a column to VIEW_DEFS does not
// silently turn these fixtures into all-or-nothing skips.
function fullFieldListRule(extra: { name: string; id: string }[] = []): GhRule {
  const mandatory = required(VIEW_DEFS[0], "VIEW_DEFS[0]").fields.filter(
    (name: string) => !OPTIONAL_VIEW_FIELDS.has(name),
  );
  const fields = [
    ...mandatory.map((name: string, index: number) => ({
      name,
      id: `FIELD_${index}`,
      options: [],
    })),
    ...extra,
  ];
  return {
    match: (a) => a[0] === "project" && a[1] === "field-list",
    respond: () => JSON.stringify(fields),
  };
}

// One live view node shaped like listExistingViews's widened selection.
function viewNode({
  id,
  name,
  layout = "TABLE_LAYOUT",
  filter = "is:open",
  sort = [] as { field: string; direction: string }[],
}: {
  id: string;
  name: string;
  layout?: string;
  filter?: string;
  sort?: { field: string; direction: string }[];
}): unknown {
  return {
    id,
    name,
    layout,
    filter,
    sortByFields: {
      nodes: sort.map((pair) => ({
        direction: pair.direction,
        field: { name: pair.field },
      })),
    },
    fields: { nodes: [] },
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
  // A GraphQL call carries no `-X`, so the check above cannot see one. Match
  // on the operation keyword instead of on `graphql` itself: the Issue-Type
  // preflight is also a `gh api graphql` call, and it is a read.
  if (args[0] === "api" && args[1] === "graphql") {
    return args.some((token) => token.includes("query=mutation"));
  }
  return false;
}

function isMutatingProjectCall(args: string[]): boolean {
  if (
    args[0] === "project" &&
    ["create", "item-add", "item-edit", "item-archive"].includes(args[1] ?? "")
  ) {
    return true;
  }
  // Narrowed from "any `gh api graphql` is mutating" once listExistingViews
  // joined the read-only PREVIEW path — a blanket rule made every dry-run
  // assertion fail on a legitimate read. Exact rather than heuristic: every
  // graphql payload this runner builds begins `query {` or `mutation {`, so
  // matching the latter catches every mutation without admitting a read.
  if (args[0] === "api" && args[1] === "graphql") {
    return typeof args[3] === "string" && args[3].includes("mutation {");
  }
  return false;
}

// The value immediately following a named flag in a recorded argv array
// (e.g. argAfter(["issue", "edit", "--type", "Friction"], "--type") ===
// "Friction") — used to assert the ADR-0052 `--type` flag `gh issue
// create`/`gh issue edit` now carry.
function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
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
      // 5 tracker rows (P0A, W1, D1, T1, F1) + 5 derived epics (one per
      // section, each with exactly one unresolved child — see ADR-0073's
      // actionableItems epic-emission guard).
      issues: { create: 10, update: 0, close: 0, reopen: 0, untouched: 0 },
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
      orgIssueTypesGraphqlRule(),
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
    // bootstrapLabels iterates the entire LABEL_DEFS table unconditionally
    // (not filtered by what this fixture's items actually use): HUB_LABEL +
    // 4 priority labels (p0-p3) + 10 type labels + 6 status labels + triage
    // = 22 rows (ADR-0052's 2026-08-20 Update widened both label families to
    // full coverage; a p3 priority label and a "capability" split into
    // libraryCapability/cliCapability/packageCapability were added since).
    expect(labelCalls).toHaveLength(22);
    // Now — unblock first, Next — consumer fleet, Governance, Later —
    // gated/deferred — one per priority/type actually present among this
    // fixture's items.
    expect(milestoneCreateCalls).toHaveLength(4);
    // 5 tracker rows + 5 derived epics (ADR-0073) — see the dry-run test's
    // comment for the exact accounting.
    expect(issueCreateCalls).toHaveLength(10);

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
        labels: [{ name: "hub-sync" }, { name: "priority:0-now" }],
      },
      {
        number: 302,
        title: "UB current title",
        body: `${hubMarker("roadmap:p0:ub")}\nwhatever\n`,
        state: "OPEN",
        labels: [{ name: "hub-sync" }, { name: "priority:0-now" }],
      },
      {
        number: 303,
        title: "UC current title",
        body: `${hubMarker("roadmap:p0:uc")}\nwhatever\n`,
        state: "CLOSED",
        labels: [{ name: "hub-sync" }, { name: "priority:0-now" }],
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
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
    // W1, T1, F1, D1-gated-thing have no matched issue yet (4), plus the 5
    // derived epics this fixture's sections still have unresolved rows for —
    // roadmapP0 (UA/UC To Do), roadmapP1 (W1), roadmapGovernance (T1), friction
    // (F1), and gated (D1) — none of which has a scripted issue either
    // (ADR-0073). 4 + 5 = 9.
    expect(createCalls).toHaveLength(9);
    // UA's stale body/title (1) + UB's pre-close label-only sync (1, ADR-0052's
    // 2026-08-20 Update: UB (302) is transitioning to Done and its existing
    // labels ["hub-sync", "priority:0-now"] are stale relative to the new
    // unconditional type:*/status:* labels, so planIssueSync's close entry
    // carries labelsStale: true and the runner syncs labels before closing,
    // since `gh issue close` cannot set labels itself) + UC's
    // reopen-triggered re-edit (1) + planParentLinks' follow-up --parent edit
    // for UA (301) and UB (302) — both existing (not newly-created-this-run)
    // OPEN issues whose item now carries a parentKey (roadmapP0's freshly
    // created epic), so their sub-issue link is set via a separate `gh issue
    // edit --parent` call. UC (303) is excluded: it started CLOSED, and
    // planParentLinks deliberately leaves a closed issue's parent alone. 1 +
    // 1 + 1 + 2 = 5.
    expect(editCalls).toHaveLength(5);

    // The parent-link-only edits carry no --title and no --add-label, so
    // excluding them from the label-only bucket (which is UB's --add-label
    // sync, also title-less) keeps the two buckets distinguishing what they
    // always did: "sets title/body" vs. "label-only sync", with the new
    // parent-link edits tracked separately.
    const parentOnlyEditCalls = editCalls.filter(
      (a) => a.includes("--parent") && !a.includes("--add-label"),
    );
    const labelOnlyEditCalls = editCalls.filter(
      (a) => argAfter(a, "--title") === undefined && a.includes("--add-label"),
    );
    const fullEditCalls = editCalls.filter(
      (a) => argAfter(a, "--title") !== undefined,
    );
    expect(parentOnlyEditCalls).toHaveLength(2);
    expect(labelOnlyEditCalls).toHaveLength(1);
    expect(fullEditCalls).toHaveLength(2);
    const labelSyncCall = required(
      labelOnlyEditCalls[0],
      "UB's label-sync edit call",
    );
    // Targets UB's issue (302), and only adds/removes managed labels.
    expect(labelSyncCall[2]).toBe("302");
    expect(labelSyncCall).toContain("--add-label");
    expect(labelSyncCall).toContain("type:library-capability");
    expect(labelSyncCall).toContain("status:done");

    // ADR-0052: every create/edit that also sets title/body/type passes
    // --type with a real ISSUE_TYPES value — the label-only sync call is
    // exempt (it never sets --type).
    const validTypes = new Set(Object.values(ISSUE_TYPES));
    for (const call of [...createCalls, ...fullEditCalls]) {
      const type = argAfter(call, "--type");
      expect(type).toBeDefined();
      expect(validTypes.has(type ?? "")).toBe(true);
    }
    expect(argAfter(labelSyncCall, "--type")).toBeUndefined();

    // The label sync runs before the close call it precedes.
    const labelSyncIndex = calls.indexOf(labelSyncCall);
    const closeIndexForUb = calls.findIndex(
      (a) => a[0] === "issue" && a[1] === "close" && a[2] === "302",
    );
    expect(labelSyncIndex).toBeLessThan(closeIndexForUb);

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
      issues: { create: 9, update: 1, close: 1, reopen: 1 },
    });
  });

  test("--apply: closing an item whose labels already match the closing payload records no label-sync edit before close", () => {
    const roadmapWithDoneItem = `# Roadmap — m3l-automation

## Priority 0

| Item   | What                       | Status | Why now / Notes |
| ------ | --------------------------- | ------ | ------------------ |
| **UD** | already-synced done thing    | Done   | notes               |

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
    const items = computeItems(
      roadmapWithDoneItem,
      EMPTY_IMPLEMENTATION_FIXTURE,
    );
    const doneItem = required(items[0], "UD item");
    const payload = buildIssuePayload(doneItem) as {
      title: string;
      body: string;
      labels: string[];
    };
    // A pre-existing OPEN issue whose labels already match the closing
    // payload exactly — proves labelsStale: false correctly skips the
    // pre-close syncManagedLabels edit, distinct from the common case
    // (previous test's UB) where stale open-state labels trigger it.
    const existingIssues = [
      {
        number: 401,
        title: payload.title,
        body: payload.body,
        state: "OPEN",
        labels: payload.labels.map((name) => ({ name })),
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
      milestonesGetRule([]),
      issueListSyncRule(existingIssues),
      labelCreateRule(),
      milestoneCreateRule(),
      issueCloseRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(roadmapWithDoneItem, EMPTY_IMPLEMENTATION_FIXTURE),
    });

    expect(outcome.ok).toBe(true);
    const editCalls = calls.filter((a) => a[0] === "issue" && a[1] === "edit");
    const closeCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]?.[2]).toBe("401");
    expect(editCalls).toHaveLength(0);
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
    // The default fixtures (makeReadDoc()) carry 5 base items — P0A, W1, T1,
    // F1, D1-gated-thing — plus the 5 derived epics their sections each still
    // have unresolved rows for (roadmapP0, roadmapP1, roadmapGovernance,
    // friction, gated), and the issue list is empty, so every one of the 10
    // is a create (ADR-0073). 5 + 5 = 10.
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 4 },
      issues: { create: 10 },
    });
  });

  test("check: true with an empty plan (everything already synced) returns { ok: true } with a distinct success message, without mutating anything", () => {
    const items = computeItems(
      CHECK_EMPTY_ROADMAP_FIXTURE,
      EMPTY_IMPLEMENTATION_FIXTURE,
    );
    const payload = buildIssuePayload(required(items[0], "items[0]"));
    // items[1] is the derived roadmap-P0 epic (ADR-0073) — it must already
    // have its own issue too, and the child's scripted issue must already
    // carry `parent: { number: <epic's number> }`, or planParentLinks sees
    // a link still to set/clear and the plan is not empty.
    const epicPayload = buildIssuePayload(required(items[1], "items[1]"));
    const existingIssues = [
      {
        number: 701,
        title: payload.title,
        body: payload.body,
        state: "OPEN",
        labels: payload.labels.map((name) => ({ name })),
        issueType: { name: payload.type },
        parent: { number: 702 },
      },
      {
        number: 702,
        title: epicPayload.title,
        body: epicPayload.body,
        state: "OPEN",
        labels: epicPayload.labels.map((name) => ({ name })),
        issueType: { name: epicPayload.type },
        parent: null,
      },
    ];
    // The p0 milestone must be an EXACT match — number, title, AND
    // description all equal to its MILESTONE_DEFS entry — or planMilestones
    // reports a rename/describe drift and the plan is no longer empty. A
    // bare title (the pre-ADR-0073 shape) can never satisfy the description
    // comparison, which is exactly the bug this fixture used to hide.
    const p0Def = milestoneDef("p0");
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([
        {
          number: 1,
          title: p0Def.title,
          description: p0Def.description,
          state: "open",
        },
      ]),
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
    // Both the P0 row's issue AND its derived epic issue (ADR-0073) already
    // exist and match, so both land in `untouched` — 2, not 1.
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 0 },
      issues: { create: 0, update: 0, close: 0, reopen: 0, untouched: 2 },
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0073 milestone parity — rename/describe PATCH, ordering ahead of any
  // issue write, and the deliberate orphan/rename+describe asymmetry in the
  // dry-run drift verdict (planIsEmpty counts rename+describe, never orphan).
  // -------------------------------------------------------------------------

  test("--apply: a milestone rename PATCHes before the first issue create/edit, with the argv shape gh api expects", () => {
    const p1Def = milestoneDef("p1");
    const legacyTitle = required(p1Def.legacyTitles[0], "p1 legacy title");

    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
      // Live p1 milestone sits under its legacy title with the CURRENT
      // description already — isolates the rename from any describe, so
      // this test's ordering assertion is about rename alone.
      milestonesGetRule([
        {
          number: 55,
          title: legacyTitle,
          description: p1Def.description,
          state: "open",
        },
      ]),
      issueListSyncRule([]),
      labelCreateRule(),
      milestonePatchRule(),
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

    const patchIndex = calls.findIndex(
      (a) => a[0] === "api" && a.includes("-X") && a.includes("PATCH"),
    );
    const firstIssueWriteIndex = calls.findIndex(
      (a) => a[0] === "issue" && ["create", "edit"].includes(a[1] ?? ""),
    );
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(firstIssueWriteIndex).toBeGreaterThanOrEqual(0);
    // The whole reason for this ordering: `gh issue create/edit --milestone`
    // resolves the milestone by TITLE, so an issue write that ran before the
    // rename would still ask for the now-renamed-away legacy title.
    expect(patchIndex).toBeLessThan(firstIssueWriteIndex);

    const patchCall = required(calls[patchIndex], "patch call");
    expect(patchCall[0]).toBe("api");
    expect(patchCall[1]).toBe(`repos/${REPO}/milestones/55`);
    expect(patchCall).toContain("-X");
    expect(patchCall).toContain("PATCH");
    expect(patchCall).toContain("-f");
    expect(patchCall).toContain(`title=${p1Def.title}`);

    expect(reporter.finishedWith).toMatchObject({
      milestones: { rename: 1 },
    });
  });

  test("--apply: creating a new milestone sends both title= and description= fields", () => {
    const p0Def = milestoneDef("p0");
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
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
    const p0CreateCall = required(
      calls.find(
        (a) =>
          a[0] === "api" &&
          a[1] === `repos/${REPO}/milestones` &&
          a.includes(`title=${p0Def.title}`),
      ),
      "p0 create call",
    );
    expect(p0CreateCall).toContain("-X");
    expect(p0CreateCall).toContain("POST");
    expect(p0CreateCall).toContain(`description=${p0Def.description}`);
  });

  test.each([
    {
      label: "rename",
      buildMilestones: (p0Def: ReturnType<typeof milestoneDef>) => [
        {
          number: 1,
          title: p0Def.title,
          description: p0Def.description,
          state: "open" as const,
        },
        {
          number: 2,
          title: required(
            milestoneDef("p1").legacyTitles[0],
            "p1 legacy title",
          ),
          description: milestoneDef("p1").description,
          state: "open" as const,
        },
      ],
    },
    {
      label: "describe",
      buildMilestones: (p0Def: ReturnType<typeof milestoneDef>) => [
        {
          number: 1,
          title: p0Def.title,
          description: "a stale description, not the managed one",
          state: "open" as const,
        },
      ],
    },
  ])(
    "check: true — a milestone $label alone (no create/update/close/reopen) is reported as drift",
    ({ buildMilestones }) => {
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
          issueType: { name: payload.type },
        },
      ];
      const p0Def = milestoneDef("p0");
      const { runGh } = scriptedGh([
        authOkRule(),
        milestonesGetRule(buildMilestones(p0Def)),
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

      expect(outcome.ok).toBe(false);
      expect(reporter.errors.some((message) => /drift/i.test(message))).toBe(
        true,
      );
    },
  );

  test("check: true — an orphaned milestone alone (matching no MILESTONE_DEFS title or legacy title) is NOT reported as drift", () => {
    const items = computeItems(
      CHECK_EMPTY_ROADMAP_FIXTURE,
      EMPTY_IMPLEMENTATION_FIXTURE,
    );
    const payload = buildIssuePayload(required(items[0], "items[0]"));
    // items[1] is the derived roadmap-P0 epic (ADR-0073) — it must already
    // have its own issue too, and the child's scripted issue must already
    // carry `parent: { number: <epic's number> }`, or planParentLinks sees
    // a link still to set/clear and the plan is not empty.
    const epicPayload = buildIssuePayload(required(items[1], "items[1]"));
    const existingIssues = [
      {
        number: 701,
        title: payload.title,
        body: payload.body,
        state: "OPEN",
        labels: payload.labels.map((name) => ({ name })),
        issueType: { name: payload.type },
        parent: { number: 702 },
      },
      {
        number: 702,
        title: epicPayload.title,
        body: epicPayload.body,
        state: "OPEN",
        labels: epicPayload.labels.map((name) => ({ name })),
        issueType: { name: epicPayload.type },
        parent: null,
      },
    ];
    const p0Def = milestoneDef("p0");
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([
        {
          number: 1,
          title: p0Def.title,
          description: p0Def.description,
          state: "open",
        },
        {
          number: 99,
          title: "A hand-filed milestone nobody's def ever named",
          description: "not managed by MILESTONE_DEFS",
          state: "open",
        },
      ]),
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
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 0, rename: 0, describe: 0, orphan: 1 },
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
      orgIssueTypesGraphqlRule(),
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
    // ADR-0052: the backfilled create also carries --type.
    expect(argAfter(required(createCalls[0], "createCalls[0]"), "--type")).toBe(
      ISSUE_TYPES.libraryCapability,
    );

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
          { name: "priority:0-now" },
          { name: "status:blocked" },
        ],
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
      milestonesGetRule([]),
      issueListSyncRule(existingIssues),
      labelCreateRule(),
      milestoneCreateRule(),
      // The roadmap-P0 epic (ADR-0073) has no existing issue in this
      // fixture, so --apply must file it (and then link UE under it) before
      // any of this test's own assertions run.
      issueCreateRule(),
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
    // even if "priority:0-now" merely appeared elsewhere in argv (e.g. paired
    // with --add-label), which is exactly what a correct edit call does.
    const removedLabels = (editCall ?? [])
      .map((arg, index) => (arg === "--remove-label" ? index : -1))
      .filter((index) => index !== -1)
      .map((index) => editCall?.[index + 1]);
    expect(removedLabels).toEqual(["status:blocked"]);
    expect(removedLabels).not.toContain("priority:0-now");
  });

  // -------------------------------------------------------------------------
  // ADR-0073 sub-issue hierarchy — epic-first create ordering, one-run
  // convergence, and the dry-run drift verdict's set/pending asymmetry.
  // CHECK_EMPTY_ROADMAP_FIXTURE + EMPTY_IMPLEMENTATION_FIXTURE is the
  // smallest fixture that emits a hierarchy: exactly one real row
  // (roadmap:p0:ck1) plus its derived epic (epic:roadmap:p0).
  //
  // `issueCreateRule` always returns the SAME number for every create, which
  // can't discriminate "the child's --parent carries the epic's own
  // just-returned number" from "the child's --parent carries some hardcoded
  // constant". This local variant hands out distinct, increasing numbers
  // instead, one per call, in create order.
  // -------------------------------------------------------------------------

  function sequencedIssueCreateRule(startNumber: number): GhRule {
    let next = startNumber;
    return {
      match: (a) => a[0] === "issue" && a[1] === "create",
      respond: () => {
        const number = next;
        next += 1;
        return `https://github.com/${REPO}/issues/${String(number)}\n`;
      },
    };
  }

  test("--apply: an epic's create precedes its child's, and the child's create carries --parent <the epic's returned number>", () => {
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
      milestonesGetRule([]),
      issueListSyncRule([]),
      labelCreateRule(),
      milestoneCreateRule(),
      sequencedIssueCreateRule(800),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(
        CHECK_EMPTY_ROADMAP_FIXTURE,
        EMPTY_IMPLEMENTATION_FIXTURE,
      ),
    });

    expect(outcome.ok).toBe(true);
    const createCalls = calls.filter(
      (a) => a[0] === "issue" && a[1] === "create",
    );
    expect(createCalls).toHaveLength(2);

    // The epic itself has no parentKey, so its own create carries no
    // --parent flag; the child's does.
    const epicCreateCall = required(
      createCalls.find((a) => !a.includes("--parent")),
      "epic create call (no --parent)",
    );
    const childCreateCall = required(
      createCalls.find((a) => a.includes("--parent")),
      "child create call (with --parent)",
    );

    const epicCreateIndex = calls.indexOf(epicCreateCall);
    const childCreateIndex = calls.indexOf(childCreateCall);
    expect(epicCreateIndex).toBeGreaterThanOrEqual(0);
    expect(epicCreateIndex).toBeLessThan(childCreateIndex);

    // sequencedIssueCreateRule(800) hands out 800 to whichever create call
    // happens first — asserting it against the epic call specifically (not
    // just "the number 800") ties this to the real mechanism: the child's
    // --parent is populated from numberByKey, which was seeded from the
    // epic's own just-returned create number.
    expect(argAfter(childCreateCall, "--parent")).toBe("800");
  });

  test("--apply: a single run both files a missing epic AND links its pre-existing child under it, converging in one pass instead of two", () => {
    // Without this ordering (epic create -> resolve `parentPlan.pending`
    // against the freshly-created epic's number, all inside the same
    // --apply), a first-time sync would leave the child unlinked until a
    // second --apply run resolved it.
    const items = computeItems(
      CHECK_EMPTY_ROADMAP_FIXTURE,
      EMPTY_IMPLEMENTATION_FIXTURE,
    );
    const payload = buildIssuePayload(required(items[0], "items[0]"));
    // The child already has an issue, with a marker-matching, otherwise
    // fully in-sync title/body/labels/type — so nothing but the sub-issue
    // link is outstanding for it. No issue is scripted for the epic at all:
    // it does not exist yet.
    const existingIssues = [
      {
        number: 950,
        title: payload.title,
        body: payload.body,
        state: "OPEN",
        labels: payload.labels.map((name) => ({ name })),
        issueType: { name: payload.type },
        parent: null,
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(),
      milestonesGetRule([]),
      issueListSyncRule(existingIssues),
      labelCreateRule(),
      milestoneCreateRule(),
      issueCreateRule(900),
      issueEditRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(
        CHECK_EMPTY_ROADMAP_FIXTURE,
        EMPTY_IMPLEMENTATION_FIXTURE,
      ),
    });

    expect(outcome.ok).toBe(true);

    const epicCreateCall = required(
      calls.find((a) => a[0] === "issue" && a[1] === "create"),
      "epic create call",
    );
    const parentLinkEditCall = required(
      calls.find(
        (a) =>
          a[0] === "issue" &&
          a[1] === "edit" &&
          a[2] === "950" &&
          a.includes("--parent"),
      ),
      "child's --parent link edit call",
    );

    const epicCreateIndex = calls.indexOf(epicCreateCall);
    const parentLinkEditIndex = calls.indexOf(parentLinkEditCall);
    expect(epicCreateIndex).toBeLessThan(parentLinkEditIndex);
    expect(argAfter(parentLinkEditCall, "--parent")).toBe("900");

    // planParentLinks runs BEFORE apply, against pre-apply state, so this
    // link starts out in `pending` (the epic's issue doesn't exist yet) and
    // is only resolved to a `setIssueParent` call once the epic's number is
    // known — not via `parentPlan.set`, which reflects only pre-apply state.
    expect(reporter.finishedWith).toMatchObject({
      applied: true,
      parents: { set: 0, clear: 0, pending: 1 },
    });
  });

  // planParentLinks' `clear` bucket fires only when an item has NO
  // `parentKey` but its existing issue already carries a parent link to
  // remove. Every actionableItems row that isn't itself an epic is
  // unconditionally assigned a parentKey (one per tracker section — see
  // EPIC_DEFS/EPIC_KEYS in bin/lib/hub-sync.mjs), and planParentLinks skips
  // `isEpic` items outright (`if (item.isEpic) continue;`), so there is
  // currently no item this test file's fixtures — or any real tracker row —
  // can construct that reaches the `clear` branch. Per this task's own
  // instruction, that unreachable state is reported rather than contrived
  // into a test: `parentPlan.clear` is exercised only by
  // bin/tests/hub-sync.test.ts's unit-level `planParentLinks` tests, which
  // can hand it a synthetic item lacking `parentKey` directly.

  test("check: true reports drift from an outstanding parentPlan.set link alone, with every other bucket (create/update/close/reopen/clear/pending) at zero", () => {
    // The dry-run verdict (planIsEmpty in bin/sync-hub-issues.mjs) counts
    // parentPlan.set and parentPlan.clear, but never parentPlan.pending. This
    // test isolates `set` as the sole source of drift to prove that half of
    // the asymmetry directly. Isolating `pending` as a counterexample (drift
    // from `pending` alone, with `create` at zero) is not constructible: an
    // item lands in `pending` only when its epic has no matching existing
    // issue, and actionableItems only emits an epic once it has >=1
    // unresolved child — so "the epic's issue does not exist" is exactly the
    // condition that also puts the epic into `issuePlan.create`, which the
    // dry-run verdict already counts. `pending` cannot fire without an
    // accompanying create in this design; see the report for this finding.
    const items = computeItems(
      CHECK_EMPTY_ROADMAP_FIXTURE,
      EMPTY_IMPLEMENTATION_FIXTURE,
    );
    const payload = buildIssuePayload(required(items[0], "items[0]"));
    const epicPayload = buildIssuePayload(required(items[1], "items[1]"));
    const existingIssues = [
      {
        number: 701,
        title: payload.title,
        body: payload.body,
        state: "OPEN",
        labels: payload.labels.map((name) => ({ name })),
        issueType: { name: payload.type },
        // Both issues already exist and both already match their item's
        // payload exactly — the ONLY outstanding drift in this fixture is
        // that the child has never been linked under its (already-filed)
        // epic.
        parent: null,
      },
      {
        number: 702,
        title: epicPayload.title,
        body: epicPayload.body,
        state: "OPEN",
        labels: epicPayload.labels.map((name) => ({ name })),
        issueType: { name: epicPayload.type },
        parent: null,
      },
    ];
    const p0Def = milestoneDef("p0");
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      milestonesGetRule([
        {
          number: 1,
          title: p0Def.title,
          description: p0Def.description,
          state: "open",
        },
      ]),
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

    expect(outcome.ok).toBe(false);
    expect(reporter.errors.some((message) => /drift/i.test(message))).toBe(
      true,
    );
    expect(reporter.succeeded).toEqual([]);
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      milestones: { create: 0 },
      issues: { create: 0, update: 0, close: 0, reopen: 0, untouched: 2 },
      parents: { set: 1, clear: 0, pending: 0 },
    });
  });

  // ---------------------------------------------------------------------------
  // issueTypePreflight — the apply-path guard added ahead of every mutation.
  // A half-provisioned org (missing even one declared type) must refuse the
  // WHOLE batch before the first write: `gh issue create --type` 422s
  // partway through otherwise, leaving some issues filed and some not.
  // ---------------------------------------------------------------------------

  test("--apply: an org missing a declared Issue Type refuses the whole batch before any mutation, naming the remedy", () => {
    // Only "Friction" is live; the other 9 ISSUE_TYPE_DEFS entries are
    // missing, so issueTypePreflight's `create` bucket is non-empty and the
    // whole --apply must refuse before bootstrapLabels (the first mutation)
    // ever runs.
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule([{ id: "IT_0", name: "Friction" }]),
      milestonesGetRule([]),
      issueListSyncRule([]),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueSync({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors).toHaveLength(1);
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toMatch(/missing/i);
    expect(message).toMatch(/--init-issue-types/);
    // The whole point: no partial batch. Not one mutating call (label
    // bootstrap, milestone create, issue create) ever reaches `gh`.
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runIssueTypeInit — the separate opt-in provisioning entry point for org
// Issue Types (ADR-0073). Never reads the trackers (no readDoc); reads only
// the live Issue Type census and the unfiltered issue list (for the retire
// census), then creates every missing declared type and retires every
// undeclared, zero-issue one. Creates always run before retires.
// ---------------------------------------------------------------------------

describe("runIssueTypeInit", () => {
  // Three of the ten declared kinds already live on the org under their new
  // (post-ADR-0073 split) names — a realistic "partially migrated" org,
  // leaving the other seven to create and nothing to retire.
  function partiallyProvisionedTypes(): { id: string; name: string }[] {
    return ["libraryCapability", "cliCapability", "packageCapability"].map(
      (key, index) => ({
        id: `IT_CAP_${String(index)}`,
        name: required(
          ISSUE_TYPE_DEFS.find((def) => def.key === key),
          `ISSUE_TYPE_DEFS entry for key "${key}"`,
        ).name,
      }),
    );
  }

  test("dry run with an under-provisioned org plans the missing creates and makes no mutating call", () => {
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(partiallyProvisionedTypes()),
      issueListAllRule([]),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: false });

    expect(outcome.ok).toBe(true);
    // 10 declared kinds minus the 3 already-live capability ones.
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      issueTypes: { create: 7, retire: 0, blocked: 0 },
    });
  });

  test("--apply issues one createIssueType mutation per missing type, each carrying that def's real name/description/color and the read ownerId", () => {
    const liveTypes = partiallyProvisionedTypes();
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      // A distinct, non-default ownerId proves the id is threaded from the
      // graphql read into each mutation, not hardcoded.
      orgIssueTypesGraphqlRule(liveTypes, "O_TEST_ORG"),
      issueListAllRule([]),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: true });

    expect(outcome.ok).toBe(true);
    const liveNames = new Set(liveTypes.map((type) => type.name));
    const missingDefs = ISSUE_TYPE_DEFS.filter(
      (def) => !liveNames.has(def.name),
    );
    expect(missingDefs).toHaveLength(7);

    for (const def of missingDefs) {
      const mutationCall = required(
        calls.find((call) => call.includes(`name=${def.name}`)),
        `createIssueType mutation call for "${def.name}"`,
      );
      expect(mutationCall).toContain("ownerId=O_TEST_ORG");
      expect(mutationCall).toContain(`description=${def.description}`);
      expect(mutationCall).toContain(`color=${def.color}`);
    }
    // No live type is undeclared here, so nothing is retired.
    expect(
      calls.some((call) => call.some((t) => t.startsWith("issueTypeId="))),
    ).toBe(false);
    expect(
      reporter.changes.filter((entry) => entry.kind === "created"),
    ).toHaveLength(7);
  });

  test("an undeclared live type no issue carries is deleted, with the mutation carrying that type's id", () => {
    const liveTypes = [
      ...ISSUE_TYPE_DEFS.map((def, index) => ({
        id: `IT_${String(index)}`,
        name: def.name,
      })),
      // A leftover from before the ADR-0073 vocabulary split — matches no
      // current ISSUE_TYPE_DEFS name.
      { id: "IT_OLD", name: "Capability" },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(liveTypes),
      issueListAllRule([]),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: true });

    expect(outcome.ok).toBe(true);
    const deleteCall = required(
      calls.find((call) => call.includes("issueTypeId=IT_OLD")),
      "deleteIssueType mutation call",
    );
    expect(deleteCall[0]).toBe("api");
    expect(deleteCall[1]).toBe("graphql");
    // No declared type is missing, so no create ever fires alongside it.
    expect(calls.some((call) => call.some((t) => t.startsWith("name=")))).toBe(
      false,
    );
    expect(reporter.changes).toContainEqual({
      kind: "removed",
      file: "Issue Type: Capability",
      note: undefined,
    });
  });

  test("an undeclared live type an issue still carries (even closed) is NOT deleted, and is named in reporter.infos with its count", () => {
    const liveTypes = [
      ...ISSUE_TYPE_DEFS.map((def, index) => ({
        id: `IT_${String(index)}`,
        name: def.name,
      })),
      { id: "IT_OLD", name: "Capability" },
    ];
    // A CLOSED issue still carrying the undeclared type — proves a closed
    // issue counts too, which is exactly what makes deleting the type
    // destructive.
    const allIssues = [
      {
        number: 1,
        title: "an old issue",
        body: "",
        state: "CLOSED",
        labels: [],
        issueType: { name: "Capability" },
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(liveTypes),
      issueListAllRule(allIssues),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: true });

    expect(outcome.ok).toBe(true);
    // Every declared type is live and the one undeclared type is blocked, so
    // --apply has literally nothing to mutate.
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    expect(
      calls.some((call) => call.some((t) => t.startsWith("issueTypeId="))),
    ).toBe(false);
    expect(
      reporter.infos.some((message) => /Capability — 1 issue/.test(message)),
    ).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: true,
      issueTypes: { create: 0, retire: 0, blocked: 1 },
    });
  });

  test("--apply runs every create before any retire", () => {
    // Drop one declared kind from the live set (a create) and add one
    // undeclared, zero-issue leftover (a retire), so both buckets are
    // non-empty in the same run.
    const liveTypes = [
      ...ISSUE_TYPE_DEFS.filter((def) => def.key !== "governance").map(
        (def, index) => ({ id: `IT_${String(index)}`, name: def.name }),
      ),
      { id: "IT_OLD", name: "Capability" },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(liveTypes),
      issueListAllRule([]),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: true });

    expect(outcome.ok).toBe(true);
    const createIndex = calls.findIndex((call) =>
      call.includes("name=Governance"),
    );
    const deleteIndex = calls.findIndex((call) =>
      call.includes("issueTypeId=IT_OLD"),
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeLessThan(deleteIndex);
  });

  test("auth failure short-circuits: { ok: false }, and no gh call runs beyond auth status", () => {
    const { runGh, calls } = scriptedGh([authFailRule("not logged in")]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: false });

    expect(outcome.ok).toBe(false);
    expect(reporter.errors).toHaveLength(1);
    expect(reporter.errors[0]).toMatch(/gh auth login/);
    expect(calls).toHaveLength(1);
  });

  test("every recorded call is an argv array of strings, across a run mixing creates and retires", () => {
    const liveTypes = [
      ...ISSUE_TYPE_DEFS.filter((def) => def.key !== "governance").map(
        (def, index) => ({ id: `IT_${String(index)}`, name: def.name }),
      ),
      { id: "IT_OLD", name: "Capability" },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      orgIssueTypesGraphqlRule(liveTypes),
      issueListAllRule([]),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runIssueTypeInit({ runGh, reporter, apply: true });

    expect(outcome.ok).toBe(true);
    expectEveryCallIsAnArgvArray(calls);
  });
});

// ---------------------------------------------------------------------------
// runClosedRetype
// ---------------------------------------------------------------------------

describe("runClosedRetype", () => {
  // The default fixtures' real P0A item — key/type computed via the same
  // extraction pipeline the runner uses, rather than hand-guessed (see
  // computeItems' own comment above): "roadmap:p0:p0a", type "Library
  // capability".
  const items = computeItems(ROADMAP_FIXTURE, IMPLEMENTATION_FIXTURE);
  const p0aItem = required(
    items.find((item) => item.key === "roadmap:p0:p0a"),
    "P0A item in the default fixtures",
  );

  test("dry run with one closed untyped issue matching a tracker row: plans the retype, makes no mutating call, and never reads org Issue Types at all", () => {
    const closedIssues = [
      {
        number: 501,
        title: "an old issue",
        body: `${hubMarker(p0aItem.key)}\n`,
        state: "CLOSED",
        labels: [],
        issueType: null,
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      issueListSyncRule(closedIssues),
    ]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      applied: false,
      closedRetype: { set: 1, unmatched: 0 },
    });
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
    // The preflight (an `api graphql` read) is --apply-only in this runner —
    // pinning its absence here is what proves a dry run needs no org read
    // access at all, distinct from runIssueTypeInit where the read is
    // unconditional.
    expect(
      calls.some((args) => args[0] === "api" && args[1] === "graphql"),
    ).toBe(false);
  });

  test("--apply issues exactly one type-only issue edit, carrying none of --title/--body/--add-label/--milestone", () => {
    const closedIssues = [
      {
        number: 501,
        title: "an old issue",
        body: `${hubMarker(p0aItem.key)}\n`,
        state: "CLOSED",
        labels: [],
        issueType: null,
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      issueListSyncRule(closedIssues),
      orgIssueTypesGraphqlRule(),
      issueEditRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    const editCalls = calls.filter(
      (args) => args[0] === "issue" && args[1] === "edit",
    );
    expect(editCalls).toHaveLength(1);
    const editCall = required(editCalls[0], "the single issue edit call");
    expect(argAfter(editCall, "--type")).toBe(p0aItem.type);
    // setIssueType is deliberately narrower than editIssue (see its own
    // comment in sync-hub-issues.mjs): a closed-and-resolved issue's
    // title/body/labels/milestone must stay untouched, only the type moves.
    for (const flag of ["--title", "--body", "--add-label", "--milestone"]) {
      expect(editCall).not.toContain(flag);
    }
    expectEveryCallIsAnArgvArray(calls);
  });

  test("--apply runs the Issue-Type preflight first: an under-provisioned org blocks with { ok: false } naming --init-issue-types, and issues no edit at all", () => {
    const closedIssues = [
      {
        number: 501,
        title: "an old issue",
        body: `${hubMarker(p0aItem.key)}\n`,
        state: "CLOSED",
        labels: [],
        issueType: null,
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      issueListSyncRule(closedIssues),
      // Only one of the ten declared types is live, so the preflight finds
      // nine missing and refuses to start the edit loop.
      orgIssueTypesGraphqlRule([
        { id: "IT_0", name: required(ISSUE_TYPE_DEFS[0], "def 0").name },
      ]),
    ]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(false);
    expect(
      reporter.errors.some((message) => /--init-issue-types/.test(message)),
    ).toBe(true);
    expect(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
    ).toBe(false);
  });

  test("an issue already carrying the correct type is left alone: set:0 and no issue edit", () => {
    const closedIssues = [
      {
        number: 501,
        title: "an old issue",
        body: `${hubMarker(p0aItem.key)}\n`,
        state: "CLOSED",
        labels: [],
        issueType: { name: p0aItem.type },
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      issueListSyncRule(closedIssues),
      orgIssueTypesGraphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
      runGh,
      reporter,
      apply: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      closedRetype: { set: 0, unmatched: 0 },
    });
    expect(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
    ).toBe(false);
  });

  test("an OPEN issue with a wrong type is ignored (set:0) — the closed-only filter at the runner level", () => {
    const openIssues = [
      {
        number: 501,
        title: "a live issue",
        body: `${hubMarker(p0aItem.key)}\n`,
        // Uppercase, matching the real `gh` CLI's JSON — listIssues is what
        // lowercases this, and open must not be mistaken for closed here.
        state: "OPEN",
        labels: [],
        issueType: { name: "Governance" },
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      issueListSyncRule(openIssues),
    ]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      closedRetype: { set: 0, unmatched: 0 },
    });
    expect(calls.every((args) => !isMutatingIssueCall(args))).toBe(true);
  });

  test("a closed issue whose marker matches no tracker row is named in reporter.infos as unmatched, not retyped, and { ok: true } still holds", () => {
    const closedIssues = [
      {
        number: 502,
        title: "a removed row's issue",
        body: `${hubMarker("roadmap:p0:vanished")}\n`,
        state: "CLOSED",
        labels: [],
        issueType: null,
      },
    ];
    const { runGh, calls } = scriptedGh([
      authOkRule(),
      issueListSyncRule(closedIssues),
    ]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
      runGh,
      reporter,
      apply: false,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(
      reporter.infos.some((message) =>
        /#502 \[roadmap:p0:vanished\] currently/.test(message),
      ),
    ).toBe(true);
    expect(reporter.finishedWith).toMatchObject({
      closedRetype: { set: 0, unmatched: 1 },
    });
    expect(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
    ).toBe(false);
  });

  test("auth failure short-circuits: { ok: false }, and no gh call runs beyond auth status", () => {
    const { runGh, calls } = scriptedGh([authFailRule("not logged in")]);
    const reporter = createFakeReporter();

    const outcome = runClosedRetype({
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

  test("board title miss with exactly one owner project: reports a rename-detection error naming the real title/number, not the generic --init message", () => {
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 42, title: "m3l-automation hub" }]),
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
    expect(reporter.errors).toHaveLength(1);
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toContain(HUB_PROJECT_TITLE);
    expect(message).toContain("m3l-automation hub");
    expect(message).toContain("#42");
    expect(message).toMatch(/renamed on GitHub/);
    expect(message).toMatch(/HUB_PROJECT_TITLE/);
    // Never suggests --init here — that would create a second, empty board.
    expect(message).not.toMatch(/run with --init/);
    expect(calls).toHaveLength(1);
  });

  test("board title miss with two or more owner projects: falls back to the generic --init message (not a rename guess)", () => {
    const { runGh, calls } = scriptedGh([
      projectListRule([
        { number: 42, title: "Some other board" },
        { number: 43, title: "Yet another board" },
      ]),
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
    expect(reporter.errors).toHaveLength(1);
    const message = required(reporter.errors[0], "reporter.errors[0]");
    expect(message).toMatch(/run with --init to create it/);
    expect(message).not.toMatch(/renamed on GitHub/);
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
      // Without these two, previewViews bails at resolveProjectId and its
      // whole view branch goes unexercised — the assertion below would hold
      // vacuously.
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule([viewNode({ id: "VIEW_1", name: "Backlog" })]),
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
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule([]),
      createViewGraphqlRule(),
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

  // Regression for the 2026-08-20 live incident: adding a 4th Priority
  // option ("Governance") alongside three EXISTING, UNRENAMED options
  // ("0-now"/"1-next"/"2-later", no renameSource entry for any of them)
  // must preserve those three options' ids in the singleSelectOptions
  // mutation literal — omitting an id on an option that already exists
  // under its own name makes GitHub create a brand-new option and silently
  // orphan the old one (and every item's value pointing at it). Before the
  // fix, `updateSingleSelectOptions` only ever attached an id via the
  // renameSource lookup, so none of these three unchanged options would
  // have carried one — this test fails against that pre-fix behavior.
  test("--init --apply: adding a new single-select option preserves existing unrenamed options' ids", () => {
    const createdProject = { number: 9, title: HUB_PROJECT_TITLE };
    const { runGh, calls } = scriptedGh([
      projectListRule([]),
      projectCreateRule(createdProject),
      projectFieldListRule([
        {
          name: "Status",
          id: "FIELD_STATUS",
          options: [
            { name: "To Do", id: "opt-todo" },
            { name: "In Progress", id: "opt-in-progress" },
            { name: "Blocked", id: "opt-blocked" },
            { name: "Deferred", id: "opt-deferred" },
            { name: "Done", id: "opt-done" },
            { name: "Rejected", id: "opt-rejected" },
          ],
        },
        {
          // Mirrors the live board immediately before the incident: three
          // existing options under their own names, no "Governance" yet.
          name: "Priority",
          id: "FIELD_PRIORITY",
          options: [
            { name: "0-now", id: "opt-0-now" },
            { name: "1-next", id: "opt-1-next" },
            { name: "2-later", id: "opt-2-later" },
          ],
        },
      ]),
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule([]),
      createViewGraphqlRule(),
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
    // Status already matches its desired options exactly, so only Priority
    // should have produced an updateProjectV2Field mutation.
    const fieldMutationCalls = calls.filter(
      (args) =>
        args[0] === "api" &&
        args[1] === "graphql" &&
        typeof args[3] === "string" &&
        args[3].includes("updateProjectV2Field"),
    );
    expect(fieldMutationCalls).toHaveLength(1);
    const mutation = required(
      fieldMutationCalls[0]?.[3],
      "Priority updateProjectV2Field mutation query",
    );
    expect(mutation).toContain('fieldId: "FIELD_PRIORITY"');
    expect(optionLiteral(mutation, "0-now")).toMatch(/^\{id: "opt-0-now",/);
    expect(optionLiteral(mutation, "1-next")).toMatch(/^\{id: "opt-1-next",/);
    expect(optionLiteral(mutation, "2-later")).toMatch(/^\{id: "opt-2-later",/);
    // The genuinely new option must NOT carry an id of its own.
    expect(optionLiteral(mutation, "Governance")).toMatch(
      /^\{name: "Governance",/,
    );
  });

  // Confirms the renameSource path (already in production use for the
  // Status field's ADR-0052 migration) still preserves a renamed option's
  // id, and that it keeps doing so in the SAME mutation as an unrelated,
  // unchanged option resolved purely via the own-name lookup — i.e. the
  // fix's "own name first, renameSource fallback" ordering serves both
  // cases at once rather than one regressing the other.
  test("--init --apply: renaming an option preserves its id alongside an unrelated unchanged option in the same mutation", () => {
    const createdProject = { number: 11, title: HUB_PROJECT_TITLE };
    const { runGh, calls } = scriptedGh([
      projectListRule([]),
      projectCreateRule(createdProject),
      projectFieldListRule([
        {
          name: "Status",
          id: "FIELD_STATUS",
          options: [
            // Pre-migration names: "Pending" -> "To Do" and "In review" ->
            // "In Progress" are genuine renames (STATUS_OPTION_RENAME_SOURCE).
            { name: "Pending", id: "opt-pending" },
            { name: "In review", id: "opt-in-review" },
            // "Blocked" already exists under its own (unchanged) desired
            // name — not part of any rename mapping.
            { name: "Blocked", id: "opt-blocked" },
          ],
        },
        {
          // Priority already matches exactly, so it produces no mutation —
          // keeps this test's single mutation focused on Status.
          name: "Priority",
          id: "FIELD_PRIORITY",
          options: [
            { name: "0-now", id: "opt-0-now" },
            { name: "1-next", id: "opt-1-next" },
            { name: "2-later", id: "opt-2-later" },
            { name: "3-gated", id: "opt-3-gated" },
            { name: "Governance", id: "opt-governance" },
          ],
        },
      ]),
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule([]),
      createViewGraphqlRule(),
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
    const fieldMutationCalls = calls.filter(
      (args) =>
        args[0] === "api" &&
        args[1] === "graphql" &&
        typeof args[3] === "string" &&
        args[3].includes("updateProjectV2Field"),
    );
    expect(fieldMutationCalls).toHaveLength(1);
    const mutation = required(
      fieldMutationCalls[0]?.[3],
      "Status updateProjectV2Field mutation query",
    );
    expect(mutation).toContain('fieldId: "FIELD_STATUS"');
    // Renamed options keep their pre-migration id.
    expect(optionLiteral(mutation, "To Do")).toMatch(/^\{id: "opt-pending",/);
    expect(optionLiteral(mutation, "In Progress")).toMatch(
      /^\{id: "opt-in-review",/,
    );
    // The unrelated, unrenamed option keeps its own id via the own-name
    // lookup — proves the fix's ordering doesn't disturb the rename path.
    expect(optionLiteral(mutation, "Blocked")).toMatch(/^\{id: "opt-blocked",/);
    // Genuinely new options (never existed under any name) carry no id.
    expect(optionLiteral(mutation, "Deferred")).toMatch(/^\{name: "Deferred",/);
    expect(optionLiteral(mutation, "Rejected")).toMatch(/^\{name: "Rejected",/);
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
      { id: "PVTI_103", content: { number: 103 }, status: "To Do" },
    ];
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      issueListProjectsRule(hubIssues),
      projectItemListRule(existingProjectItems),
      projectViewRule("PROJECT_ID"),
      projectFieldListRule([
        {
          name: "Status",
          id: "FIELD_1",
          options: [
            { name: "To Do", id: "opt-todo" },
            { name: "In Progress", id: "opt-in-progress" },
            { name: "Blocked", id: "opt-blocked" },
            { name: "Deferred", id: "opt-deferred" },
            { name: "Done", id: "opt-done" },
            { name: "Rejected", id: "opt-rejected" },
          ],
        },
        {
          name: "Priority",
          id: "FIELD_2",
          options: [
            { name: "0-now", id: "opt-0-now" },
            { name: "1-next", id: "opt-1-next" },
            { name: "2-later", id: "opt-2-later" },
          ],
        },
      ]),
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
    // add (status + priority) + setStatus + setPriority = 4 item-edit calls.
    expect(editCalls.length).toBeGreaterThanOrEqual(2);
    expect(archiveCalls).toHaveLength(1);
    expect(reporter.finishedWith).toMatchObject({
      applied: true,
      board: { add: 1, setStatus: 1, setPriority: 1, archive: 1 },
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
// View pruning (--prune-views)
//
// The board carries one declared view (VIEW_DEFS: "Backlog"); anything else
// live is undeclared. Deleting a view is irreversible through the API, so
// these pin that it happens ONLY behind the flag, only by id, and only when
// the board is in a known-good state.
// ---------------------------------------------------------------------------

describe("runProjectSync view pruning", () => {
  const DECLARED = required(VIEW_DEFS[0], "VIEW_DEFS[0]").name;

  // The four calls every --init --apply view path makes, in rule order.
  // deleteViewGraphqlRule comes BEFORE graphqlRule() deliberately — see its
  // own comment.
  function viewRules(liveViews: unknown[]): GhRule[] {
    return [
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      fullFieldListRule(),
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule(liveViews),
      createViewGraphqlRule(),
      deleteViewGraphqlRule(),
      graphqlRule(),
    ];
  }

  test("--init --apply without --prune-views: reports the undeclared view, naming the flag, and issues no deleteProjectV2View at all", () => {
    const { runGh, calls } = scriptedGh(
      viewRules([
        viewNode({ id: "VIEW_BACKLOG", name: DECLARED }),
        viewNode({ id: "VIEW_BOARD", name: "Board", layout: "BOARD_LAYOUT" }),
      ]),
    );
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(deleteViewCalls(calls)).toHaveLength(0);
    expect(reporter.changes.every((entry) => entry.kind !== "removed")).toBe(
      true,
    );
    // Reported, and the remedy is named — the whole point of the default-off
    // behaviour is that item 1 still happens, once, explicitly.
    const notice = required(
      reporter.infos.find((message) => /Undeclared view/.test(message)),
      "undeclared-view notice",
    );
    expect(notice).toContain('"Board"');
    expect(notice).toContain("--prune-views");
  });

  test("--prune-views --apply: deletes the undeclared view by id, never by name", () => {
    const { runGh, calls } = scriptedGh(
      viewRules([
        viewNode({ id: "VIEW_BACKLOG", name: DECLARED }),
        viewNode({ id: "VIEW_BOARD", name: "Board", layout: "BOARD_LAYOUT" }),
      ]),
    );
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      pruneViews: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    const deletions = deleteViewCalls(calls);
    expect(deletions).toHaveLength(1);
    const mutation = required(deletions[0]?.[3], "delete mutation");
    expect(mutation).toContain('viewId: "VIEW_BOARD"');
    // The declared view must not be in the blast radius.
    expect(mutation).not.toContain("VIEW_BACKLOG");
    // By id only — a name would be matched against user-editable text.
    expect(mutation).not.toContain('"Board"');
    // "removed", not "deleted" — createReporter's change() indexes a fixed
    // {updated,created,removed} bag, so an invented kind throws at runtime.
    expect(
      reporter.changes.some(
        (entry) => entry.kind === "removed" && /"Board"/.test(entry.file),
      ),
    ).toBe(true);
  });

  test("--prune-views --apply: a view created by this same run is not pruned by it (prune reads back, never the stale pre-update map)", () => {
    // Live board has ONLY the undeclared view, so the declared one is created
    // in this run. The re-read must see both, prune the undeclared one, and
    // leave the newborn alone.
    let listCount = 0;
    const readBackRule: GhRule = {
      match: (a) =>
        a[0] === "api" &&
        a[1] === "graphql" &&
        typeof a[3] === "string" &&
        a[3].includes("views(first: 20)"),
      respond: () => {
        listCount += 1;
        const nodes =
          listCount === 1
            ? [viewNode({ id: "VIEW_OLD", name: "Board" })]
            : [
                viewNode({ id: "VIEW_OLD", name: "Board" }),
                viewNode({ id: "VIEW_NEW", name: DECLARED }),
              ];
        return JSON.stringify({ data: { node: { views: { nodes } } } });
      },
    };
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      fullFieldListRule(),
      projectViewRule("PROJECT_ID"),
      readBackRule,
      createViewGraphqlRule("VIEW_NEW"),
      deleteViewGraphqlRule(),
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      pruneViews: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    const deletions = deleteViewCalls(calls);
    expect(deletions).toHaveLength(1);
    const mutation = required(deletions[0]?.[3], "delete mutation");
    expect(mutation).toContain('viewId: "VIEW_OLD"');
    expect(mutation).not.toContain("VIEW_NEW");
  });

  test("--prune-views --apply: deletes nothing when a declared view's update failed", () => {
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      fullFieldListRule(),
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule([
        viewNode({ id: "VIEW_BACKLOG", name: DECLARED }),
        viewNode({ id: "VIEW_BOARD", name: "Board", layout: "BOARD_LAYOUT" }),
      ]),
      deleteViewGraphqlRule(),
      // updateProjectV2View throws — the declared view is left in an unknown
      // state, so its undeclared neighbour must survive.
      {
        match: (a) =>
          a[0] === "api" &&
          a[1] === "graphql" &&
          typeof a[3] === "string" &&
          a[3].includes("updateProjectV2View"),
        respond: () => {
          throw new Error("HTTP 502");
        },
      },
      graphqlRule(),
    ]);
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      pruneViews: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(deleteViewCalls(calls)).toHaveLength(0);
    expect(
      reporter.warnings.some((message) =>
        /Not pruning.*failed to reconcile/s.test(message),
      ),
    ).toBe(true);
  });

  test("--prune-views --apply: deletes nothing when doing so would empty the board", () => {
    // Every live view is undeclared (the declared one does not exist yet), so
    // pruning would leave zero views. GitHub's own last-view refusal is a
    // backstop; this is the guard.
    const { runGh, calls } = scriptedGh(
      viewRules([viewNode({ id: "VIEW_ONLY", name: "Board" })]),
    );
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      pruneViews: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(deleteViewCalls(calls)).toHaveLength(0);
    expect(
      reporter.warnings.some((message) =>
        /Not pruning.*no views at all/s.test(message),
      ),
    ).toBe(true);
  });

  test("a declared column that fails to resolve skips the view update instead of writing a truncated visibleFieldIds", () => {
    // field-list resolves everything EXCEPT one mandatory declared column.
    // visibleFieldIds is a full replace, so writing the short list would
    // delete every other column — the 2026-08-20 Priority-wipe shape.
    const mandatory = required(VIEW_DEFS[0], "VIEW_DEFS[0]").fields.filter(
      (name: string) => !OPTIONAL_VIEW_FIELDS.has(name),
    );
    const dropped = required(mandatory.at(-1), "last mandatory field");
    const { runGh, calls } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      {
        match: (a) => a[0] === "project" && a[1] === "field-list",
        respond: () =>
          JSON.stringify(
            mandatory
              .filter((name: string) => name !== dropped)
              .map((name: string, index: number) => ({
                name,
                id: `FIELD_${index}`,
                options: [],
              })),
          ),
      },
      projectViewRule("PROJECT_ID"),
      viewsListGraphqlRule([viewNode({ id: "VIEW_BACKLOG", name: DECLARED })]),
      createViewGraphqlRule(),
      deleteViewGraphqlRule(),
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
    // No view mutation of any kind — not a partial one.
    const viewMutations = calls.filter(
      (args) =>
        args[0] === "api" &&
        args[1] === "graphql" &&
        typeof args[3] === "string" &&
        (args[3].includes("updateProjectV2View") ||
          args[3].includes("createProjectV2View")),
    );
    expect(viewMutations).toHaveLength(0);
    const warning = required(
      reporter.warnings.find((message) => /did not resolve/.test(message)),
      "unresolved-field warning",
    );
    expect(warning).toContain(dropped);
    expect(warning).toMatch(/full replace/);
  });

  test("the optional built-in Type column is omitted with an info note, not a warning, and does not block the update", () => {
    const { runGh, calls } = scriptedGh(
      viewRules([viewNode({ id: "VIEW_BACKLOG", name: DECLARED })]),
    );
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: true,
      init: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    // fullFieldListRule deliberately omits every OPTIONAL_VIEW_FIELDS name.
    for (const optional of OPTIONAL_VIEW_FIELDS) {
      expect(
        reporter.infos.some(
          (message) =>
            message.includes(optional) && /not on the board yet/.test(message),
        ),
      ).toBe(true);
      expect(
        reporter.warnings.some((message) => message.includes(optional)),
      ).toBe(false);
    }
    // The view still got its columns.
    expect(
      calls.some(
        (args) =>
          typeof args[3] === "string" &&
          args[3].includes("updateProjectV2View"),
      ),
    ).toBe(true);
  });

  test("--prune-views implies the view path without --init, and stays read-only without --apply", () => {
    const { runGh, calls } = scriptedGh(
      viewRules([
        viewNode({ id: "VIEW_BACKLOG", name: DECLARED }),
        viewNode({ id: "VIEW_BOARD", name: "Board", layout: "BOARD_LAYOUT" }),
      ]),
    );
    const reporter = createFakeReporter();

    const outcome = runProjectSync({
      runGh,
      reporter,
      apply: false,
      init: false,
      pruneViews: true,
      readDoc: makeReadDoc(),
    });

    expect(outcome.ok).toBe(true);
    expect(deleteViewCalls(calls)).toHaveLength(0);
    expect(calls.every((args) => !isMutatingProjectCall(args))).toBe(true);
    expect(
      reporter.infos.some((message) =>
        /Would DELETE undeclared view/.test(message),
      ),
    ).toBe(true);
  });

  test("a view missing from the post-update re-read is reported as vanished, not as a cleared sort", () => {
    // Distinct failure, distinct message: telling the maintainer to re-apply a
    // sort on a view that no longer exists is not actionable.
    let listCount = 0;
    const vanishingRule: GhRule = {
      match: (a) =>
        a[0] === "api" &&
        a[1] === "graphql" &&
        typeof a[3] === "string" &&
        a[3].includes("views(first: 20)"),
      respond: () => {
        listCount += 1;
        // First read: present, with a sort. After the update: gone entirely.
        const nodes =
          listCount === 1
            ? [
                viewNode({
                  id: "VIEW_BACKLOG",
                  name: DECLARED,
                  sort: [{ field: "Priority", direction: "ASC" }],
                }),
              ]
            : [viewNode({ id: "VIEW_OTHER", name: DECLARED })];
        return JSON.stringify({ data: { node: { views: { nodes } } } });
      },
    };
    const { runGh } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      fullFieldListRule(),
      projectViewRule("PROJECT_ID"),
      vanishingRule,
      createViewGraphqlRule(),
      deleteViewGraphqlRule(),
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
    const warning = required(
      reporter.warnings.find((message) => /was not found when/.test(message)),
      "vanished-view warning",
    );
    expect(warning).toContain("VIEW_BACKLOG");
    expect(warning).toContain("Priority ASC");
    // Must NOT claim the sort was cleared — that is a different diagnosis.
    expect(
      reporter.warnings.some((message) => /lost its sort order/.test(message)),
    ).toBe(false);
  });

  test("an existing view's sort is captured before the column update and a loss is warned about, not silently swallowed", () => {
    // updateProjectV2View with configuration.visibleFieldIds may or may not
    // preserve sortByFields — the schema says only that sort is not an INPUT.
    // Sort is readable but not writable, so a loss needs a manual fix and must
    // never be reported as success.
    let listCount = 0;
    const sortLosingRule: GhRule = {
      match: (a) =>
        a[0] === "api" &&
        a[1] === "graphql" &&
        typeof a[3] === "string" &&
        a[3].includes("views(first: 20)"),
      respond: () => {
        listCount += 1;
        const nodes = [
          viewNode({
            id: "VIEW_BACKLOG",
            name: DECLARED,
            // First read: sorted. Every read after the update: sort gone.
            sort:
              listCount === 1
                ? [
                    { field: "Priority", direction: "ASC" },
                    { field: "Created", direction: "ASC" },
                  ]
                : [],
          }),
        ];
        return JSON.stringify({ data: { node: { views: { nodes } } } });
      },
    };
    const { runGh } = scriptedGh([
      projectListRule([{ number: 7, title: HUB_PROJECT_TITLE }]),
      fullFieldListRule(),
      projectViewRule("PROJECT_ID"),
      sortLosingRule,
      createViewGraphqlRule(),
      deleteViewGraphqlRule(),
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
    const warning = required(
      reporter.warnings.find((message) => /lost its sort order/.test(message)),
      "sort-loss warning",
    );
    // The captured names AND directions, so the manual fix is spelled out.
    expect(warning).toContain("Priority ASC");
    expect(warning).toContain("Created ASC");
    expect(warning).toMatch(/NOT writable/);
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
