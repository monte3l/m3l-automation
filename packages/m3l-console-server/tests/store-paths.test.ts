/**
 * Tests for src/config/paths.ts — `resolveStoreDatabasePath` (X3 console-
 * persistence, slice A2, ADR-0069). Drives only `src/config/paths.ts`; keep
 * `env.ts` out of this file so v8's `perFile` coverage binds this src slice
 * to this test file alone (see `tests.md`'s per-file-size note).
 *
 * No filesystem I/O anywhere in this file: `resolveStoreDatabasePath` is a
 * pure path computation, so the tests need none either.
 */
import * as path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { resolveStoreDatabasePath } from "../src/config/paths.js";
import type { ResolveStoreDatabasePathOptions } from "../src/config/paths.js";

/** Dotted config key every rejection must name (never the rejected value). */
const DB_PATH_KEY = "m3l.console.db.path";

/** Env vars this file deliberately pollutes to prove the resolver never reads them. */
const ENV_KEYS_UNDER_TEST = ["M3L_DATA_DIR", "M3L_CONSOLE_DB_PATH"] as const;

/** Snapshot of the two env vars above, captured before each polluting test mutates them. */
let savedEnv: Record<(typeof ENV_KEYS_UNDER_TEST)[number], string | undefined> =
  {
    M3L_DATA_DIR: undefined,
    M3L_CONSOLE_DB_PATH: undefined,
  };

afterEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv = {
    M3L_DATA_DIR: undefined,
    M3L_CONSOLE_DB_PATH: undefined,
  };
});

describe("ResolveStoreDatabasePathOptions", () => {
  test("declares both fields optional", () => {
    expectTypeOf<ResolveStoreDatabasePathOptions>().toEqualTypeOf<{
      readonly configuredPath?: string | undefined;
      readonly resolveDataDir?: () => string;
    }>();
  });
});

describe("resolveStoreDatabasePath — default", () => {
  test("resolves <dataDir>/console/console.sqlite when configuredPath is absent", () => {
    const result = resolveStoreDatabasePath({
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.join("/data", "console", "console.sqlite"));
  });

  test("resolveStoreDatabasePath is callable with no options at all", () => {
    expectTypeOf(resolveStoreDatabasePath).toBeCallableWith();
  });
});

describe("resolveStoreDatabasePath — configuredPath resolution", () => {
  test("resolves a relative configuredPath against the injected data dir", () => {
    const result = resolveStoreDatabasePath({
      configuredPath: "custom/store.sqlite",
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(path.resolve("/data", "custom/store.sqlite"));
  });

  test("passes an absolute configuredPath through path.resolve unchanged", () => {
    const absolute = path.resolve(path.sep, "abs", "store.sqlite");

    const result = resolveStoreDatabasePath({
      configuredPath: absolute,
      resolveDataDir: () => "/data",
    });

    expect(result).toBe(absolute);
  });
});

describe("resolveStoreDatabasePath — rejects an unsafe configuredPath", () => {
  test.each<[string, string]>([
    ["a blank string", ""],
    ["a whitespace-only string", "   "],
    ["the literal :memory:", ":memory:"],
    ["a file: prefix", "file:///tmp/store.sqlite"],
    ["a trailing path separator", `some/dir${path.sep}`],
  ])(
    "rejects %s as ERR_CONSOLE_CONFIG_INVALID naming the key and never echoing the value",
    (_label, rejectedValue) => {
      let thrown: unknown;
      try {
        resolveStoreDatabasePath({
          configuredPath: rejectedValue,
          resolveDataDir: () => "/data",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      const error = thrown as M3LConsoleError;
      expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
      expect(error.message).toContain(DB_PATH_KEY);
      // A blank/whitespace-only rejected value trivially satisfies "message
      // does not contain the value" (every string contains "" or is itself
      // whitespace-adjacent noise), so that assertion only carries signal
      // for a non-blank rejected value.
      if (rejectedValue.trim().length > 0) {
        expect(error.message).not.toContain(rejectedValue);
      }
    },
  );
});

describe("resolveStoreDatabasePath — resolveDataDir failure", () => {
  test("wraps a thrown resolveDataDir failure as M3LConsoleError, chaining the original as cause", () => {
    const original = new Error(
      "boom - simulates M3LPathResolutionError/M3LEnvironmentDetectionError escaping M3LPaths",
    );

    let thrown: unknown;
    try {
      resolveStoreDatabasePath({
        resolveDataDir: () => {
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
  });
});

describe("resolveStoreDatabasePath — never reads process.env", () => {
  test("ignores M3L_DATA_DIR and M3L_CONSOLE_DB_PATH sentinels planted in process.env", () => {
    const SENTINEL = "sentinel-value-9f3c1a-should-never-appear";
    savedEnv = {
      M3L_DATA_DIR: process.env["M3L_DATA_DIR"],
      M3L_CONSOLE_DB_PATH: process.env["M3L_CONSOLE_DB_PATH"],
    };
    process.env["M3L_DATA_DIR"] = SENTINEL;
    process.env["M3L_CONSOLE_DB_PATH"] = SENTINEL;

    const result = resolveStoreDatabasePath({
      resolveDataDir: () => "/data",
    });

    expect(result).not.toContain(SENTINEL);
    expect(result).toBe(path.join("/data", "console", "console.sqlite"));
  });
});

describe("resolveStoreDatabasePath — path traversal / absolute paths (accepted-behavior regression lock)", () => {
  // Escaping the data directory is accepted, not overlooked.
  // `M3L_CONSOLE_DB_PATH` is set by the operator, for a loopback-only
  // process that runs as them and can already write anywhere their umask
  // allows; containment would break the legitimate "put the database on a
  // separate volume" case while preventing nothing they could not do more
  // directly. Revisit if this path ever becomes settable through the HTTP
  // surface — at that point the actor is no longer necessarily the
  // operator, and containment becomes worth its cost.
  //
  // This test PASSES today — it pins the current, deliberate behavior as a
  // regression lock, not a RED test proving a fix.
  test("a relative configuredPath containing ../ traversal resolves outside the injected data dir", () => {
    const dataDir = path.join(path.sep, "data", "dir");

    const result = resolveStoreDatabasePath({
      configuredPath: path.join("..", "..", "elsewhere", "db.sqlite"),
      resolveDataDir: () => dataDir,
    });

    expect(result).toBe(
      path.resolve(dataDir, "..", "..", "elsewhere", "db.sqlite"),
    );
    // The discriminating assertion: the resolved path is NOT contained
    // within `dataDir` — proving traversal actually escapes, not merely
    // that some path was returned.
    const relative = path.relative(dataDir, result);
    expect(relative.startsWith("..")).toBe(true);
  });

  test("an absolute configuredPath passes through unchanged, regardless of the injected data dir", () => {
    const dataDir = path.join(path.sep, "data", "dir");
    const absolute = path.resolve(path.sep, "somewhere", "else", "db.sqlite");

    const result = resolveStoreDatabasePath({
      configuredPath: absolute,
      resolveDataDir: () => dataDir,
    });

    expect(result).toBe(absolute);
    const relative = path.relative(dataDir, result);
    expect(relative.startsWith("..")).toBe(true);
  });
});
