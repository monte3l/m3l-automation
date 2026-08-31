import { describe, expect, test } from "vitest";
import { diffCapSources, extractCap } from "../../bin/check-review-policy.mjs";

describe("extractCap", () => {
  test("extracts the number from the bold REVIEW.md phrasing", () => {
    expect(
      extractCap(
        "Cap each section at its **10** most severe findings, most-severe first.",
      ),
    ).toBe(10);
  });

  test("extracts the number from plain (non-bold) phrasing", () => {
    expect(extractCap("its 10 most severe findings")).toBe(10);
  });

  test("extracts the number when the phrase wraps across a line break", () => {
    expect(
      extractCap(
        "Cap each section at its 10 most\nsevere findings, most-severe first.",
      ),
    ).toBe(10);
  });

  test("returns null when the phrase is absent entirely", () => {
    expect(extractCap("nothing relevant here")).toBeNull();
  });
});

describe("diffCapSources", () => {
  test("a source with cap: null produces an error mentioning the missing phrase and its label", () => {
    const errors = diffCapSources(10, [{ label: "some/file.md", cap: null }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("has no");
    expect(errors[0]).toContain("most severe findings");
    expect(errors[0]).toContain("some/file.md");
  });

  test("a source with a differing cap produces an error mentioning both numbers and its label", () => {
    const errors = diffCapSources(10, [{ label: "some/file.md", cap: 8 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("10");
    expect(errors[0]).toContain("8");
    expect(errors[0]).toContain("some/file.md");
  });

  test("a source with a matching cap produces no error", () => {
    expect(diffCapSources(10, [{ label: "some/file.md", cap: 10 }])).toEqual(
      [],
    );
  });

  test("a mix of matching, null, and mismatched sources yields exactly one message per problem source in input order, referencing the correct label", () => {
    const sources = [
      { label: "matching-one.md", cap: 10 },
      { label: "missing-phrase.md", cap: null },
      { label: "mismatched.md", cap: 7 },
      { label: "matching-two.md", cap: 10 },
    ];
    const errors = diffCapSources(10, sources);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("missing-phrase.md");
    expect(errors[0]).not.toContain("mismatched.md");
    expect(errors[1]).toContain("mismatched.md");
    expect(errors[1]).toContain("7");
    expect(errors[1]).not.toContain("missing-phrase.md");
  });
});
