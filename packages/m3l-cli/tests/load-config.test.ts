/**
 * Tests for src/discovery/load-config.ts — parameter descriptor mapping,
 * dist-first config-module resolution, and the injectable-importer config
 * loader (m3l-cli 8b contract).
 */
import * as fs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors packages/m3l-common's
// exporters.test.ts / script.test.ts pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import {
  describeParameters,
  loadScriptParameters,
  resolveConfigModulePath,
} from "../src/discovery/load-config.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { M3LCliError } from "../src/cli/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stubs `fs.statSync` to return the given mtimeMs for a path (matched by
 * suffix), throwing an ENOENT-shaped error for any other path. The cast is
 * on the whole mock implementation (not the returned object), since a
 * partial `{ mtimeMs }` literal does not structurally satisfy the full
 * `fs.Stats` shape and fighting that per-call is unnecessary noise here.
 */
function mockStatSyncBySuffix(mtimesBySuffix: Record<string, number>): void {
  vi.spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) => {
    const value = String(path);
    const match = Object.entries(mtimesBySuffix).find(([suffix]) =>
      value.endsWith(suffix),
    );
    if (match === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return { mtimeMs: match[1] };
  }) as unknown as typeof fs.statSync);
}

describe("describeParameters", () => {
  test("maps every public getter through to the descriptor shape", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "PORT",
      type: Core.M3LConfigParameterType.INT,
      aliases: ["SERVER_PORT"],
      defaultValue: 3000,
      required: true,
      description: "the listen port",
    });

    const descriptors = describeParameters([parameter]);

    expect(descriptors).toEqual([
      {
        name: "PORT",
        aliases: ["SERVER_PORT"],
        type: "INT",
        required: true,
        defaultValue: "3000",
        description: "the listen port",
      },
    ]);
  });

  test("renders defaultValue as undefined and description as '' when neither was declared", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "TAGS",
      type: Core.M3LConfigParameterType.STRING_ARRAY,
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.defaultValue).toBeUndefined();
    expect(descriptor?.description).toBe("");
    expect(descriptor?.aliases).toEqual([]);
    expect(descriptor?.required).toBe(false);
  });

  test("renders a BOOL/array defaultValue via String(...)", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "ENABLED",
      type: Core.M3LConfigParameterType.BOOL,
      defaultValue: true,
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.defaultValue).toBe("true");
  });

  test("returns an empty array for an empty input", () => {
    expect(describeParameters([])).toEqual([]);
  });
});

describe("resolveConfigModulePath", () => {
  const scriptDirectory = join("/repo", "scripts", "foo");
  const distPath = join(scriptDirectory, "dist", "config.js");
  const srcPath = join(scriptDirectory, "src", "config.ts");

  test("prefers dist/config.js when it exists and is at least as new as src/config.ts", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === distPath || String(path) === srcPath,
    );
    mockStatSyncBySuffix({
      [join("dist", "config.js")]: 200,
      [join("src", "config.ts")]: 100,
    });

    const result = resolveConfigModulePath(scriptDirectory);

    expect(result).toEqual({ path: distPath, source: "dist" });
  });

  test("prefers dist/config.js when src/config.ts is entirely absent", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === distPath,
    );
    mockStatSyncBySuffix({ [join("dist", "config.js")]: 1 });

    expect(resolveConfigModulePath(scriptDirectory)).toEqual({
      path: distPath,
      source: "dist",
    });
  });

  test("falls back to src/config.ts when dist is older than src", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === distPath || String(path) === srcPath,
    );
    mockStatSyncBySuffix({
      [join("dist", "config.js")]: 100,
      [join("src", "config.ts")]: 200,
    });

    expect(resolveConfigModulePath(scriptDirectory)).toEqual({
      path: srcPath,
      source: "src",
    });
  });

  test("falls back to src/config.ts when dist/config.js does not exist", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === srcPath,
    );
    mockStatSyncBySuffix({ [join("src", "config.ts")]: 1 });

    expect(resolveConfigModulePath(scriptDirectory)).toEqual({
      path: srcPath,
      source: "src",
    });
  });

  test("throws M3LCliError ERR_CLI_CONFIG_IMPORT when neither dist nor src exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(() => resolveConfigModulePath(scriptDirectory)).toThrowError(
      M3LCliError,
    );

    let thrown: unknown;
    try {
      resolveConfigModulePath(scriptDirectory);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
  });
});

