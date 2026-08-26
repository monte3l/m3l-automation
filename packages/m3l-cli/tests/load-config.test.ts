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
import type {
  M3LCliOperationDescriptor,
  M3LCliParameterDescriptor,
} from "../src/discovery/load-config.js";
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
        secret: false,
        operations: [],
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

  test("maps a secret-flagged parameter's isSecret() through to descriptor.secret (8f)", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "API_KEY",
      type: Core.M3LConfigParameterType.STRING,
      secret: true,
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.secret).toBe(true);
  });

  test("maps a non-secret parameter's isSecret() to descriptor.secret === false (8f)", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "REGION",
      type: Core.M3LConfigParameterType.STRING,
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.secret).toBe(false);
  });

  test("masks a secret-flagged parameter's defaultValue as ******** in the descriptor, never the raw value (8f)", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "API_KEY",
      type: Core.M3LConfigParameterType.STRING,
      defaultValue: "raw-secret-default-value",
      secret: true,
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.defaultValue).toBe("********");
    expect(descriptor?.defaultValue).not.toContain("raw-secret-default-value");
  });

  test("leaves a non-secret parameter's defaultValue untouched (8f)", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "REGION",
      type: Core.M3LConfigParameterType.STRING,
      defaultValue: "us-east-1",
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.defaultValue).toBe("us-east-1");
  });

  test("treats a duck-typed element missing isSecret() as non-secret, tolerating stale pre-2.3.0 dist builds (8f)", () => {
    const staleParameterLike = {
      getName: () => "LEGACY",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      // no isSecret() — simulates a config module compiled against a dist
      // predating the 8f secret-threading addition.
    };

    const [descriptor] = describeParameters([staleParameterLike]);

    expect(descriptor?.secret).toBe(false);
  });
});

