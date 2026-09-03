import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { displayWidth } from "../../.claude/hooks/statusline-layout.mjs";
import {
  WARN_THRESHOLD_PERCENT,
  HIGH_THRESHOLD_PERCENT,
  resolveUsedPercentage,
  zoneForPercentage,
  GREEN,
  YELLOW,
  RED,
  CYAN,
  DIM,
  RESET,
  SEGMENT_SEPARATOR,
  PLACEHOLDER,
  GUTTER_WIDTH,
  CONTEXT_BAR_WIDTH,
  QUOTA_BAR_WIDTH,
  SESSION_NAME_PATTERN,
  SESSION_NAME_MAX_LENGTH,
  formatSessionNameSegment,
  formatBranchSegment,
  formatWorktreeSegment,
  formatPrSegment,
  formatAgentSegment,
  formatOriginRepoSegment,
  formatModelSegment,
  formatEffortSegment,
  formatThinkingSegment,
  formatFastModeSegment,
  formatOutputStyleSegment,
  formatVimModeSegment,
  formatTokenCount,
  formatContextBarSegment,
  formatContextPercentSegment,
  formatContextDenominatorSegment,
  formatContextHeadroomSegment,
  formatDuration,
  formatFiveHourSegment,
  formatSevenDaySegment,
  formatSpendLimitSegment,
  formatCostSegment,
  formatDurationSegment,
  formatLinesChangedSegment,
  formatCacheSegment,
  parseHeadRef,
  parseGitdirPointer,
  resolveBranch,
  formatMemorySegment,
  buildSessionRow,
  buildModelRow,
  buildContextRow,
  buildQuotaRow,
  buildWorkRow,
  renderStatusLine,
} from "../../.claude/hooks/statusline-context-pressure.mjs";

// ---------------------------------------------------------------------------
// Shared helpers for the quota-bar segments (formatFiveHourSegment /
// formatSevenDaySegment / formatSpendLimitSegment). Mirrors the
// zone/fill formulas the contract documents for formatContextBarSegment,
// scaled to QUOTA_BAR_WIDTH.
// ---------------------------------------------------------------------------
function quotaBar(pct: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * QUOTA_BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(QUOTA_BAR_WIDTH - filled);
}

