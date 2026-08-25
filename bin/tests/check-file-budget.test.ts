import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock setup for walkMatching / collectBudgetEntries (node:fs) and
// collectBudgetEntriesAtRef / readBaselineAtRef (node:child_process)
// ---------------------------------------------------------------------------
//
// Spread the actual fs so vi.spyOn can intercept individual methods (ESM
// namespace objects are non-writable by default — the spread makes them
// plain, writable object properties), following
// bin/tests/check-test-counts.test.ts and bin/tests/check-scaffold-seam.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

// Same vi.hoisted + vi.mock pattern bin/tests/check-test-counts.test.ts uses
// for spawnSync — execFileSync here.
const h = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: h.execFileSync,
}));

import {
  SRC_CEILING_BYTES,
  TEST_CEILING_BYTES,
  walkMatching,
  isCoverageEligibleSrcFile,
  isTestFile,
  classifyRefPath,
  collectBudgetEntries,
  collectBudgetEntriesAtRef,
  readBaselineAtRef,
  parseRefArg,
  checkBudget,
  buildBaseline,
} from "../check-file-budget.mjs";

// check-file-budget.mjs computes `root` as
// dirname(dirname(fileURLToPath(import.meta.url)))` from its own location
// (bin/check-file-budget.mjs), i.e. the repo root. This test file lives one
// directory deeper (bin/tests/), so the same repo root needs one extra
// dirname() hop from here.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packagesDir = join(root, "packages");

/** Minimal fake `Dirent` satisfying the shape `walkMatching` reads. */
function fakeDirent(name: string, kind: "file" | "dir") {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  };
}

describe("SRC_CEILING_BYTES / TEST_CEILING_BYTES", () => {
  test("exports the documented ceilings", () => {
    expect(SRC_CEILING_BYTES).toBe(25_000);
    expect(TEST_CEILING_BYTES).toBe(60_000);
  });
});

describe("walkMatching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("an empty directory yields no files", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([]);

    expect(walkMatching("/fake/empty-dir", () => true)).toEqual([]);
  });

  test("a missing directory yields no files rather than throwing", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      const error = new Error(
        "ENOENT: no such file or directory",
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const missing = "/fake/does-not-exist";

    expect(() => walkMatching(missing, () => true)).not.toThrow();
    expect(walkMatching(missing, () => true)).toEqual([]);
  });

  test("recurses into nested directories and returns matches sorted", () => {
    const dir = "/fake/nested-test";
    const subdir = join(dir, "subdir");
    const nested = join(subdir, "nested");

    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      const path = String(current);
      if (path === dir) {
        return [
          fakeDirent("a.ts", "file"),
          fakeDirent("b.txt", "file"),
          fakeDirent("subdir", "dir"),
        ];
      }
      if (path === subdir) {
        return [fakeDirent("c.ts", "file"), fakeDirent("nested", "dir")];
      }
      if (path === nested) {
        return [fakeDirent("f.ts", "file")];
      }
      throw new Error(`unexpected readdirSync call: ${path}`);
    }) as unknown as typeof fs.readdirSync);

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
    const dir = "/fake/prune-test";

    // A readdirSync call into either pruned subtree throws, so this test
    // fails loudly (rather than just missing an assertion) if walkMatching
    // ever descends into node_modules/ or dist/ instead of skipping them.
    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      const path = String(current);
      if (path === dir) {
        return [
          fakeDirent("kept.ts", "file"),
          fakeDirent("node_modules", "dir"),
          fakeDirent("dist", "dir"),
        ];
      }
      throw new Error(
        `unexpected readdirSync call into pruned subtree: ${path}`,
      );
    }) as unknown as typeof fs.readdirSync);

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

describe("classifyRefPath", () => {
  test.each([
    ["packages/m3l-common/src/core/foo/M3LFoo.ts", "src"],
    ["packages/m3l-common/tests/core/foo/M3LFoo.test.ts", "test"],
    ["packages/m3l-common/src/core/foo/index.ts", null],
    ["packages/m3l-common/src/core/foo/M3LFoo.d.ts", null],
    ["packages/m3l-common/tests/core/foo/helper.ts", null],
    ["bin/check-file-budget.mjs", null],
  ])("classifyRefPath(%s) -> %s", (relPath, expected) => {
    expect(classifyRefPath(relPath)).toBe(expected);
  });
});

