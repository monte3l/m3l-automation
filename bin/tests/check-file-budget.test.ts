import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SRC_CEILING_BYTES,
  TEST_CEILING_BYTES,
  walkMatching,
  isCoverageEligibleSrcFile,
  isTestFile,
  collectBudgetEntries,
  checkBudget,
  buildBaseline,
} from "../check-file-budget.mjs";

describe("SRC_CEILING_BYTES / TEST_CEILING_BYTES", () => {
  test("exports the documented ceilings", () => {
    expect(SRC_CEILING_BYTES).toBe(25_000);
    expect(TEST_CEILING_BYTES).toBe(60_000);
  });
});

describe("walkMatching", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m3l-file-budget-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty directory yields no files", () => {
    expect(walkMatching(dir, () => true)).toEqual([]);
  });

  test("a missing directory yields no files rather than throwing", () => {
    const missing = join(dir, "does-not-exist");
    expect(() => walkMatching(missing, () => true)).not.toThrow();
    expect(walkMatching(missing, () => true)).toEqual([]);
  });

  test("recurses into nested directories and returns matches sorted", () => {
    writeFileSync(join(dir, "a.ts"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    mkdirSync(join(dir, "subdir"), { recursive: true });
    writeFileSync(join(dir, "subdir", "c.ts"), "c");
    mkdirSync(join(dir, "subdir", "nested"), { recursive: true });
    writeFileSync(join(dir, "subdir", "nested", "f.ts"), "f");

    const found = walkMatching(dir, (relPath) => relPath.endsWith(".ts"));

    expect(found).toHaveLength(3);
    expect(found.some((p) => p.endsWith("a.ts"))).toBe(true);
    expect(found.some((p) => p.endsWith(join("subdir", "c.ts")))).toBe(true);
    expect(
      found.some((p) => p.endsWith(join("subdir", "nested", "f.ts"))),
    ).toBe(true);
    // never matched a non-.ts file
    expect(found.some((p) => p.endsWith("b.txt"))).toBe(false);
    // results come back sorted
    expect(found).toEqual([...found].sort());
  });

  test("prunes node_modules and dist subtrees entirely", () => {
    writeFileSync(join(dir, "kept.ts"), "kept");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "skip.ts"), "skip");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "skip.ts"), "skip");

    const found = walkMatching(dir, (relPath) => relPath.endsWith(".ts"));

    expect(found).toHaveLength(1);
    expect(found[0]?.endsWith("kept.ts")).toBe(true);
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    expect(found.some((p) => p.includes("dist"))).toBe(false);
  });
});

describe("isCoverageEligibleSrcFile", () => {
  test.each([
    ["core/foo/M3LFoo.ts", true],
    ["core/foo/M3LFoo.d.ts", false],
    ["index.ts", false],
    ["core/foo/index.ts", false],
    ["core/foo/M3LFoo.test.ts", true],
    ["core/foo/README.md", false],
  ])("isCoverageEligibleSrcFile(%s) -> %s", (relPath, expected) => {
    expect(isCoverageEligibleSrcFile(relPath)).toBe(expected);
  });
});

describe("isTestFile", () => {
  test.each([
    ["core/foo/M3LFoo.test.ts", true],
    ["core/foo/M3LFoo.ts", false],
    ["core/foo/M3LFoo.test.tsx", false],
    ["tests/index.test.ts", true],
  ])("isTestFile(%s) -> %s", (relPath, expected) => {
    expect(isTestFile(relPath)).toBe(expected);
  });
});

describe("collectBudgetEntries", () => {
  test("returns a non-empty array of well-formed entries from the live repo", () => {
    const entries = collectBudgetEntries();

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(["src", "test"]).toContain(entry.category);
      expect(entry.bytes).toBeGreaterThan(0);
      expect(typeof entry.path).toBe("string");
    }
  });
});

