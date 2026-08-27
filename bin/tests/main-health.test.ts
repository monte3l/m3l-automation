import { describe, expect, test } from "vitest";
import {
  MAIN_HEALTH_ISSUE_TITLE,
  WATCHED_WORKFLOWS,
  buildFailureComment,
  buildFailureIssueBody,
  buildPartialResolutionComment,
  buildResolutionComment,
  decideSuccessAction,
  findTrackingIssue,
  otherWatchedWorkflow,
} from "../lib/main-health.mjs";

const OCCURRENCE = {
  workflow: "CI",
  runUrl: "https://github.com/monte3l/m3l-automation/actions/runs/123",
  sha: "abc1234",
  occurredAt: "2026-08-27T10:00:00.000Z",
};

describe("MAIN_HEALTH_ISSUE_TITLE", () => {
  test("is the fixed, emoji-prefixed tracking issue title", () => {
    expect(MAIN_HEALTH_ISSUE_TITLE).toBe("🔴 main is red");
  });
});

describe("WATCHED_WORKFLOWS", () => {
  test("is exactly CI and Pages, in that order", () => {
    expect(WATCHED_WORKFLOWS).toEqual(["CI", "Pages"]);
  });
});

describe("otherWatchedWorkflow", () => {
  test('returns "Pages" for "CI"', () => {
    expect(otherWatchedWorkflow("CI")).toBe("Pages");
  });

  test('returns "CI" for "Pages"', () => {
    expect(otherWatchedWorkflow("Pages")).toBe("CI");
  });

  test("throws for a workflow name that is not exactly one of the watched workflows", () => {
    expect(() => otherWatchedWorkflow("Deploy")).toThrow(
      '"Deploy" is not exactly one of the watched workflows (CI, Pages).',
    );
  });
});

describe("decideSuccessAction", () => {
  test('returns "close" when the other workflow has no run history (null)', () => {
    expect(decideSuccessAction(null)).toBe("close");
  });

  test('returns "close" when the other workflow\'s latest conclusion is "success"', () => {
    expect(decideSuccessAction("success")).toBe("close");
  });

  test('returns "stay-open" when the other workflow\'s latest conclusion is "failure"', () => {
    expect(decideSuccessAction("failure")).toBe("stay-open");
  });

  test('returns "stay-open" for a non-success, non-"failure" conclusion, proving it is not special-casing exactly "failure"', () => {
    expect(decideSuccessAction("cancelled")).toBe("stay-open");
  });
});

describe("buildFailureIssueBody", () => {
  test("includes the workflow, sha, run URL, and occurred-at timestamp", () => {
    const body = buildFailureIssueBody(OCCURRENCE);
    expect(body).toContain(OCCURRENCE.workflow);
    expect(body).toContain(OCCURRENCE.sha);
    expect(body).toContain(OCCURRENCE.runUrl);
    expect(body).toContain(OCCURRENCE.occurredAt);
  });

  test("warns against editing the title and points at the owning workflow file", () => {
    const body = buildFailureIssueBody(OCCURRENCE);
    expect(body).toContain(".github/workflows/main-health.yml");
    expect(body).toContain("do not edit the title");
  });
});

describe("buildFailureComment", () => {
  test("includes the workflow, sha, run URL, and occurred-at timestamp", () => {
    const comment = buildFailureComment(OCCURRENCE);
    expect(comment).toContain(OCCURRENCE.workflow);
    expect(comment).toContain(OCCURRENCE.sha);
    expect(comment).toContain(OCCURRENCE.runUrl);
    expect(comment).toContain(OCCURRENCE.occurredAt);
  });

  test("omits the title-editing guidance the initial issue body carries", () => {
    const comment = buildFailureComment(OCCURRENCE);
    expect(comment).not.toContain("do not edit the title");
    expect(comment).not.toContain(".github/workflows/main-health.yml");
  });

  test("is shorter than the initial issue body, since it is a follow-up on an already-open issue", () => {
    const body = buildFailureIssueBody(OCCURRENCE);
    const comment = buildFailureComment(OCCURRENCE);
    expect(comment.length).toBeLessThan(body.length);
  });
});

