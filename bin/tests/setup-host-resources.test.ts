import { describe, expect, test } from "vitest";
import {
  parseSessionsFlag,
  buildEarlyoomOverride,
  buildUserSliceOverride,
  buildClaudeRcOverride,
} from "../../bin/setup-host-resources.mjs";

describe("parseSessionsFlag", () => {
  test("parses a valid --sessions=N flag", () => {
    expect(parseSessionsFlag(["--sessions=3"])).toBe(3);
  });

  test("defaults to 2 when the flag is absent", () => {
    expect(parseSessionsFlag([])).toBe(2);
  });

  test("defaults to 2 for a non-numeric value", () => {
    expect(parseSessionsFlag(["--sessions=abc"])).toBe(2);
  });

  test("defaults to 2 for zero", () => {
    expect(parseSessionsFlag(["--sessions=0"])).toBe(2);
  });

  test("defaults to 2 for a negative value", () => {
    expect(parseSessionsFlag(["--sessions=-1"])).toBe(2);
  });

  test("finds the flag regardless of its position in argv", () => {
    expect(parseSessionsFlag(["--other=flag", "--sessions=5"])).toBe(5);
  });
});

describe("buildEarlyoomOverride", () => {
  test("produces a systemd override with the tuned ExecStart", () => {
    const unit = buildEarlyoomOverride();
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/usr/bin/earlyoom");
    expect(unit).toContain("--avoid");
    expect(unit).toContain("--prefer");
  });
});

describe("buildUserSliceOverride", () => {
  test("reserves a fixed 2 GiB for the OS and gives the rest to the user-slice ceiling", () => {
    // totalBudgetGiB = max(4, floor(16 - 2)) = 14; MemoryHigh = max(2, 13) = 13.
    expect(buildUserSliceOverride(16)).toBe(
      "[Slice]\nMemoryMax=14G\nMemoryHigh=13G\n",
    );
  });

  test("floors MemoryMax to the minimum of 4 on a small host where the OS reserve would leave less", () => {
    // totalBudgetGiB = max(4, floor(4 - 2)) = max(4, 2) = 4; MemoryHigh = max(2, 3) = 3.
    expect(buildUserSliceOverride(4)).toBe(
      "[Slice]\nMemoryMax=4G\nMemoryHigh=3G\n",
    );
  });

  // No case exercises the Math.max(2, totalBudgetGiB - 1) floor on MemoryHigh:
  // totalBudgetGiB is already floored at 4 by the check above, so
  // totalBudgetGiB - 1 >= 3 always holds and the MemoryHigh floor of 2 is
  // unreachable given the MemoryMax floor's own minimum.
});

describe("buildClaudeRcOverride", () => {
  test("produces the fixed MemoryMax + OOMPolicy drop-in", () => {
    expect(buildClaudeRcOverride()).toBe(
      "[Service]\nMemoryMax=6G\nOOMPolicy=kill\n",
    );
  });
});