describe("collectBudgetEntries", () => {
  const pkgADir = join(packagesDir, "fake-pkg-a");
  const pkgASrcDir = join(pkgADir, "src");
  const pkgATestsDir = join(pkgADir, "tests");
  const pkgBDir = join(packagesDir, "fake-pkg-b");
  const pkgBSrcDir = join(pkgBDir, "src");
  const pkgBTestsDir = join(pkgBDir, "tests");

  const fooTsPath = join(pkgASrcDir, "Foo.ts");
  const fooTestPath = join(pkgATestsDir, "Foo.test.ts");
  const barTsPath = join(pkgBSrcDir, "Bar.ts");
  const barTestPath = join(pkgBTestsDir, "Bar.test.ts");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns correctly-shaped entries (path, bytes, category) for a synthetic packages/ layout", () => {
    const fooContent = "export const foo = 1;";
    const fooTestContent = "test('foo', () => {});";
    const barContent = "export const bar = 2;";
    const barTestContent = "test('bar', () => {});";

    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      const path = String(current);
      if (path === packagesDir) {
        return [
          fakeDirent("fake-pkg-a", "dir"),
          fakeDirent("fake-pkg-b", "dir"),
        ];
      }
      if (path === pkgASrcDir) {
        // index.ts and Foo.d.ts are noise that isCoverageEligibleSrcFile
        // must filter out.
        return [
          fakeDirent("Foo.ts", "file"),
          fakeDirent("index.ts", "file"),
          fakeDirent("Foo.d.ts", "file"),
        ];
      }
      if (path === pkgATestsDir) {
        // helper.ts is noise that isTestFile must filter out.
        return [
          fakeDirent("Foo.test.ts", "file"),
          fakeDirent("helper.ts", "file"),
        ];
      }
      if (path === pkgBSrcDir) {
        return [fakeDirent("Bar.ts", "file")];
      }
      if (path === pkgBTestsDir) {
        return [fakeDirent("Bar.test.ts", "file")];
      }
      const error = new Error(
        `unexpected readdirSync call: ${path}`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }) as unknown as typeof fs.readdirSync);

    vi.spyOn(fs, "readFileSync").mockImplementation(((path: string) => {
      const p = String(path);
      if (p === fooTsPath) return fooContent;
      if (p === fooTestPath) return fooTestContent;
      if (p === barTsPath) return barContent;
      if (p === barTestPath) return barTestContent;
      throw new Error(`unexpected readFileSync call: ${p}`);
    }) as typeof fs.readFileSync);

    const entries = collectBudgetEntries();

    const expected = [
      {
        path: relative(root, fooTsPath),
        bytes: Buffer.byteLength(fooContent, "utf8"),
        category: "src" as const,
      },
      {
        path: relative(root, fooTestPath),
        bytes: Buffer.byteLength(fooTestContent, "utf8"),
        category: "test" as const,
      },
      {
        path: relative(root, barTsPath),
        bytes: Buffer.byteLength(barContent, "utf8"),
        category: "src" as const,
      },
      {
        path: relative(root, barTestPath),
        bytes: Buffer.byteLength(barTestContent, "utf8"),
        category: "test" as const,
      },
    ].sort((a, b) => a.path.localeCompare(b.path));

    expect(entries).toEqual(expected);
  });

  test("propagates a readdirSync(packages/) failure rather than swallowing it into an empty array", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(((current: string) => {
      const path = String(current);
      if (path === packagesDir) {
        throw new Error("EACCES: permission denied");
      }
      throw new Error(`unexpected readdirSync call: ${path}`);
    }) as typeof fs.readdirSync);

    expect(() => collectBudgetEntries()).toThrow("EACCES: permission denied");
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

describe("collectBudgetEntriesAtRef", () => {
  afterEach(() => {
    h.execFileSync.mockReset();
  });

  test("filters a git ls-tree listing through classifyRefPath and shapes/sorts the survivors", () => {
    const listing = [
      "packages/m3l-common/src/core/foo/M3LFoo.ts",
      "packages/m3l-common/src/core/foo/index.ts",
      "packages/m3l-common/tests/core/foo/M3LFoo.test.ts",
      "packages/m3l-common/tests/core/foo/helper.ts",
      "bin/check-file-budget.mjs",
      "",
    ].join("\n");
    const sizeByPath: Record<string, string> = {
      "packages/m3l-common/src/core/foo/M3LFoo.ts": "1234",
      "packages/m3l-common/tests/core/foo/M3LFoo.test.ts": "5678",
    };

    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "ls-tree") return listing;
      if (args[0] === "cat-file" && args[1] === "-s") {
        const target = String(args[2]);
        const path = target.slice(target.indexOf(":") + 1);
        return sizeByPath[path] ?? "0";
      }
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });

    expect(collectBudgetEntriesAtRef("main")).toEqual([
      {
        path: "packages/m3l-common/src/core/foo/M3LFoo.ts",
        bytes: 1234,
        category: "src",
      },
      {
        path: "packages/m3l-common/tests/core/foo/M3LFoo.test.ts",
        bytes: 5678,
        category: "test",
      },
    ]);
  });
});

describe("readBaselineAtRef", () => {
  afterEach(() => {
    h.execFileSync.mockReset();
  });

  test("returns the parsed baseline when present at ref", () => {
    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "cat-file" && args[1] === "-e") return "";
      if (args[0] === "show")
        return '{"packages/m3l-common/src/big.ts": 30000}\n';
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });

    expect(readBaselineAtRef("main")).toEqual({
      "packages/m3l-common/src/big.ts": 30000,
    });
  });

  test("returns {} when the baseline is missing at ref", () => {
    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "cat-file" && args[1] === "-e") {
        throw new Error(
          "fatal: Not a valid object name main:bin/file-budget-baseline.json",
        );
      }
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });

    expect(readBaselineAtRef("main")).toEqual({});
  });

  test("propagates a JSON.parse failure on an invalid baseline rather than swallowing it", () => {
    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "cat-file" && args[1] === "-e") return "";
      if (args[0] === "show") return "{not valid json";
      throw new Error(`unexpected execFileSync call: ${JSON.stringify(args)}`);
    });

    expect(() => readBaselineAtRef("main")).toThrow();
  });
});

describe("parseRefArg", () => {
  test("returns the value following --ref", () => {
    expect(parseRefArg(["--ref", "main"])).toBe("main");
  });

  test("returns undefined when --ref is absent", () => {
    expect(parseRefArg(["--update"])).toBeUndefined();
  });
});
