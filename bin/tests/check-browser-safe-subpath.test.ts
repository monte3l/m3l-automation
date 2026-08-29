import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mock setup for node:fs (see bin/tests/check-scaffold-seam.test.ts for the
// established pattern: spread the actual module so vi.spyOn can intercept
// individual methods — ESM namespace objects are non-writable by default).
//
// bin/check-browser-safe-subpath.mjs guards its CLI logic behind
// `process.argv[1] === fileURLToPath(import.meta.url)`, matching every
// sibling bin/ checker — importing the module below for its exported
// helpers has no filesystem side effects and never calls process.exit.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  stripComments,
  extractImportSpecifiers,
  resolveRelativeSpecifier,
  walkImportGraph,
} from "../../bin/lib/browser-safe-subpath.mjs";
import {
  BROWSER_SAFE_SUBPATHS,
  runCheck,
} from "../../bin/check-browser-safe-subpath.mjs";

// ---------------------------------------------------------------------------
// stripComments
// ---------------------------------------------------------------------------

describe("stripComments", () => {
  test("strips a TSDoc block comment showing the published (fake) import path", () => {
    const source = [
      "/**",
      " * @example",
      " * ```ts",
      ' * import { M3LError } from "@m3l-automation/m3l-common/core";',
      " * ```",
      " */",
      "export class M3LError extends Error {}",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toContain("@m3l-automation/m3l-common/core");
    expect(stripped).toContain("export class M3LError extends Error {}");
  });

  test("strips a trailing line comment", () => {
    const source = 'const x = 1; // import "node:fs"';
    expect(stripComments(source)).toBe("const x = 1; ");
  });

  test("leaves real code untouched when there are no comments", () => {
    const source = 'import { readFileSync } from "node:fs";\nconst a = 1;';
    expect(stripComments(source)).toBe(source);
  });

  test("fully removes a block comment spanning multiple lines", () => {
    const source = [
      "const before = 1;",
      "/*",
      " * a long comment",
      ' * import "node:crypto"',
      " */",
      "const after = 2;",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toContain("a long comment");
    expect(stripped).not.toContain("node:crypto");
    expect(stripped).toContain("const before = 1;");
    expect(stripped).toContain("const after = 2;");
  });
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers
// ---------------------------------------------------------------------------

describe("extractImportSpecifiers", () => {
  test("extracts a named import specifier", () => {
    expect(extractImportSpecifiers('import { x } from "./a.js";')).toEqual([
      "./a.js",
    ]);
  });

  test("extracts a namespace import specifier", () => {
    expect(extractImportSpecifiers('import * as ns from "./b.js";')).toEqual([
      "./b.js",
    ]);
  });

  test("extracts a bare side-effect import specifier", () => {
    expect(extractImportSpecifiers('import "./x.js";')).toEqual(["./x.js"]);
  });

  test("extracts a re-export specifier", () => {
    expect(extractImportSpecifiers('export * from "./y.js";')).toEqual([
      "./y.js",
    ]);
  });

  test("extracts a dynamic import() call specifier", () => {
    expect(extractImportSpecifiers('const m = import("./z.js");')).toEqual([
      "./z.js",
    ]);
  });

  test("ignores an import-like string appearing only inside a comment", () => {
    const source = [
      '// import { fake } from "./not-real.js";',
      'import { real } from "./real.js";',
    ].join("\n");
    expect(extractImportSpecifiers(source)).toEqual(["./real.js"]);
  });

  test("extracts specifiers from multiple statements in appearance order", () => {
    const source = [
      'import { a } from "./a.js";',
      'import { b } from "./b.js";',
      'export * from "./c.js";',
    ].join("\n");
    expect(extractImportSpecifiers(source)).toEqual([
      "./a.js",
      "./b.js",
      "./c.js",
    ]);
  });

  // The regex's `[^;]*?` class bounds the import/export branch to a single
  // statement. A `[\s\S]*?` lazy match would instead skip past an unrelated
  // later `from` token (e.g. embedded inside a large string-literal array
  // like M3L_ERROR_CODES) and misattribute the NEXT real import statement's
  // specifier to the FIRST import keyword found, or swallow it entirely.
  test("an unrelated later occurrence of the word 'from' inside a string/array literal does not swallow the next real import", () => {
    const source = [
      'import { first } from "./first.js";',
      "export const M3L_ERROR_CODES = [",
      '  "derived from upstream data",',
      '  "converted from legacy format",',
      "];",
      'import { second } from "./second.js";',
    ].join("\n");
    expect(extractImportSpecifiers(source)).toEqual([
      "./first.js",
      "./second.js",
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveRelativeSpecifier
// ---------------------------------------------------------------------------

describe("resolveRelativeSpecifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a .js-suffixed specifier resolves to the sibling .ts file", () => {
    const result = resolveRelativeSpecifier(
      "/repo/src/index.ts",
      "./catalog.js",
    );
    expect(result).toBe("/repo/src/catalog.ts");
  });

  test("an extension-less specifier resolves to <path>.ts when it exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith("helper.ts"),
    );
    const result = resolveRelativeSpecifier("/repo/src/index.ts", "./helper");
    expect(result).toBe("/repo/src/helper.ts");
  });

  test("an extension-less specifier falls back to <path>/index.ts when <path>.ts does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = resolveRelativeSpecifier("/repo/src/index.ts", "./sub");
    expect(result).toBe("/repo/src/sub/index.ts");
  });
});

// ---------------------------------------------------------------------------
// walkImportGraph
// ---------------------------------------------------------------------------

describe("walkImportGraph", () => {
  test("a clean multi-file graph with only relative imports returns no violations", () => {
    const files: Record<string, string> = {
      "/repo/entry.ts": 'import { a } from "./a.js";',
      "/repo/a.ts": 'import { b } from "./b.js";',
      "/repo/b.ts": "export const b = 1;",
    };
    const readFile = vi.fn((path: string): string => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`no fixture for ${path}`);
      }
      return content;
    });

    const result = walkImportGraph("/repo/entry.ts", { readFile });

    expect(result.violations).toEqual([]);
    expect(result.visited.sort()).toEqual(
      ["/repo/entry.ts", "/repo/a.ts", "/repo/b.ts"].sort(),
    );
  });

  test("a node: builtin import and a bare package import produce exactly those two violations", () => {
    const files: Record<string, string> = {
      "/repo/entry.ts": [
        'import { readFileSync } from "node:fs";',
        'import { z } from "zod";',
        'import { a } from "./a.js";',
      ].join("\n"),
      "/repo/a.ts": "export const a = 1;",
    };
    const readFile = vi.fn((path: string): string => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`no fixture for ${path}`);
      }
      return content;
    });

    const result = walkImportGraph("/repo/entry.ts", { readFile });

    expect(result.violations).toEqual([
      { file: "/repo/entry.ts", specifier: "node:fs" },
      { file: "/repo/entry.ts", specifier: "zod" },
    ]);
  });

  test("a two-file mutual-import cycle terminates without duplicating either file", () => {
    const files: Record<string, string> = {
      "/repo/a.ts": 'import { b } from "./b.js";',
      "/repo/b.ts": 'import { a } from "./a.js";',
    };
    const readFile = vi.fn((path: string): string => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`no fixture for ${path}`);
      }
      return content;
    });

    const result = walkImportGraph("/repo/a.ts", { readFile });

    expect(result.visited).toHaveLength(2);
    expect(result.visited.sort()).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(result.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BROWSER_SAFE_SUBPATHS
// ---------------------------------------------------------------------------

describe("BROWSER_SAFE_SUBPATHS", () => {
  test("contains the ./core/errors entry with the expected entry path", () => {
    expect(BROWSER_SAFE_SUBPATHS).toContainEqual({
      subpath: "./core/errors",
      entry: "packages/m3l-common/src/core/errors/index.ts",
    });
  });
});

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

describe("runCheck", () => {
  test("against the real core/errors submodule reports success and no violations", () => {
    const reporter = { error: vi.fn(), succeed: vi.fn() };

    const ok = runCheck(reporter);

    expect(ok).toBe(true);
    expect(reporter.succeed).toHaveBeenCalled();
    expect(reporter.error).not.toHaveBeenCalled();
  });
});
