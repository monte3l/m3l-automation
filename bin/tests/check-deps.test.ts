import { describe, expect, test } from "vitest";
import {
  MAJOR_HOLDS,
  findMajorBumps,
  findPeerMetaInconsistencies,
  findRangedDependencies,
  parseOutdated,
  partitionHolds,
} from "../../bin/check-deps.mjs";

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

describe("partitionHolds", () => {
  const holds = {
    "held-pkg": { major: 7, reason: "deferred for a documented reason" },
  };

  test("a package on hold at the available major is held, not active", () => {
    const bumps = [{ name: "held-pkg", current: "6.0.3", latest: "7.0.2" }];
    const { held, active } = partitionHolds(bumps, holds);
    expect(active).toEqual([]);
    expect(held).toEqual([
      {
        name: "held-pkg",
        current: "6.0.3",
        latest: "7.0.2",
        reason: "deferred for a documented reason",
      },
    ]);
  });

  test("a package not on hold stays active", () => {
    const bumps = [{ name: "other-pkg", current: "1.0.0", latest: "2.0.0" }];
    const { held, active } = partitionHolds(bumps, holds);
    expect(held).toEqual([]);
    expect(active).toEqual(bumps);
  });

  test("a major newer than the held one re-surfaces as active", () => {
    const bumps = [{ name: "held-pkg", current: "6.0.3", latest: "8.0.0" }];
    const { held, active } = partitionHolds(bumps, holds);
    expect(held).toEqual([]);
    expect(active).toEqual(bumps);
  });

  test("a major older than the held one is not swallowed by the hold", () => {
    // A hold defers exactly the major it names: an intermediate, adoptable
    // major below the held one must stay active, never be masked by the hold.
    const bumps = [{ name: "held-pkg", current: "4.0.0", latest: "5.0.0" }];
    const { held, active } = partitionHolds(bumps, holds);
    expect(held).toEqual([]);
    expect(active).toEqual(bumps);
  });

  test("empty input yields empty partitions", () => {
    expect(partitionHolds([], holds)).toEqual({ held: [], active: [] });
  });

  test("mixed list splits into held and active", () => {
    const bumps = [
      { name: "held-pkg", current: "6.0.3", latest: "7.0.2" },
      { name: "other-pkg", current: "1.0.0", latest: "2.0.0" },
    ];
    const { held, active } = partitionHolds(bumps, holds);
    expect(held.map((e) => e.name)).toEqual(["held-pkg"]);
    expect(active.map((e) => e.name)).toEqual(["other-pkg"]);
  });
});

describe("MAJOR_HOLDS", () => {
  test("typescript is deferred at major 7 with a documented reason", () => {
    // This deferral exists because typescript-eslint has no TS 7 support yet.
    // When that changes and TS 7 is adopted, remove the hold AND this test.
    expect(MAJOR_HOLDS.typescript?.major).toBe(7);
    expect(MAJOR_HOLDS.typescript?.reason).toMatch(/typescript-eslint/);
  });
});

describe("findRangedDependencies", () => {
  test("exact-pinned dependencies pass (empty result)", () => {
    const pkg = {
      dependencies: { yaml: "2.9.0", undici: "8.5.0", "csv-parse": "7.0.0" },
    };
    expect(findRangedDependencies(pkg)).toEqual([]);
  });

  test("a caret range is flagged", () => {
    const pkg = { dependencies: { "string-width": "^8.2.1" } };
    expect(findRangedDependencies(pkg)).toEqual([
      { name: "string-width", range: "^8.2.1" },
    ]);
  });

  test("tilde, comparator, wildcard, x-range, and dist-tag are all flagged", () => {
    const pkg = {
      dependencies: {
        a: "~1.2.3",
        b: ">=1.0.0",
        c: "*",
        d: "1.x",
        e: "latest",
      },
    };
    expect(findRangedDependencies(pkg).map((r) => r.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("exact prerelease and build-metadata versions pass", () => {
    const pkg = {
      dependencies: { a: "1.2.3-rc.1", b: "1.2.3+build.5" },
    };
    expect(findRangedDependencies(pkg)).toEqual([]);
  });

  test("only the ranged entries are returned from a mixed set", () => {
    const pkg = {
      dependencies: { exact: "1.0.0", ranged: "^1.0.0" },
    };
    expect(findRangedDependencies(pkg)).toEqual([
      { name: "ranged", range: "^1.0.0" },
    ]);
  });

  test("missing dependencies block returns empty array", () => {
    expect(findRangedDependencies({})).toEqual([]);
  });
});

describe("findPeerMetaInconsistencies", () => {
  test("every optional peer present in both maps passes", () => {
    const pkg = {
      peerDependencies: { "adm-zip": "^0.5.18", cheerio: "^1.2.0" },
      peerDependenciesMeta: {
        "adm-zip": { optional: true },
        cheerio: { optional: true },
      },
    };
    expect(findPeerMetaInconsistencies(pkg)).toEqual([]);
  });

  test("a peer missing its optional:true meta is flagged", () => {
    const pkg = {
      peerDependencies: { "adm-zip": "^0.5.18" },
      peerDependenciesMeta: {},
    };
    expect(findPeerMetaInconsistencies(pkg)).toEqual([
      {
        name: "adm-zip",
        issue:
          "in peerDependencies but not marked optional in peerDependenciesMeta",
      },
    ]);
  });

  test("a peer marked optional:false is flagged", () => {
    const pkg = {
      peerDependencies: { "adm-zip": "^0.5.18" },
      peerDependenciesMeta: { "adm-zip": { optional: false } },
    };
    expect(findPeerMetaInconsistencies(pkg)).toEqual([
      {
        name: "adm-zip",
        issue:
          "in peerDependencies but not marked optional in peerDependenciesMeta",
      },
    ]);
  });

  test("an orphan meta entry with no matching peer is flagged", () => {
    const pkg = {
      peerDependencies: {},
      peerDependenciesMeta: { "adm-zip": { optional: true } },
    };
    expect(findPeerMetaInconsistencies(pkg)).toEqual([
      {
        name: "adm-zip",
        issue:
          "in peerDependenciesMeta but has no matching peerDependencies entry",
      },
    ]);
  });

  test("missing peer blocks return empty array", () => {
    expect(findPeerMetaInconsistencies({})).toEqual([]);
  });
});
