/**
 * Tests for src/discovery/discover.ts — workspace-root resolution and
 * scripts/* candidate enumeration (m3l-cli 8b contract).
 */
import * as fs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  discoverScripts,
  resolveWorkspaceRoot,
} from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { M3LCliError } from "../src/cli/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A minimal fake fs.Dirent — just enough for a `readdirSync(withFileTypes)` consumer. */
function fakeDirent(name: string, isDirectory: boolean) {
  return { name, isDirectory: () => isDirectory };
}

/**
 * Stubs `fs.readdirSync` to return the given fake dirents, regardless of the
 * generic `Dirent<T>` overload TS would otherwise pick for `withFileTypes` —
 * the cast is on the whole mock implementation (not the array), since
 * `readdirSync`'s overload set makes an element-wise cast fight the
 * `NonSharedBuffer` generic across @types/node versions.
 */
function mockReaddirSync(
  entries: ReadonlyArray<ReturnType<typeof fakeDirent>>,
): void {
  vi.spyOn(fs, "readdirSync").mockImplementation(
    (() => entries) as unknown as typeof fs.readdirSync,
  );
}

describe("resolveWorkspaceRoot", () => {
  test("returns the starting directory when it directly contains pnpm-workspace.yaml", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === join("/repo", "pnpm-workspace.yaml"),
    );

    expect(resolveWorkspaceRoot("/repo")).toBe("/repo");
  });

  test("walks up parent directories until pnpm-workspace.yaml is found", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === join("/repo", "pnpm-workspace.yaml"),
    );

    expect(resolveWorkspaceRoot(join("/repo", "scripts", "foo", "src"))).toBe(
      "/repo",
    );
  });

  test("throws M3LCliError ERR_CLI_WORKSPACE_NOT_FOUND when no ancestor has pnpm-workspace.yaml", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(() =>
      resolveWorkspaceRoot(join("/repo", "scripts", "foo")),
    ).toThrowError(M3LCliError);

    let thrown: unknown;
    try {
      resolveWorkspaceRoot(join("/repo", "scripts", "foo"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_WORKSPACE_NOT_FOUND");
  });
});

describe("discoverScripts", () => {
  test("returns [] when the scripts directory does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(discoverScripts("/repo")).toEqual([]);
  });

  test("lists every scripts/* dir that has a package.json, sorted by name", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      const value = String(path);
      return (
        value === join("/repo", "scripts") ||
        value === join("/repo", "scripts", "zebra", "package.json") ||
        value === join("/repo", "scripts", "alpha", "package.json")
      );
    });
    mockReaddirSync([
      fakeDirent("zebra", true),
      fakeDirent("alpha", true),
      fakeDirent("README.md", false),
    ]);
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === join("/repo", "scripts", "zebra", "package.json")) {
        return JSON.stringify({ description: "zebra script" });
      }
      return JSON.stringify({});
    });

    const result = discoverScripts("/repo");

    expect(result).toEqual([
      {
        name: "alpha",
        directory: join("/repo", "scripts", "alpha"),
        description: "",
      },
      {
        name: "zebra",
        directory: join("/repo", "scripts", "zebra"),
        description: "zebra script",
      },
    ]);
  });

  test("skips a scripts/* entry that is not a directory", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      const value = String(path);
      return (
        value === join("/repo", "scripts") ||
        value === join("/repo", "scripts", "alpha", "package.json")
      );
    });
    mockReaddirSync([
      fakeDirent("alpha", true),
      fakeDirent("not-a-dir.txt", false),
    ]);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({}));

    const result: readonly M3LCliScriptCandidate[] = discoverScripts("/repo");

    expect(
      result.map((candidate: M3LCliScriptCandidate) => candidate.name),
    ).toEqual(["alpha"]);
  });

  test("skips a scripts/* directory that has no package.json", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === join("/repo", "scripts"),
    );
    mockReaddirSync([fakeDirent("no-manifest", true)]);

    expect(discoverScripts("/repo")).toEqual([]);
  });

  test("an empty scripts/ directory returns []", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === join("/repo", "scripts"),
    );
    mockReaddirSync([]);

    expect(discoverScripts("/repo")).toEqual([]);
  });
});

describe("M3LCliScriptCandidate contract", () => {
  test("declares the documented readonly shape", () => {
    expectTypeOf<M3LCliScriptCandidate>().toEqualTypeOf<{
      readonly name: string;
      readonly directory: string;
      readonly description: string;
    }>();
  });
});