describe("loadScriptParameters", () => {
  const scriptDirectory = join("/repo", "scripts", "foo");
  const distPath = join(scriptDirectory, "dist", "config.js");

  function mockDistOnly(): void {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === distPath,
    );
    mockStatSyncBySuffix({ [join("dist", "config.js")]: 1 });
  }

  test("resolves the module path, imports via the injected importer, and describes its configParameters", async () => {
    mockDistOnly();
    const parameter = new Core.M3LConfigParameter({
      name: "PORT",
      type: Core.M3LConfigParameterType.INT,
    });
    const importModule = vi.fn((specifier: string) =>
      Promise.resolve({ configParameters: [parameter], specifier }),
    );

    const descriptors = await loadScriptParameters(
      scriptDirectory,
      importModule,
    );

    expect(importModule).toHaveBeenCalledTimes(1);
    const [specifier] = importModule.mock.calls[0] ?? [""];
    expect(typeof specifier).toBe("string");
    expect(specifier).toContain("config.js");
    expect(descriptors).toEqual([
      {
        name: "PORT",
        aliases: [],
        type: "INT",
        required: false,
        defaultValue: undefined,
        description: "",
      },
    ]);
  });

  test("wraps an importer rejection in M3LCliError ERR_CLI_CONFIG_IMPORT, chaining the original as cause", async () => {
    mockDistOnly();
    const original = new Error("syntax error");
    const importModule = vi.fn(async () => Promise.reject(original));

    await expect(
      loadScriptParameters(scriptDirectory, importModule),
    ).rejects.toBeInstanceOf(M3LCliError);

    let thrown: unknown;
    try {
      await loadScriptParameters(scriptDirectory, importModule);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
    expect((thrown as M3LCliError).cause).toBe(original);
  });

  test("wraps a module missing an array configParameters export in ERR_CLI_CONFIG_IMPORT", async () => {
    mockDistOnly();
    const importModule = vi.fn(async () => Promise.resolve({}));

    await expect(
      loadScriptParameters(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CLI_CONFIG_IMPORT" });
  });

  test("wraps a configParameters array whose elements lack the getter duck-type in ERR_CLI_CONFIG_IMPORT", async () => {
    mockDistOnly();
    const importModule = vi.fn(async () =>
      Promise.resolve({ configParameters: [{ notAGetter: true }] }),
    );

    await expect(
      loadScriptParameters(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CLI_CONFIG_IMPORT" });
  });

  test("propagates resolveConfigModulePath's own M3LCliError without double-wrapping", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const importModule = vi.fn(async () => Promise.resolve({}));

    await expect(
      loadScriptParameters(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CLI_CONFIG_IMPORT" });
    expect(importModule).not.toHaveBeenCalled();
  });

  test("uses the default dynamic-import based importer when none is injected, still wrapping the failure", async () => {
    mockDistOnly();

    // No real dist/config.js exists at this fake path, so the real
    // dynamic import() the default importer performs rejects with Node's
    // own module-resolution error — proving the default importer path (as
    // opposed to the injected `importModule`) runs, and its failure still
    // surfaces as an M3LCliError, never a raw throw.
    await expect(loadScriptParameters(scriptDirectory)).rejects.toBeInstanceOf(
      M3LCliError,
    );
  });
});

describe("M3LCliParameterDescriptor contract", () => {
  test("declares the documented readonly shape", () => {
    expectTypeOf<M3LCliParameterDescriptor>().toEqualTypeOf<{
      readonly name: string;
      readonly aliases: readonly string[];
      readonly type: string;
      readonly required: boolean;
      readonly defaultValue: string | undefined;
      readonly description: string;
    }>();
  });
});
