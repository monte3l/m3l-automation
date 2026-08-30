/**
 * Tests for `src/runs/descriptors.ts` — `createScriptCatalog` (X10b contract
 * §3): `list()` delegation, the mtime+path descriptor cache, the
 * operations-aggregation de-duplication, and every arm of `describe()`'s
 * error mapping.
 *
 * Real temp directories via `node:fs`/`node:os` are used for the
 * `scriptsRoot` fixtures — filesystem shape (which config module resolves,
 * its mtime) IS the behavior under test for the cache matrix, matching
 * `config-introspection-module.test.ts`'s idiom. `node:fs` is additionally
 * mocked (async-factory form, preserving every real export) ONLY so a
 * single test can simulate the narrow race window the contract describes
 * ("the file vanished between the two calls") by making `existsSync` report
 * a path present on its first query and absent on its second — the same
 * call-count-based technique `runs-resolver.test.ts` uses. Every other test
 * relies on the real filesystem.
 *
 * `loadDescriptors` is always injected as a stub (contract §3's own
 * injection seam) — it is the fixture actually under test's control for the
 * cache hit/miss matrix and every error-mapping arm downstream of a config
 * module import failure.
 *
 * RED: `../src/runs/descriptors.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands the module.
 */
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { createScriptCatalog } from "../src/runs/descriptors.js";
import type {
  M3LScriptCatalog,
  M3LScriptDetail,
} from "../src/runs/descriptors.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

let scriptsRoot: string;

