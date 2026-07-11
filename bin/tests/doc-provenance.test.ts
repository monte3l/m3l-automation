import { describe, expect, test } from "vitest";
import {
  parseHeadings,
  isSymbolExported,
  hashBlobs,
  verifySidecarSections,
  applyBlobUpdates,
} from "../lib/doc-provenance.mjs";

describe("parseHeadings", () => {
  test("extracts heading text across levels 1-6", () => {
    const md = [
      "# Title",
      "some prose",
      "## Section A",
      "### `Nested`",
      "not a heading #hashtag",
    ].join("\n");
    expect(parseHeadings(md)).toEqual(["Title", "Section A", "`Nested`"]);
  });

  test("returns an empty array when there are no headings", () => {
    expect(parseHeadings("just prose\nmore prose")).toEqual([]);
  });
});

describe("isSymbolExported", () => {
  test("finds a direct export", () => {
    expect(isSymbolExported("export class M3LFoo {}", "M3LFoo")).toBe(true);
    expect(isSymbolExported("export interface M3LFoo {}", "M3LFoo")).toBe(true);
    expect(isSymbolExported("export const M3LFoo = 1;", "M3LFoo")).toBe(true);
  });

  test("finds a named-export block", () => {
    expect(isSymbolExported("export { M3LFoo, M3LBar };", "M3LFoo")).toBe(true);
  });

  test("returns false when the symbol is absent", () => {
    expect(isSymbolExported("export class M3LFoo {}", "M3LBar")).toBe(false);
  });

  test("escapes regex metacharacters so a dot isn't treated as a wildcard", () => {
    // Unescaped, "." in the symbol would match any character, so this would
    // false-positive against an unrelated "M3LFooXBar" export.
    expect(isSymbolExported("export const M3LFooXBar = 1;", "M3LFoo.Bar")).toBe(
      false,
    );
  });
});

describe("hashBlobs", () => {
  test("maps each file to its blob line in order", () => {
    const runGit = (args: string[]) => {
      expect(args[0]).toBe("hash-object");
      return { status: 0, stdout: "blob1\nblob2\n" };
    };
    const map = hashBlobs("/repo", ["a.ts", "b.ts"], runGit);
    expect(map.get("a.ts")).toBe("blob1");
    expect(map.get("b.ts")).toBe("blob2");
  });

  test("deduplicates repeated files before spawning", () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "blob1\n" };
    };
    hashBlobs("/repo", ["a.ts", "a.ts"], runGit);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["hash-object", "--", "a.ts"]);
  });

  test("throws (rather than silently returning an empty map) on a failed batch", () => {
    // A swallowed failure here would make every blob resolve to `undefined`,
    // which verifySidecarSections treats as "nothing to compare against" and
    // silently skips — disabling staleness detection repo-wide.
    const runGit = () => ({
      status: 1,
      stdout: "",
      stderr: "fatal: bad object",
    });
    expect(() => hashBlobs("/repo", ["a.ts"], runGit)).toThrow(
      /git hash-object failed \(exit 1\): fatal: bad object/,
    );
  });

  test("returns an empty map for an empty file list without spawning", () => {
    const runGit = () => {
      throw new Error("should not be called");
    };
    expect(hashBlobs("/repo", [], runGit).size).toBe(0);
  });
});