describe("buildResolutionComment", () => {
  test("includes the workflow, sha, run URL, and occurred-at timestamp", () => {
    const comment = buildResolutionComment(OCCURRENCE);
    expect(comment).toContain(OCCURRENCE.workflow);
    expect(comment).toContain(OCCURRENCE.sha);
    expect(comment).toContain(OCCURRENCE.runUrl);
    expect(comment).toContain(OCCURRENCE.occurredAt);
  });

  test("reads as a resolution, not a failure", () => {
    const comment = buildResolutionComment(OCCURRENCE);
    expect(comment).toMatch(/passed/i);
    expect(comment).not.toContain("failed");
  });

  test("is distinct from both failure-path builders for the same occurrence", () => {
    const comment = buildResolutionComment(OCCURRENCE);
    expect(comment).not.toBe(buildFailureIssueBody(OCCURRENCE));
    expect(comment).not.toBe(buildFailureComment(OCCURRENCE));
  });
});

describe("buildPartialResolutionComment", () => {
  const PARTIAL_OCCURRENCE = { ...OCCURRENCE, other: "Pages" };

  test("includes the recovered workflow, the still-red other workflow, the run URL, and sha", () => {
    const comment = buildPartialResolutionComment(PARTIAL_OCCURRENCE);
    expect(comment).toContain(PARTIAL_OCCURRENCE.workflow);
    expect(comment).toContain(PARTIAL_OCCURRENCE.other);
    expect(comment).toContain(PARTIAL_OCCURRENCE.runUrl);
    expect(comment).toContain(PARTIAL_OCCURRENCE.sha);
  });

  test("reads as still-open, not as a close", () => {
    const comment = buildPartialResolutionComment(PARTIAL_OCCURRENCE);
    expect(comment).toMatch(/still red/i);
    expect(comment).toContain("leaving this open");
    expect(comment).not.toContain("closing");
  });

  test("is meaningfully distinct from buildResolutionComment for the same occurrence fields", () => {
    const partial = buildPartialResolutionComment(PARTIAL_OCCURRENCE);
    const resolution = buildResolutionComment(OCCURRENCE);
    expect(partial).not.toBe(resolution);
    expect(resolution).toContain("closing");
    expect(partial).not.toContain("closing");
    expect(resolution).not.toContain(PARTIAL_OCCURRENCE.other);
  });
});

describe("occurrence destructuring throws on a missing occurrence object", () => {
  test.each([
    ["buildFailureIssueBody", buildFailureIssueBody],
    ["buildFailureComment", buildFailureComment],
    ["buildResolutionComment", buildResolutionComment],
    ["buildPartialResolutionComment", buildPartialResolutionComment],
  ])("%s throws when called with null", (_name, builder) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the destructuring failure path with a deliberately invalid argument
    expect(() => builder(null as any)).toThrow(TypeError);
  });
});

describe("findTrackingIssue", () => {
  test("returns null for an empty issue list", () => {
    expect(findTrackingIssue([])).toBeNull();
  });

  test("returns null when no issue's title matches", () => {
    const issues = [
      { number: 1, title: "Some unrelated issue" },
      { number: 2, title: "Another one" },
    ];
    expect(findTrackingIssue(issues)).toBeNull();
  });

  test("returns the issue whose title exactly matches the tracking title", () => {
    const target = { number: 42, title: MAIN_HEALTH_ISSUE_TITLE };
    const issues = [{ number: 1, title: "Unrelated" }, target];
    expect(findTrackingIssue(issues)).toBe(target);
  });

  test.each([
    ["different emoji", "🟥 main is red"],
    ["different casing", "🔴 Main Is Red"],
    ["trailing whitespace", `${MAIN_HEALTH_ISSUE_TITLE} `],
    ["substring of the real title", "main is red"],
    ["superset of the real title", `${MAIN_HEALTH_ISSUE_TITLE} (duplicate)`],
  ])("does not match a near-miss title: %s", (_description, nearMissTitle) => {
    const issues = [{ number: 7, title: nearMissTitle }];
    expect(findTrackingIssue(issues)).toBeNull();
  });

  test("returns the first exact match deterministically when duplicates exist", () => {
    const first = { number: 1, title: MAIN_HEALTH_ISSUE_TITLE };
    const second = { number: 2, title: MAIN_HEALTH_ISSUE_TITLE };
    const result = findTrackingIssue([first, second]);
    expect(result).toBe(first);
  });
});