beforeEach(() => {
  scriptsRoot = mkdtempSync(join(tmpdir(), "m3l-runs-descriptors-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scriptsRoot, { recursive: true, force: true });
});

/** Creates `<scriptsRoot>/<name>/dist/config.js` with the given mtime (seconds). */
function writeDistConfig(name: string, mtimeSeconds: number): string {
  const scriptDir = join(scriptsRoot, name);
  const distDir = join(scriptDir, "dist");
  mkdirSync(distDir, { recursive: true });
  const distPath = join(distDir, "config.js");
  writeFileSync(distPath, "// dist config");
  utimesSync(distPath, mtimeSeconds, mtimeSeconds);
  return distPath;
}

/** Creates `<scriptsRoot>/<name>/src/config.ts` with the given mtime (seconds). */
function writeSrcConfig(name: string, mtimeSeconds: number): string {
  const scriptDir = join(scriptsRoot, name);
  const srcDir = join(scriptDir, "src");
  mkdirSync(srcDir, { recursive: true });
  const srcPath = join(srcDir, "config.ts");
  writeFileSync(srcPath, "// src config");
  utimesSync(srcPath, mtimeSeconds, mtimeSeconds);
  return srcPath;
}

/**
 * Writes `<scriptsRoot>/<name>/dist/config.js` with a REAL, importable
 * `configParameters` export built from `source` (a JS body string), setting
 * its mtime. Used only by the Fix B (descriptor cache freshness) tests
 * below, which exercise the DEFAULT `loadDescriptors` — i.e. the real
 * `Core.loadScriptConfigDescriptors` importing a real file via Node's own
 * `import()` — rather than an injected stub, since the bug under test lives
 * in Node's ESM registry memoization, not in anything a stub could
 * reproduce.
 */
function writeRealConfigModule(
  name: string,
  source: string,
  mtimeSeconds: number,
): string {
  const distDir = join(scriptsRoot, name, "dist");
  mkdirSync(distDir, { recursive: true });
  const distPath = join(distDir, "config.js");
  writeFileSync(distPath, source);
  utimesSync(distPath, mtimeSeconds, mtimeSeconds);
  return distPath;
}

/** A real, importable single-parameter `configParameters` module body (v1). */
const CONFIG_MODULE_V1 = [
  "export const configParameters = [",
  "  {",
  '    getName: () => "QUEUE_URL",',
  "    getAliases: () => [],",
  '    getType: () => "STRING",',
  "    isRequired: () => true,",
  "    getDefaultValue: () => undefined,",
  '    getDescription: () => "",',
  "  },",
  "];",
  "",
].join("\n");

/**
 * A real, importable TWO-parameter `configParameters` module body (v2) —
 * `TOPIC_ARN` is present here and absent from {@link CONFIG_MODULE_V1}, so
 * its appearance in a `describe()` result is a discriminating signal that
 * the SECOND call actually re-imported this file rather than serving a
 * memoized `v1` module namespace.
 */
const CONFIG_MODULE_V2 = [
  "export const configParameters = [",
  "  {",
  '    getName: () => "QUEUE_URL",',
  "    getAliases: () => [],",
  '    getType: () => "STRING",',
  "    isRequired: () => true,",
  "    getDefaultValue: () => undefined,",
  '    getDescription: () => "",',
  "  },",
  "  {",
  '    getName: () => "TOPIC_ARN",',
  "    getAliases: () => [],",
  '    getType: () => "STRING",',
  "    isRequired: () => false,",
  "    getDefaultValue: () => undefined,",
  '    getDescription: () => "",',
  "  },",
  "];",
  "",
].join("\n");

/** Builds a single-parameter descriptor list, overridable per test. */
function buildDescriptor(
  overrides: Partial<Core.M3LConfigParameterDescriptor> = {},
): Core.M3LConfigParameterDescriptor {
  return {
    name: "QUEUE_URL",
    aliases: [],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "",
    secret: false,
    operations: [],
    ...overrides,
  };
}

describe("createScriptCatalog — list()", () => {
  test("delegates to listScriptSummaries(scriptsRoot)", () => {
    writeDistConfig("sqs-etl", 1000);
    writeDistConfig("json-etl", 1000);

    const catalog: M3LScriptCatalog = createScriptCatalog({ scriptsRoot });

    const names = catalog
      .list()
      .map((summary: { name: string }) => summary.name);
    expect(names).toEqual(["json-etl", "sqs-etl"]);
  });

  test("is uncached — a script scaffolded after catalog creation still appears", () => {
    const catalog = createScriptCatalog({ scriptsRoot });
    expect(catalog.list()).toHaveLength(0);

    writeDistConfig("brand-new", 1000);

    expect(
      catalog.list().map((summary: { name: string }) => summary.name),
    ).toContain("brand-new");
  });
});

describe("createScriptCatalog — describe() happy path", () => {
  test("returns the full detail shape, aggregating parameters and operations", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));

    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });
    const detail: M3LScriptDetail = await catalog.describe("sqs-etl");

    expect(detail.name).toBe("sqs-etl");
    expect(detail.hasCommandModule).toBe(false);
    expect(detail.executionMode).toBe("spawn");
    expect(detail.parameters).toEqual([buildDescriptor()]);
    expect(detail.operations).toEqual([]);
  });

  test("aggregates operations across parameters, de-duplicated in first-seen order", async () => {
    writeDistConfig("sqs-etl", 1000);
    const firstOperation: Core.M3LConfigOperationDescriptor = {
      name: "export",
      description: "Export data",
      requiredParameters: [],
    };
    const duplicateOperation: Core.M3LConfigOperationDescriptor = {
      name: "export",
      description: "Export data (duplicate declaration)",
      requiredParameters: ["QUEUE_URL"],
    };
    const secondOperation: Core.M3LConfigOperationDescriptor = {
      name: "import",
      description: "Import data",
      requiredParameters: [],
    };
    const loadDescriptors = vi.fn(() =>
      Promise.resolve([
        buildDescriptor({ name: "A", operations: [firstOperation] }),
        buildDescriptor({
          name: "B",
          operations: [duplicateOperation, secondOperation],
        }),
      ]),
    );

    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });
    const detail = await catalog.describe("sqs-etl");

    // "export" keeps its FIRST-seen description, and "import" is included
    // once — first-seen order wins, duplicates are dropped, not merged.
    expect(detail.operations).toEqual([firstOperation, secondOperation]);
  });

  test("returns [] for operations when no parameter declares one", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(() =>
      Promise.resolve([buildDescriptor(), buildDescriptor({ name: "OTHER" })]),
    );

    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });
    const detail = await catalog.describe("sqs-etl");

    expect(detail.operations).toEqual([]);
  });

  test("a secret-flagged parameter's masked default passes through describe() verbatim", async () => {
    writeDistConfig("sqs-etl", 1000);
    const secretDescriptor = buildDescriptor({
      name: "API_TOKEN",
      secret: true,
      defaultValue: "********",
    });
    const loadDescriptors = vi.fn(() => Promise.resolve([secretDescriptor]));

    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });
    const detail = await catalog.describe("sqs-etl");

    const apiToken = detail.parameters.find(
      (p: { name: string }) => p.name === "API_TOKEN",
    );
    expect(apiToken?.secret).toBe(true);
    // Verbatim passthrough of the already-masked descriptor field — no
    // re-reading of the underlying parameter object, no re-derivation.
    expect(apiToken?.defaultValue).toBe("********");
    expect(detail.parameters).toEqual([secretDescriptor]);
  });
});

