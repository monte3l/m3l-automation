import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  WARN_THRESHOLD_PERCENT,
  HIGH_THRESHOLD_PERCENT,
  resolveUsedPercentage,
  zoneForPercentage,
  formatContextSegment,
  describeContextLocation,
  buildCompactSuggestion,
  renderStatusLine,
} from "../../.claude/hooks/statusline-context-pressure.mjs";

describe("thresholds", () => {
  test("WARN_THRESHOLD_PERCENT is 70", () => {
    expect(WARN_THRESHOLD_PERCENT).toBe(70);
  });

  test("HIGH_THRESHOLD_PERCENT is 90", () => {
    expect(HIGH_THRESHOLD_PERCENT).toBe(90);
  });
});

describe("resolveUsedPercentage", () => {
  test("returns the rounded percentage for a normal payload", () => {
    expect(
      resolveUsedPercentage({ context_window: { used_percentage: 42 } }),
    ).toBe(42);
  });

  test("rounds a fractional percentage", () => {
    expect(
      resolveUsedPercentage({ context_window: { used_percentage: 81.6 } }),
    ).toBe(82);
  });

  test("returns null when used_percentage is missing", () => {
    expect(resolveUsedPercentage({ context_window: {} })).toBeNull();
  });

  test("returns null when used_percentage is null", () => {
    expect(
      resolveUsedPercentage({ context_window: { used_percentage: null } }),
    ).toBeNull();
  });

  test("returns null when context_window is missing entirely", () => {
    expect(resolveUsedPercentage({})).toBeNull();
  });

  test.each([
    ["null", null],
    ["a string", "not an object"],
    ["undefined", undefined],
  ])("returns null for a non-object payload: %s", (_description, payload) => {
    expect(resolveUsedPercentage(payload)).toBeNull();
  });
});

describe("zoneForPercentage", () => {
  test("returns 'unknown' for null", () => {
    expect(zoneForPercentage(null)).toBe("unknown");
  });

  test.each([
    [0, "ok"],
    [69, "ok"],
    [70, "warn"],
    [89, "warn"],
    [90, "high"],
    [100, "high"],
  ])("returns %s -> %s at the boundary", (pct, zone) => {
    expect(zoneForPercentage(pct)).toBe(zone);
  });
});

describe("formatContextSegment", () => {
  test("renders 'ctx --%' with no icon for an unknown zone", () => {
    const result = formatContextSegment({});

    expect(result).toContain("ctx --%");
    expect(result).not.toContain("⚠");
  });

  test("renders the percentage with no icon for the ok zone", () => {
    const result = formatContextSegment({
      context_window: { used_percentage: 42 },
    });

    expect(result).toContain("ctx 42%");
    expect(result).not.toContain("⚠");
  });

  test("renders the percentage with a single warning icon for the warn zone", () => {
    const result = formatContextSegment({
      context_window: { used_percentage: 75 },
    });

    expect(result).toContain("ctx 75%");
    expect(result).toContain("⚠");
    expect(result).not.toContain("⚠⚠");
  });

  test("renders the percentage with a double warning icon for the high zone", () => {
    const result = formatContextSegment({
      context_window: { used_percentage: 95 },
    });

    expect(result).toContain("ctx 95%");
    expect(result).toContain("⚠⚠");
  });
});

describe("describeContextLocation", () => {
  test("joins PR and worktree with ' on ' when both present", () => {
    expect(
      describeContextLocation({
        pr: { number: 12 },
        workspace: { git_worktree: "statusline-context-pressure" },
      }),
    ).toBe('PR #12 on worktree "statusline-context-pressure"');
  });

  test("returns only the PR clause when only pr.number is present", () => {
    expect(describeContextLocation({ pr: { number: 12 } })).toBe("PR #12");
  });

  test("returns only the worktree clause when only workspace.git_worktree is present", () => {
    expect(
      describeContextLocation({ workspace: { git_worktree: "foo" } }),
    ).toBe('worktree "foo"');
  });

  test("returns null when neither is present", () => {
    expect(describeContextLocation({})).toBeNull();
  });

  test.each([
    ["null", null],
    ["a string", "not an object"],
    ["undefined", undefined],
  ])("returns null for a non-object payload: %s", (_description, payload) => {
    expect(describeContextLocation(payload)).toBeNull();
  });
});

describe("buildCompactSuggestion", () => {
  test("returns a suggestion including the location when the zone is high and both PR and worktree are present", () => {
    const result = buildCompactSuggestion({
      context_window: { used_percentage: 95 },
      pr: { number: 12 },
      workspace: { git_worktree: "statusline-context-pressure" },
    });

    expect(result).not.toBeNull();
    expect(result?.startsWith("/compact preserve ")).toBe(true);
    expect(result).toContain(
      'PR #12 on worktree "statusline-context-pressure"',
    );
    expect(
      result?.endsWith(
        "the failing gate's exact error text, and the current plan/ADR step",
      ),
    ).toBe(true);
  });

  test("returns the fixed suffix only (no dangling comma/prefix) when high but neither PR nor worktree is present", () => {
    const result = buildCompactSuggestion({
      context_window: { used_percentage: 95 },
    });

    expect(result).toBe(
      "/compact preserve the failing gate's exact error text, and the current plan/ADR step",
    );
  });

  test.each([
    ["ok zone (69%)", { context_window: { used_percentage: 69 } }],
    ["warn zone (89%)", { context_window: { used_percentage: 89 } }],
    ["unknown zone (no context_window)", {}],
  ])(
    "returns null for a non-high zone: %s, even with a PR/worktree present",
    (_description, contextFields) => {
      const payload = {
        ...contextFields,
        pr: { number: 12 },
        workspace: { git_worktree: "foo" },
      };

      expect(buildCompactSuggestion(payload)).toBeNull();
    },
  );
});

describe("renderStatusLine", () => {
  test("combines the segment and the suggestion with an arrow when a suggestion exists", () => {
    const payload = {
      context_window: { used_percentage: 95 },
      pr: { number: 12 },
    };

    const result = renderStatusLine(payload);

    expect(result).toContain("ctx 95%");
    expect(result).toContain(" → /compact preserve ");
    expect(result).toContain("PR #12");
  });

  test("returns only the segment when there is no suggestion", () => {
    const payload = { context_window: { used_percentage: 42 } };

    const result = renderStatusLine(payload);

    expect(result).toContain("ctx 42%");
    expect(result).not.toContain("→");
  });
});

describe("CLI entry (real child process)", () => {
  const scriptPath = fileURLToPath(
    new URL(
      "../../.claude/hooks/statusline-context-pressure.mjs",
      import.meta.url,
    ),
  );
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

  test("reads a JSON payload from stdin, renders it, and writes to stdout", () => {
    const stdout = execFileSync("node", [scriptPath], {
      input: JSON.stringify({
        context_window: { used_percentage: 42 },
      }),
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(stdout).toContain("ctx 42%");
  });

  test("falls back to 'ctx --%' and exits 0 on malformed JSON stdin", () => {
    const stdout = execFileSync("node", [scriptPath], {
      input: "{ this is not json",
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(stdout).toContain("ctx --%");
  });
});
