/**
 * Tests for `src/runs/catalog.ts` — `listScriptSummaries` and
 * `readScriptSummary` (m3l-console-server X10b contract §2), plus
 * `src/runs/resolver.ts`'s new `executionModeForScript` export (contract
 * §1) and a drift assertion that `runs/orchestrator.ts` no longer declares
 * its own private copy of that logic.
 *
 * Real temp directories via `node:fs`/`node:os` are used throughout (not a
 * mocked `node:fs`) — filesystem shape (which directories are "launchable
 * scripts") IS the behavior under test here, matching
 * `config-introspection-module.test.ts`'s established idiom in
 * `packages/m3l-common/tests/`.
 *
 * RED: `../src/runs/catalog.ts` does not exist yet, and `executionModeForScript`
 * is not yet exported from `../src/runs/resolver.js` — every import below is
 * expected to fail to resolve until the implementer lands the module.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { listScriptSummaries, readScriptSummary } from "../src/runs/catalog.js";
import type { M3LScriptSummary } from "../src/runs/catalog.js";
import { executionModeForScript } from "../src/runs/resolver.js";
import type { M3LResolvedScript } from "../src/runs/resolver.js";

let scriptsRoot: string;

beforeEach(() => {
  scriptsRoot = mkdtempSync(join(tmpdir(), "m3l-runs-catalog-"));
});

afterEach(() => {
  rmSync(scriptsRoot, { recursive: true, force: true });
  // Only the "rethrow" describe blocks below vi.spyOn Core.resolveConfigModulePath;
  // restoreAllMocks is a no-op for every other test in this file.
  vi.restoreAllMocks();
});

/** Creates `<scriptsRoot>/<name>/dist/config.js`, marking it a launchable script via the compiled path. */
function makeScriptWithDistConfig(name: string): string {
  const scriptDir = join(scriptsRoot, name);
  mkdirSync(join(scriptDir, "dist"), { recursive: true });
  writeFileSync(join(scriptDir, "dist", "config.js"), "// dist config");
  return scriptDir;
}

/** Creates `<scriptsRoot>/<name>/src/config.ts`, marking it a launchable script via the source path. */
function makeScriptWithSrcConfig(name: string): string {
  const scriptDir = join(scriptsRoot, name);
  mkdirSync(join(scriptDir, "src"), { recursive: true });
  writeFileSync(join(scriptDir, "src", "config.ts"), "// src config");
  return scriptDir;
}

/** Creates `<scriptsRoot>/<name>` with a `dist/command.js`, so `hasCommandModule` is `true`. */
function addCommandModule(scriptDir: string): void {
  mkdirSync(join(scriptDir, "dist"), { recursive: true });
  writeFileSync(join(scriptDir, "dist", "command.js"), "// command");
}

/** Writes a `package.json` with the given `description` field (or omits it when `undefined`). */
function writePackageJson(
  scriptDir: string,
  description: string | undefined,
): void {
  const body: Record<string, unknown> =
    description === undefined ? {} : { description };
  writeFileSync(join(scriptDir, "package.json"), JSON.stringify(body));
}

describe("executionModeForScript", () => {
  function buildResolved(hasCommandModule: boolean): M3LResolvedScript {
    return {
      name: "sqs-etl",
      scriptsRoot: "/scripts",
      scriptDir: "/scripts/sqs-etl",
      hasCommandModule,
    };
  }

  test("returns 'in-process' when the resolved script has a command module", () => {
    expect(executionModeForScript(buildResolved(true))).toBe("in-process");
  });

  test("returns 'spawn' when the resolved script has no command module", () => {
    expect(executionModeForScript(buildResolved(false))).toBe("spawn");
  });
});

describe("executionModeForScript — drift guard against orchestrator.ts", () => {
  test("runs/orchestrator.ts no longer declares its own computeExecutionMode helper", () => {
    // This is a pure-move drift guard (contract §1): orchestrator.ts must
    // import executionModeForScript from resolver.ts rather than keeping a
    // duplicate private implementation. Grepping the source text (rather
    // than reflecting on the module's exports, which wouldn't see a
    // private, unexported function anyway) is the only way to assert a
    // NEGATIVE — that the symbol name is gone from the file entirely.
    const orchestratorSource = readFileSync(
      join(import.meta.dirname, "../src/runs/orchestrator.ts"),
      "utf8",
    );

    expect(orchestratorSource).not.toContain("computeExecutionMode");
  });
});

