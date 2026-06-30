import { describe, expect, test } from "vitest";
import { findMajorBumps, parseOutdated } from "../../bin/check-deps.mjs";

describe("parseOutdated", () => {
  test("empty string returns empty array", () => {
    expect(parseOutdated("")).toEqual([]);
  });

  test("whitespace-only string returns empty array", () => {
    expect(parseOutdated("   \n")).toEqual([]);
  });

  test("warning-prefixed output (malformed JSON) returns empty array gracefully", () => {
    // pnpm may prepend WARN lines before JSON in some environments
    const warningPrefixed =
      "WARN  deprecated package@1.0.0: use something else\n{invalid json}";
    expect(parseOutdated(warningPrefixed)).toEqual([]);
  });

  test("object form (name keyed) normalises to entry array", () => {
    const stdout = JSON.stringify({
      "my-package": { current: "1.2.3", latest: "2.0.0" },
    });
    expect(parseOutdated(stdout)).toEqual([
      { name: "my-package", current: "1.2.3", latest: "2.0.0" },
    ]);
  });

  test("array form (packageName keyed) normalises to entry array", () => {
    const stdout = JSON.stringify([
      { packageName: "pkg-a", current: "3.1.0", latest: "4.0.0" },
    ]);
    expect(parseOutdated(stdout)).toEqual([
      { name: "pkg-a", current: "3.1.0", latest: "4.0.0" },
    ]);
  });

  test("array form with name field (fallback from packageName)", () => {
    const stdout = JSON.stringify([
      { name: "pkg-b", current: "0.5.0", latest: "1.0.0" },
    ]);
    expect(parseOutdated(stdout)).toEqual([
      { name: "pkg-b", current: "0.5.0", latest: "1.0.0" },
    ]);
  });

  test("empty JSON object returns empty array", () => {
    expect(parseOutdated("{}")).toEqual([]);
  });

  test("empty JSON array returns empty array", () => {
    expect(parseOutdated("[]")).toEqual([]);
  });
});

describe("findMajorBumps", () => {
  test("major bump detected", () => {
    const entries = [{ name: "a", current: "1.2.3", latest: "2.0.0" }];
    expect(findMajorBumps(entries)).toEqual(entries);
  });

  test("minor bump is not a major bump", () => {
    const entries = [{ name: "a", current: "1.2.3", latest: "1.5.0" }];
    expect(findMajorBumps(entries)).toEqual([]);
  });

  test("patch bump is not a major bump", () => {
    const entries = [{ name: "a", current: "1.2.3", latest: "1.2.9" }];
    expect(findMajorBumps(entries)).toEqual([]);
  });

  test("already on latest — not a bump", () => {
    const entries = [{ name: "a", current: "2.0.0", latest: "2.0.0" }];
    expect(findMajorBumps(entries)).toEqual([]);
  });

  test("filters only major bumps from a mixed list", () => {
    const entries = [
      { name: "major-pkg", current: "1.0.0", latest: "2.0.0" },
      { name: "minor-pkg", current: "1.0.0", latest: "1.5.0" },
      { name: "same-pkg", current: "3.0.0", latest: "3.0.0" },
    ];
    expect(findMajorBumps(entries)).toEqual([
      { name: "major-pkg", current: "1.0.0", latest: "2.0.0" },
    ]);
  });

  test("empty list returns empty array", () => {
    expect(findMajorBumps([])).toEqual([]);
  });

  test("missing version strings fall back gracefully", () => {
    const entries = [{ name: "broken", current: "", latest: "" }];
    expect(findMajorBumps(entries)).toEqual([]);
  });
});
