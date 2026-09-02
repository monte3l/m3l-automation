import { describe, expect, test } from "vitest";

import {
  ESCAPE_SEQUENCE_RE,
  displayWidth,
  truncateToWidth,
  fitRow,
  terminalColumns,
} from "../../.claude/hooks/statusline-layout.mjs";

// Local, module-agnostic ANSI helpers -- statusline-layout.mjs is a generic
// width-fitting primitive with no knowledge of any particular color palette,
// so tests use raw escape codes rather than importing color constants from
// statusline-context-pressure.mjs.
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

describe("ESCAPE_SEQUENCE_RE", () => {
  // ESCAPE_SEQUENCE_RE carries the /g flag, so .test() is stateful across
  // calls via .lastIndex -- reset it immediately before each direct .test()
  // call so each assertion below is independent of call order, per the
  // module's own JSDoc caveat on this constant.
  test("matches an SGR color sequence", () => {
    ESCAPE_SEQUENCE_RE.lastIndex = 0;
    expect(ESCAPE_SEQUENCE_RE.test(`${GREEN}hi${RESET}`)).toBe(true);
  });

  test("matches an OSC-8 hyperlink sequence", () => {
    ESCAPE_SEQUENCE_RE.lastIndex = 0;
    expect(
      ESCAPE_SEQUENCE_RE.test(
        "\x1b]8;;https://example.test\x07label\x1b]8;;\x07",
      ),
    ).toBe(true);
  });

  test("does not match plain text", () => {
    ESCAPE_SEQUENCE_RE.lastIndex = 0;
    expect(ESCAPE_SEQUENCE_RE.test("plain text, no escapes")).toBe(false);
  });
});

describe("displayWidth", () => {
  test("counts plain ASCII 1:1", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  test("does not count ANSI SGR color codes toward width", () => {
    expect(displayWidth(`${GREEN}hello${RESET}`)).toBe(5);
  });

  test("does not count OSC-8 hyperlink escapes, only the visible label", () => {
    const linked = "\x1b]8;;https://example.test\x07label\x1b]8;;\x07";

    expect(displayWidth(linked)).toBe(5);
  });

  test("treats a combining mark as zero width", () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT
    expect(displayWidth("é")).toBe(1);
  });

  test("treats the variation selector U+FE0F as zero width", () => {
    expect(displayWidth("️")).toBe(0);
  });

  test("treats a Nerd Font / PUA glyph (BMP range) as width 1", () => {
    // U+E0A0, a Nerd Font branch glyph, inside the 0xE000-0xF8FF PUA range.
    expect(displayWidth("")).toBe(1);
  });

  test("treats a supplementary-plane PUA codepoint (0xF0000-0xFFFFD) as width 1", () => {
    expect(displayWidth(String.fromCodePoint(0xf_00_01))).toBe(1);
  });

  test("treats a supplementary-plane PUA codepoint (0x100000-0x10FFFD) as width 1", () => {
    expect(displayWidth(String.fromCodePoint(0x10_00_01))).toBe(1);
  });

  test("treats an emoji-presentation codepoint (e.g. leaf U+1F33F) as width 2", () => {
    expect(displayWidth("\u{1F33F}")).toBe(2);
  });

  test("treats a CJK wide codepoint (e.g. U+4E2D) as width 2", () => {
    expect(displayWidth("中")).toBe(2);
  });

  test("sums width across a mixed string of narrow and wide codepoints", () => {
    expect(displayWidth(`a${"\u{1F33F}"}b`)).toBe(4);
  });

  test("returns 0 for an empty string", () => {
    expect(displayWidth("")).toBe(0);
  });
});