describe("listScriptSummaries — inclusion and exclusion rules", () => {
  test("includes a directory with only dist/config.js", () => {
    makeScriptWithDistConfig("has-dist-only");

    const summaries = listScriptSummaries(scriptsRoot);

    expect(
      summaries.map((summary: { name: string }) => summary.name),
    ).toContain("has-dist-only");
  });

  test("includes a directory with only src/config.ts", () => {
    makeScriptWithSrcConfig("has-src-only");

    const summaries = listScriptSummaries(scriptsRoot);

    expect(
      summaries.map((summary: { name: string }) => summary.name),
    ).toContain("has-src-only");
  });

  test("excludes a directory whose name is not kebab-case", () => {
    makeScriptWithDistConfig("Not-Kebab-Case");

    const summaries = listScriptSummaries(scriptsRoot);

    expect(
      summaries.map((summary: { name: string }) => summary.name),
    ).not.toContain("Not-Kebab-Case");
  });

  test("excludes a plain file sitting alongside script directories", () => {
    makeScriptWithDistConfig("real-script");
    writeFileSync(join(scriptsRoot, "not-a-directory"), "just a file");

    const summaries = listScriptSummaries(scriptsRoot);

    expect(
      summaries.map((summary: { name: string }) => summary.name),
    ).not.toContain("not-a-directory");
  });

  test("excludes a directory with no config module at all", () => {
    mkdirSync(join(scriptsRoot, "empty-dir"), { recursive: true });

    const summaries = listScriptSummaries(scriptsRoot);

    expect(
      summaries.map((summary: { name: string }) => summary.name),
    ).not.toContain("empty-dir");
  });

  test("sorts results ascending by name using plain comparison, not locale-aware ordering", () => {
    makeScriptWithDistConfig("zebra-script");
    makeScriptWithDistConfig("alpha-script");
    makeScriptWithDistConfig("mid-script");

    const summaries = listScriptSummaries(scriptsRoot);

    expect(summaries.map((summary: { name: string }) => summary.name)).toEqual([
      "alpha-script",
      "mid-script",
      "zebra-script",
    ]);
  });

  test("wraps a readdirSync failure as ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED without echoing the path", () => {
    const missingRoot = join(scriptsRoot, "does-not-exist");

    let thrown: unknown;
    try {
      listScriptSummaries(missingRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_SCRIPT_INTROSPECTION_FAILED",
    );
    expect((thrown as M3LConsoleError).message).not.toContain(missingRoot);
  });

  test("each summary reflects executionMode consistent with hasCommandModule", () => {
    const scriptDir = makeScriptWithDistConfig("with-command");
    addCommandModule(scriptDir);
    makeScriptWithDistConfig("without-command");

    const summaries = listScriptSummaries(scriptsRoot);
    const withCommand = summaries.find(
      (summary: { name: string }) => summary.name === "with-command",
    );
    const withoutCommand = summaries.find(
      (summary: { name: string }) => summary.name === "without-command",
    );

    expect(withCommand?.hasCommandModule).toBe(true);
    expect(withCommand?.executionMode).toBe("in-process");
    expect(withoutCommand?.hasCommandModule).toBe(false);
    expect(withoutCommand?.executionMode).toBe("spawn");
  });
});

describe("listScriptSummaries — description fallback and cap", () => {
  test("falls back to '' when package.json is missing entirely", () => {
    makeScriptWithDistConfig("no-package-json");

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "no-package-json",
    );

    expect(summary?.description).toBe("");
  });

  test("falls back to '' when package.json is invalid JSON", () => {
    const scriptDir = makeScriptWithDistConfig("bad-json");
    writeFileSync(join(scriptDir, "package.json"), "{ not valid json");

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "bad-json",
    );

    expect(summary?.description).toBe("");
  });

  test("falls back to '' when the description field is not a string", () => {
    const scriptDir = makeScriptWithDistConfig("non-string-description");
    writeFileSync(
      join(scriptDir, "package.json"),
      JSON.stringify({ description: 12345 }),
    );

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "non-string-description",
    );

    expect(summary?.description).toBe("");
  });

  test("falls back to '' when package.json's top-level JSON is a scalar string, not an object", () => {
    const scriptDir = makeScriptWithDistConfig("scalar-string-json");
    writeFileSync(
      join(scriptDir, "package.json"),
      JSON.stringify("just a string"),
    );

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "scalar-string-json",
    );

    expect(summary?.description).toBe("");
  });

  test("falls back to '' when package.json's top-level JSON is a scalar number, not an object", () => {
    const scriptDir = makeScriptWithDistConfig("scalar-number-json");
    writeFileSync(join(scriptDir, "package.json"), JSON.stringify(42));

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "scalar-number-json",
    );

    expect(summary?.description).toBe("");
  });

  test("falls back to '' when package.json's top-level JSON is null", () => {
    const scriptDir = makeScriptWithDistConfig("null-json");
    writeFileSync(join(scriptDir, "package.json"), JSON.stringify(null));

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "null-json",
    );

    expect(summary?.description).toBe("");
  });

  test("uses the package.json description verbatim when present and short", () => {
    const scriptDir = makeScriptWithDistConfig("described-script");
    writePackageJson(scriptDir, "Extracts data from SQS.");

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "described-script",
    );

    expect(summary?.description).toBe("Extracts data from SQS.");
  });

  test("truncates a description longer than 500 characters", () => {
    const scriptDir = makeScriptWithDistConfig("long-description");
    const longDescription = "x".repeat(600);
    writePackageJson(scriptDir, longDescription);

    const summaries = listScriptSummaries(scriptsRoot);
    const summary = summaries.find(
      (s: { name: string }) => s.name === "long-description",
    );

    expect(summary?.description).toHaveLength(500);
    expect(summary?.description).toBe("x".repeat(500));
  });
});

