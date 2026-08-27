import { describe, expect, test } from "vitest";
import {
  recommendToolMemoryLimitGiB,
  hasZramSwap,
  isSystemdUnitActive,
  parseMemoryMax,
  countClaudeProcesses,
  evaluateHostResources,
} from "../../bin/check-host-resources.mjs";

describe("recommendToolMemoryLimitGiB", () => {
  test("computes a whole-GiB budget for a normal-sized host", () => {
    expect(recommendToolMemoryLimitGiB(16, 2)).toBe(6);
  });

  test("floors to the minimum of 2 on a small machine", () => {
    expect(recommendToolMemoryLimitGiB(4, 2)).toBe(2);
  });

  test("defaults to 2 concurrent sessions when omitted", () => {
    expect(recommendToolMemoryLimitGiB(16)).toBe(
      recommendToolMemoryLimitGiB(16, 2),
    );
  });
});

describe("hasZramSwap", () => {
  test("true when the output contains a zram device", () => {
    expect(
      hasZramSwap(
        "/dev/zram0                              partition\t8388604\t0\t100",
      ),
    ).toBe(true);
  });

  test("false when there is no zram substring", () => {
    expect(
      hasZramSwap(
        "/dev/sda2                               partition\t2097148\t0\t-2",
      ),
    ).toBe(false);
  });

  test("false for empty output", () => {
    expect(hasZramSwap("")).toBe(false);
  });
});

describe("isSystemdUnitActive", () => {
  test("true for exactly 'active'", () => {
    expect(isSystemdUnitActive("active")).toBe(true);
  });

  test("true for 'active' with trailing newline", () => {
    expect(isSystemdUnitActive("active\n")).toBe(true);
  });

  test("false for 'inactive'", () => {
    expect(isSystemdUnitActive("inactive")).toBe(false);
  });

  test("false for empty output", () => {
    expect(isSystemdUnitActive("")).toBe(false);
  });
});

describe("parseMemoryMax", () => {
  test("null for empty output", () => {
    expect(parseMemoryMax("")).toBeNull();
  });

  test("null for 'infinity'", () => {
    expect(parseMemoryMax("infinity")).toBeNull();
  });

  test("null for 'infinity' with trailing newline", () => {
    expect(parseMemoryMax("infinity\n")).toBeNull();
  });

  test("returns the parsed number for a valid byte ceiling", () => {
    expect(parseMemoryMax("4294967296")).toBe(4294967296);
  });

  test("null for a non-numeric string", () => {
    expect(parseMemoryMax("not-a-number")).toBeNull();
  });

  test("null for zero", () => {
    expect(parseMemoryMax("0")).toBeNull();
  });

  test("null for a negative number", () => {
    expect(parseMemoryMax("-1")).toBeNull();
  });
});

describe("countClaudeProcesses", () => {
  test("counts only exact 'claude' lines among other process names", () => {
    expect(countClaudeProcesses("node\nclaude\nbash\nclaude\n")).toBe(2);
  });

  test("zero when no line matches", () => {
    expect(countClaudeProcesses("node\nbash\nvitest\n")).toBe(0);
  });

  test("does not count a line that merely starts with 'claude'", () => {
    expect(countClaudeProcesses("claude-something\n")).toBe(0);
  });
});

describe("evaluateHostResources", () => {
  test("non-linux platform returns an info-only, warning-free report", () => {
    const result = evaluateHostResources({
      platform: "darwin",
      oomDaemonActive: false,
      hasZram: false,
      userSliceMemoryMax: null,
      toolMemoryLimitEnv: undefined,
      claudeProcessCount: 5,
      totalMemGiB: 16,
    });
    expect(result.warnings).toEqual([]);
    expect(result.info).toHaveLength(1);
    expect(result.info[0]).toEqual(expect.stringContaining("Linux-specific"));
    expect(result.info[0]).toEqual(expect.stringContaining("darwin"));
  });

  test("linux with every mitigation in place produces no warnings", () => {
    const result = evaluateHostResources({
      platform: "linux",
      oomDaemonActive: true,
      hasZram: true,
      userSliceMemoryMax: 8589934592,
      toolMemoryLimitEnv: "6G",
      claudeProcessCount: 1,
      totalMemGiB: 16,
    });
    expect(result.warnings).toEqual([]);
    expect(result.info).toEqual([]);
  });

  test("linux with every condition failing produces one warning per condition, in order", () => {
    const result = evaluateHostResources({
      platform: "linux",
      oomDaemonActive: false,
      hasZram: false,
      userSliceMemoryMax: null,
      toolMemoryLimitEnv: undefined,
      claudeProcessCount: 3,
      totalMemGiB: 16,
    });
    expect(result.info).toEqual([]);
    expect(result.warnings).toHaveLength(5);
    expect(result.warnings[0]).toEqual(expect.stringContaining("OOM daemon"));
    expect(result.warnings[1]).toEqual(expect.stringContaining("zram"));
    expect(result.warnings[2]).toEqual(expect.stringContaining("MemoryMax"));
    expect(result.warnings[3]).toEqual(
      expect.stringContaining("CLAUDE_CODE_TOOL_MEMORY_LIMIT"),
    );
    expect(result.warnings[4]).toEqual(expect.stringContaining("claude"));
    expect(result.warnings[4]).toEqual(expect.stringContaining("3"));
  });

  test("linux with only the OOM daemon missing produces exactly one warning", () => {
    const result = evaluateHostResources({
      platform: "linux",
      oomDaemonActive: false,
      hasZram: true,
      userSliceMemoryMax: 8589934592,
      toolMemoryLimitEnv: "6G",
      claudeProcessCount: 1,
      totalMemGiB: 16,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual(expect.stringContaining("OOM daemon"));
  });
});
