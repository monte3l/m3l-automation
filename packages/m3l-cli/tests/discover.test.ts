/**
 * Tests for src/discovery/discover.ts — workspace-root resolution and
 * scripts/* candidate enumeration (m3l-cli 8b contract).
 */
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

// Same non-writable-ESM-namespace reason, so vi.spyOn can override
// createRequire's return value to simulate a resolveScriptManifestDefault
// failure carrying a specific `.code` (see the "resolveScriptManifestDefault
// error narrowing" describe block below).
vi.mock("node:module", async () => {
  const actual = await vi.importActual<typeof nodeModule>("node:module");
  return { ...actual };
});

import {
  diagnoseDependencyGraph,
  discoverScripts,
  discoverScriptsFromDependencyGraph,
  resolveWorkspaceRoot,
} from "../src/discovery/discover.js";
import type {
  M3LCliDependencyGraphOptions,
  M3LCliDependencyGraphStatus,
  M3LCliScriptCandidate,
} from "../src/discovery/discover.js";
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

/**
 * discoverScriptsFromDependencyGraph / diagnoseDependencyGraph (U7, ADR-0054
 * — "discovery starts resolving over the dependency graph"). Neither reads
 * the real workspace: both accept an injectable `M3LCliDependencyGraphOptions`
 * seam (`readOwnManifest`/`resolveScriptManifest`) mirroring
 * `M3LCliInProcessImportOptions.importModule` (run/in-process.ts) and
 * `M3LCliSpawnOptions.spawnImpl` (run/spawn.ts) — the CLI's own established
 * injectable-override pattern for a collaborator that would otherwise be a
 * real dynamic import / real child process / (here) a real fs read + real
 * Node module resolution against the live, potentially-drifting workspace
 * dependency graph.
 */
describe("discoverScriptsFromDependencyGraph", () => {
  function buildGraphOptions(
    dependencies: Readonly<Record<string, string>>,
    resolutions: Readonly<Record<string, string | undefined>>,
  ): M3LCliDependencyGraphOptions {
    return {
      readOwnManifest: () => ({ dependencies }),
      resolveScriptManifest: (depName: string) => resolutions[depName],
    };
  }

  test("resolves each declared @m3l-automation/* dependency (minus m3l-common) to a candidate", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === "/graph/json-etl/package.json") {
        return JSON.stringify({ description: "JSON ETL" });
      }
      return JSON.stringify({});
    });

    const options = buildGraphOptions(
      {
        "@m3l-automation/m3l-common": "workspace:*",
        "@m3l-automation/json-etl": "workspace:*",
        "@m3l-automation/s3-objects": "workspace:*",
      },
      {
        "@m3l-automation/json-etl": "/graph/json-etl/package.json",
        "@m3l-automation/s3-objects": "/graph/s3-objects/package.json",
      },
    );

    const result = discoverScriptsFromDependencyGraph(options);

    expect(result).toEqual([
      {
        name: "json-etl",
        directory: "/graph/json-etl",
        description: "JSON ETL",
      },
      {
        name: "s3-objects",
        directory: "/graph/s3-objects",
        description: "",
      },
    ]);
  });

  test("excludes @m3l-automation/m3l-common — it is the library, never a script", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({}));
    const options = buildGraphOptions(
      { "@m3l-automation/m3l-common": "workspace:*" },
      { "@m3l-automation/m3l-common": "/graph/m3l-common/package.json" },
    );

    expect(discoverScriptsFromDependencyGraph(options)).toEqual([]);
  });

  test("excludes a non-@m3l-automation dependency entirely", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({}));
    const options = buildGraphOptions(
      { "some-other-package": "^1.0.0" },
      { "some-other-package": "/node_modules/some-other-package/package.json" },
    );

    expect(discoverScriptsFromDependencyGraph(options)).toEqual([]);
  });

  test("never throws: a declared dependency that fails to resolve is silently skipped", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === "/graph/json-etl/package.json") {
        return JSON.stringify({ description: "JSON ETL" });
      }
      return JSON.stringify({});
    });
    const options = buildGraphOptions(
      {
        "@m3l-automation/json-etl": "workspace:*",
        "@m3l-automation/stale-symlink": "workspace:*",
      },
      {
        "@m3l-automation/json-etl": "/graph/json-etl/package.json",
        // "@m3l-automation/stale-symlink" intentionally omitted — resolves to undefined
      },
    );

    expect(() => discoverScriptsFromDependencyGraph(options)).not.toThrow();
    expect(discoverScriptsFromDependencyGraph(options)).toEqual([
      {
        name: "json-etl",
        directory: "/graph/json-etl",
        description: "JSON ETL",
      },
    ]);
  });

  test("no declared @m3l-automation/* dependencies returns []", () => {
    const options = buildGraphOptions({}, {});

    expect(discoverScriptsFromDependencyGraph(options)).toEqual([]);
  });
});

