import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
  GREEN,
  YELLOW,
  RED,
  RESET,
  BLUE,
  CYAN,
  BRIGHT_WHITE,
  BRIGHT_RED,
  BRIGHT_BLUE,
  BRIGHT_CYAN,
  BRIGHT_GREEN,
  DIM,
  SEGMENT_JOIN,
  formatContextBar,
  formatModelSegment,
  formatEffortSegment,
  formatTokenCount,
  formatSessionUsage,
  formatDuration,
  formatResetCountdown,
  formatWeeklyReset,
  formatCacheWidget,
  parseHeadRef,
  parseGitdirPointer,
  resolveBranch,
  formatBranch,
  formatWorktreeAndPr,
  formatAgentSegment,
  formatOriginRepo,
  formatFreeMemory,
  buildLine1,
  buildLine2,
  buildLine3,
  buildLine4,
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

  test("clamps a used_percentage above 100 down to 100", () => {
    expect(
      resolveUsedPercentage({ context_window: { used_percentage: 105 } }),
    ).toBe(100);
  });

  test("clamps a negative used_percentage up to 0", () => {
    expect(
      resolveUsedPercentage({ context_window: { used_percentage: -12 } }),
    ).toBe(0);
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

describe("SEGMENT_JOIN", () => {
  test("is two spaces", () => {
    expect(SEGMENT_JOIN).toBe("  ");
  });
});

describe("formatContextBar", () => {
  test("renders a partially-filled green bar in the ok zone", () => {
    const result = formatContextBar({
      context_window: { used_percentage: 28 },
    });

    expect(result).not.toBeNull();
    expect(result).toContain(GREEN);
    expect(result).toContain("[▓▓▓░░░░░░░]");
  });

  test("renders a fully-filled red bar in the high zone", () => {
    const result = formatContextBar({
      context_window: { used_percentage: 95 },
    });

    expect(result).toContain(RED);
    expect(result).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });

  test("renders an empty green bar at 0%", () => {
    const result = formatContextBar({ context_window: { used_percentage: 0 } });

    expect(result).toContain(GREEN);
    expect(result).toContain("[░░░░░░░░░░]");
  });

  test("renders a yellow bar in the warn zone", () => {
    const result = formatContextBar({
      context_window: { used_percentage: 75 },
    });

    expect(result).toContain(YELLOW);
  });

  test("returns null when the used percentage is unknown", () => {
    expect(formatContextBar({})).toBeNull();
  });

  test("clamps an above-100 used_percentage to a fully-filled bar instead of throwing", () => {
    let result: string | null = null;

    expect(() => {
      result = formatContextBar({
        context_window: { used_percentage: 105 },
      });
    }).not.toThrow();
    expect(result).toContain("[▓▓▓▓▓▓▓▓▓▓]");
    expect(result).not.toContain("░");
  });

  test("clamps a negative used_percentage to a fully-empty bar instead of throwing", () => {
    let result: string | null = null;

    expect(() => {
      result = formatContextBar({
        context_window: { used_percentage: -12 },
      });
    }).not.toThrow();
    expect(result).toContain("[░░░░░░░░░░]");
    expect(result).not.toContain("▓");
  });
});

describe("formatModelSegment", () => {
  test("renders the model display name in blue", () => {
    const result = formatModelSegment({ model: { display_name: "Sonnet 5" } });

    expect(result).toContain(BLUE);
    expect(result).toContain("Sonnet 5");
  });

  test("returns null when display_name is absent, empty, or non-string", () => {
    expect(formatModelSegment({})).toBeNull();
    expect(formatModelSegment({ model: { display_name: "" } })).toBeNull();
    expect(formatModelSegment({ model: { display_name: 5 } })).toBeNull();
  });
});

describe("formatEffortSegment", () => {
  test("renders the effort level in cyan", () => {
    const result = formatEffortSegment({ effort: { level: "high" } });

    expect(result).toContain(CYAN);
    expect(result).toContain("high");
  });

  test("returns null when level is absent, empty, or non-string", () => {
    expect(formatEffortSegment({})).toBeNull();
    expect(formatEffortSegment({ effort: { level: "" } })).toBeNull();
  });
});

describe("formatTokenCount", () => {
  test.each([
    [500, "500"],
    [999, "999"],
    [1000, "1k"],
    [1200, "1.2k"],
    [15500, "15.5k"],
    [45000, "45k"],
  ])("formats %i tokens as %s", (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });

  test("does not pad a whole-thousand count with a trailing .0", () => {
    expect(formatTokenCount(45000)).not.toBe("45.0k");
  });
});

describe("formatSessionUsage", () => {
  test("joins cost and token counts with a middot when both are present", () => {
    const result = formatSessionUsage({
      cost: { total_cost_usd: 0.01234 },
      context_window: { total_input_tokens: 15500, total_output_tokens: 1200 },
    });

    expect(result).toContain(BRIGHT_WHITE);
    expect(result).toContain("$0.01");
    expect(result).toContain("15.5k↑ 1.2k↓");
    expect(result).toContain(" · ");
  });

  test("renders only the cost part, with no middot, when tokens are absent", () => {
    const result = formatSessionUsage({ cost: { total_cost_usd: 2 } });

    expect(result).toContain("$2.00");
    expect(result).not.toContain("·");
  });

  test("returns null when neither cost nor a complete token pair is present", () => {
    expect(formatSessionUsage({})).toBeNull();
    expect(
      formatSessionUsage({
        context_window: { total_input_tokens: 100 },
      }),
    ).toBeNull();
  });

  test("omits the token-count clause (and returns null overall) when total_input_tokens is NaN", () => {
    const result = formatSessionUsage({
      context_window: { total_input_tokens: NaN, total_output_tokens: 1200 },
    });

    expect(result?.includes("NaN")).toBeFalsy();
    expect(result).toBeNull();
  });

  test("omits the token-count clause (and returns null overall) when total_output_tokens is Infinity", () => {
    const result = formatSessionUsage({
      context_window: {
        total_input_tokens: 1200,
        total_output_tokens: Infinity,
      },
    });

    expect(result?.includes("Infinity")).toBeFalsy();
    expect(result).toBeNull();
  });
});

describe("formatDuration", () => {
  test.each([
    [3600, "1h00m"],
    [1500, "25m"],
    [0, "now"],
    [-5, "now"],
  ])("formats %i seconds as %s", (deltaSec, expected) => {
    expect(formatDuration(deltaSec)).toBe(expected);
  });
});

describe("formatResetCountdown", () => {
  const now = 1_700_000_000_000;

  test("renders an hour+minute countdown in bright red", () => {
    const result = formatResetCountdown(
      { rate_limits: { five_hour: { resets_at: now / 1000 + 3600 } } },
      { now },
    );

    expect(result).toContain(BRIGHT_RED);
    expect(result).toContain("reset 1h00m");
  });

  test("renders a minute-only countdown", () => {
    const result = formatResetCountdown(
      { rate_limits: { five_hour: { resets_at: now / 1000 + 1500 } } },
      { now },
    );

    expect(result).toContain("reset 25m");
  });

  test("renders 'now' when the reset time is in the past", () => {
    const result = formatResetCountdown(
      { rate_limits: { five_hour: { resets_at: now / 1000 - 100 } } },
      { now },
    );

    expect(result).toContain("reset now");
  });

  test("returns null when resets_at is absent", () => {
    expect(formatResetCountdown({}, { now })).toBeNull();
  });
});

describe("formatWeeklyReset", () => {
  test("renders the UTC month-day and time in bright blue", () => {
    const resetsAtSec = 1_700_003_661;
    const date = new Date(resetsAtSec * 1000);
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const min = String(date.getUTCMinutes()).padStart(2, "0");
    const expected = `week ${mm}-${dd} ${hh}:${min}Z`;

    const result = formatWeeklyReset({
      rate_limits: { seven_day: { resets_at: resetsAtSec } },
    });

    expect(result).toContain(BRIGHT_BLUE);
    expect(result).toContain(expected);
  });

  test("returns null when resets_at is absent", () => {
    expect(formatWeeklyReset({})).toBeNull();
  });
});

describe("formatCacheWidget", () => {
  test("renders a percentage when warm with a numeric hit_ratio", () => {
    const result = formatCacheWidget({
      prompt_cache: { warm: true, hit_ratio: 0.87 },
    });

    expect(result).toContain(GREEN);
    expect(result).toContain("cache 87%");
  });

  test("renders 'cache warm' when warm but hit_ratio is not a number", () => {
    expect(formatCacheWidget({ prompt_cache: { warm: true } })).toBe(
      `${GREEN}cache warm${RESET}`,
    );
  });

  test("renders a token estimate when cold with a numeric recache_tokens_if_cold", () => {
    const result = formatCacheWidget({
      prompt_cache: { warm: false, recache_tokens_if_cold: 1200 },
    });

    expect(result).toContain(YELLOW);
    expect(result).toContain("cache cold · 1.2k");
  });

  test("renders 'cache cold' when cold but recache_tokens_if_cold is not a number", () => {
    expect(formatCacheWidget({ prompt_cache: { warm: false } })).toBe(
      `${YELLOW}cache cold${RESET}`,
    );
  });

  test("returns null when prompt_cache is absent or not an object", () => {
    expect(formatCacheWidget({})).toBeNull();
    expect(formatCacheWidget({ prompt_cache: "warm" })).toBeNull();
  });

  test("returns null when warm is not a boolean", () => {
    expect(formatCacheWidget({ prompt_cache: { warm: "yes" } })).toBeNull();
  });

  test("falls back to plain 'cache warm' (no percentage, no 'NaN') when warm with a NaN hit_ratio", () => {
    // Number.isFinite(NaN) is false, so this takes the same
    // not-a-finite-number fallback branch as an absent hit_ratio.
    expect(
      formatCacheWidget({ prompt_cache: { warm: true, hit_ratio: NaN } }),
    ).toBe(`${GREEN}cache warm${RESET}`);
  });

  test("falls back to plain 'cache cold' (no token estimate, no 'Infinity') when cold with an Infinity recache_tokens_if_cold", () => {
    // Number.isFinite(Infinity) is false, so this takes the same
    // not-a-finite-number fallback branch as an absent recache_tokens_if_cold.
    expect(
      formatCacheWidget({
        prompt_cache: { warm: false, recache_tokens_if_cold: Infinity },
      }),
    ).toBe(`${YELLOW}cache cold${RESET}`);
  });
});

describe("parseHeadRef", () => {
  test("extracts the branch name from a ref line", () => {
    expect(parseHeadRef("ref: refs/heads/feat/foo\n")).toBe("feat/foo");
  });

  test("returns null for a detached HEAD (raw SHA)", () => {
    expect(
      parseHeadRef("3f2504e04f8964efd25f5f1efd9b0f7e6f2f9c1a\n"),
    ).toBeNull();
  });

  test("returns null for non-string input", () => {
    expect(parseHeadRef(null)).toBeNull();
    expect(parseHeadRef(undefined)).toBeNull();
  });
});

describe("parseGitdirPointer", () => {
  test("extracts the gitdir path from a pointer file", () => {
    expect(parseGitdirPointer("gitdir: /some/worktrees/path\n")).toBe(
      "/some/worktrees/path",
    );
  });

  test("returns null when the content does not match the gitdir pattern", () => {
    expect(parseGitdirPointer("not a pointer file")).toBeNull();
  });

  test("returns null for non-string input", () => {
    expect(parseGitdirPointer(null)).toBeNull();
  });

  test("returns an empty string (not null) for a gitdir line whose target is only whitespace", () => {
    // Root cause the resolveBranch "empty pointer" fix guards against: a
    // trimmed-to-empty pointer must be distinguishable from "no pointer
    // matched at all" (null) so the caller can short-circuit instead of
    // falling through to join(dir, "") -> dir.
    expect(parseGitdirPointer("gitdir: \n")).toBe("");
  });
});

describe("resolveBranch", () => {
  test("resolves the branch name from a plain .git directory", () => {
    const startDir = "/workspace/project";
    const readFile = (path: string): string | null =>
      path === join(startDir, ".git", "HEAD")
        ? "ref: refs/heads/feat/foo\n"
        : null;

    expect(resolveBranch(readFile, startDir)).toBe("feat/foo");
  });

  test("returns null for a detached HEAD", () => {
    const startDir = "/workspace/project";
    const readFile = (path: string): string | null =>
      path === join(startDir, ".git", "HEAD")
        ? "3f2504e04f8964efd25f5f1efd9b0f7e6f2f9c1a\n"
        : null;

    expect(resolveBranch(readFile, startDir)).toBeNull();
  });

  test("resolves through a linked-worktree gitdir pointer file", () => {
    const startDir = "/workspace/project";
    const worktreeGitDir = "/some/worktrees/path";
    const readFile = (path: string): string | null => {
      if (path === join(startDir, ".git", "HEAD")) return null;
      if (path === join(startDir, ".git")) return `gitdir: ${worktreeGitDir}\n`;
      if (path === join(worktreeGitDir, "HEAD"))
        return "ref: refs/heads/feat/bar\n";
      return null;
    };

    expect(resolveBranch(readFile, startDir)).toBe("feat/bar");
  });

  test("returns null when nothing is found up to the filesystem root", () => {
    const readFile = (): string | null => null;

    expect(resolveBranch(readFile, "/workspace/project")).toBeNull();
  });

  test("stops at the nearest .git and does not walk up to an ancestor repo", () => {
    const startDir = "/a/b/c";
    const parentDir = "/a/b";
    const readFile = (path: string): string | null => {
      if (path === join(startDir, ".git", "HEAD")) return null;
      if (path === join(startDir, ".git")) return "gitdir: /some/other/path\n";
      if (path === join("/some/other/path", "HEAD")) return null;
      // An ancestor repo that WOULD resolve if the walk continued past the
      // nearer .git file found at startDir -- must never be reached.
      if (path === join(parentDir, ".git", "HEAD")) {
        return "ref: refs/heads/should-not-be-found\n";
      }
      return null;
    };

    expect(resolveBranch(readFile, startDir)).toBeNull();
  });

  test("returns null for a non-string or empty startDir", () => {
    const readFile = (): string | null => null;

    expect(resolveBranch(readFile, "")).toBeNull();
    expect(resolveBranch(readFile, null)).toBeNull();
  });

  test("returns null for a whitespace-only gitdir pointer, and does not fall through to a coincidentally-present HEAD at the worktree root", () => {
    const startDir = "/workspace/project";
    const readFile = (path: string): string | null => {
      if (path === join(startDir, ".git", "HEAD")) return null;
      if (path === join(startDir, ".git")) return "gitdir: \n";
      // The OLD buggy code fell through to reading this file when the
      // pointer target trimmed to empty; it must never be reached once the
      // empty-pointer short-circuit is in place.
      if (path === join(startDir, "HEAD")) {
        return "ref: refs/heads/should-not-be-picked-up\n";
      }
      return null;
    };

    expect(resolveBranch(readFile, startDir)).toBeNull();
  });
});

describe("formatBranch", () => {
  test("returns null for null or empty branch names", () => {
    expect(formatBranch(null)).toBeNull();
    expect(formatBranch("")).toBeNull();
  });

  test("renders a warning-colored 'main' segment for the main branch", () => {
    const result = formatBranch("main");

    expect(result).toContain(RED);
    expect(result).toContain("⚠ main");
  });

  test("renders any other branch name in green with no warning icon", () => {
    const result = formatBranch("feat/foo");

    expect(result).toContain(GREEN);
    expect(result).toContain("feat/foo");
    expect(result).not.toContain("⚠");
  });
});

describe("formatWorktreeAndPr", () => {
  test("returns null for a non-object payload", () => {
    expect(formatWorktreeAndPr(null)).toBeNull();
    expect(formatWorktreeAndPr("not an object")).toBeNull();
  });

  test("returns null when neither worktree nor pr is present", () => {
    expect(formatWorktreeAndPr({})).toBeNull();
  });

  test("renders only the worktree clause when only git_worktree is present", () => {
    const result = formatWorktreeAndPr({ workspace: { git_worktree: "foo" } });

    expect(result).toContain('worktree "foo"');
    expect(result).not.toContain("PR #");
  });

  test.each([
    ["approved", GREEN],
    ["changes_requested", RED],
    ["draft", DIM],
    ["pending", YELLOW],
  ])("colors the PR clause by review_state %s", (reviewState, color) => {
    const result = formatWorktreeAndPr({
      pr: { number: 12, review_state: reviewState },
    });

    expect(result).toContain(color);
    expect(result).toContain("PR #12");
  });

  test("still renders the PR clause for an unknown or absent review_state", () => {
    const result = formatWorktreeAndPr({ pr: { number: 12 } });

    expect(result).toContain("PR #12");
  });

  test("wraps the PR label in an OSC 8 hyperlink when pr.url is present", () => {
    const result = formatWorktreeAndPr({
      pr: { number: 12, url: "https://example.test/pr/12" },
    });

    expect(result).toContain("\x1b]8;;");
    expect(result).toContain("https://example.test/pr/12");
    expect(result).toContain("PR #12");
  });

  test("does not include an OSC 8 hyperlink when pr.url is absent", () => {
    const result = formatWorktreeAndPr({ pr: { number: 12 } });

    expect(result).not.toContain("\x1b]8;;");
  });

  test("joins the worktree and PR clauses with a middot when both are present", () => {
    const result = formatWorktreeAndPr({
      workspace: { git_worktree: "foo" },
      pr: { number: 12 },
    });

    expect(result).toContain('worktree "foo"');
    expect(result).toContain("PR #12");
    expect(result).toContain(" · ");
  });
});

describe("formatAgentSegment", () => {
  test("renders the agent name dimmed with an arrow prefix", () => {
    const result = formatAgentSegment({ agent: { name: "code-implementer" } });

    expect(result).toContain(DIM);
    expect(result).toContain("↳ code-implementer");
  });

  test("returns null when agent.name is absent or empty", () => {
    expect(formatAgentSegment({})).toBeNull();
    expect(formatAgentSegment({ agent: { name: "" } })).toBeNull();
  });
});

describe("formatOriginRepo", () => {
  test("renders owner/name in bright cyan", () => {
    const result = formatOriginRepo({
      workspace: { repo: { owner: "monte3l", name: "m3l-automation" } },
    });

    expect(result).toContain(BRIGHT_CYAN);
    expect(result).toContain("monte3l/m3l-automation");
  });

  test("returns null when owner or name is missing", () => {
    expect(
      formatOriginRepo({ workspace: { repo: { owner: "monte3l" } } }),
    ).toBeNull();
    expect(formatOriginRepo({ workspace: {} })).toBeNull();
    expect(formatOriginRepo({})).toBeNull();
  });
});

describe("formatFreeMemory", () => {
  test("renders the free-memory percentage in bright green", () => {
    const result = formatFreeMemory({
      freemem: 2_000_000_000,
      totalmem: 8_000_000_000,
    });

    expect(result).toContain(BRIGHT_GREEN);
    expect(result).toContain("mem 25%free");
  });

  test("returns null when totalmem is zero or fields are missing", () => {
    expect(formatFreeMemory({ freemem: 100, totalmem: 0 })).toBeNull();
    expect(formatFreeMemory({})).toBeNull();
  });
});

describe("buildLine1", () => {
  test("joins model, effort, and the context bar+segment with the segment join", () => {
    const payload = {
      model: { display_name: "Sonnet" },
      effort: { level: "high" },
      context_window: { used_percentage: 42 },
    };

    const result = buildLine1(payload);

    expect(result).not.toBeNull();
    expect(result).toContain("Sonnet");
    expect(result).toContain("high");
    expect(result).toContain("ctx 42%");
    expect((result ?? "").split(SEGMENT_JOIN).length).toBeGreaterThanOrEqual(3);
  });

  test("still renders the context segment when model and effort are absent", () => {
    expect(buildLine1({})).toContain("ctx --%");
  });
});

describe("buildLine2", () => {
  const now = 1_700_000_000_000;

  test("joins session usage, reset countdown, weekly reset, and cache widgets", () => {
    const payload = {
      cost: { total_cost_usd: 1 },
      rate_limits: {
        five_hour: { resets_at: now / 1000 + 3600 },
        seven_day: { resets_at: now / 1000 + 7200 },
      },
      prompt_cache: { warm: true },
    };

    const result = buildLine2(payload, { now });

    expect(result).not.toBeNull();
    expect(result).toContain("$1.00");
    expect(result).toContain("reset 1h00m");
    expect(result).toContain("week ");
    expect(result).toContain("cache warm");
  });

  test("returns null when every constituent widget is absent", () => {
    expect(buildLine2({}, {})).toBeNull();
  });
});

describe("buildLine3", () => {
  test("joins branch, worktree/PR, agent, origin repo, and free memory", () => {
    const payload = {
      workspace: {
        git_worktree: "foo",
        repo: { owner: "monte3l", name: "m3l-automation" },
      },
      pr: { number: 12 },
      agent: { name: "code-implementer" },
    };
    const env = { branch: "feat/foo", freemem: 1, totalmem: 4 };

    const result = buildLine3(payload, env);

    expect(result).not.toBeNull();
    expect(result).toContain("feat/foo");
    expect(result).toContain("PR #12");
    expect(result).toContain("code-implementer");
    expect(result).toContain("monte3l/m3l-automation");
    expect(result).toContain("mem 25%free");
  });

  test("returns null when every constituent widget is absent", () => {
    expect(buildLine3({}, {})).toBeNull();
  });
});

describe("buildLine4", () => {
  test("returns exactly the compact suggestion", () => {
    const payload = { context_window: { used_percentage: 95 } };

    expect(buildLine4(payload)).toBe(buildCompactSuggestion(payload));
  });

  test("returns null when there is no compact suggestion", () => {
    expect(buildLine4({ context_window: { used_percentage: 42 } })).toBeNull();
  });
});

describe("renderStatusLine", () => {
  test("works with no env arg and puts the compact suggestion on its own line, not joined with an arrow", () => {
    const payload = {
      context_window: { used_percentage: 95 },
      pr: { number: 12 },
    };

    const result = renderStatusLine(payload);
    const lines = result.split("\n");

    expect(lines.some((line) => line.includes("ctx 95%"))).toBe(true);
    expect(lines).toContain(buildCompactSuggestion(payload));
    expect(result).not.toContain(" → ");
  });

  test("renders exactly one line for a minimal payload with no widgets beyond the context segment", () => {
    const payload = { context_window: { used_percentage: 42 } };

    const result = renderStatusLine(payload);

    expect(result).toContain("ctx 42%");
    expect(result.split("\n")).toHaveLength(1);
    expect(result.startsWith("\n")).toBe(false);
    expect(result.endsWith("\n")).toBe(false);
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
