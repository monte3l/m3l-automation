/**
 * Tests for the two helpers moved into bin/lib/reference-index.mjs (out of
 * bin/check-doc-exports, which now imports them) so bin/sync-docs.mjs can
 * share them: `baseName` (strip generic parameters for symbol-identity
 * comparison) and `fileExports` (collect the named exports a .ts file
 * declares or re-exports, resolving `export * from "./sibling.js"` one level
 * deep, recursively).
 */
import { describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors script-scaffold.test.ts's
// pattern for the same reason.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { baseName, fileExports } from "../lib/reference-index.mjs";

describe("baseName", () => {
  test("returns a plain symbol unchanged", () => {
    expect(baseName("M3LFoo")).toBe("M3LFoo");
  });

  test("strips a single generic parameter list", () => {
    expect(baseName("M3LResult<T, E>")).toBe("M3LResult");
  });

  test("strips nested generic parameter lists", () => {
    expect(baseName("Foo<Bar<Baz>>")).toBe("Foo");
  });

  test("trims surrounding whitespace", () => {
    expect(baseName("  M3LFoo  ")).toBe("M3LFoo");
  });

  test("trims whitespace left after stripping the generic part", () => {
    expect(baseName("M3LFoo  <T>")).toBe("M3LFoo");
  });

  test("matches across newlines inside the generic parameter list (dotAll)", () => {
    expect(baseName("Foo<\nBar\n>")).toBe("Foo");
  });

  test("returns an empty string when the whole symbol is a generic parameter list", () => {
    expect(baseName("<T>")).toBe("");
  });

  test("returns an empty string for an empty input", () => {
    expect(baseName("")).toBe("");
  });
});

describe("fileExports", () => {
  function mockSources(sources: Record<string, string>) {
    vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathLike) => {
      const key = String(path);
      if (key in sources) return sources[key];
      const error = new Error(
        `ENOENT: no such file or directory, open '${key}'`,
      );
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }) as unknown as typeof fs.readFileSync);
  }

  test("finds direct declaration exports (class, function, const, type, interface, enum)", () => {
    mockSources({
      "/repo/a.ts": [
        "export class M3LFoo {}",
        "export function m3lBar() {}",
        "export const M3L_BAZ = 1;",
        "export type M3LQux = string;",
        "export interface M3LQuux {}",
        "export enum M3LCorge {}",
        "export declare abstract class M3LGrault {}",
      ].join("\n"),
    });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(
      new Set([
        "M3LFoo",
        "m3lBar",
        "M3L_BAZ",
        "M3LQux",
        "M3LQuux",
        "M3LCorge",
        "M3LGrault",
      ]),
    );
  });

  test("finds named-export-list entries, honoring `as` aliases and skipping `default`", () => {
    mockSources({
      "/repo/a.ts": "export { Foo, Bar as Baz, default as Named };",
    });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(
      new Set(["Foo", "Baz", "Named"]),
    );
  });

  test("finds type-only named-export-list entries by their exported name", () => {
    mockSources({ "/repo/a.ts": "export { type Foo, Bar };" });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(
      new Set(["Foo", "Bar"]),
    );
  });

  test("does not surface a bare `export default`", () => {
    mockSources({ "/repo/a.ts": "export default function () {}" });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(new Set());
  });

  test("finds `export * as ns from ...` namespace re-exports", () => {
    mockSources({ "/repo/a.ts": 'export * as Utils from "./utils.js";' });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(new Set(["Utils"]));
  });

  test("resolves a wildcard re-export one level deep", () => {
    const indexPath = join("/repo", "src", "core", "foo", "index.ts");
    const siblingPath = join("/repo", "src", "core", "foo", "impl.ts");
    mockSources({
      [indexPath]: 'export * from "./impl.js";',
      [siblingPath]: "export const M3LFoo = 1;",
    });
    expect(fileExports(indexPath, new Set())).toEqual(new Set(["M3LFoo"]));
  });

  test("merges declarations from the barrel itself with its resolved re-exports", () => {
    const indexPath = join("/repo", "src", "core", "foo", "index.ts");
    const siblingPath = join("/repo", "src", "core", "foo", "impl.ts");
    mockSources({
      [indexPath]: [
        'export * from "./impl.js";',
        "export const M3LDirect = 1;",
      ].join("\n"),
      [siblingPath]: "export const M3LFoo = 1;",
    });
    expect(fileExports(indexPath, new Set())).toEqual(
      new Set(["M3LDirect", "M3LFoo"]),
    );
  });

  test("never follows a bare package specifier re-export", () => {
    mockSources({ "/repo/a.ts": 'export * from "some-package";' });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(new Set());
  });

  test("returns an empty set for a file with no exports", () => {
    mockSources({
      "/repo/a.ts": "const internalOnly = 1;\nfunction helper() {}",
    });
    expect(fileExports("/repo/a.ts", new Set())).toEqual(new Set());
  });

  test("returns an empty set (not a throw) when the file does not exist", () => {
    mockSources({});
    expect(fileExports("/repo/missing.ts", new Set())).toEqual(new Set());
  });

  test("guards against a re-export cycle via the shared `visited` set", () => {
    const aPath = join("/repo", "a.ts");
    const bPath = join("/repo", "b.ts");
    mockSources({
      [aPath]: ['export * from "./b.js";', "export const M3LFromA = 1;"].join(
        "\n",
      ),
      [bPath]: ['export * from "./a.js";', "export const M3LFromB = 1;"].join(
        "\n",
      ),
    });
    // Must terminate (no infinite recursion) and still collect both sides.
    expect(fileExports(aPath, new Set())).toEqual(
      new Set(["M3LFromA", "M3LFromB"]),
    );
  });

  test("does not re-collect a file already present in the caller-supplied visited set", () => {
    const aPath = join("/repo", "a.ts");
    mockSources({ [aPath]: "export const M3LFromA = 1;" });
    const visited = new Set([aPath]);
    expect(fileExports(aPath, visited)).toEqual(new Set());
  });
});
