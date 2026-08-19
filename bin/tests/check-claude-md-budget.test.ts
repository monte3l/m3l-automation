import { describe, expect, test } from "vitest";
import {
  countRuntimeLines,
  estimateTokens,
  findWidePaddedTableLines,
  normalizeRuntimeContent,
  stripBlockComments,
} from "../check-claude-md-budget.mjs";

describe("stripBlockComments", () => {
  test("strips a single block comment", () => {
    expect(stripBlockComments("before <!-- hidden --> after")).toBe(
      "before  after",
    );
  });

  test("strips multiple non-adjacent block comments", () => {
    expect(stripBlockComments("a <!-- one --> b <!-- two --> c")).toBe(
      "a  b  c",
    );
  });

  test("leaves content with no comments unchanged", () => {
    const text = "# Heading\n\nSome prose with no comments.\n";
    expect(stripBlockComments(text)).toBe(text);
  });

  test("strips a comment spanning multiple lines", () => {
    const text = [
      "before",
      "<!--",
      "this is a maintainer note",
      "spanning several lines",
      "-->",
      "after",
    ].join("\n");
    expect(stripBlockComments(text)).toBe("before\n\nafter");
  });

  test("loops to a fixed point to fully strip a marker reassembled by removing a nested comment", () => {
    // Regression for CodeQL js/incomplete-multi-character-sanitization: a
    // single `.replace(/<!--[\s\S]*?-->/g, "")` pass scans the ORIGINAL
    // string once, left to right, so it can never see a NEW "<!--...-->"
    // span that only exists in the string the replacement produces.
    //
    // Input: "before<!" + "<!--nested-->" + "--after-->tail"
    // A single pass matches only the inner, fully-formed "<!--nested-->"
    // (the leftmost "<!--" it finds, up to the nearest "-->"), and removes
    // just that. What's left before it ("before<!") and after it
    // ("--after-->tail") sit directly adjacent in the result, which
    // accidentally reconstructs a brand-new comment marker:
    //   single pass  -> "before<!--after-->tail"  (still contains <!-- and -->)
    //   fixed point  -> "beforetail"               (loops once more, strips it, converges)
    const input = "before<!<!--nested-->--after-->tail";
    expect(stripBlockComments(input)).toBe("beforetail");
    expect(stripBlockComments(input)).not.toMatch(/<!--|--!?>/);
  });

  test("still strips two separate, well-formed comments unaffected by the fixed-point loop", () => {
    expect(stripBlockComments("<!-- a --> text <!-- b -->")).toBe(" text ");
  });
});

describe("normalizeRuntimeContent", () => {
  test("collapses 3+ blank lines to exactly 2 newlines", () => {
    expect(normalizeRuntimeContent("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("leaves a single blank line (2 newlines) alone", () => {
    expect(normalizeRuntimeContent("a\n\nb")).toBe("a\n\nb");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeRuntimeContent("\n\n  content  \n\n")).toBe("content");
  });

  test("returns empty string when content is only whitespace", () => {
    expect(normalizeRuntimeContent("   \n\n\t  ")).toBe("");
  });
});

describe("countRuntimeLines", () => {
  test("returns 0 for an empty string", () => {
    expect(countRuntimeLines("")).toBe(0);
  });

  test("returns 1 for a single line with no newline", () => {
    expect(countRuntimeLines("single line")).toBe(1);
  });

  test("returns N+1 lines for a string with N newlines", () => {
    expect(countRuntimeLines("a\nb\nc")).toBe(3);
    expect(countRuntimeLines("a\nb\nc\n")).toBe(4);
  });
});

describe("estimateTokens", () => {
  test("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("matches Math.ceil(length / 4) for a length exactly divisible by 4", () => {
    const text = "a".repeat(8);
    expect(estimateTokens(text)).toBe(2);
  });

  test("rounds up rather than truncating for a length not divisible by 4", () => {
    const text = "a".repeat(9);
    expect(estimateTokens(text)).toBe(3);
  });
});

describe("findWidePaddedTableLines", () => {
  test("returns table lines exceeding maxWidth", () => {
    const wide = `| ${"x".repeat(200)} |`;
    const normalized = ["short line", wide, "another short line"].join("\n");
    expect(findWidePaddedTableLines(normalized, 50)).toEqual([wide]);
  });

  test("excludes short table lines at or under the width", () => {
    const atLimit = "|" + "x".repeat(9); // length 10, at the limit
    expect(findWidePaddedTableLines(atLimit, 10)).toEqual([]);
  });

  test("excludes non-table lines even if they're long", () => {
    const longProse = "x".repeat(300);
    expect(findWidePaddedTableLines(longProse, 50)).toEqual([]);
  });

  test("only flags a line starting with | after trimStart, not one merely containing |", () => {
    const containsPipeButNotTableRow = `some prose with a | pipe character ${"x".repeat(
      100,
    )}`;
    const indentedTableRow = `   | ${"y".repeat(100)} |`;
    const normalized = [containsPipeButNotTableRow, indentedTableRow].join(
      "\n",
    );
    expect(findWidePaddedTableLines(normalized, 20)).toEqual([
      indentedTableRow,
    ]);
  });
});

describe("integration: stripBlockComments -> normalizeRuntimeContent -> measurements", () => {
  test("comment content is excluded from lines/tokens and a wide table row is flagged", () => {
    const wideRow = `| col | ${"z".repeat(80)} |`;
    const synthetic = [
      "<!--",
      "maintainer-only note, should not count toward the budget",
      "spanning multiple lines of commentary",
      "-->",
      "# CLAUDE.md",
      "",
      "Some prose describing the project.",
      "",
      wideRow,
      "",
    ].join("\n");

    const stripped = stripBlockComments(synthetic);
    const normalized = normalizeRuntimeContent(stripped);

    // The comment body must not survive into the measured content.
    expect(normalized).not.toContain("maintainer-only note");
    expect(normalized).not.toContain("spanning multiple lines");

    const lines = countRuntimeLines(normalized);
    const tokens = estimateTokens(normalized);

    expect(lines).toBe(countRuntimeLines(normalized));
    expect(tokens).toBe(Math.ceil(normalized.length / 4));
    expect(findWidePaddedTableLines(normalized, 50)).toEqual([wideRow]);
  });
});