describe("diagnoseDependencyGraph", () => {
  function buildGraphOptions(
    dependencies: Readonly<Record<string, string>>,
    resolutions: Readonly<Record<string, string | undefined>>,
  ): M3LCliDependencyGraphOptions {
    return {
      readOwnManifest: () => ({ dependencies }),
      resolveScriptManifest: (depName: string) => resolutions[depName],
    };
  }

  test("reports every declared dependency as resolved when all resolve", () => {
    const options = buildGraphOptions(
      {
        "@m3l-automation/json-etl": "workspace:*",
        "@m3l-automation/s3-objects": "workspace:*",
      },
      {
        "@m3l-automation/json-etl": "/graph/json-etl/package.json",
        "@m3l-automation/s3-objects": "/graph/s3-objects/package.json",
      },
    );

    const status: M3LCliDependencyGraphStatus =
      diagnoseDependencyGraph(options);

    expect(status.resolved.toSorted()).toEqual(["json-etl", "s3-objects"]);
    expect(status.unresolved).toEqual([]);
  });

  test("names an unresolvable declared dependency in `unresolved`, by its script name (not the scoped package name)", () => {
    const options = buildGraphOptions(
      {
        "@m3l-automation/json-etl": "workspace:*",
        "@m3l-automation/stale-symlink": "workspace:*",
      },
      {
        "@m3l-automation/json-etl": "/graph/json-etl/package.json",
      },
    );

    const status = diagnoseDependencyGraph(options);

    expect(status.resolved).toEqual(["json-etl"]);
    expect(status.unresolved).toEqual(["stale-symlink"]);
  });

  test("zero declared @m3l-automation/* dependencies is reported as an empty resolved/unresolved pair", () => {
    const status = diagnoseDependencyGraph(buildGraphOptions({}, {}));

    expect(status.resolved).toEqual([]);
    expect(status.unresolved).toEqual([]);
  });
});

/**
 * resolveScriptManifestDefault's caught-error narrowing (Should-fix,
 * silent-failure-hunter review of #531): the real default resolver — used
 * whenever `options.resolveScriptManifest` is NOT supplied — currently
 * treats every `require.resolve` failure identically as "unresolved"
 * (`undefined`), discarding the real failure reason. The fix narrows the
 * catch to Node's `MODULE_NOT_FOUND` code only (mirroring
 * `commands/doctor.ts`'s `isPermissionDenied` pattern), re-throwing any
 * other error. These tests exercise the REAL default resolver (no
 * `resolveScriptManifest` override), since the bug lives inside
 * `resolveScriptManifestDefault` itself, not at the
 * `discoverScriptsFromDependencyGraph`/`diagnoseDependencyGraph` call sites.
 */