describe("createScriptCatalog — descriptor cache", () => {
  test("a second describe() with an unchanged resolved path and mtime does not call the loader again", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await catalog.describe("sqs-etl");
    await catalog.describe("sqs-etl");

    expect(loadDescriptors).toHaveBeenCalledTimes(1);
  });

  test("a bumped mtime on the same resolved path calls the loader again", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await catalog.describe("sqs-etl");
    writeDistConfig("sqs-etl", 2000);
    await catalog.describe("sqs-etl");

    expect(loadDescriptors).toHaveBeenCalledTimes(2);
  });

  test("a changed resolved path at the SAME mtime calls the loader again (path check, not mtime alone)", async () => {
    // src/config.ts resolves first; then a dist/config.js appears with the
    // EXACT same mtime — resolveConfigModulePath's `>=` rule now prefers
    // dist, so the resolved *path* changes even though a cache keyed on
    // mtime alone would see no difference.
    const sameMtime = 1_700_000_000;
    writeSrcConfig("sqs-etl", sameMtime);
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await catalog.describe("sqs-etl");
    writeDistConfig("sqs-etl", sameMtime);
    await catalog.describe("sqs-etl");

    expect(loadDescriptors).toHaveBeenCalledTimes(2);
  });

  test("caches independently per script name", async () => {
    writeDistConfig("sqs-etl", 1000);
    writeDistConfig("json-etl", 1000);
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await catalog.describe("sqs-etl");
    await catalog.describe("json-etl");
    await catalog.describe("sqs-etl");
    await catalog.describe("json-etl");

    expect(loadDescriptors).toHaveBeenCalledTimes(2);
  });

  test("a statSync failure after resolution (the file vanishing) never registers as a cache hit", async () => {
    writeDistConfig("sqs-etl", 1000);
    const distPath = join(scriptsRoot, "sqs-etl", "dist", "config.js");
    const originalStatSync = fs.statSync;
    let statCalls = 0;
    vi.spyOn(fs, "statSync").mockImplementation((target: fs.PathLike) => {
      if (String(target) === distPath) {
        statCalls += 1;
        throw new Error("ENOENT: simulated vanish");
      }
      return originalStatSync(target);
    });
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await catalog.describe("sqs-etl");
    await catalog.describe("sqs-etl");

    expect(statCalls).toBeGreaterThan(0);
    // NaN !== NaN: neither call could have registered a cache hit against
    // the other, so the loader ran both times.
    expect(loadDescriptors).toHaveBeenCalledTimes(2);
  });
});