describe("verifySidecarSections", () => {
  const baseData = {
    sections: [
      {
        heading: "Public API",
        sources: [{ file: "src/a.ts", symbol: "Foo", blob: "blob-old" }],
      },
    ],
  };

  test("passes clean when the heading exists, symbol is exported, and blob matches", () => {
    const { errors, warnings, staleSources } = verifySidecarSections(
      baseData,
      ["Public API"],
      {
        fileExists: () => true,
        symbolCheck: () => true,
        blobOf: () => "blob-old",
      },
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(staleSources).toEqual([]);
  });

  test("warns and records a stale source when the blob changed", () => {
    const { errors, warnings, staleSources } = verifySidecarSections(
      baseData,
      ["Public API"],
      {
        fileExists: () => true,
        symbolCheck: () => true,
        blobOf: () => "blob-new",
      },
    );
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(staleSources).toEqual([
      { sectionIndex: 0, sourceIndex: 0, file: "src/a.ts", blob: "blob-new" },
    ]);
  });

  test("treats a source with no recorded blob yet as stale (first-time stamp)", () => {
    const unstamped = {
      sections: [
        {
          heading: "Public API",
          sources: [{ file: "src/a.ts", symbol: "Foo" }],
        },
      ],
    };
    const { staleSources } = verifySidecarSections(unstamped, ["Public API"], {
      fileExists: () => true,
      symbolCheck: () => true,
      blobOf: () => "blob-current",
    });
    expect(staleSources).toEqual([
      {
        sectionIndex: 0,
        sourceIndex: 0,
        file: "src/a.ts",
        blob: "blob-current",
      },
    ]);
  });

  test("hard errors when the heading is missing from the doc", () => {
    const { errors } = verifySidecarSections(baseData, ["Other Heading"], {
      fileExists: () => true,
      symbolCheck: () => true,
      blobOf: () => "blob-old",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/heading "Public API" not found/);
  });

  test("hard errors when the source file does not exist, and skips the symbol/blob checks for it", () => {
    let symbolCheckCalled = false;
    const { errors, warnings } = verifySidecarSections(
      baseData,
      ["Public API"],
      {
        fileExists: () => false,
        symbolCheck: () => {
          symbolCheckCalled = true;
          return true;
        },
        blobOf: () => "blob-old",
      },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/source file not found: src\/a\.ts/);
    expect(warnings).toEqual([]);
    expect(symbolCheckCalled).toBe(false);
  });

  test("hard errors when the symbol is no longer exported", () => {
    const { errors } = verifySidecarSections(baseData, ["Public API"], {
      fileExists: () => true,
      symbolCheck: () => false,
      blobOf: () => "blob-old",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"Foo" not exported from src\/a\.ts/);
  });

  test("does not warn when the current blob is unresolved (file outside the hashed batch)", () => {
    const { warnings, staleSources } = verifySidecarSections(
      baseData,
      ["Public API"],
      {
        fileExists: () => true,
        symbolCheck: () => true,
        blobOf: () => undefined,
      },
    );
    expect(warnings).toEqual([]);
    expect(staleSources).toEqual([]);
  });
});

describe("applyBlobUpdates", () => {
  const data = {
    sections: [
      {
        heading: "Public API",
        sources: [{ file: "src/a.ts", symbol: "Foo", blob: "old-a" }],
        commit: "deadbeef",
        retrieved: "2026-01-01",
      },
      {
        heading: "Notes",
        sources: [{ file: "src/b.ts", symbol: "Bar", blob: "old-b" }],
        commit: "deadbeef",
        retrieved: "2026-01-01",
      },
    ],
  };

  test("returns null when nothing is stale (safe bare --update)", () => {
    expect(applyBlobUpdates(data, [], "2026-07-11")).toBeNull();
  });

  test("stamps the blob and bumps retrieved only for touched sections", () => {
    const next = applyBlobUpdates(
      data,
      [{ sectionIndex: 0, sourceIndex: 0, blob: "new-a" }],
      "2026-07-11",
    );
    expect(next.sections[0].sources[0].blob).toBe("new-a");
    expect(next.sections[0].retrieved).toBe("2026-07-11");
    // untouched section is left alone
    expect(next.sections[1].sources[0].blob).toBe("old-b");
    expect(next.sections[1].retrieved).toBe("2026-01-01");
  });

  test("strips the legacy commit field from every section on write", () => {
    const next = applyBlobUpdates(
      data,
      [{ sectionIndex: 0, sourceIndex: 0, blob: "new-a" }],
      "2026-07-11",
    );
    expect(next.sections[0].commit).toBeUndefined();
    expect(next.sections[1].commit).toBeUndefined();
  });

  test("does not mutate the input data", () => {
    const before = JSON.stringify(data);
    applyBlobUpdates(
      data,
      [{ sectionIndex: 0, sourceIndex: 0, blob: "new-a" }],
      "2026-07-11",
    );
    expect(JSON.stringify(data)).toBe(before);
  });
});