describe("diagnoseDependencyGraph / discoverScriptsFromDependencyGraph — resolveScriptManifestDefault's error narrowing", () => {
  test("a MODULE_NOT_FOUND resolution failure (the expected, tolerated case — a declared-but-not-yet-installed dependency) is still classified as unresolved", () => {
    // A real, deterministic Node module resolution failure: this package
    // name never exists in node_modules, so createRequire(...).resolve(...)
    // throws a genuine MODULE_NOT_FOUND — no mocking needed for this arm.
    const options: M3LCliDependencyGraphOptions = {
      readOwnManifest: () => ({
        dependencies: {
          "@m3l-automation/definitely-not-a-real-package-xyz": "workspace:*",
        },
      }),
    };

    const status = diagnoseDependencyGraph(options);

    expect(status.unresolved).toEqual(["definitely-not-a-real-package-xyz"]);
    expect(status.resolved).toEqual([]);
  });

  test("a non-MODULE_NOT_FOUND resolution failure (e.g. ERR_PACKAGE_PATH_NOT_EXPORTED) propagates from diagnoseDependencyGraph rather than being silently classified as unresolved", () => {
    vi.spyOn(nodeModule, "createRequire").mockReturnValue({
      resolve: () => {
        throw Object.assign(
          new Error("Package subpath './package.json' is not defined"),
          { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
        );
      },
    } as unknown as ReturnType<typeof nodeModule.createRequire>);

    const options: M3LCliDependencyGraphOptions = {
      readOwnManifest: () => ({
        dependencies: { "@m3l-automation/some-script": "workspace:*" },
      }),
    };

    expect(() => diagnoseDependencyGraph(options)).toThrow();
  });

  test("a resolution failure with no .code at all also propagates from diagnoseDependencyGraph, synchronously", () => {
    vi.spyOn(nodeModule, "createRequire").mockReturnValue({
      resolve: () => {
        throw new Error("unexpected resolution failure");
      },
    } as unknown as ReturnType<typeof nodeModule.createRequire>);

    const options: M3LCliDependencyGraphOptions = {
      readOwnManifest: () => ({
        dependencies: { "@m3l-automation/some-script": "workspace:*" },
      }),
    };

    let thrown: unknown;
    try {
      diagnoseDependencyGraph(options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
  });

  test("a non-MODULE_NOT_FOUND resolution failure propagates from discoverScriptsFromDependencyGraph too — the same default resolver backs both entry points", () => {
    vi.spyOn(nodeModule, "createRequire").mockReturnValue({
      resolve: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
      },
    } as unknown as ReturnType<typeof nodeModule.createRequire>);

    const options: M3LCliDependencyGraphOptions = {
      readOwnManifest: () => ({
        dependencies: { "@m3l-automation/some-script": "workspace:*" },
      }),
    };

    expect(() => discoverScriptsFromDependencyGraph(options)).toThrow();
  });
});

describe("discoverScripts — dependency-graph-first, filesystem-fallback merge (U7)", () => {
  function buildGraphOptions(
    dependencies: Readonly<Record<string, string>>,
    resolutions: Readonly<Record<string, string | undefined>>,
  ): M3LCliDependencyGraphOptions {
    return {
      readOwnManifest: () => ({ dependencies }),
      resolveScriptManifest: (depName: string) => resolutions[depName],
    };
  }

  test("the graph candidate wins over the filesystem candidate for the same name", () => {
    // Filesystem scan finds "json-etl" at scripts/json-etl with description "fs version".
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      const value = String(path);
      return (
        value === join("/repo", "scripts") ||
        value === join("/repo", "scripts", "json-etl", "package.json")
      );
    });
    mockReaddirSync([fakeDirent("json-etl", true)]);
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === join("/repo", "scripts", "json-etl", "package.json")) {
        return JSON.stringify({ description: "fs version" });
      }
      if (value === "/graph/json-etl/package.json") {
        return JSON.stringify({ description: "graph version" });
      }
      return JSON.stringify({});
    });

    const graphOptions = buildGraphOptions(
      { "@m3l-automation/json-etl": "workspace:*" },
      { "@m3l-automation/json-etl": "/graph/json-etl/package.json" },
    );

    const result = discoverScripts("/repo", graphOptions);

    expect(result).toEqual([
      {
        name: "json-etl",
        directory: "/graph/json-etl",
        description: "graph version",
      },
    ]);
  });

  test("a script the filesystem finds but the graph does not (not yet a declared CLI dependency) is still included", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      const value = String(path);
      return (
        value === join("/repo", "scripts") ||
        value === join("/repo", "scripts", "brand-new-script", "package.json")
      );
    });
    mockReaddirSync([fakeDirent("brand-new-script", true)]);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ description: "not yet a CLI dependency" }),
    );

    const graphOptions = buildGraphOptions({}, {});

    const result = discoverScripts("/repo", graphOptions);

    expect(result).toEqual([
      {
        name: "brand-new-script",
        directory: join("/repo", "scripts", "brand-new-script"),
        description: "not yet a CLI dependency",
      },
    ]);
  });

  test("a script the graph resolves but that has no scripts/ directory entry is still included, sourced from the graph alone", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === "/graph/json-etl/package.json") {
        return JSON.stringify({ description: "graph-only" });
      }
      return JSON.stringify({});
    });

    const graphOptions = buildGraphOptions(
      { "@m3l-automation/json-etl": "workspace:*" },
      { "@m3l-automation/json-etl": "/graph/json-etl/package.json" },
    );

    const result = discoverScripts("/repo", graphOptions);

    expect(result).toEqual([
      {
        name: "json-etl",
        directory: "/graph/json-etl",
        description: "graph-only",
      },
    ]);
  });

  test("the merged result stays sorted by name across graph and filesystem sources", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      const value = String(path);
      return (
        value === join("/repo", "scripts") ||
        value === join("/repo", "scripts", "zebra-script", "package.json")
      );
    });
    mockReaddirSync([fakeDirent("zebra-script", true)]);
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === "/graph/alpha-script/package.json") {
        return JSON.stringify({ description: "" });
      }
      return JSON.stringify({});
    });

    const graphOptions = buildGraphOptions(
      { "@m3l-automation/alpha-script": "workspace:*" },
      { "@m3l-automation/alpha-script": "/graph/alpha-script/package.json" },
    );

    const result = discoverScripts("/repo", graphOptions);

    expect(result.map((candidate) => candidate.name)).toEqual([
      "alpha-script",
      "zebra-script",
    ]);
  });
});

describe("M3LCliDependencyGraphOptions / M3LCliDependencyGraphStatus contract", () => {
  test("declares the documented readonly shapes", () => {
    expectTypeOf<M3LCliDependencyGraphOptions>().toMatchTypeOf<{
      readOwnManifest?: () => {
        dependencies?: Readonly<Record<string, string>>;
      };
      resolveScriptManifest?: (depName: string) => string | undefined;
    }>();
    expectTypeOf<M3LCliDependencyGraphStatus>().toEqualTypeOf<{
      readonly resolved: readonly string[];
      readonly unresolved: readonly string[];
    }>();
  });
});