describe("createScriptCatalog — describe() error mapping", () => {
  test("an M3LConsoleError from readScriptSummary (bad-request name) propagates unchanged", async () => {
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("Not-Kebab");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(loadDescriptors).not.toHaveBeenCalled();
  });

  test("an M3LConsoleError from readScriptSummary (missing script) propagates unchanged", async () => {
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("missing-script");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
    expect(loadDescriptors).not.toHaveBeenCalled();
  });

  test("a Core.M3LError ERR_CONFIG_MODULE_NOT_FOUND from the second resolveConfigModulePath call (the file vanished after readScriptSummary already resolved it) becomes ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND", async () => {
    // Simulates the narrow race the contract documents: readScriptSummary's
    // own internal resolution succeeds first, but by the time describe()'s
    // own SECOND resolveConfigModulePath call queries the same src/config.ts
    // path, it has vanished. `existsSync` is spied to report the path
    // present on its first query and absent on every query after —
    // mirroring `runs-resolver.test.ts`'s call-count-based technique.
    const srcPath = writeSrcConfig("sqs-etl", 1000);
    const originalExistsSync = fs.existsSync;
    let srcQueryCount = 0;
    vi.spyOn(fs, "existsSync").mockImplementation((target: fs.PathLike) => {
      if (String(target) === srcPath) {
        srcQueryCount += 1;
        return srcQueryCount === 1;
      }
      return originalExistsSync(target);
    });
    const loadDescriptors = vi.fn(() => Promise.resolve([buildDescriptor()]));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("sqs-etl");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
    expect(loadDescriptors).not.toHaveBeenCalled();
  });

  test("[Fix D] a bare Core.M3LError ERR_CONFIG_MODULE_NOT_FOUND from loadDescriptors's OWN internal second resolveConfigModulePath call becomes ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND (404), not ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED (500)", async () => {
    // Core.loadScriptConfigDescriptors calls resolveConfigModulePath a
    // SECOND time internally, deliberately outside its own try/catch, so
    // that code propagates unwrapped as a bare Core.M3LError rather than an
    // M3LConsoleError. describe()'s outer catch must special-case this
    // exact code onto the caller-facing 404 the contract's mapping table
    // promises, not fold it into the generic 500 every other Core.M3LError
    // code gets (see the "any other Core.M3LError code" test below, which
    // must keep mapping to 500).
    writeDistConfig("sqs-etl", 1000);
    const original = new Core.M3LError("config module could not be resolved", {
      code: "ERR_CONFIG_MODULE_NOT_FOUND",
    });
    const loadDescriptors = vi.fn(() => Promise.reject(original));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("sqs-etl");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
    expect((thrown as M3LConsoleError).code).not.toBe(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe(original);
  });

  test("ERR_CONFIG_MODULE_INVALID from loadDescriptors becomes ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED, chaining the cause", async () => {
    writeDistConfig("sqs-etl", 1000);
    const original = new Core.M3LError("config module could not be described", {
      code: "ERR_CONFIG_MODULE_INVALID",
    });
    const loadDescriptors = vi.fn(() => Promise.reject(original));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("sqs-etl");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe(original);
    expect((thrown as M3LConsoleError).message).not.toContain(scriptsRoot);
  });

  test("any other Core.M3LError code from loadDescriptors becomes ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED", async () => {
    writeDistConfig("sqs-etl", 1000);
    const original = new Core.M3LError("unexpected core failure", {
      code: "ERR_SOME_OTHER_CORE_CODE",
    });
    const loadDescriptors = vi.fn(() => Promise.reject(original));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("sqs-etl");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe(original);
  });

  test("a plain Error from loadDescriptors becomes ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED", async () => {
    writeDistConfig("sqs-etl", 1000);
    const original = new Error("boom");
    const loadDescriptors = vi.fn(() => Promise.reject(original));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("sqs-etl");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe(original);
  });

  test("a thrown non-Error value from loadDescriptors becomes ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED, chaining the raw value as cause", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional non-Error rejection to verify describe() normalizes an unknown throw channel
      Promise.reject("a plain string failure"),
    );
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    let thrown: unknown;
    try {
      await catalog.describe("sqs-etl");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
    );
    expect((thrown as M3LConsoleError).cause).toBe("a plain string failure");
  });

  test("never masks a load failure as an empty parameter list", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(() => Promise.reject(new Error("boom")));
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await expect(catalog.describe("sqs-etl")).rejects.not.toEqual(
      expect.objectContaining({ parameters: [] }),
    );
  });
});

/**
 * Fix B (confirmed exploit, must-fix): the descriptor cache's freshness key
 * is inert. `loadCachedParameters` correctly detects a cache MISS on a
 * changed mtime (see the "descriptor cache" describe block above, all
 * exercised through an injected stub), but the injected `loadDescriptors`'s
 * DEFAULT — `Core.loadScriptConfigDescriptors`'s default dynamic-`import()`
 * importer — has no cache-buster, so Node's ESM module registry (which
 * memoizes by resolved `file://` URL for the whole process lifetime, not by
 * file content or mtime) silently returns the ORIGINAL module namespace on
 * every subsequent import of the same path, even from a brand-new catalog
 * instance with an empty cache `Map`.
 *
 * The tests below deliberately do NOT inject `loadDescriptors` — they let
 * `createScriptCatalog` fall through to its real default, and drive a real
 * file on disk via {@link writeRealConfigModule}, because the bug lives
 * exactly in that default's importer, not in anything a stub could
 * reproduce.
 */
