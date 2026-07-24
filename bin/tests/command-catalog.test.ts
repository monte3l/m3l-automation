import { describe, expect, test } from "vitest";
import {
  COMMAND_CATALOG,
  deriveCommandCatalogDiff,
  groupByFamily,
} from "../lib/command-catalog.mjs";

// ---------------------------------------------------------------------------
// deriveCommandCatalogDiff
// ---------------------------------------------------------------------------

describe("deriveCommandCatalogDiff", () => {
  test("both empty when every script has exactly one catalog row and vice versa", () => {
    const scripts = { build: "turbo run build", lint: "eslint ." };
    const catalog = [
      { name: "build", description: "Compiles the workspace." },
      { name: "lint", description: "Lints the workspace." },
    ];
    expect(deriveCommandCatalogDiff(scripts, catalog)).toEqual({
      missingFromCatalog: [],
      staleInCatalog: [],
    });
  });

  test("a package.json script with no catalog row is missingFromCatalog", () => {
    const scripts = { build: "turbo run build", knip: "knip" };
    const catalog = [{ name: "build", description: "Compiles the workspace." }];
    expect(deriveCommandCatalogDiff(scripts, catalog)).toEqual({
      missingFromCatalog: ["knip"],
      staleInCatalog: [],
    });
  });

  test("a catalog row for a script package.json no longer defines is staleInCatalog", () => {
    const scripts = { build: "turbo run build" };
    const catalog = [
      { name: "build", description: "Compiles the workspace." },
      { name: "removed-script", description: "No longer exists." },
    ];
    expect(deriveCommandCatalogDiff(scripts, catalog)).toEqual({
      missingFromCatalog: [],
      staleInCatalog: ["removed-script"],
    });
  });

  test("reports both directions simultaneously, each sorted", () => {
    const scripts = { zeta: "echo z", alpha: "echo a" };
    const catalog = [
      { name: "omega", description: "stale" },
      { name: "beta", description: "also stale" },
    ];
    expect(deriveCommandCatalogDiff(scripts, catalog)).toEqual({
      missingFromCatalog: ["alpha", "zeta"],
      staleInCatalog: ["beta", "omega"],
    });
  });

  test("an empty scripts object against a non-empty catalog reports everything stale", () => {
    const catalog = [{ name: "build", description: "Compiles the workspace." }];
    expect(deriveCommandCatalogDiff({}, catalog)).toEqual({
      missingFromCatalog: [],
      staleInCatalog: ["build"],
    });
  });

  test("defaults to the real COMMAND_CATALOG when no catalog argument is passed", () => {
    // Exercises the default-parameter branch without needing the real
    // package.json — an empty scripts object against the real (non-empty)
    // catalog reports every real entry as stale, proving the default kicked in.
    const result = deriveCommandCatalogDiff({});
    expect(result.staleInCatalog.length).toBe(COMMAND_CATALOG.length);
    expect(result.missingFromCatalog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupByFamily
// ---------------------------------------------------------------------------

describe("groupByFamily", () => {
  const catalog = [
    { name: "build", description: "Compiles the workspace." },
    { name: "lint", description: "Lints the workspace." },
    { name: "lint:md", description: "Lints markdown." },
    { name: "check:api", description: "Checks the API." },
    { name: "check:hooks", description: "Checks hooks." },
  ];

  test("groups a colon-namespaced name by the substring before its first colon", () => {
    const scripts = { "check:api": "node a.mjs", "check:hooks": "node b.mjs" };
    const groups = groupByFamily(scripts, catalog);
    expect(groups).toEqual([
      {
        family: "check",
        entries: [
          {
            name: "check:api",
            description: "Checks the API.",
            hasDescription: true,
          },
          {
            name: "check:hooks",
            description: "Checks hooks.",
            hasDescription: true,
          },
        ],
      },
    ]);
  });

  test("a bare name merges with its colon-namespaced siblings under the bare name as family", () => {
    const scripts = { lint: "eslint .", "lint:md": "rumdl check ." };
    const groups = groupByFamily(scripts, catalog);
    expect(groups).toEqual([
      {
        family: "lint",
        entries: [
          {
            name: "lint",
            description: "Lints the workspace.",
            hasDescription: true,
          },
          {
            name: "lint:md",
            description: "Lints markdown.",
            hasDescription: true,
          },
        ],
      },
    ]);
  });

  test("a bare name with no colon-siblings is its own single-entry family", () => {
    const scripts = { build: "turbo run build" };
    const groups = groupByFamily(scripts, catalog);
    expect(groups).toEqual([
      {
        family: "build",
        entries: [
          {
            name: "build",
            description: "Compiles the workspace.",
            hasDescription: true,
          },
        ],
      },
    ]);
  });

  test("a script with no catalog entry falls back to its raw command as description, flagged hasDescription: false", () => {
    const scripts = { "gen:mystery": "node bin/mystery.mjs" };
    const groups = groupByFamily(scripts, catalog);
    expect(groups).toEqual([
      {
        family: "gen",
        entries: [
          {
            name: "gen:mystery",
            description: "node bin/mystery.mjs",
            hasDescription: false,
          },
        ],
      },
    ]);
  });

  test("families are sorted alphabetically, and entries within a family are sorted alphabetically", () => {
    const scripts = {
      "lint:md": "rumdl check .",
      build: "turbo run build",
      "check:hooks": "node b.mjs",
      "check:api": "node a.mjs",
      lint: "eslint .",
    };
    const groups = groupByFamily(scripts, catalog);
    expect(groups.map((g) => g.family)).toEqual(["build", "check", "lint"]);
    expect(
      groups.find((g) => g.family === "check")?.entries.map((e) => e.name),
    ).toEqual(["check:api", "check:hooks"]);
    expect(
      groups.find((g) => g.family === "lint")?.entries.map((e) => e.name),
    ).toEqual(["lint", "lint:md"]);
  });

  test("defaults to the real COMMAND_CATALOG when no catalog argument is passed", () => {
    const groups = groupByFamily({ build: "turbo run build" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries[0]?.hasDescription).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// COMMAND_CATALOG — structural sanity, independent of package.json
// ---------------------------------------------------------------------------

describe("COMMAND_CATALOG", () => {
  test("every entry has a unique, non-empty name and a non-empty description", () => {
    const names = new Set<string>();
    for (const entry of COMMAND_CATALOG) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(names.has(entry.name)).toBe(false);
      names.add(entry.name);
    }
  });
});
