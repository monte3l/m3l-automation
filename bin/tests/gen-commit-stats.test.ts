import { describe, expect, test } from "vitest";
import {
  BEGIN_MARKER,
  END_MARKER,
  buildBadgeBlock,
  replaceBadgeBlock,
} from "../../bin/gen-commit-stats.mjs";

const counts = new Map([
  ["Claude Opus 4.8", 203],
  ["Claude Fable 5", 16],
  ["Claude Sonnet 4.6", 106],
  ["Claude Sonnet 5", 6],
]);

describe("buildBadgeBlock", () => {
  test("leads with the aggregate ratio badge", () => {
    const block = buildBadgeBlock(counts, 515);
    const lines = block.split("\n");
    expect(lines[0]).toBe(BEGIN_MARKER);
    expect(lines[1]).toContain("331%20of%20515%20commits");
    expect(lines[1]).toContain('alt="AI co-authored: 331 of 515 commits"');
  });

  test("orders per-model badges by allowlist (capability tier), not count", () => {
    const block = buildBadgeBlock(counts, 515);
    const order = [...block.matchAll(/alt="(Claude [^:]+):/g)].map((m) => m[1]);
    expect(order).toEqual([
      "Claude Fable 5",
      "Claude Opus 4.8",
      "Claude Sonnet 5",
      "Claude Sonnet 4.6",
    ]);
  });

  test("skips models with no commits and closes with the end marker", () => {
    const block = buildBadgeBlock(new Map([["Claude Fable 5", 2]]), 10);
    expect(block).not.toContain("Opus");
    expect(block).not.toContain("Haiku");
    expect(block.split("\n").at(-1)).toBe(END_MARKER);
  });

  test("aggregate numerator is the sum of the per-model counts", () => {
    const block = buildBadgeBlock(new Map([["Claude Sonnet 5", 7]]), 42);
    expect(block).toContain("7%20of%2042%20commits");
  });
});

describe("replaceBadgeBlock", () => {
  test("replaces only the marker-delimited region", () => {
    const content = `before\n${BEGIN_MARKER}\nstale\n${END_MARKER}\nafter`;
    const next = replaceBadgeBlock(
      content,
      `${BEGIN_MARKER}\nfresh\n${END_MARKER}`,
    );
    expect(next).toBe(`before\n${BEGIN_MARKER}\nfresh\n${END_MARKER}\nafter`);
  });

  test("throws when the markers are missing", () => {
    expect(() => replaceBadgeBlock("no markers here", "block")).toThrow(
      /missing/,
    );
  });
});
