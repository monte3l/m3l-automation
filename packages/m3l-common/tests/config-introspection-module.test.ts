/**
 * Tests for `core/config`'s `resolveConfigModulePath` and
 * `loadScriptConfigDescriptors` (X10a — promoted from
 * `packages/m3l-cli/src/discovery/load-config.ts`). RED until implemented.
 *
 * Contract source: docs/reference/core/config.md, "Script introspection"
 * section. This is a PROMOTION, not new behaviour — coverage is ported from
 * `packages/m3l-cli/tests/load-config.test.ts`'s `resolveConfigModulePath`
 * and `loadScriptParameters` blocks, onto the new Core symbol names. The
 * CLI test file is untouched and remains the CLI-adapter regression net.
 *
 * Deliberate behavioural change from the CLI original: the Core seam throws
 * `Core.M3LError` with TWO codes instead of one `M3LCliError`
 * `ERR_CLI_CONFIG_IMPORT`:
 *  - ERR_CONFIG_MODULE_NOT_FOUND — resolveConfigModulePath found neither
 *    dist/config.js nor src/config.ts. Propagates UNWRAPPED out of
 *    loadScriptConfigDescriptors.
 *  - ERR_CONFIG_MODULE_INVALID — the import rejected (cause chained), or the
 *    module shape is invalid.
 *
 * `resolveConfigModulePath` is exercised against a REAL temp directory (not
 * a mocked `node:fs`) per the task's explicit instruction — the `>=` mtime
 * boundary is exactly the behavior under test, and the repo's own
 * `files.test.ts` establishes the precedent of real fs fixtures for tests
 * where filesystem behavior IS the contract. Named `node:fs` imports (not
 * `fs.mkdtempSync(...)`-style member calls) are used throughout, matching
 * that file's style.
 *
 * New exports under test (from `packages/m3l-common/src/core/config`):
 *   resolveConfigModulePath, loadScriptConfigDescriptors,
 *   M3LConfigModuleLocation.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  loadScriptConfigDescriptors,
  M3LConfigParameter,
  M3LConfigParameterType,
  resolveConfigModulePath,
} from "../src/core/config/index.js";
import type { M3LConfigModuleLocation } from "../src/core/config/index.js";

let scriptDirectory: string;

beforeEach(() => {
  scriptDirectory = mkdtempSync(join(tmpdir(), "m3l-config-introspection-"));
});

afterEach(() => {
  rmSync(scriptDirectory, { recursive: true, force: true });
});

/** Writes `content` to `<scriptDirectory>/dist/config.js`, setting its mtime. */
function writeDistConfig(content: string, mtimeSeconds: number): string {
  const distDir = join(scriptDirectory, "dist");
  mkdirSync(distDir, { recursive: true });
  const distPath = join(distDir, "config.js");
  writeFileSync(distPath, content);
  utimesSync(distPath, mtimeSeconds, mtimeSeconds);
  return distPath;
}

/** Writes `content` to `<scriptDirectory>/src/config.ts`, setting its mtime. */
function writeSrcConfig(content: string, mtimeSeconds: number): string {
  const srcDir = join(scriptDirectory, "src");
  mkdirSync(srcDir, { recursive: true });
  const srcPath = join(srcDir, "config.ts");
  writeFileSync(srcPath, content);
  utimesSync(srcPath, mtimeSeconds, mtimeSeconds);
  return srcPath;
}

