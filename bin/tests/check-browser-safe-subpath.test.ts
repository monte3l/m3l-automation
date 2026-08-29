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
  extractImportSpecifiers,
  resolveRelativeSpecifier,
  walkImportGraph,
} from "../../bin/lib/browser-safe-subpath.mjs";
import {
  BROWSER_SAFE_SUBPATHS,
  runCheck,
} from "../../bin/check-browser-safe-subpath.mjs";

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

  test("ignores an import-like statement appearing only inside a comment", () => {
    // The old stripComments() pre-pass handled this by deleting comment text
    // before the regex scan ran; the AST parser gets the same result for a
    // different reason — forEachChild never visits comment trivia at all, so
    // a commented-out import is structurally invisible, not textually erased.
    const source = [
      '// import { fake } from "./not-real.js";',
      'import { real } from "./real.js";',
    ].join("\n");
    expect(extractImportSpecifiers(source)).toEqual(["./real.js"]);
  });

  test("ignores an import-like statement inside a TSDoc block comment", () => {
    const source = [
      "/**",
      " * @example",
      " * ```ts",
      ' * import { M3LError } from "@m3l-automation/m3l-common/core";',
      " * ```",
      " */",
      "export class M3LError extends Error {}",
    ].join("\n");
    expect(extractImportSpecifiers(source)).toEqual([]);
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

  // Regression guard for the old regex implementation's failure mode: its
  // `[^;]*?` bounding trick was needed to stop an unrelated later `from`
  // token (e.g. embedded inside a string-literal array like
  // M3L_ERROR_CODES) from misattributing or swallowing the NEXT real import.
  // The AST parser has no such failure mode at all — a string literal inside
  // a `const` array declaration is just a StringLiteral node, never scanned
  // for import-like text — but the property is still worth asserting so a
  // future change to this function can't silently regress it.
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

  // Bug 1 (false negative): a regex-based comment-stripping pre-pass would
  // delete everything between two unrelated `/*`/`*/`-containing string
  // literals, including a real import statement sitting textually between
  // them. The AST parser only strips actual comment trivia, so ordinary
  // string-literal content containing comment-like sequences can never
  // swallow a real import.
  test("a real import sitting between two string literals containing /* and */ sequences is not swallowed", () => {
    const source =
      'const a = "see /* details"; import { readFileSync } from "node:fs"; const b = "more */ text";';
    expect(extractImportSpecifiers(source)).toEqual(["node:fs"]);
  });

  // Bug 2 (false positive): a regex-based scanner reading raw source text
  // cannot distinguish a real import statement from text that merely looks
  // like one inside a template literal. The AST parser sees a
  // NoSubstitutionTemplateLiteral node, not an ImportDeclaration, so nothing
  // is extracted.
  test("import-like text inside a template literal is not misread as a real import", () => {
    const source = 'const sql = `import x from "evil-pkg"`;';
    expect(extractImportSpecifiers(source)).toEqual([]);
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
  const [registeredSubpath] = BROWSER_SAFE_SUBPATHS;
  if (registeredSubpath === undefined) {
    throw new Error(
      "BROWSER_SAFE_SUBPATHS must have at least one entry for this test file",
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reports success and no violations when every registered subpath's graph is clean", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("export {};");
    const reporter = { error: vi.fn(), succeed: vi.fn() };

    const ok = runCheck(reporter);

    expect(ok).toBe(true);
    expect(reporter.succeed).toHaveBeenCalledWith(
      expect.stringContaining(registeredSubpath.subpath),
    );
    expect(reporter.error).not.toHaveBeenCalled();
  });

  test("reports failure and the violating specifier when a registered subpath's graph is not browser-safe", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      'import { readFileSync } from "node:fs";',
    );
    const reporter = { error: vi.fn(), succeed: vi.fn() };

    const ok = runCheck(reporter);

    expect(ok).toBe(false);
    expect(reporter.succeed).not.toHaveBeenCalled();
    expect(reporter.error).toHaveBeenCalledWith(
      expect.stringContaining('"node:fs"'),
      expect.objectContaining({ file: registeredSubpath.entry }),
    );
  });
});