describe("createScriptCatalog — descriptor cache freshness (Fix B, security)", () => {
  test("the default loader is invoked with the resolved config module's mtime as its second argument", async () => {
    const distPath = writeDistConfig("sqs-etl", 1000);
    const expectedMtimeMs = fs.statSync(distPath).mtimeMs;
    const loadDescriptors = vi.fn(
      (_scriptDirectory: string, _mtimeMs?: number) =>
        Promise.resolve([buildDescriptor()]),
    );

    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });
    await catalog.describe("sqs-etl");

    expect(loadDescriptors).toHaveBeenCalledWith(
      join(scriptsRoot, "sqs-etl"),
      expectedMtimeMs,
    );
  });

  test("[end-to-end reload] a script rebuilt with a new mtime is reflected on the next describe(), using the REAL default importer", async () => {
    writeRealConfigModule("sqs-etl", CONFIG_MODULE_V1, 1000);
    const catalog = createScriptCatalog({ scriptsRoot });

    const first = await catalog.describe("sqs-etl");
    expect(first.parameters.map((p) => p.name)).toEqual(["QUEUE_URL"]);

    // Rebuild: different declared parameters AND a bumped mtime — the
    // config-module-invalidation promise the module's own TSDoc makes.
    writeRealConfigModule("sqs-etl", CONFIG_MODULE_V2, 2000);
    const second = await catalog.describe("sqs-etl");

    expect(second.parameters.map((p) => p.name)).toEqual([
      "QUEUE_URL",
      "TOPIC_ARN",
    ]);
  });

  test("[secret remediation] flipping isSecret to true after a rebuild masks the default on the very next describe(), with no server restart", async () => {
    const secretModuleV1 = [
      "export const configParameters = [",
      "  {",
      '    getName: () => "API_TOKEN",',
      "    getAliases: () => [],",
      '    getType: () => "STRING",',
      "    isRequired: () => true,",
      '    getDefaultValue: () => "AKIA-REAL-CREDENTIAL-DO-NOT-LEAK",',
      '    getDescription: () => "",',
      "    isSecret: () => false,",
      "  },",
      "];",
      "",
    ].join("\n");
    const secretModuleV2 = [
      "export const configParameters = [",
      "  {",
      '    getName: () => "API_TOKEN",',
      "    getAliases: () => [],",
      '    getType: () => "STRING",',
      "    isRequired: () => true,",
      '    getDefaultValue: () => "AKIA-REAL-CREDENTIAL-DO-NOT-LEAK",',
      '    getDescription: () => "",',
      "    isSecret: () => true,",
      "  },",
      "];",
      "",
    ].join("\n");

    writeRealConfigModule("sqs-etl", secretModuleV1, 1000);
    const catalog = createScriptCatalog({ scriptsRoot });

    const before = await catalog.describe("sqs-etl");
    const beforeToken = before.parameters.find((p) => p.name === "API_TOKEN");
    expect(beforeToken?.secret).toBe(false);
    expect(beforeToken?.defaultValue).toBe("AKIA-REAL-CREDENTIAL-DO-NOT-LEAK");

    // Operator remediates and rebuilds: isSecret flips true, mtime bumps.
    writeRealConfigModule("sqs-etl", secretModuleV2, 2000);
    const after = await catalog.describe("sqs-etl");
    const afterToken = after.parameters.find((p) => p.name === "API_TOKEN");

    expect(afterToken?.secret).toBe(true);
    expect(afterToken?.defaultValue).toBe("********");
    // The recognisable secret must appear NOWHERE in the serialised result
    // — not just under the masked field.
    expect(JSON.stringify(after)).not.toContain(
      "AKIA-REAL-CREDENTIAL-DO-NOT-LEAK",
    );
  });

  test("a non-finite mtime (the file vanished mid-race) still forces a genuinely fresh import, not one memoized onto a single '?mtime=NaN' URL", async () => {
    const distPath = writeRealConfigModule("sqs-etl", CONFIG_MODULE_V1, 1000);
    const originalStatSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((target: fs.PathLike) => {
      if (String(target) === distPath) {
        // Every call reports NaN — the narrow race the contract documents
        // ("statSync threw") — a naive fix that busts the cache with a
        // single constant literal `?mtime=NaN` query would still collapse
        // every NaN-mtime call onto the same memoized URL.
        throw new Error("ENOENT: simulated vanish");
      }
      return originalStatSync(target);
    });

    const catalog = createScriptCatalog({ scriptsRoot });
    const first = await catalog.describe("sqs-etl");
    expect(first.parameters.map((p) => p.name)).toEqual(["QUEUE_URL"]);

    writeRealConfigModule("sqs-etl", CONFIG_MODULE_V2, 2000);
    const second = await catalog.describe("sqs-etl");

    expect(second.parameters.map((p) => p.name)).toEqual([
      "QUEUE_URL",
      "TOPIC_ARN",
    ]);
  });

  test("existing cache-hit behaviour is preserved: an unchanged mtime still calls the loader only once, even against the new two-argument signature", async () => {
    writeDistConfig("sqs-etl", 1000);
    const loadDescriptors = vi.fn(
      (_scriptDirectory: string, _mtimeMs?: number) =>
        Promise.resolve([buildDescriptor()]),
    );
    const catalog = createScriptCatalog({ scriptsRoot, loadDescriptors });

    await catalog.describe("sqs-etl");
    await catalog.describe("sqs-etl");

    expect(loadDescriptors).toHaveBeenCalledTimes(1);
  });
});
