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
  test("computes MemoryMax/MemoryHigh for a normal-sized host", () => {
    expect(buildUserSliceOverride(16, 2)).toBe(
      "[Slice]\nMemoryMax=6G\nMemoryHigh=5G\n",
    );
  });

  test("floors MemoryMax to the minimum of 4 on a small, heavily-shared host", () => {
    expect(buildUserSliceOverride(4, 4)).toBe(
      "[Slice]\nMemoryMax=4G\nMemoryHigh=3G\n",
    );
  });
});

describe("buildClaudeRcOverride", () => {
  test("produces the fixed MemoryMax + OOMPolicy drop-in", () => {
    expect(buildClaudeRcOverride()).toBe(
      "[Service]\nMemoryMax=6G\nOOMPolicy=kill\n",
    );
  });
});