describe("describeParameters — operations (U8)", () => {
  test("normalizes a real Core.M3LConfigParameter's single declared operation onto descriptor.operations", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "command",
      type: Core.M3LConfigParameterType.STRING,
      operations: [
        {
          name: "get",
          description: "Fetch one item.",
          requiredParameters: ["key"],
        },
      ],
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.operations).toEqual([
      {
        name: "get",
        description: "Fetch one item.",
        requiredParameters: ["key"],
      },
    ]);
  });

  test("preserves declaration order across multiple declared operations", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "command",
      type: Core.M3LConfigParameterType.STRING,
      operations: [
        { name: "get", description: "Fetch one item." },
        { name: "put", description: "Write one item." },
        { name: "delete", description: "Remove one item." },
      ],
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.operations?.map((operation) => operation.name)).toEqual([
      "get",
      "put",
      "delete",
    ]);
  });

  test("normalizes an operation with no declared requiredParameters to an empty array, not undefined", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "command",
      type: Core.M3LConfigParameterType.STRING,
      operations: [{ name: "get", description: "Fetch one item." }],
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.operations?.[0]?.requiredParameters).toEqual([]);
  });

  test("normalizes an operation's declared requiredParameters through unchanged", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "command",
      type: Core.M3LConfigParameterType.STRING,
      operations: [
        {
          name: "put",
          description: "Write one item.",
          requiredParameters: ["key", "value"],
        },
      ],
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.operations?.[0]?.requiredParameters).toEqual([
      "key",
      "value",
    ]);
  });

  test("assigns an empty operations array to a real parameter that declares no operations", () => {
    const parameter = new Core.M3LConfigParameter({
      name: "PORT",
      type: Core.M3LConfigParameterType.INT,
    });

    const [descriptor] = describeParameters([parameter]);

    expect(descriptor?.operations).toEqual([]);
  });

  test("assigns an empty operations array, never throwing, for a duck-typed element with no getOperations() method", () => {
    const staleParameterLike = {
      getName: () => "LEGACY",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      // no getOperations() — simulates a config module compiled against a
      // dist predating the U8 operation-threading addition.
    };

    const [descriptor] = describeParameters([staleParameterLike]);

    expect(descriptor?.operations).toEqual([]);
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a non-array string", "get"],
    ["a non-array plain object", { name: "get" }],
    ["an array containing a non-object element", ["get"]],
    ["an array containing an object missing name and description", [{}]],
    [
      "an array containing an object with non-string name and description",
      [{ name: 1, description: 2 }],
    ],
    [
      "an array containing an object with a non-array requiredParameters",
      [{ name: "get", description: "d", requiredParameters: "key" }],
    ],
    [
      "an array containing an object whose requiredParameters array contains a non-string element",
      [{ name: "get", description: "d", requiredParameters: [1] }],
    ],
    ["an empty array", []],
  ])(
    "falls back to an empty operations array, never throwing, when getOperations() returns %s",
    (_label, malformedReturn) => {
      const duckTypedElement = {
        getName: () => "command",
        getAliases: () => [],
        getType: () => "STRING",
        isRequired: () => false,
        getDefaultValue: () => undefined,
        getDescription: () => undefined,
        getOperations: () => malformedReturn,
      };

      expect(() => describeParameters([duckTypedElement])).not.toThrow();
      const [descriptor] = describeParameters([duckTypedElement]);
      expect(descriptor?.operations).toEqual([]);
    },
  );

  test("reads a duck-typed element's getOperations() exactly once, reflecting only its first return value", () => {
    const getOperations = vi
      .fn()
      .mockReturnValueOnce([
        {
          name: "get",
          description: "Fetch one item.",
          requiredParameters: ["key"],
        },
      ])
      .mockReturnValueOnce([{ name: "put", description: "Write one item." }]);
    const duckTypedElement = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => undefined,
      getOperations,
    };

    const [descriptor] = describeParameters([duckTypedElement]);

    expect(getOperations).toHaveBeenCalledTimes(1);
    expect(descriptor?.operations).toEqual([
      {
        name: "get",
        description: "Fetch one item.",
        requiredParameters: ["key"],
      },
    ]);
  });

  test("assigns an empty operations array, never throwing, when getOperations is a non-function property", () => {
    // Cast bypasses the getOperations type: this simulates a config module
    // exporting a plain property in place of the documented method, a shape
    // TypeScript itself would reject but a dynamically-imported, untrusted
    // script module can still produce at runtime.
    const duckTypedElement = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => "A malformed export.",
      getOperations: "not-a-function",
    } as unknown as Parameters<typeof describeParameters>[0][number];

    expect(() => describeParameters([duckTypedElement])).not.toThrow();
    const [descriptor] = describeParameters([duckTypedElement]);

    expect(descriptor?.operations).toEqual([]);
    expect(descriptor?.name).toBe("command");
    expect(descriptor?.type).toBe("STRING");
    expect(descriptor?.required).toBe(false);
    expect(descriptor?.description).toBe("A malformed export.");
  });

  test("assigns an empty operations array, never throwing, when getOperations() throws", () => {
    const duckTypedElement = {
      getName: () => "command",
      getAliases: () => [],
      getType: () => "STRING",
      isRequired: () => false,
      getDefaultValue: () => undefined,
      getDescription: () => "A thrown getter.",
      getOperations: () => {
        throw new Error("boom");
      },
    };

    expect(() => describeParameters([duckTypedElement])).not.toThrow();
    const [descriptor] = describeParameters([duckTypedElement]);

    expect(descriptor?.operations).toEqual([]);
    expect(descriptor?.name).toBe("command");
    expect(descriptor?.type).toBe("STRING");
    expect(descriptor?.required).toBe(false);
    expect(descriptor?.description).toBe("A thrown getter.");
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
        secret: false,
        operations: [],
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
  test("declares the documented readonly shape, including 8f's secret flag and U8's operations list", () => {
    expectTypeOf<M3LCliParameterDescriptor>().toEqualTypeOf<{
      readonly name: string;
      readonly aliases: readonly string[];
      readonly type: string;
      readonly required: boolean;
      readonly defaultValue: string | undefined;
      readonly description: string;
      readonly secret?: boolean;
      readonly operations?: readonly M3LCliOperationDescriptor[];
    }>();
  });
});

describe("M3LCliOperationDescriptor contract (U8)", () => {
  test("declares the documented readonly shape: name, description, and an always-array requiredParameters", () => {
    expectTypeOf<M3LCliOperationDescriptor>().toEqualTypeOf<{
      readonly name: string;
      readonly description: string;
      readonly requiredParameters: readonly string[];
    }>();
  });
});