describe("resolveConfigModulePath", () => {
  test("prefers dist/config.js when it is strictly newer than src/config.ts", () => {
    const distPath = writeDistConfig("// dist", 2000);
    writeSrcConfig("// src", 1000);

    const result = resolveConfigModulePath(scriptDirectory);

    expect(result).toEqual({ path: distPath, source: "dist" });
  });

  test("prefers dist/config.js when both mtimes are EXACTLY equal (the >= boundary)", () => {
    const sameMtime = 1_700_000_000;
    const distPath = writeDistConfig("// dist", sameMtime);
    writeSrcConfig("// src", sameMtime);

    const result = resolveConfigModulePath(scriptDirectory);

    expect(result).toEqual({ path: distPath, source: "dist" });
    expect(result.source).toBe("dist");
  });

  test("prefers dist/config.js when src/config.ts is entirely absent", () => {
    const distPath = writeDistConfig("// dist", 1000);

    const result = resolveConfigModulePath(scriptDirectory);

    expect(result).toEqual({ path: distPath, source: "dist" });
    expect(result.source).toBe("dist");
  });

  test("falls back to src/config.ts when dist is older than src", () => {
    writeDistConfig("// dist", 1000);
    const srcPath = writeSrcConfig("// src", 2000);

    const result = resolveConfigModulePath(scriptDirectory);

    expect(result).toEqual({ path: srcPath, source: "src" });
    expect(result.source).toBe("src");
  });

  test("falls back to src/config.ts when dist/config.js does not exist", () => {
    const srcPath = writeSrcConfig("// src", 1000);

    const result = resolveConfigModulePath(scriptDirectory);

    expect(result).toEqual({ path: srcPath, source: "src" });
    expect(result.source).toBe("src");
  });

  test("throws M3LError ERR_CONFIG_MODULE_NOT_FOUND when neither dist nor src exists", () => {
    expect(() => resolveConfigModulePath(scriptDirectory)).toThrowError(
      M3LError,
    );

    let thrown: unknown;
    try {
      resolveConfigModulePath(scriptDirectory);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_NOT_FOUND");
  });
});

describe("loadScriptConfigDescriptors", () => {
  test("resolves the module path, imports via the injected importer, and describes its configParameters", async () => {
    writeDistConfig("// dist placeholder — importModule is injected below", 1);
    const parameter = new M3LConfigParameter({
      name: "PORT",
      type: M3LConfigParameterType.INT,
    });
    const importModule = vi.fn((specifier: string) =>
      Promise.resolve({ configParameters: [parameter], specifier }),
    );

    const descriptors = await loadScriptConfigDescriptors(
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

  test("wraps an importer rejection in M3LError ERR_CONFIG_MODULE_INVALID, chaining the original as cause", async () => {
    writeDistConfig("// dist placeholder", 1);
    const original = new Error("syntax error");
    const importModule = vi.fn(async () => Promise.reject(original));

    await expect(
      loadScriptConfigDescriptors(scriptDirectory, importModule),
    ).rejects.toBeInstanceOf(M3LError);

    let thrown: unknown;
    try {
      await loadScriptConfigDescriptors(scriptDirectory, importModule);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_INVALID");
    expect((thrown as M3LError).cause).toBe(original);
  });

  test("wraps a module that does not export an object in ERR_CONFIG_MODULE_INVALID", async () => {
    writeDistConfig("// dist placeholder", 1);
    const importModule = vi.fn(async () => Promise.resolve(null));

    await expect(
      loadScriptConfigDescriptors(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CONFIG_MODULE_INVALID" });
  });

  test("wraps a module missing the configParameters export in ERR_CONFIG_MODULE_INVALID", async () => {
    writeDistConfig("// dist placeholder", 1);
    const importModule = vi.fn(async () => Promise.resolve({}));

    await expect(
      loadScriptConfigDescriptors(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CONFIG_MODULE_INVALID" });
  });

  test("wraps a module whose configParameters export is not an array in ERR_CONFIG_MODULE_INVALID", async () => {
    writeDistConfig("// dist placeholder", 1);
    const importModule = vi.fn(async () =>
      Promise.resolve({ configParameters: "not-an-array" }),
    );

    await expect(
      loadScriptConfigDescriptors(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CONFIG_MODULE_INVALID" });
  });

  test("wraps a configParameters array whose elements lack the getter duck-type in ERR_CONFIG_MODULE_INVALID", async () => {
    writeDistConfig("// dist placeholder", 1);
    const importModule = vi.fn(async () =>
      Promise.resolve({ configParameters: [{ notAGetter: true }] }),
    );

    await expect(
      loadScriptConfigDescriptors(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CONFIG_MODULE_INVALID" });
  });

  test("propagates resolveConfigModulePath's ERR_CONFIG_MODULE_NOT_FOUND unwrapped, never calling importModule", async () => {
    // scriptDirectory is a freshly-created empty temp dir: no dist/, no src/.
    const importModule = vi.fn(async () => Promise.resolve({}));

    await expect(
      loadScriptConfigDescriptors(scriptDirectory, importModule),
    ).rejects.toMatchObject({ code: "ERR_CONFIG_MODULE_NOT_FOUND" });
    expect(importModule).not.toHaveBeenCalled();

    let thrown: unknown;
    try {
      await loadScriptConfigDescriptors(scriptDirectory, importModule);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_CONFIG_MODULE_NOT_FOUND");
    expect((thrown as M3LError).code).not.toBe("ERR_CONFIG_MODULE_INVALID");
  });

  test("uses the default dynamic-import based importer when none is injected", async () => {
    // A real dist/config.js, actually importable via Node's dynamic import(),
    // exercising the default importer code path (as opposed to an injected
    // `importModule`) end to end.
    writeDistConfig(
      [
        "export const configParameters = [",
        "  {",
        '    getName: () => "PORT",',
        "    getAliases: () => [],",
        '    getType: () => "INT",',
        "    isRequired: () => false,",
        "    getDefaultValue: () => 3000,",
        "    getDescription: () => undefined,",
        "  },",
        "];",
        "",
      ].join("\n"),
      1,
    );

    const descriptors = await loadScriptConfigDescriptors(scriptDirectory);

    expect(descriptors).toEqual([
      {
        name: "PORT",
        aliases: [],
        type: "INT",
        required: false,
        defaultValue: "3000",
        description: "",
        secret: false,
        operations: [],
      },
    ]);
  });
});

describe("M3LConfigModuleLocation contract", () => {
  test("declares the documented readonly shape: an absolute path plus a dist|src discriminant", () => {
    expectTypeOf<M3LConfigModuleLocation>().toEqualTypeOf<{
      readonly path: string;
      readonly source: "dist" | "src";
    }>();
  });
});