describe("truncateToWidth", () => {
  test("returns an empty string when maxWidth is 0", () => {
    expect(truncateToWidth("hello world", 0)).toBe("");
  });

  test("returns an empty string when maxWidth is negative", () => {
    expect(truncateToWidth("hello world", -5)).toBe("");
  });

  test("returns the string unchanged when it already fits", () => {
    expect(truncateToWidth("hi", 10)).toBe("hi");
  });

  test("truncates plain text and appends the default ellipsis", () => {
    // width("hello world") = 11; limit = 7 - width("…") = 6 -> "hello "
    expect(truncateToWidth("hello world", 7)).toBe("hello …");
  });

  test("truncates using a custom, wider ellipsis", () => {
    // limit = 8 - width("...") = 5 -> "hello"
    expect(truncateToWidth("hello world", 8, "...")).toBe("hello...");
  });

  test("never cuts mid-codepoint: drops a wide codepoint entirely rather than half-rendering it", () => {
    // width("a" + leaf(2) + "bc") = 4; limit = 3 - 1 = 2 -> only "a" fits
    // before the leaf, which itself doesn't fit in the remaining budget.
    const result = truncateToWidth(`a${"\u{1F33F}"}bc`, 3);

    expect(result).toBe("a…");
    expect([...result]).not.toContain("\uD83C"); // no orphaned surrogate half
  });

  test("never cuts mid-escape-sequence: keeps a full color code intact or omits it entirely", () => {
    const colored = `${RED}ab${RESET}cd`; // visible "abcd", width 4
    const result = truncateToWidth(colored, 3);

    // Any escape sequence present in the result must be a complete,
    // well-formed one -- never a partial "\x1b[3" fragment.
    const nonEscapes = result.replace(ESCAPE_SEQUENCE_RE, "");
    expect(nonEscapes).not.toContain("\x1b");
  });

  test("appends a reset when a color was left open by the cut point", () => {
    const colored = `${GREEN}hello world${RESET}`; // cut lands before RESET
    const result = truncateToWidth(colored, 7);

    expect(result).toContain(GREEN);
    expect(result).toContain("hello …");
    expect(result.endsWith(RESET)).toBe(true);
  });

  test("does not append a spurious reset when no color was opened", () => {
    const result = truncateToWidth("hello world", 7);

    expect(result).not.toContain("\x1b");
  });

  test("does not double up the reset when one was already consumed within the kept prefix", () => {
    // The RESET after "ab" is consumed before the break at "c", so
    // colorOpen becomes false and no extra reset should be appended.
    const colored = `${RED}ab${RESET}cd`;
    const result = truncateToWidth(colored, 3);

    const resetCount = result.split(RESET).length - 1;
    expect(resetCount).toBe(1);
  });
});

