/**
 * Tests for src/runs/resolver.ts — `resolveScript` (m3l-console-server X4
 * run-governor contract). Mocks `node:fs`'s `existsSync` via the
 * async-factory form so real exports still resolve; each test spies on
 * `existsSync` individually.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { resolveScript } from "../src/runs/resolver.js";
import type { M3LResolvedScript } from "../src/runs/resolver.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

const SCRIPTS_ROOT = "/scripts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveScript — happy path", () => {
  test("resolves a script with a command module present", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const resolved = resolveScript("sqs-etl", SCRIPTS_ROOT);

    expect(resolved).toEqual({
      name: "sqs-etl",
      scriptsRoot: SCRIPTS_ROOT,
      scriptDir: path.join(SCRIPTS_ROOT, "sqs-etl"),
      hasCommandModule: true,
    });
  });

  test("calls existsSync exactly twice: once for the dir, once for command.ts", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    resolveScript("sqs-etl", SCRIPTS_ROOT);

    expect(existsSyncSpy).toHaveBeenCalledTimes(2);
    expect(existsSyncSpy).toHaveBeenNthCalledWith(
      1,
      path.join(SCRIPTS_ROOT, "sqs-etl"),
    );
    expect(existsSyncSpy).toHaveBeenNthCalledWith(
      2,
      path.join(SCRIPTS_ROOT, "sqs-etl", "src", "command.ts"),
    );
  });
});

describe("resolveScript — script without a command module", () => {
  test("hasCommandModule is false when src/command.ts is absent", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (target: fs.PathLike) => !String(target).endsWith("command.ts"),
    );

    const resolved = resolveScript("json-etl", SCRIPTS_ROOT);

    expect(resolved.hasCommandModule).toBe(false);
  });
});

describe("resolveScript — script directory not found", () => {
  test("throws ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND when the script directory does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    let thrown: unknown;
    try {
      resolveScript("missing-script", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });
});

describe("resolveScript — scriptDir composition", () => {
  test("scriptDir is path.join(scriptsRoot, scriptName)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const resolved = resolveScript("sqs-etl", "/some/other/root");

    expect(resolved.scriptDir).toBe(path.join("/some/other/root", "sqs-etl"));
  });
});

describe("resolveScript — invalid scriptName pattern", () => {
  test("throws ERR_CONSOLE_BAD_REQUEST without calling existsSync", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    let thrown: unknown;
    try {
      resolveScript("MyScript", SCRIPTS_ROOT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
    expect(existsSyncSpy).not.toHaveBeenCalled();
  });
});

describe("M3LResolvedScript", () => {
  test("has the exact readonly field shape the contract declares", () => {
    expectTypeOf<M3LResolvedScript>().toEqualTypeOf<{
      readonly name: string;
      readonly scriptsRoot: string;
      readonly scriptDir: string;
      readonly hasCommandModule: boolean;
    }>();
  });
});