describe("checkBudget", () => {
  test("an unbaselined entry over its category ceiling is a violation", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/big.ts",
        bytes: SRC_CEILING_BYTES + 1,
        category: "src" as const,
      },
    ];
    const { violations } = checkBudget(entries, {});
    expect(violations).toEqual([
      {
        path: "packages/m3l-common/src/big.ts",
        bytes: SRC_CEILING_BYTES + 1,
        limit: SRC_CEILING_BYTES,
        baselined: false,
      },
    ]);
  });

  test("an unbaselined entry at-or-under its ceiling is not a violation", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/small.ts",
        bytes: SRC_CEILING_BYTES,
        category: "src" as const,
      },
    ];
    expect(checkBudget(entries, {}).violations).toEqual([]);
  });

  test("a baselined entry that grew past its recorded size is a violation", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/grown.ts",
        bytes: 30_000,
        category: "src" as const,
      },
    ];
    const baseline = { "packages/m3l-common/src/grown.ts": 29_000 };
    expect(checkBudget(entries, baseline).violations).toEqual([
      {
        path: "packages/m3l-common/src/grown.ts",
        bytes: 30_000,
        limit: 29_000,
        baselined: true,
      },
    ]);
  });

  test("a baselined entry exactly at its recorded size is not a violation (strict >, not >=)", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/steady.ts",
        bytes: 29_000,
        category: "src" as const,
      },
    ];
    const baseline = { "packages/m3l-common/src/steady.ts": 29_000 };
    expect(checkBudget(entries, baseline).violations).toEqual([]);
  });

  test("a baselined entry that shrank below its recorded size is not a violation", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/shrunk.ts",
        bytes: 20_000,
        category: "src" as const,
      },
    ];
    const baseline = { "packages/m3l-common/src/shrunk.ts": 29_000 };
    expect(checkBudget(entries, baseline).violations).toEqual([]);
  });

  test("mixed src and test entries are each checked against their own ceiling", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/ok.ts",
        bytes: 100,
        category: "src" as const,
      },
      {
        path: "packages/m3l-common/src/over.ts",
        bytes: SRC_CEILING_BYTES + 500,
        category: "src" as const,
      },
      {
        path: "packages/m3l-common/tests/ok.test.ts",
        bytes: 100,
        category: "test" as const,
      },
      {
        path: "packages/m3l-common/tests/over.test.ts",
        bytes: TEST_CEILING_BYTES + 500,
        category: "test" as const,
      },
    ];
    const { violations } = checkBudget(entries, {});
    expect(violations.map((v) => v.path)).toEqual([
      "packages/m3l-common/src/over.ts",
      "packages/m3l-common/tests/over.test.ts",
    ]);
    expect(violations.every((v) => v.baselined === false)).toBe(true);
  });
});

describe("buildBaseline", () => {
  test("includes only entries currently over their category ceiling, at their exact byte count", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/big.ts",
        bytes: SRC_CEILING_BYTES + 1,
        category: "src" as const,
      },
      {
        path: "packages/m3l-common/src/small.ts",
        bytes: SRC_CEILING_BYTES,
        category: "src" as const,
      },
      {
        path: "packages/m3l-common/tests/big.test.ts",
        bytes: TEST_CEILING_BYTES + 1,
        category: "test" as const,
      },
    ];
    expect(buildBaseline(entries)).toEqual({
      "packages/m3l-common/src/big.ts": SRC_CEILING_BYTES + 1,
      "packages/m3l-common/tests/big.test.ts": TEST_CEILING_BYTES + 1,
    });
  });

  test("a shrunk file that no longer exceeds its ceiling is dropped from the baseline", () => {
    // Regenerating the baseline after a prior over-ceiling file shrank back
    // under its limit must not carry it forward as stale debt.
    const entries = [
      {
        path: "packages/m3l-common/src/was-big.ts",
        bytes: SRC_CEILING_BYTES - 1,
        category: "src" as const,
      },
    ];
    expect(buildBaseline(entries)).toEqual({});
  });

  test("returns a key-sorted object", () => {
    const entries = [
      {
        path: "packages/m3l-common/src/z.ts",
        bytes: SRC_CEILING_BYTES + 1,
        category: "src" as const,
      },
      {
        path: "packages/m3l-common/src/a.ts",
        bytes: SRC_CEILING_BYTES + 1,
        category: "src" as const,
      },
      {
        path: "packages/m3l-common/src/m.ts",
        bytes: SRC_CEILING_BYTES + 1,
        category: "src" as const,
      },
    ];
    expect(Object.keys(buildBaseline(entries))).toEqual([
      "packages/m3l-common/src/a.ts",
      "packages/m3l-common/src/m.ts",
      "packages/m3l-common/src/z.ts",
    ]);
  });
});
