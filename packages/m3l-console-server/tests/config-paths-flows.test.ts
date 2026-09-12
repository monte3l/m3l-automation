/**
 * Tests for src/config/paths.ts — `resolveFlowsDirectory` (X13
 * session-flow-export module, issue #561, PR 5/6).
 *
 * RED: `resolveFlowsDirectory` does not exist yet in `../src/config/paths.js`
 * — the import below is expected to fail to resolve until the implementer
 * lands it.
 *
 * A DELIBERATE divergence from every sibling resolver in this file
 * (`resolveStoreDatabasePath`, `resolveSessionArtifactRoot`,
 * `resolveAuditStreamRoot`, `resolveRunsOutputRoot`, all covered in
 * `store-paths.test.ts`): those all anchor on `Core.M3LPaths().getDataDir()`
 * via an injectable `resolveDataDir`. This resolver anchors on
 * `Core.M3LPaths().getConfigDir()` instead, via an injectable
 * `resolveConfigDir` — because `packages/m3l-cli/src/flow/load.ts` resolves
 * flow definitions from `<workspaceRoot>/data/config/flows`, and this
 * resolver exists to reproduce that exact path so the console server writes
 * exports where the CLI already looks for them.
 *
 * No filesystem I/O anywhere in this file: the resolver is a pure path
 * computation, so the tests need none either.
 */
import * as path from "node:path";

import { describe, expect, expectTypeOf, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { resolveFlowsDirectory } from "../src/config/paths.js";
import type { ResolveFlowsDirectoryOptions } from "../src/config/paths.js";

describe("ResolveFlowsDirectoryOptions", () => {
  test("declares configuredPath and resolveConfigDir, both optional", () => {
    expectTypeOf<ResolveFlowsDirectoryOptions>().toEqualTypeOf<{
      readonly configuredPath?: string | undefined;
      readonly resolveConfigDir?: () => string;
    }>();
  });
});

describe("resolveFlowsDirectory — default", () => {
  test("resolves <configDir>/flows when configuredPath is absent", () => {
    const result = resolveFlowsDirectory({
      resolveConfigDir: () => "/fake/config",
    });

    expect(result).toBe(path.join("/fake/config", "flows"));
  });

  test("resolveFlowsDirectory is callable with no options at all", () => {
    expectTypeOf(resolveFlowsDirectory).toBeCallableWith();
  });

  test("no options at all falls through to the real Core.M3LPaths().getConfigDir() without throwing", () => {
    const result = resolveFlowsDirectory();

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.endsWith("flows")).toBe(true);
  });

  test("an empty options object behaves identically to no argument at all", () => {
    const result = resolveFlowsDirectory({});

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.endsWith("flows")).toBe(true);
  });

  test("matches Core.M3LPaths().getConfigDir() joined with 'flows' exactly", () => {
    const expected = path.join(new Core.M3LPaths().getConfigDir(), "flows");

    expect(resolveFlowsDirectory()).toBe(expected);
  });
});

describe("resolveFlowsDirectory — configuredPath resolution", () => {
  test("resolves a relative configuredPath against the injected config dir", () => {
    const result = resolveFlowsDirectory({
      configuredPath: "custom-flows",
      resolveConfigDir: () => "/fake/config",
    });

    expect(result).toBe(path.resolve("/fake/config", "custom-flows"));
  });

  test("passes an absolute configuredPath through path.resolve unchanged", () => {
    const absolute = path.resolve(path.sep, "abs", "flows");

    const result = resolveFlowsDirectory({
      configuredPath: absolute,
      resolveConfigDir: () => "/fake/config",
    });

    expect(result).toBe(absolute);
  });

  test("accepts a configuredPath with no file extension — the natural shape for a directory root", () => {
    const result = resolveFlowsDirectory({
      configuredPath: "flows-root",
      resolveConfigDir: () => "/fake/config",
    });

    expect(result).toBe(path.resolve("/fake/config", "flows-root"));
  });
});

describe("resolveFlowsDirectory — rejects an unsafe configuredPath", () => {
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
    ["a file: prefix", "file:///tmp/flows"],
  ])("rejects %s as ERR_CONSOLE_CONFIG_INVALID", (_label, rejectedValue) => {
    let thrown: unknown;
    try {
      resolveFlowsDirectory({
        configuredPath: rejectedValue,
        resolveConfigDir: () => "/fake/config",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    if (rejectedValue.trim().length > 0) {
      expect(error.message).not.toContain(rejectedValue);
    }
  });
});

describe("resolveFlowsDirectory — resolveConfigDir failure", () => {
  test("wraps a thrown resolveConfigDir failure as M3LConsoleError, chaining the original as cause", () => {
    const original = new Error(
      "boom - simulates M3LPathResolutionError/M3LEnvironmentDetectionError escaping M3LPaths",
    );

    let thrown: unknown;
    try {
      resolveFlowsDirectory({
        resolveConfigDir: () => {
          throw original;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(error.cause).toBe(original);
    expect(error.message.toLowerCase()).toContain("config");
    expect(error.message.toLowerCase()).not.toContain("data");
  });
});
