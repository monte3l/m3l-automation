import { describe, expect, test } from "vitest";
import {
  recommendToolMemoryLimitGiB,
  hasZramSwap,
  isSystemdUnitActive,
  parseMemoryMax,
  countClaudeProcesses,
  evaluateHostResources,
  parseDarwinMemoryPressureLevel,
  parseDarwinSwapDetail,
  evaluateDarwinHostResources,
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
  test("unsupported platform returns an info-only, warning-free report", () => {
    // platform: "darwin" now routes to a real evaluateDarwinHostResources
    // branch (see the describe block below) rather than this generic skip —
    // "win32" is a platform that genuinely falls through to it.
    const result = evaluateHostResources({
      platform: "win32",
      oomDaemonActive: false,
      hasZram: false,
      userSliceMemoryMax: null,
      toolMemoryLimitEnv: undefined,
      claudeProcessCount: 5,
      totalMemGiB: 16,
    });
    expect(result.warnings).toEqual([]);
    expect(result.info).toHaveLength(1);
    expect(result.info[0]).toEqual(
      expect.stringContaining("Linux/macOS-specific"),
    );
    expect(result.info[0]).toEqual(expect.stringContaining("win32"));
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

describe("parseDarwinMemoryPressureLevel", () => {
  test("parses a normal-priority pressure level with a trailing newline", () => {
    expect(parseDarwinMemoryPressureLevel("1\n")).toBe(1);
  });

  test("parses a higher (warning) pressure level", () => {
    expect(parseDarwinMemoryPressureLevel("2")).toBe(2);
  });

  test("null for non-numeric output", () => {
    expect(parseDarwinMemoryPressureLevel("not-a-number")).toBeNull();
  });

  test("returns null for empty output, not 0", () => {
    expect(parseDarwinMemoryPressureLevel("")).toBeNull();
  });
});

describe("parseDarwinSwapDetail", () => {
  test("parses period-decimal sysctl vm.swapusage output", () => {
    // total = 1024.00M -> 1024/1024 = 1.0 GiB; used = 124.00M ->
    // 124/1024 = 0.12109375 -> round(1.2109375)/10 = 0.1 GiB.
    const output =
      "vm.swapusage: total = 1024.00M  used = 124.00M  free = 900.00M  (encrypted)";
    expect(parseDarwinSwapDetail(output)).toEqual({
      totalGiB: 1,
      usedGiB: 0.1,
    });
  });

  test("tolerates a comma decimal separator (it_IT locale) with the same result", () => {
    const output =
      "vm.swapusage: total = 1024,00M  used = 124,00M  free = 900,00M  (encrypted)";
    expect(parseDarwinSwapDetail(output)).toEqual({
      totalGiB: 1,
      usedGiB: 0.1,
    });
  });

  test("null when total= is missing", () => {
    const output = "vm.swapusage: used = 124.00M  free = 900.00M";
    expect(parseDarwinSwapDetail(output)).toBeNull();
  });

  test("null when used= is missing", () => {
    const output = "vm.swapusage: total = 1024.00M  free = 900.00M";
    expect(parseDarwinSwapDetail(output)).toBeNull();
  });
});

describe("evaluateDarwinHostResources", () => {
  // A fully healthy host: normal pressure, low swap, tool-memory-limit env
  // unset (which is expected/correct on darwin, not a warning), and a
  // single claude process — used as the baseline for every other case
  // below by overriding just the field under test.
  const healthyFacts = {
    memoryPressureLevel: 1,
    swap: { totalGiB: 1, usedGiB: 0.1 },
    availableMemGiB: 47.3,
    toolMemoryLimitEnv: undefined,
    claudeProcessCount: 1,
    totalMemGiB: 64,
  };

  test("healthy host produces no warnings and names the Linux-mitigation analogues", () => {
    const result = evaluateDarwinHostResources(healthyFacts);
    expect(result.warnings).toEqual([]);
    expect(result.info).toEqual(
      expect.arrayContaining([
        expect.stringContaining("jetsam"),
        expect.stringContaining("compressor"),
        expect.stringContaining("cgroups"),
        expect.stringContaining("GiB available"),
      ]),
    );
  });

  test("elevated memory pressure (level 2) fires a warning naming the level", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      memoryPressureLevel: 2,
    });
    expect(
      result.warnings.some((w) => /pressure/i.test(w) && w.includes("2")),
    ).toBe(true);
  });

  test("normal memory pressure (level 1) does NOT fire the pressure warning", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      memoryPressureLevel: 1,
    });
    expect(result.warnings.some((w) => /pressure/i.test(w))).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test("high swap usage (75%, above the absolute floor) fires a warning naming the percentage", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      swap: { totalGiB: 8, usedGiB: 6 },
    });
    expect(result.warnings.some((w) => w.includes("75%"))).toBe(true);
  });

  test("low swap usage (10%) does NOT fire the swap warning", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      swap: { totalGiB: 1, usedGiB: 0.1 },
    });
    expect(result.warnings.some((w) => /swap/i.test(w))).toBe(false);
  });

  test("high swap PERCENTAGE below the absolute floor (dynamic_pager on a healthy host) does NOT fire the swap warning", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      swap: { totalGiB: 1, usedGiB: 0.9 }, // 90% but only 0.9 GiB used
    });
    expect(result.warnings.some((w) => /swap/i.test(w))).toBe(false);
  });

  test("unparseable swap (null) does not crash and produces no swap warning", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      swap: null,
    });
    expect(result.warnings.some((w) => /swap/i.test(w))).toBe(false);
  });

  test("unset CLAUDE_CODE_TOOL_MEMORY_LIMIT produces an info line, not a warning", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      toolMemoryLimitEnv: undefined,
    });
    expect(
      result.info.some(
        (line) =>
          line.includes("CLAUDE_CODE_TOOL_MEMORY_LIMIT") &&
          /macos|linux|wsl/i.test(line),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("CLAUDE_CODE_TOOL_MEMORY_LIMIT")),
    ).toBe(false);
  });

  test("set CLAUDE_CODE_TOOL_MEMORY_LIMIT suppresses that info line (never warn about it on darwin)", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      toolMemoryLimitEnv: "6G",
    });
    expect(
      result.info.some((line) =>
        line.includes("CLAUDE_CODE_TOOL_MEMORY_LIMIT"),
      ),
    ).toBe(false);
    expect(
      result.warnings.some((w) => w.includes("CLAUDE_CODE_TOOL_MEMORY_LIMIT")),
    ).toBe(false);
  });

  test("multiple claude processes fires a warning naming the count", () => {
    const result = evaluateDarwinHostResources({
      ...healthyFacts,
      claudeProcessCount: 2,
    });
    expect(
      result.warnings.some((w) => w.includes("2") && /claude/i.test(w)),
    ).toBe(true);
  });

  test("the evaluateHostResources dispatcher routes platform: darwin to this branch", () => {
    const result = evaluateHostResources({
      platform: "darwin",
      ...healthyFacts,
    });
    expect(result.warnings).toEqual([]);
  });
});