function zoneColor(pct: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  if (clamped >= HIGH_THRESHOLD_PERCENT) return RED;
  if (clamped >= WARN_THRESHOLD_PERCENT) return YELLOW;
  return GREEN;
}

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

  test("returns null when context_window is missing entirely", () => {
    expect(resolveUsedPercentage({})).toBeNull();
  });

  test("returns null when used_percentage is explicitly null (not just absent)", () => {
    expect(
      resolveUsedPercentage({ context_window: { used_percentage: null } }),
    ).toBeNull();
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

describe("layout constants", () => {
  test("SEGMENT_SEPARATOR is a dim middot", () => {
    expect(SEGMENT_SEPARATOR).toBe(`${DIM} · ${RESET}`);
  });

  test("PLACEHOLDER is a dim em dash", () => {
    expect(PLACEHOLDER).toBe(`${DIM}—${RESET}`);
  });

  test("GUTTER_WIDTH is 10", () => {
    expect(GUTTER_WIDTH).toBe(10);
  });

  test("CONTEXT_BAR_WIDTH is 20", () => {
    expect(CONTEXT_BAR_WIDTH).toBe(20);
  });

  test("QUOTA_BAR_WIDTH is 10", () => {
    expect(QUOTA_BAR_WIDTH).toBe(10);
  });
});

describe("formatSessionNameSegment", () => {
  test("renders a conforming <kind>-<slug> name in green, unmarked", () => {
    const result = formatSessionNameSegment({
      session_name: "feat-statusline-widgets",
    });

    expect(result).toEqual({
      id: "session_name",
      priority: 100,
      minWidth: 12,
      text: `${GREEN}feat-statusline-widgets${RESET}`,
    });
  });

  test("flags a non-conforming name (e.g. an AI-generated title) in yellow with a marker", () => {
    const result = formatSessionNameSegment({
      session_name: "Statusline context pressure security review",
    });

    expect(result).toEqual({
      id: "session_name",
      priority: 100,
      minWidth: 12,
      text: `${YELLOW}⚠ Statusline context pressure security review${RESET}`,
    });
  });

  test("flags a name over the length bound even when it otherwise matches the pattern", () => {
    const overLong = `feat-${"a".repeat(SESSION_NAME_MAX_LENGTH)}`;
    const result = formatSessionNameSegment({ session_name: overLong });

    expect(result?.text).toContain(YELLOW);
    expect(result?.text).toContain("⚠");
  });

  test("renders a dim 'unnamed' marker when absent, empty, or non-string -- never null", () => {
    const expected = {
      id: "session_name",
      priority: 100,
      minWidth: 12,
      text: `${DIM}unnamed${RESET}`,
    };

    expect(formatSessionNameSegment({})).toEqual(expected);
    expect(formatSessionNameSegment({ session_name: "" })).toEqual(expected);
    expect(formatSessionNameSegment({ session_name: 5 })).toEqual(expected);
    expect(formatSessionNameSegment(null)).toEqual(expected);
    expect(formatSessionNameSegment(undefined)).toEqual(expected);
    expect(formatSessionNameSegment("not an object")).toEqual(expected);
  });

  test("SESSION_NAME_PATTERN accepts every documented kind and rejects an undeclared one", () => {
    for (const kind of [
      "feat",
      "fix",
      "audit",
      "research",
      "docs",
      "review",
      "ci",
      "merge",
    ]) {
      expect(SESSION_NAME_PATTERN.test(`${kind}-example-slug`)).toBe(true);
    }
    expect(SESSION_NAME_PATTERN.test("wip-example-slug")).toBe(false);
  });
});

describe("formatBranchSegment", () => {
  test("returns null for null or empty branch names", () => {
    expect(formatBranchSegment(null)).toBeNull();
    expect(formatBranchSegment("")).toBeNull();
  });

  test("renders a warning-colored 'main' segment for the main branch", () => {
    expect(formatBranchSegment("main")).toEqual({
      id: "branch",
      priority: 95,
      minWidth: 6,
      text: `${RED}⚠ main${RESET}`,
    });
  });

  test("renders any other branch name with a leaf emoji and no ANSI wrap", () => {
    const result = formatBranchSegment("feat/x");

    expect(result).toEqual({
      id: "branch",
      priority: 95,
      minWidth: 6,
      text: "🌿 feat/x",
    });
    expect(result?.text).not.toContain("\x1b");
  });
});

describe("formatWorktreeSegment", () => {
  test("returns null for a non-object payload", () => {
    expect(formatWorktreeSegment(null)).toBeNull();
    expect(formatWorktreeSegment("not an object")).toBeNull();
  });

  test("returns null when git_worktree is absent or empty", () => {
    expect(formatWorktreeSegment({})).toBeNull();
    expect(
      formatWorktreeSegment({ workspace: { git_worktree: "" } }),
    ).toBeNull();
  });

  test("renders the worktree name, uncolored", () => {
    const result = formatWorktreeSegment({
      workspace: { git_worktree: "foo" },
    });

    expect(result).toEqual({
      id: "worktree",
      priority: 85,
      minWidth: 8,
      text: 'wt "foo"',
    });
    expect(result?.text).not.toContain("\x1b");
  });
});

describe("formatPrSegment", () => {
  test("returns null when pr is absent or pr.number is not a number", () => {
    expect(formatPrSegment({})).toBeNull();
    expect(formatPrSegment({ pr: { number: "12" } })).toBeNull();
    expect(formatPrSegment(null)).toBeNull();
  });

  test.each([
    ["approved", GREEN],
    ["changes_requested", RED],
    ["draft", DIM],
    ["pending", YELLOW],
  ])("colors the PR label by review_state %s", (reviewState, color) => {
    const result = formatPrSegment({
      pr: { number: 12, review_state: reviewState },
    });

    expect(result).toEqual({
      id: "pr",
      priority: 90,
      minWidth: 8,
      text: `${color}PR #12${RESET}`,
    });
  });

  test("renders a plain, uncolored label for an unknown or absent review_state", () => {
    const result = formatPrSegment({ pr: { number: 12 } });

    expect(result).toEqual({
      id: "pr",
      priority: 90,
      minWidth: 8,
      text: "PR #12",
    });
    expect(result?.text).not.toContain("\x1b");
  });

  test("wraps the label in an OSC-8 hyperlink when pr.url is a non-empty string", () => {
    const result = formatPrSegment({
      pr: {
        number: 12,
        review_state: "approved",
        url: "https://example.test/pr/12",
      },
    });

    expect(result?.text).toBe(
      `${GREEN}\x1b]8;;https://example.test/pr/12\x07PR #12\x1b]8;;\x07${RESET}`,
    );
  });

  test("does not include an OSC-8 hyperlink when pr.url is absent or empty", () => {
    const result = formatPrSegment({ pr: { number: 12, url: "" } });

    expect(result?.text).not.toContain("\x1b]8;;");
  });
});

describe("formatAgentSegment", () => {
  test("renders a dim '↳ name' segment when agent.name is a non-empty string", () => {
    const result = formatAgentSegment({ agent: { name: "code-reviewer" } });

    // toEqual is an exact match, so this also implicitly proves no other
    // ANSI color (e.g. red) is present beyond DIM/RESET.
    expect(result).toEqual({
      id: "agent",
      priority: 55,
      minWidth: 6,
      text: `${DIM}↳ code-reviewer${RESET}`,
    });
  });

  test("returns null when agent is absent", () => {
    expect(formatAgentSegment({})).toBeNull();
  });

  test("returns null when agent is present but not an object", () => {
    expect(formatAgentSegment({ agent: "code-reviewer" })).toBeNull();
    expect(formatAgentSegment({ agent: 5 })).toBeNull();
    expect(formatAgentSegment({ agent: null })).toBeNull();
  });

  test("returns null when agent.name is absent", () => {
    expect(formatAgentSegment({ agent: {} })).toBeNull();
  });

  test("returns null when agent.name is an empty string", () => {
    expect(formatAgentSegment({ agent: { name: "" } })).toBeNull();
  });

  test("returns null when agent.name is present but non-string", () => {
    expect(formatAgentSegment({ agent: { name: 5 } })).toBeNull();
  });

  test("returns null for a non-object payload", () => {
    expect(formatAgentSegment(null)).toBeNull();
    expect(formatAgentSegment(undefined)).toBeNull();
    expect(formatAgentSegment("not an object")).toBeNull();
  });
});

describe("formatOriginRepoSegment", () => {
  test("renders 'owner/name', uncolored", () => {
    const result = formatOriginRepoSegment({
      workspace: { repo: { owner: "monte3l", name: "m3l-automation" } },
    });

    expect(result).toEqual({
      id: "origin_repo",
      priority: 40,
      minWidth: 10,
      text: "monte3l/m3l-automation",
    });
    expect(result?.text).not.toContain("\x1b");
  });

  test("returns null when owner or name is missing or empty", () => {
    expect(
      formatOriginRepoSegment({ workspace: { repo: { owner: "monte3l" } } }),
    ).toBeNull();
    expect(
      formatOriginRepoSegment({
        workspace: { repo: { owner: "", name: "m3l-automation" } },
      }),
    ).toBeNull();
    expect(formatOriginRepoSegment({})).toBeNull();
  });
});

describe("formatModelSegment", () => {
  test("renders the model display name in cyan", () => {
    const result = formatModelSegment({ model: { display_name: "Sonnet 5" } });

    expect(result).toEqual({
      id: "model",
      priority: 100,
      minWidth: 6,
      text: `${CYAN}Sonnet 5${RESET}`,
    });
  });

  test("returns null when display_name is absent, empty, or non-string", () => {
    expect(formatModelSegment({})).toBeNull();
    expect(formatModelSegment({ model: { display_name: "" } })).toBeNull();
    expect(formatModelSegment({ model: { display_name: 5 } })).toBeNull();
    expect(formatModelSegment(null)).toBeNull();
  });
});

describe("formatEffortSegment", () => {
  test("renders the effort level plainly, uncolored", () => {
    const result = formatEffortSegment({ effort: { level: "high" } });

    expect(result).toEqual({
      id: "effort",
      priority: 90,
      minWidth: 4,
      text: "high",
    });
    expect(result?.text).not.toContain("\x1b");
  });

  test("returns null when level is absent, empty, or non-string", () => {
    expect(formatEffortSegment({})).toBeNull();
    expect(formatEffortSegment({ effort: { level: "" } })).toBeNull();
  });
});

describe("formatThinkingSegment", () => {
  test("renders 'thinking' only when thinking.enabled is strictly true", () => {
    expect(formatThinkingSegment({ thinking: { enabled: true } })).toEqual({
      id: "thinking",
      priority: 70,
      minWidth: 8,
      text: "thinking",
    });
  });

  test("returns null for false, absent, or a non-boolean truthy value", () => {
    expect(formatThinkingSegment({ thinking: { enabled: false } })).toBeNull();
    expect(formatThinkingSegment({})).toBeNull();
    expect(formatThinkingSegment({ thinking: { enabled: "true" } })).toBeNull();
    expect(formatThinkingSegment({ thinking: { enabled: 1 } })).toBeNull();
  });
});

describe("formatFastModeSegment", () => {
  test("renders 'fast mode' only when fast_mode is strictly true", () => {
    expect(formatFastModeSegment({ fast_mode: true })).toEqual({
      id: "fast_mode",
      priority: 65,
      minWidth: 10,
      text: "fast mode",
    });
  });

  test("returns null for false, absent, or a non-boolean truthy value", () => {
    expect(formatFastModeSegment({ fast_mode: false })).toBeNull();
    expect(formatFastModeSegment({})).toBeNull();
    expect(formatFastModeSegment({ fast_mode: "true" })).toBeNull();
  });
});

describe("formatOutputStyleSegment", () => {
  test("returns null when absent, empty, or exactly 'default'", () => {
    expect(formatOutputStyleSegment({})).toBeNull();
    expect(formatOutputStyleSegment({ output_style: { name: "" } })).toBeNull();
    expect(
      formatOutputStyleSegment({ output_style: { name: "default" } }),
    ).toBeNull();
  });

  test("renders any other non-empty style name plainly", () => {
    const result = formatOutputStyleSegment({
      output_style: { name: "explanatory" },
    });

    expect(result).toEqual({
      id: "output_style",
      priority: 55,
      minWidth: 6,
      text: "explanatory",
    });
    expect(result?.text).not.toContain("\x1b");
  });
});

describe("formatVimModeSegment", () => {
  test("returns null when absent or empty", () => {
    expect(formatVimModeSegment({})).toBeNull();
    expect(formatVimModeSegment({ vim: { mode: "" } })).toBeNull();
  });

  test("renders the mode lowercased", () => {
    const result = formatVimModeSegment({ vim: { mode: "NORMAL" } });

    expect(result).toEqual({
      id: "vim",
      priority: 50,
      minWidth: 6,
      text: "normal",
    });
  });

  test("leaves an already-lowercase mode unchanged", () => {
    expect(formatVimModeSegment({ vim: { mode: "insert" } })?.text).toBe(
      "insert",
    );
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
});

describe("formatContextBarSegment", () => {
  test("returns null for an unknown zone (no context_window data)", () => {
    expect(formatContextBarSegment({})).toBeNull();
  });

  test("renders an empty green bar at 0%", () => {
    const result = formatContextBarSegment({
      context_window: { used_percentage: 0 },
    });

    expect(result).toEqual({
      id: "context_bar",
      priority: 100,
      minWidth: 20,
      text: `${GREEN}${"░".repeat(20)}${RESET}`,
    });
  });

  test("renders a half-filled green bar at 50%", () => {
    const result = formatContextBarSegment({
      context_window: { used_percentage: 50 },
    });

    expect(result?.text).toBe(
      `${GREEN}${"█".repeat(10)}${"░".repeat(10)}${RESET}`,
    );
  });

  test("renders a fully-filled red bar at 100%", () => {
    const result = formatContextBarSegment({
      context_window: { used_percentage: 100 },
    });

    expect(result?.text).toBe(`${RED}${"█".repeat(20)}${RESET}`);
  });

  test("rounds the filled cell count (72% -> round(14.4) -> 14 filled)", () => {
    const result = formatContextBarSegment({
      context_window: { used_percentage: 72 },
    });

    expect(result?.text).toBe(
      `${YELLOW}${"█".repeat(14)}${"░".repeat(6)}${RESET}`,
    );
  });

  test.each([
    [69, GREEN],
    [70, YELLOW],
    [89, YELLOW],
    [90, RED],
  ])("colors the bar by the %i%% zone boundary", (pct, color) => {
    const result = formatContextBarSegment({
      context_window: { used_percentage: pct },
    });

    expect(result?.text.startsWith(color)).toBe(true);
  });
});

describe("formatContextPercentSegment", () => {
  test("returns null for an unknown zone", () => {
    expect(formatContextPercentSegment({})).toBeNull();
  });

  test("renders the percentage with no warning icon in the ok zone", () => {
    const result = formatContextPercentSegment({
      context_window: { used_percentage: 42 },
    });

    expect(result).toEqual({
      id: "context_pct",
      priority: 95,
      minWidth: 4,
      text: `${GREEN}42%${RESET}`,
    });
  });

  test("renders yellow with no warning icon in the warn zone", () => {
    const result = formatContextPercentSegment({
      context_window: { used_percentage: 75 },
    });

    expect(result?.text).toBe(`${YELLOW}75%${RESET}`);
    expect(result?.text).not.toContain("⚠");
  });

  test("renders red with no warning icon in the high zone", () => {
    const result = formatContextPercentSegment({
      context_window: { used_percentage: 95 },
    });

    expect(result?.text).toBe(`${RED}95%${RESET}`);
    expect(result?.text).not.toContain("⚠");
  });
});

describe("formatContextDenominatorSegment", () => {
  test("returns null when either field is missing, zero, or non-finite", () => {
    expect(formatContextDenominatorSegment({})).toBeNull();
    expect(
      formatContextDenominatorSegment({
        context_window: { total_input_tokens: 100 },
      }),
    ).toBeNull();
    expect(
      formatContextDenominatorSegment({
        context_window: { total_input_tokens: 0, context_window_size: 200000 },
      }),
    ).toBeNull();
    expect(
      formatContextDenominatorSegment({
        context_window: {
          total_input_tokens: NaN,
          context_window_size: 200000,
        },
      }),
    ).toBeNull();
  });

  test("renders formatted token counts, uncolored", () => {
    const result = formatContextDenominatorSegment({
      context_window: {
        total_input_tokens: 15500,
        context_window_size: 200000,
      },
    });

    expect(result).toEqual({
      id: "context_denom",
      priority: 80,
      minWidth: 10,
      text: "15.5k/200k",
    });
    expect(result?.text).not.toContain("\x1b");
  });
});

describe("formatContextHeadroomSegment", () => {
  test("returns null when either field is missing, negative, or non-finite", () => {
    expect(formatContextHeadroomSegment({})).toBeNull();
    expect(
      formatContextHeadroomSegment({
        context_window: {
          remaining_percentage: -1,
          context_window_size: 200000,
        },
      }),
    ).toBeNull();
    expect(
      formatContextHeadroomSegment({
        context_window: { remaining_percentage: 50, context_window_size: 0 },
      }),
    ).toBeNull();
  });

  test("renders the computed headroom token count, uncolored", () => {
    const result = formatContextHeadroomSegment({
      context_window: { remaining_percentage: 50, context_window_size: 200000 },
    });

    expect(result).toEqual({
      id: "context_headroom",
      priority: 70,
      minWidth: 12,
      text: "100k headroom",
    });
    expect(result?.text).not.toContain("\x1b");
  });

  test("allows a remaining_percentage of exactly 0", () => {
    const result = formatContextHeadroomSegment({
      context_window: { remaining_percentage: 0, context_window_size: 200000 },
    });

    expect(result?.text).toBe("0 headroom");
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

describe.each([
  [
    "formatFiveHourSegment",
    formatFiveHourSegment,
    "five_hour",
    "5h",
    "quota_5h",
    100,
  ],
  [
    "formatSevenDaySegment",
    formatSevenDaySegment,
    "seven_day",
    "7d",
    "quota_7d",
    85,
  ],
  [
    "formatSpendLimitSegment",
    formatSpendLimitSegment,
    "spend_limit",
    "spend",
    "quota_spend",
    60,
  ],
] as const)("%s", (_name, fn, field, label, id, priority) => {
  const now = 1_700_000_000_000;

  test("returns null when rate_limits or the field is absent", () => {
    expect(fn({}, { now })).toBeNull();
    expect(fn({ rate_limits: {} }, { now })).toBeNull();
  });

  test("returns null when the field is not an object", () => {
    expect(fn({ rate_limits: { [field]: "nope" } }, { now })).toBeNull();
  });

  test("returns null when used_percentage is not a finite number", () => {
    expect(fn({ rate_limits: { [field]: {} } }, { now })).toBeNull();
    expect(
      fn({ rate_limits: { [field]: { used_percentage: NaN } } }, { now }),
    ).toBeNull();
  });

  test("renders the bar and percentage with no reset suffix when resets_at is absent", () => {
    const pct = 50;
    const result = fn(
      { rate_limits: { [field]: { used_percentage: pct } } },
      { now },
    );

    expect(result).toEqual({
      id,
      priority,
      minWidth: 20,
      text: `${zoneColor(pct)}${label} ${quotaBar(pct)} ${pct}%${RESET}${DIM}${RESET}`,
    });
  });

  test("appends a dim reset-time suffix when resets_at is present and finite", () => {
    const pct = 30;
    const resetsAtSec = now / 1000 + 3661; // 1h01m
    const result = fn(
      {
        rate_limits: {
          [field]: { used_percentage: pct, resets_at: resetsAtSec },
        },
      },
      { now },
    );

    expect(result?.text).toBe(
      `${zoneColor(pct)}${label} ${quotaBar(pct)} ${pct}%${RESET}${DIM} 1h01m${RESET}`,
    );
  });

  test("renders the raw, uncapped percentage while the bar fill and color use the clamped value", () => {
    const pct = 127;
    const result = fn(
      { rate_limits: { [field]: { used_percentage: pct } } },
      { now },
    );

    expect(result?.text).toContain("127%");
    expect(result?.text).toContain(RED); // clamped to 100 -> high zone
    expect(result?.text).toContain(quotaBar(pct)); // fully-filled bar
  });
});

describe("formatCostSegment", () => {
  test("returns null when total_cost_usd is absent or non-finite", () => {
    expect(formatCostSegment({})).toBeNull();
    expect(formatCostSegment({ cost: { total_cost_usd: NaN } })).toBeNull();
    expect(
      formatCostSegment({ cost: { total_cost_usd: Infinity } }),
    ).toBeNull();
  });

  test("renders a dollar-formatted cost, uncolored", () => {
    const result = formatCostSegment({ cost: { total_cost_usd: 2 } });

    expect(result).toEqual({
      id: "cost",
      priority: 100,
      minWidth: 6,
      text: "$2.00",
    });
    expect(result?.text).not.toContain("\x1b");
  });
});

describe("formatDurationSegment", () => {
  test("returns null when total_duration_ms is absent or non-finite", () => {
    expect(formatDurationSegment({})).toBeNull();
    expect(
      formatDurationSegment({ cost: { total_duration_ms: NaN } }),
    ).toBeNull();
  });

  test("renders just the minute count when api duration is absent", () => {
    const result = formatDurationSegment({
      cost: { total_duration_ms: 125000 },
    });

    expect(result).toEqual({
      id: "duration",
      priority: 85,
      minWidth: 10,
      text: "2m",
    });
    expect(result?.text).not.toContain("\x1b");
  });

  test("renders the api-duration clause when present and finite", () => {
    const result = formatDurationSegment({
      cost: { total_duration_ms: 125000, total_api_duration_ms: 65000 },
    });

    expect(result?.text).toBe("2m (1m api)");
  });

  test("omits the api-duration clause when it is present but non-finite", () => {
    const result = formatDurationSegment({
      cost: { total_duration_ms: 125000, total_api_duration_ms: Infinity },
    });

    expect(result?.text).toBe("2m");
  });
});

describe("formatLinesChangedSegment", () => {
  test("returns null when either field is missing or non-finite", () => {
    expect(formatLinesChangedSegment({})).toBeNull();
    expect(
      formatLinesChangedSegment({ cost: { total_lines_added: 5 } }),
    ).toBeNull();
    expect(
      formatLinesChangedSegment({
        cost: { total_lines_added: NaN, total_lines_removed: 2 },
      }),
    ).toBeNull();
  });

  test("returns null when both counts are exactly 0 (quiet when nothing changed)", () => {
    expect(
      formatLinesChangedSegment({
        cost: { total_lines_added: 0, total_lines_removed: 0 },
      }),
    ).toBeNull();
  });

  test("renders colorized +added/-removed when at least one count is non-zero", () => {
    const result = formatLinesChangedSegment({
      cost: { total_lines_added: 5, total_lines_removed: 2 },
    });

    expect(result).toEqual({
      id: "lines",
      priority: 65,
      minWidth: 8,
      text: `${GREEN}+5${RESET}${DIM}/${RESET}${RED}-2${RESET}`,
    });
  });

  test("still renders when only one of the two counts is non-zero", () => {
    const result = formatLinesChangedSegment({
      cost: { total_lines_added: 0, total_lines_removed: 3 },
    });

    expect(result?.text).toBe(
      `${GREEN}+0${RESET}${DIM}/${RESET}${RED}-3${RESET}`,
    );
  });
});

describe("formatCacheSegment", () => {
  test("renders a percentage when warm with a numeric hit_ratio", () => {
    const result = formatCacheSegment({
      prompt_cache: { warm: true, hit_ratio: 0.87 },
    });

    expect(result).toEqual({
      id: "cache",
      priority: 55,
      minWidth: 10,
      text: `${GREEN}cache 87%${RESET}`,
    });
  });

  test("renders 'cache warm' when warm but hit_ratio is not a finite number", () => {
    expect(formatCacheSegment({ prompt_cache: { warm: true } })?.text).toBe(
      `${GREEN}cache warm${RESET}`,
    );
  });

  test("renders a token estimate when cold with a numeric recache_tokens_if_cold", () => {
    const result = formatCacheSegment({
      prompt_cache: { warm: false, recache_tokens_if_cold: 1200 },
    });

    expect(result?.text).toBe(`${YELLOW}cache cold · 1.2k${RESET}`);
  });

  test("renders 'cache cold' when cold but recache_tokens_if_cold is not a finite number", () => {
    expect(formatCacheSegment({ prompt_cache: { warm: false } })?.text).toBe(
      `${YELLOW}cache cold${RESET}`,
    );
  });

  test("returns null when prompt_cache is absent, not an object, or warm is not a boolean", () => {
    expect(formatCacheSegment({})).toBeNull();
    expect(formatCacheSegment({ prompt_cache: "warm" })).toBeNull();
    expect(formatCacheSegment({ prompt_cache: { warm: "yes" } })).toBeNull();
  });

  test("renders the 'cache warm' fallback when warm but hit_ratio is NaN (not just absent)", () => {
    expect(
      formatCacheSegment({ prompt_cache: { warm: true, hit_ratio: NaN } })
        ?.text,
    ).toBe(`${GREEN}cache warm${RESET}`);
  });

  test("renders the 'cache cold' fallback when cold but recache_tokens_if_cold is Infinity (not just absent)", () => {
    expect(
      formatCacheSegment({
        prompt_cache: { warm: false, recache_tokens_if_cold: Infinity },
      })?.text,
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

  // The regex `\s*` after "gitdir:" is greedy and `\s` also matches the
  // trailing newline, so with an all-whitespace tail the capture group
  // backtracks down to a single space character; `.trim()` then collapses
  // that to "". This is a MATCH with an empty capture, not a non-match --
  // the function returns "" here, not null.
  test("returns an empty string (not null) for a whitespace-only gitdir value", () => {
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

  test("returns null for a non-string or empty startDir", () => {
    const readFile = (): string | null => null;

    expect(resolveBranch(readFile, "")).toBeNull();
    expect(resolveBranch(readFile, null)).toBeNull();
  });

  test("returns null for a detached HEAD (raw SHA, not a ref line)", () => {
    const startDir = "/workspace/project";
    const readFile = (path: string): string | null =>
      path === join(startDir, ".git", "HEAD")
        ? "3f2504e04f8964efd25f5f1efd9b0f7e6f2f9c1a\n"
        : null;

    expect(resolveBranch(readFile, startDir)).toBeNull();
  });

  test("stops at the nearest .git it finds and does not walk further up past it, even when that .git yields no usable branch", () => {
    const nearest = "/workspace/project";
    const further = "/workspace";
    const readFile = (path: string): string | null => {
      // Nearest .git/HEAD exists but is a detached-HEAD raw SHA -- no ref.
      if (path === join(nearest, ".git", "HEAD")) {
        return "3f2504e04f8964efd25f5f1efd9b0f7e6f2f9c1a\n";
      }
      // A further-up .git DOES have a valid ref, but must never be reached:
      // resolveBranch stops at the first .git it finds, broken or not.
      if (path === join(further, ".git", "HEAD")) {
        return "ref: refs/heads/should-not-be-found\n";
      }
      return null;
    };

    expect(resolveBranch(readFile, join(nearest, "sub"))).toBeNull();
  });

  test("treats a whitespace-only linked-worktree pointer as no branch found, without falling through to a malformed path read", () => {
    const startDir = "/workspace/project";
    const readFile = (path: string): string | null => {
      if (path === join(startDir, ".git", "HEAD")) return null;
      if (path === join(startDir, ".git")) return "gitdir: \n";
      // If the empty-pointer guard were missing, resolveBranch would fall
      // through to reading join(startDir, "HEAD") next -- must never happen.
      if (path === join(startDir, "HEAD")) return "ref: refs/heads/decoy\n";
      return null;
    };

    expect(resolveBranch(readFile, startDir)).toBeNull();
  });
});

describe("formatMemorySegment", () => {
  test("returns null when freemem/totalmem are missing or totalmem is zero", () => {
    expect(formatMemorySegment({})).toBeNull();
    expect(formatMemorySegment({ freemem: 100, totalmem: 0 })).toBeNull();
  });

  test("renders red when free memory is at or below 10%", () => {
    const result = formatMemorySegment({
      freemem: 1_000_000_000,
      totalmem: 10_000_000_000,
    });

    expect(result).toEqual({
      id: "memory",
      priority: 50,
      minWidth: 10,
      text: `${RED}1.0/10.0G free${RESET}`,
    });
  });

  test("renders yellow when free memory is at or below 30% but above 10%", () => {
    const result = formatMemorySegment({
      freemem: 3_000_000_000,
      totalmem: 10_000_000_000,
    });

    expect(result?.text).toBe(`${YELLOW}3.0/10.0G free${RESET}`);
  });

  test("renders green when free memory is above 30%", () => {
    const result = formatMemorySegment({
      freemem: 8_000_000_000,
      totalmem: 10_000_000_000,
    });

    expect(result?.text).toBe(`${GREEN}8.0/10.0G free${RESET}`);
  });
});

describe("buildSessionRow", () => {
  // Unlike the other four rows, this one can never hit the all-null
  // placeholder case: formatSessionNameSegment always returns a segment
  // (never null, per its own contract), so an entirely empty payload/env
  // still renders the "unnamed" fallback rather than PLACEHOLDER.
  test("still renders a non-empty, non-placeholder row for an entirely empty payload/env (session_name never returns null)", () => {
    const result = buildSessionRow({}, {}, 80);

    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("unnamed");
    expect(result).not.toContain(PLACEHOLDER);
  });

  test("renders session name, branch, worktree, PR, agent, and origin repo segments", () => {
    const payload = {
      session_name: "feat-statusline-widgets",
      workspace: {
        git_worktree: "foo",
        repo: { owner: "monte3l", name: "m3l-automation" },
      },
      pr: { number: 12 },
      agent: { name: "code-reviewer" },
    };
    const env = { branch: "feat/foo" };

    const result = buildSessionRow(payload, env, 200);

    expect(result).toContain("feat-statusline-widgets");
    expect(result).toContain("feat/foo");
    expect(result).toContain('wt "foo"');
    expect(result).toContain("PR #12");
    expect(result).toContain("↳ code-reviewer");
    expect(result).toContain("monte3l/m3l-automation");
  });

  test("always returns a non-empty string, even at a very narrow width", () => {
    const payload = { session_name: "feat-x" };

    expect(buildSessionRow(payload, {}, 5).length).toBeGreaterThan(0);
  });
});

describe("buildModelRow", () => {
  test("starts with the padded, dimmed 'model' gutter label followed by the placeholder for an empty payload", () => {
    expect(buildModelRow({}, 80)).toBe(
      `${DIM}model     ${RESET}${PLACEHOLDER}`,
    );
  });

  test("renders model, effort, thinking, fast mode, output style, and vim mode segments", () => {
    const payload = {
      model: { display_name: "Sonnet 5" },
      effort: { level: "high" },
      thinking: { enabled: true },
      fast_mode: true,
      output_style: { name: "explanatory" },
      vim: { mode: "NORMAL" },
    };

    const result = buildModelRow(payload, 200);

    expect(result).toContain("Sonnet 5");
    expect(result).toContain("high");
    expect(result).toContain("thinking");
    expect(result).toContain("fast mode");
    expect(result).toContain("explanatory");
    expect(result).toContain("normal");
  });

  test("always returns a non-empty string, even at a very narrow width", () => {
    const payload = { model: { display_name: "Sonnet 5" } };

    expect(buildModelRow(payload, 5).length).toBeGreaterThan(0);
  });
});

describe("buildContextRow", () => {
  test("returns the gutter + placeholder when there is no context-window data", () => {
    expect(buildContextRow({}, 80)).toBe(
      `${DIM}${"context".padEnd(GUTTER_WIDTH)}${RESET}${PLACEHOLDER}`,
    );
  });

  test("renders the bar, percentage, denominator, and headroom segments", () => {
    const payload = {
      context_window: {
        used_percentage: 50,
        total_input_tokens: 15500,
        context_window_size: 200000,
        remaining_percentage: 50,
      },
    };

    const result = buildContextRow(payload, 200);

    expect(result).toContain("50%");
    expect(result).toContain("15.5k/200k");
    expect(result).toContain("headroom");
    expect(result).toContain("█");
  });

  test("always returns a non-empty string, even at a very narrow width", () => {
    const payload = { context_window: { used_percentage: 50 } };

    expect(buildContextRow(payload, 5).length).toBeGreaterThan(0);
  });
});

describe("buildQuotaRow", () => {
  const now = 1_700_000_000_000;

  test("returns the gutter + placeholder when no rate-limit data is present", () => {
    expect(buildQuotaRow({}, { now }, 80)).toBe(
      `${DIM}${"quota".padEnd(GUTTER_WIDTH)}${RESET}${PLACEHOLDER}`,
    );
  });

  test("renders the five-hour, seven-day, and spend-limit segments", () => {
    const payload = {
      rate_limits: {
        five_hour: { used_percentage: 20 },
        seven_day: { used_percentage: 40 },
        spend_limit: { used_percentage: 60 },
      },
    };

    const result = buildQuotaRow(payload, { now }, 200);

    expect(result).toContain("5h");
    expect(result).toContain("7d");
    expect(result).toContain("spend");
  });

  test("always returns a non-empty string, even at a very narrow width", () => {
    const payload = { rate_limits: { five_hour: { used_percentage: 20 } } };

    expect(buildQuotaRow(payload, { now }, 5).length).toBeGreaterThan(0);
  });
});

describe("buildWorkRow", () => {
  test("returns the gutter + placeholder when no cost/cache/memory data is present", () => {
    expect(buildWorkRow({}, {}, 80)).toBe(
      `${DIM}${"work".padEnd(GUTTER_WIDTH)}${RESET}${PLACEHOLDER}`,
    );
  });

  test("renders cost, duration, lines-changed, cache, and memory segments", () => {
    const payload = {
      cost: {
        total_cost_usd: 1.5,
        total_duration_ms: 125000,
        total_lines_added: 5,
        total_lines_removed: 2,
      },
      prompt_cache: { warm: true },
    };
    const env = { freemem: 2_000_000_000, totalmem: 8_000_000_000 };

    const result = buildWorkRow(payload, env, 200);

    expect(result).toContain("$1.50");
    expect(result).toContain("2m");
    expect(result).toContain("+5");
    expect(result).toContain("-2");
    expect(result).toContain("cache warm");
    expect(result).toContain("G free");
  });

  test("always returns a non-empty string, even at a very narrow width", () => {
    const payload = { cost: { total_cost_usd: 1 } };

    expect(buildWorkRow(payload, {}, 5).length).toBeGreaterThan(0);
  });
});

describe("renderStatusLine", () => {
  const now = 1_700_000_000_000;
  const richPayload = {
    session_name: "feat-statusline-widgets",
    model: { display_name: "Sonnet 5" },
    effort: { level: "high" },
    thinking: { enabled: true },
    fast_mode: true,
    output_style: { name: "explanatory" },
    vim: { mode: "NORMAL" },
    context_window: {
      used_percentage: 72,
      total_input_tokens: 15500,
      context_window_size: 200000,
      remaining_percentage: 28,
    },
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: now / 1000 + 3600 },
      seven_day: { used_percentage: 40 },
      spend_limit: { used_percentage: 10 },
    },
    cost: {
      total_cost_usd: 1.5,
      total_duration_ms: 125000,
      total_api_duration_ms: 65000,
      total_lines_added: 5,
      total_lines_removed: 2,
    },
    prompt_cache: { warm: true, hit_ratio: 0.9 },
    workspace: {
      git_worktree: "statusline-context-pressure",
      repo: { owner: "monte3l", name: "m3l-automation" },
    },
    pr: { number: 12, review_state: "approved" },
  };
  const richEnv = {
    now,
    freemem: 2_000_000_000,
    totalmem: 8_000_000_000,
    branch: "feat/statusline-redesign",
  };

  test("always returns exactly 5 newline-joined lines for a fully-populated payload", () => {
    const result = renderStatusLine(richPayload, richEnv);

    expect(result.split("\n")).toHaveLength(5);
  });

  test("always returns exactly 5 lines for an empty payload with no env arg", () => {
    expect(renderStatusLine({}).split("\n")).toHaveLength(5);
  });

  test("always returns exactly 5 lines for a payload with only context_window.used_percentage set", () => {
    const result = renderStatusLine({
      context_window: { used_percentage: 42 },
    });

    expect(result.split("\n")).toHaveLength(5);
  });

  test("respects a narrow terminal: every line's display width stays within COLUMNS=40", () => {
    const result = renderStatusLine(richPayload, { ...richEnv, COLUMNS: "40" });

    for (const line of result.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("renders correctly at a wide terminal (COLUMNS=200) without throwing or emitting undefined/NaN text", () => {
    const result = renderStatusLine(richPayload, {
      ...richEnv,
      COLUMNS: "200",
    });

    expect(result).not.toContain("undefined");
    expect(result).not.toContain("NaN");
    for (const line of result.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(200);
    }
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

  test("reads a JSON payload from stdin, renders it as 5 lines, and writes to stdout", () => {
    const stdout = execFileSync("node", [scriptPath], {
      input: JSON.stringify({
        context_window: { used_percentage: 42 },
      }),
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(stdout).toContain("42%");
    expect(stdout.split("\n")).toHaveLength(5);
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
