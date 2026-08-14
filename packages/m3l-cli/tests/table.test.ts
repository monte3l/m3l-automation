import { describe, expect, expectTypeOf, test } from "vitest";

import { formatAlignedTable } from "../src/cli/table.js";

/**
 * Contract: `src/cli/table.ts` — `formatAlignedTable` is the shared
 * per-column max-width `padEnd` alignment algorithm extracted from
 * `list.ts`'s original inline `formatRowLines` (8d dedup refactor, 8b review
 * CR#5). Both `list.ts` and `inspect.ts` render through it. The last column
 * of every line is never padded, so no line carries trailing whitespace. See
 * the pinned contract at `docs/reference/cli.md`.
 */

describe("formatAlignedTable — happy path", () => {
  test("pads every non-last column to its own max width (header+rows), joined by two spaces, last column unpadded", () => {
    const lines = formatAlignedTable(
      ["NAME", "AGE"],
      [
        ["alice", "30"],
        ["bob", "5"],
      ],
    );

    expect(lines).toEqual(["NAME   AGE", "alice  30", "bob    5"]);
  });

  test("aligns three columns independently", () => {
    const lines = formatAlignedTable(["A", "BB", "CCC"], [["x", "yy", "z"]]);

    // column widths: A -> max(1,1)=1, BB -> max(2,2)=2, CCC last column unpadded
    expect(lines).toEqual(["A  BB  CCC", "x  yy  z"]);
  });

  test("widens a column to the widest row value, not just the header", () => {
    const lines = formatAlignedTable(
      ["NAME", "VALUE"],
      [["averylongname", "1"]],
    );

    expect(lines[0]).toBe("NAME           VALUE");
    expect(lines[1]).toBe("averylongname  1");
  });
});

describe("formatAlignedTable — no trailing spaces on the last column", () => {
  test("neither the header nor any row line ends with whitespace", () => {
    const lines = formatAlignedTable(
      ["NAME", "DESCRIPTION"],
      [
        ["a", "short"],
        ["averyveryverylongname", "d"],
      ],
    );

    for (const line of lines) {
      expect(line).not.toMatch(/\s$/);
    }
  });
});

describe("formatAlignedTable — empty rows", () => {
  test("returns only the header line, sized to the header's own width, when rows is empty", () => {
    const lines = formatAlignedTable(["NAME", "AGE"], []);

    expect(lines).toEqual(["NAME  AGE"]);
  });
});

describe("formatAlignedTable — single column", () => {
  test("a single-column table is never padded (it is always the last column)", () => {
    const lines = formatAlignedTable(["NAME"], [["a"], ["averylongname"]]);

    expect(lines).toEqual(["NAME", "a", "averylongname"]);
  });
});

describe("formatAlignedTable — row/header arity mismatch", () => {
  test("throws a descriptive Error naming both lengths when a row's length differs from the header's", () => {
    expect(() =>
      formatAlignedTable(["NAME", "AGE"], [["alice", "30", "extra"]]),
    ).toThrowError(
      "formatAlignedTable: row of length 3 does not match header of length 2",
    );
  });
});

describe("formatAlignedTable — type contract", () => {
  test("accepts readonly header/rows and returns a readonly string array", () => {
    expectTypeOf(formatAlignedTable)
      .parameter(0)
      .toEqualTypeOf<readonly string[]>();
    expectTypeOf(formatAlignedTable)
      .parameter(1)
      .toEqualTypeOf<readonly (readonly string[])[]>();
    expectTypeOf(formatAlignedTable).returns.toEqualTypeOf<readonly string[]>();
  });
});