describe("readScriptSummary", () => {
  test("returns the summary for a launchable script", () => {
    const scriptDir = makeScriptWithDistConfig("sqs-etl");
    writePackageJson(scriptDir, "Extracts data from SQS.");

    const summary: M3LScriptSummary = readScriptSummary("sqs-etl", scriptsRoot);

    expect(summary).toEqual({
      name: "sqs-etl",
      description: "Extracts data from SQS.",
      hasCommandModule: false,
      executionMode: "spawn",
    });
  });

  test("propagates ERR_CONSOLE_BAD_REQUEST for a non-kebab-case name", () => {
    let thrown: unknown;
    try {
      readScriptSummary("Not-Kebab", scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe("ERR_CONSOLE_BAD_REQUEST");
  });

  test("propagates ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND when the script directory is missing", () => {
    let thrown: unknown;
    try {
      readScriptSummary("missing-script", scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
  });

  test("maps a directory with no config module to ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND (a caller-facing 404, not a server fault)", () => {
    mkdirSync(join(scriptsRoot, "no-config-dir"), { recursive: true });

    let thrown: unknown;
    try {
      readScriptSummary("no-config-dir", scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    expect((thrown as M3LConsoleError).code).toBe(
      "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
    );
    expect((thrown as M3LConsoleError).message).not.toContain(scriptsRoot);
  });
});

describe("listScriptSummaries — isLaunchableScriptEntry rethrows a non-ERR_CONFIG_MODULE_NOT_FOUND failure", () => {
  // The catch in isLaunchableScriptEntry (src/runs/catalog.ts) is a narrow
  // guard: it swallows exactly Core.M3LError with code
  // ERR_CONFIG_MODULE_NOT_FOUND into "not a launchable script" (`return
  // false`), and rethrows everything else unchanged. Widening that catch to
  // a bare `catch { return false; }` would make both cases below fail,
  // since the mocked failure would then be silently swallowed instead of
  // propagating out of listScriptSummaries.

  test("rethrows an M3LError with a different code, unwrapped", () => {
    mkdirSync(join(scriptsRoot, "candidate-script"), { recursive: true });
    const otherError = new Core.M3LError("unrelated failure", {
      code: "ERR_SOMETHING_ELSE",
    });
    vi.spyOn(Core, "resolveConfigModulePath").mockImplementation(() => {
      throw otherError;
    });

    let thrown: unknown;
    try {
      listScriptSummaries(scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(otherError);
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
  });

  test("rethrows a plain, non-M3LError failure, unwrapped", () => {
    mkdirSync(join(scriptsRoot, "candidate-script"), { recursive: true });
    const plainError = new RangeError(
      "not an M3LError - simulates a module defect",
    );
    vi.spyOn(Core, "resolveConfigModulePath").mockImplementation(() => {
      throw plainError;
    });

    let thrown: unknown;
    try {
      listScriptSummaries(scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(plainError);
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
  });
});

describe("readScriptSummary — rethrows a non-ERR_CONFIG_MODULE_NOT_FOUND failure", () => {
  // Same narrow-catch guarantee as isLaunchableScriptEntry above, but for
  // readScriptSummary's own try/catch around Core.resolveConfigModulePath:
  // only ERR_CONFIG_MODULE_NOT_FOUND maps to the caller-facing
  // ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND 404; anything else propagates
  // unchanged. A bare `catch { throw new M3LConsoleError(...) }` would wrap
  // both cases below into ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND and fail them.

  test("rethrows an M3LError with a different code, unwrapped", () => {
    mkdirSync(join(scriptsRoot, "sqs-etl"), { recursive: true });
    const otherError = new Core.M3LError("unrelated failure", {
      code: "ERR_SOMETHING_ELSE",
    });
    vi.spyOn(Core, "resolveConfigModulePath").mockImplementation(() => {
      throw otherError;
    });

    let thrown: unknown;
    try {
      readScriptSummary("sqs-etl", scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(otherError);
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
  });

  test("rethrows a plain, non-M3LError failure, unwrapped", () => {
    mkdirSync(join(scriptsRoot, "sqs-etl"), { recursive: true });
    const plainError = new RangeError(
      "not an M3LError - simulates a module defect",
    );
    vi.spyOn(Core, "resolveConfigModulePath").mockImplementation(() => {
      throw plainError;
    });

    let thrown: unknown;
    try {
      readScriptSummary("sqs-etl", scriptsRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(plainError);
    expect(thrown).not.toBeInstanceOf(M3LConsoleError);
  });
});

describe("symlinked script directories — list and detail agree (X10b Fix A)", () => {
  // isLaunchableScriptEntry's exclusion of a symlink is documented in
  // catalog.ts's own TSDoc and already implemented (Dirent.isDirectory()
  // reports false for a symlink), so the `listScriptSummaries` case below
  // is coverage for existing behavior, not a new assertion. The
  // `readScriptSummary` case is the actual regression lock for Fix A:
  // today `resolver.ts`'s `resolveScript` uses `fs.existsSync`, which
  // FOLLOWS the symlink, so `readScriptSummary` currently resolves and
  // returns a summary for a symlinked name that `listScriptSummaries` never
  // lists — list and detail disagreeing is exactly the confirmed exploit
  // the fix closes.

  test("listScriptSummaries excludes a symlinked directory even though its target is a valid launchable script", () => {
    const target = mkdtempSync(
      join(tmpdir(), "m3l-runs-catalog-symlink-target-"),
    );
    try {
      mkdirSync(join(target, "dist"), { recursive: true });
      writeFileSync(join(target, "dist", "config.js"), "// dist config");
      symlinkSync(target, join(scriptsRoot, "symlinked-script"));

      const summaries = listScriptSummaries(scriptsRoot);

      expect(
        summaries.map((summary: { name: string }) => summary.name),
      ).not.toContain("symlinked-script");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("readScriptSummary on that same symlinked name throws ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND", () => {
    const target = mkdtempSync(
      join(tmpdir(), "m3l-runs-catalog-symlink-target-"),
    );
    try {
      mkdirSync(join(target, "dist"), { recursive: true });
      writeFileSync(join(target, "dist", "config.js"), "// dist config");
      symlinkSync(target, join(scriptsRoot, "symlinked-script"));

      let thrown: unknown;
      try {
        readScriptSummary("symlinked-script", scriptsRoot);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      expect((thrown as M3LConsoleError).code).toBe(
        "ERR_CONSOLE_RUN_SCRIPT_NOT_FOUND",
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