describe("fitRow", () => {
  test("joins all segments in original array order (not priority order) when everything fits", () => {
    const segments = [
      { id: "low", priority: 10, text: "LOW", minWidth: 1 },
      { id: "high", priority: 100, text: "HIGH", minWidth: 1 },
    ];

    expect(fitRow(segments, 80, " ")).toBe("LOW HIGH");
  });

  test("drops exactly one low-priority segment to fit the budget", () => {
    const segments = [
      { id: "a", priority: 100, text: "AAAA", minWidth: 1 },
      { id: "b", priority: 50, text: "BBBB", minWidth: 1 },
      { id: "c", priority: 100, text: "CCCC", minWidth: 1 },
    ];
    // Full join "AAAA BBBB CCCC" is width 14; budget 9 fits only after
    // dropping "b" (the lowest priority): "AAAA CCCC" is width 9.
    expect(fitRow(segments, 9, " ")).toBe("AAAA CCCC");
  });

  test("drops multiple segments, lowest priority first, until the budget is met", () => {
    const segments = [
      { id: "a", priority: 100, text: "A", minWidth: 1 },
      { id: "b", priority: 10, text: "BB", minWidth: 1 },
      { id: "c", priority: 20, text: "CC", minWidth: 1 },
      { id: "d", priority: 100, text: "D", minWidth: 1 },
    ];
    // Full join "A|BB|CC|D" is width 9. Budget 5 requires dropping "b"
    // (priority 10) then "c" (priority 20), leaving "A|D" at width 3.
    expect(fitRow(segments, 5, "|")).toBe("A|D");
  });

  test("breaks a priority tie toward the segment appearing later in the array", () => {
    const segments = [
      { id: "x", priority: 50, text: "XXXX", minWidth: 1 },
      { id: "y", priority: 50, text: "YYYY", minWidth: 1 },
      { id: "z", priority: 100, text: "ZZZZ", minWidth: 1 },
    ];
    // Full join width 14; budget 9 fits by dropping exactly one of the
    // tied priority-50 pair. "y" (later in the array) must drop first.
    expect(fitRow(segments, 9, " ")).toBe("XXXX ZZZZ");
  });

  test("drops down to the sole highest-priority segment and truncates it when the budget is 0 (or less)", () => {
    // Two segments never both drop to zero: the drop-loop stops at
    // kept.size === 1 (keeping "a", the higher priority), then the
    // post-loop guard truncates that lone survivor to
    // Math.max(its minWidth, budget) via truncateToWidth -- here
    // Math.max(1, budget), which for both a zero and a negative budget is
    // 1, i.e. the ellipsis alone.
    const segments = () => [
      { id: "a", priority: 100, text: "AAAA", minWidth: 1 },
      { id: "b", priority: 50, text: "BBBB", minWidth: 1 },
    ];
    const expected = truncateToWidth("AAAA", 1);

    expect(fitRow(segments(), 0, " ")).toBe(expected);
    expect(fitRow(segments(), -5, " ")).toBe(expected);
  });

  // Contract: "If exactly one segment remains and it alone still exceeds
  // budget, truncates its text to Math.max(its minWidth, budget) via
  // truncateToWidth" -- i.e. a lone over-budget segment is TRUNCATED, never
  // dropped to nothing. The drop-loop's condition
  // `while (kept.size > 1 && currentWidth(...) > budget)` now stops before
  // deleting the last remaining segment, so this branch is reachable: kept
  // shrinks to exactly one, the loop exits (kept.size is no longer > 1),
  // and the post-loop guard `kept.size === 1 && currentWidth(...) > budget`
  // fires the truncation.
  test("truncates (not drops) the sole remaining over-budget segment", () => {
    const segments = [
      { id: "a", priority: 100, text: "AAAAAAAAAA", minWidth: 5 },
    ];

    const result = fitRow(segments, 3, " ");

    expect(result).toBe(truncateToWidth("AAAAAAAAAA", Math.max(5, 3)));
    expect(result).not.toBe("");
  });

  // Deliberate design floor (per the module's own JSDoc on fitRow): the sole
  // survivor is never cut below its own minWidth, even when budget is
  // smaller -- so the returned row's displayWidth can exceed the requested
  // budget by design. Plain ASCII text keeps truncateToWidth's accumulation
  // exact (no wide codepoints), so the result's width lands on exactly
  // Math.max(minWidth, budget), not merely "close to" it.
  test("floors the sole survivor's truncated width at its own minWidth, exceeding a smaller budget", () => {
    const minWidth = 10;
    const segments = [
      { id: "a", priority: 100, text: "A".repeat(20), minWidth },
    ];
    const budget = 3;

    const result = fitRow(segments, budget, " ");

    expect(displayWidth(result)).toBe(Math.max(minWidth, budget));
    expect(displayWidth(result)).toBeGreaterThan(budget);
  });

  // Hand-traced: kept.size starts at 0, so the drop-loop condition
  // `kept.size > 1` is false immediately; survivors is []; the
  // survivors.length === 1 truncation branch never fires; falls through to
  // [].map().join(separator), which is "".
  test("returns an empty string for an empty segments array, without crashing", () => {
    expect(fitRow([], 80, " ")).toBe("");
  });

  // A segment whose text is "" must be treated like any other segment --
  // contributing 0 width, never dropped or truncated specially -- so it
  // still survives and still separates its neighbors.
  test("keeps a segment with empty text, contributing zero width", () => {
    const segments = [
      { id: "a", priority: 100, text: "AAAA", minWidth: 1 },
      { id: "empty", priority: 90, text: "", minWidth: 0 },
      { id: "b", priority: 80, text: "BBBB", minWidth: 1 },
    ];

    expect(fitRow(segments, 80, "|")).toBe("AAAA||BBBB");
  });

  // ESCAPE_SEQUENCE_RE's OSC-8 alternative requires a \x07 terminator on the
  // matched segment; an OSC-8 *opener* (`\x1b]8;;URL\x07`) is itself a
  // complete match of that alternative even with no closing
  // `\x1b]8;;\x07`, so it IS stripped -- but any trailing bare text after it
  // (no closer at all) is left as ordinary visible text, counted normally.
  test("strips an unterminated OSC-8 opener without crashing, counting the trailing bare text normally", () => {
    const segments = [
      {
        id: "link",
        priority: 100,
        text: "\x1b]8;;http://example.com\x07link",
        minWidth: 1,
      },
    ];

    expect(fitRow(segments, 80, " ")).toBe(
      "\x1b]8;;http://example.com\x07link",
    );
    expect(displayWidth("\x1b]8;;http://example.com\x07link")).toBe(4);
  });
});

describe("terminalColumns", () => {
  test("returns 80 when env is undefined", () => {
    expect(terminalColumns(undefined)).toBe(80);
  });

  test("returns 80 when COLUMNS is absent", () => {
    expect(terminalColumns({})).toBe(80);
  });

  test("returns 80 when COLUMNS is non-numeric", () => {
    expect(terminalColumns({ COLUMNS: "not-a-number" })).toBe(80);
  });

  test("returns 80 when COLUMNS is zero", () => {
    expect(terminalColumns({ COLUMNS: "0" })).toBe(80);
  });

  test("returns 80 when COLUMNS is negative", () => {
    expect(terminalColumns({ COLUMNS: "-10" })).toBe(80);
  });

  test("returns the parsed value for a valid positive COLUMNS string", () => {
    expect(terminalColumns({ COLUMNS: "120" })).toBe(120);
  });

  test("coerces a numeric (non-string) COLUMNS value", () => {
    expect(terminalColumns({ COLUMNS: 132 })).toBe(132);
  });
});
