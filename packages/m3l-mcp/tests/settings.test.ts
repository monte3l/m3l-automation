// Tests for src/config/settings.ts (V10c contract, "File 1"):
// loadM3LMcpSettings resolves this package's boot configuration from
// injected env + paths, never from the real process.env/filesystem.
//
// Every test injects both `env` and `paths` explicitly (contract requirement
// for this file) — `paths` is satisfied by a plain object literal typed as
// `Pick<Core.M3LPaths, "getProjectRoot">`, never a real `Core.M3LPaths`
// instance, so nothing here touches the filesystem.
import { dirname, join } from "node:path";
import { inspect } from "node:util";

import { Core } from "@monte3l/m3l-common";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { M3LMcpError } from "../src/errors/mcp-error.js";
import {
  loadM3LMcpSettings,
  type LoadM3LMcpSettingsOptions,
  type M3LMcpSettings,
} from "../src/config/settings.js";

/** A paths stub that never resolves a project root — used whenever the
 * entrypoint is supplied explicitly, so `getProjectRoot` must never fire. */
function unreachablePaths(): Pick<Core.M3LPaths, "getProjectRoot"> {
  return {
    getProjectRoot: vi.fn(() => {
      throw new Error("getProjectRoot must not be called in this test");
    }),
  };
}

/**
 * Serializes a caught error two ways and concatenates both into one
 * haystack. `JSON.stringify(error.toJSON())` alone is NOT sufficient:
 * `Core.M3LError#toJSON` fully serializes a *genuine* `M3LError` cause's
 * `message` (recursively, at depth 2 as well), but collapses a **foreign**
 * (non-`M3LError`) cause to just `{name}`, silently dropping its `message`
 * — while that value remains fully readable via `error.cause.message` and
 * via `node:util`'s `inspect(error, { depth: Infinity })`, which renders a
 * `[cause]: ...` block (stack and all) for any `Error` carrying a `cause`
 * property, regardless of its class. Without the `inspect` half, a
 * regression that stuffs a secret into a *foreign* cause's message (e.g.
 * `{ cause: new Error(...) }` instead of an `M3LError`) would pass every
 * "no leak" assertion below undetected. A non-leak assertion that only
 * checked `error.message` couldn't catch detail migrating into `context` or
 * a chained `cause` either; this widened haystack is what makes these
 * assertions able to fail at all (see the contract's Fix 2).
 */
function serialize(error: Core.M3LError): string {
  return JSON.stringify(error.toJSON()) + inspect(error, { depth: Infinity });
}

describe("loadM3LMcpSettings — defaults (monorepo mode)", () => {
  test("derives every default from the resolved project root when M3L_MCP_CLI_ENTRYPOINT is unset", () => {
    const paths: Pick<Core.M3LPaths, "getProjectRoot"> = {
      getProjectRoot: () => "/repo/root",
    };

    const settings = loadM3LMcpSettings({ env: {}, paths });

    const expectedEntrypoint = join(
      "/repo/root",
      "packages",
      "m3l-cli",
      "bin",
      "m3l.mjs",
    );
    expect(settings.cliEntrypoint).toBe(expectedEntrypoint);
    expect(settings.cliTimeoutMs).toBe(30_000);
    expect(settings.maxOutputBytes).toBe(1_048_576);
  });

  test("cwd is dirname(cliEntrypoint), not this process's cwd", () => {
    const paths: Pick<Core.M3LPaths, "getProjectRoot"> = {
      getProjectRoot: () => "/repo/root",
    };

    const settings = loadM3LMcpSettings({ env: {}, paths });

    expect(settings.cwd).toBe(dirname(settings.cliEntrypoint));
    expect(settings.cwd).not.toBe(process.cwd());
  });

  test("nodeExecPath defaults to process.execPath when not overridden", () => {
    const paths: Pick<Core.M3LPaths, "getProjectRoot"> = {
      getProjectRoot: () => "/repo/root",
    };

    const settings = loadM3LMcpSettings({ env: {}, paths });

    expect(settings.nodeExecPath).toBe(process.execPath);
  });
});

describe("loadM3LMcpSettings — overrides", () => {
  test("an explicit M3L_MCP_CLI_ENTRYPOINT wins, and short-circuits path resolution entirely", () => {
    const paths = unreachablePaths();
    const env = { M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/point/m3l.mjs" };

    const settings = loadM3LMcpSettings({ env, paths });

    expect(settings.cliEntrypoint).toBe("/custom/entry/point/m3l.mjs");
    expect(settings.cwd).toBe("/custom/entry/point");
    // Proves the standalone-mode getProjectRoot() branch is unreachable when
    // the entrypoint is supplied explicitly — the stub throws if called.
    expect(paths.getProjectRoot).not.toHaveBeenCalled();
  });

  test("an explicit M3L_MCP_CLI_TIMEOUT_MS overrides the 30000 default", () => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_CLI_TIMEOUT_MS: "5000",
    };

    const settings = loadM3LMcpSettings({ env, paths });

    expect(settings.cliTimeoutMs).toBe(5000);
  });

  test("an explicit M3L_MCP_MAX_OUTPUT_BYTES overrides the 1048576 default", () => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_MAX_OUTPUT_BYTES: "2048",
    };

    const settings = loadM3LMcpSettings({ env, paths });

    expect(settings.maxOutputBytes).toBe(2048);
  });

  test("an explicit nodeExecPath option overrides process.execPath", () => {
    const paths = unreachablePaths();
    const env = { M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs" };

    const settings = loadM3LMcpSettings({
      env,
      paths,
      nodeExecPath: "/opt/custom/node",
    });

    expect(settings.nodeExecPath).toBe("/opt/custom/node");
  });
});

describe("loadM3LMcpSettings — coercion failures never leak the raw value", () => {
  test("a non-numeric M3L_MCP_CLI_TIMEOUT_MS raises ERR_MCP_CONFIG naming the key, never the value", () => {
    const paths = unreachablePaths();
    // Distinctive sentinel standing in for a secret an env var might hold —
    // the whole point of this test is that it must never appear anywhere in
    // the raised error's message (Security rule 2: "a config coercion
    // failure names the key, never the value").
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_CLI_TIMEOUT_MS: "s3cr3t-not-a-number",
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const error = thrown as M3LMcpError;
    expect(error.code).toBe("ERR_MCP_CONFIG");
    expect(error.message).toContain("M3L_MCP_CLI_TIMEOUT_MS");
    // The actual assertion this test exists for: checked against the WHOLE
    // serialized error (message + context + chained cause), not just
    // `error.message` — a message-only check can never fail when the
    // message is a fixed string, since the sentinel would then be
    // unreachable in that position by construction.
    expect(serialize(error)).not.toContain("s3cr3t-not-a-number");
    expect(error.cause).toBeInstanceOf(Core.M3LConfigCoercionError);
  });

  test("a non-numeric M3L_MCP_MAX_OUTPUT_BYTES raises ERR_MCP_CONFIG naming the key, never the value", () => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_MAX_OUTPUT_BYTES: "s3cr3t-not-a-number",
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const error = thrown as M3LMcpError;
    expect(error.code).toBe("ERR_MCP_CONFIG");
    expect(error.message).toContain("M3L_MCP_MAX_OUTPUT_BYTES");
    expect(serialize(error)).not.toContain("s3cr3t-not-a-number");
  });
});

describe("loadM3LMcpSettings — range violations", () => {
  test.each([
    ["M3L_MCP_CLI_TIMEOUT_MS", "0"],
    ["M3L_MCP_CLI_TIMEOUT_MS", "-5"],
    ["M3L_MCP_MAX_OUTPUT_BYTES", "0"],
    ["M3L_MCP_MAX_OUTPUT_BYTES", "-1"],
  ])("%s = %s is rejected as ERR_MCP_CONFIG", (key, value) => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      [key]: value,
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    expect((thrown as M3LMcpError).code).toBe("ERR_MCP_CONFIG");
  });

  test("accepts M3L_MCP_CLI_TIMEOUT_MS exactly at the 2_147_483_647 MAX_TIMER_DELAY_MS bound", () => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_CLI_TIMEOUT_MS: "2147483647",
    };

    const settings = loadM3LMcpSettings({ env, paths });

    expect(settings.cliTimeoutMs).toBe(2_147_483_647);
  });

  test("rejects M3L_MCP_CLI_TIMEOUT_MS one past the MAX_TIMER_DELAY_MS bound", () => {
    // Node's setTimeout silently truncates any delay above the 32-bit signed
    // max (2_147_483_647 ms) down to 1ms (see Node's internal
    // `timers.enroll`). A value one past the bound is therefore NOT "wait a
    // very long time" — it is "fire almost immediately", which for this
    // package's CLI-subprocess timeout would kill a healthy child right
    // after spawning it. That silent truncation is strictly worse than a
    // loud rejection at config-load time, so the bound is enforced here
    // rather than deferred to whichever call eventually arms the timer.
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_CLI_TIMEOUT_MS: "2147483648",
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    expect((thrown as M3LMcpError).code).toBe("ERR_MCP_CONFIG");
  });
});

describe("loadM3LMcpSettings — standalone (non-monorepo) mode", () => {
  test("wraps a thrown Core.M3LPathResolutionError as ERR_MCP_CONFIG when the entrypoint is unset", () => {
    const pathResolutionError = new Core.M3LPathResolutionError(
      "getProjectRoot() is unavailable in standalone mode",
    );
    const paths: Pick<Core.M3LPaths, "getProjectRoot"> = {
      getProjectRoot: () => {
        throw pathResolutionError;
      },
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env: {}, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    const error = thrown as M3LMcpError;
    expect(error.code).toBe("ERR_MCP_CONFIG");
    expect(error.cause).toBe(pathResolutionError);
  });

  test("propagates a non-M3LPathResolutionError from getProjectRoot() unwrapped, as the same instance", () => {
    // The contract explicitly distinguishes this from the case above: "a
    // non-path failure is a bug here, not operator misconfiguration" — it
    // must NOT be wrapped in an M3LMcpError.
    const bug = new TypeError("unexpected failure inside getProjectRoot");
    const paths: Pick<Core.M3LPaths, "getProjectRoot"> = {
      getProjectRoot: () => {
        throw bug;
      },
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env: {}, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(bug);
    expect(thrown).not.toBeInstanceOf(M3LMcpError);
  });
});

describe("loadM3LMcpSettings — real Core.M3LPaths construction never leaks (Fix 1)", () => {
  // Distinctive sentinel standing in for a secret one of the seven
  // environment variables `Core.M3LPaths` construction reads might hold.
  // `Core.M3LPaths`'s own constructor (directly, and via
  // `Core.M3LExecutionEnvironment.detect()`) reads the REAL process.env for
  // these keys (never `options.env`), so only
  // `vi.stubEnv`/`vi.unstubAllEnvs` can drive these branches without a bare,
  // leak-prone mutation of the real environment.
  const SENTINEL = "relative/dir/with-SECRET-TOKEN-abc123";

  afterEach(() => {
    vi.unstubAllEnvs();
    // `Core.M3LExecutionEnvironment.detect()` — called by `new
    // Core.M3LPaths()` — memoizes its result as a process-global singleton
    // (see its own TSDoc), independent of `vi.unstubAllEnvs()`. Without this,
    // the first case in `poisonedRealPathsCases` below (which forces
    // STANDALONE mode) would leave every later case in this block reading a
    // stale cached deployment mode instead of re-detecting from the
    // now-different stubbed environment.
    Core.M3LExecutionEnvironment.resetForTesting();
  });

  // Each case stubs the real env keys needed to make its named variable
  // actually load-bearing, then poisons it (or, for M3L_DEPLOYMENT_MODE
  // itself, supplies an invalid value).
  const poisonedRealPathsCases: ReadonlyArray<
    readonly [key: string, envOverrides: Readonly<Record<string, string>>]
  > = [
    // M3L_BASE_DIR is read only by `resolveStandaloneBase()`, on the
    // STANDALONE branch of `M3LPaths`'s constructor — a no-op in MONOREPO
    // mode. This repo's own pnpm workspace marker means these tests run in
    // MONOREPO mode by default, so asserting M3L_BASE_DIR alone (without
    // also forcing STANDALONE mode) would pass vacuously: the constructor
    // would never read it, and the "throws ERR_MCP_CONFIG" assertion would
    // never even be exercised for that key. Forcing
    // M3L_DEPLOYMENT_MODE=standalone alongside it drives the key through the
    // one branch where it is actually load-bearing.
    [
      "M3L_BASE_DIR",
      { M3L_DEPLOYMENT_MODE: "standalone", M3L_BASE_DIR: SENTINEL },
    ],
    ["M3L_DATA_DIR", { M3L_DATA_DIR: SENTINEL }],
    ["M3L_CONFIG_DIR", { M3L_CONFIG_DIR: SENTINEL }],
    ["M3L_INPUT_DIR", { M3L_INPUT_DIR: SENTINEL }],
    ["M3L_OUTPUT_DIR", { M3L_OUTPUT_DIR: SENTINEL }],
    ["M3L_CACHE_DIR", { M3L_CACHE_DIR: SENTINEL }],
    // Not a M3L_*_DIR override at all — `M3L_DEPLOYMENT_MODE` itself embeds
    // the raw override value verbatim in `Core.M3LEnvironmentDetectionError`
    // ("Unrecognised M3L_DEPLOYMENT_MODE value: ..."), a seventh leak site
    // the original Fix 1 census omitted.
    [
      "M3L_DEPLOYMENT_MODE",
      { M3L_DEPLOYMENT_MODE: `not-a-real-mode-${SENTINEL}` },
    ],
  ];

  test.each(poisonedRealPathsCases)(
    "a poisoned real %s raises ERR_MCP_CONFIG with the sentinel absent from the widened haystack, cause undefined, when paths is not injected",
    (_key, envOverrides) => {
      for (const [envKey, envValue] of Object.entries(envOverrides)) {
        vi.stubEnv(envKey, envValue);
      }

      let thrown: unknown;
      try {
        // No `paths` injected — this is the branch that used to construct a
        // real Core.M3LPaths eagerly and unguarded.
        loadM3LMcpSettings({ env: {} });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LMcpError);
      const error = thrown as M3LMcpError;
      expect(error.code).toBe("ERR_MCP_CONFIG");
      const serialized = serialize(error);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain("SECRET-TOKEN");
      // The leak this fix closes is specifically a chained `cause` (whose
      // message embeds the raw value) reappearing in the serialized form.
      expect(error.cause).toBeUndefined();
    },
  );

  test("an explicit M3L_MCP_CLI_ENTRYPOINT means a poisoned real M3L_DATA_DIR never throws at all", () => {
    vi.stubEnv("M3L_DATA_DIR", SENTINEL);

    const settings = loadM3LMcpSettings({
      env: { M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs" },
    });

    expect(settings.cliEntrypoint).toBe("/custom/entry/m3l.mjs");
  });
});

describe("loadM3LMcpSettings — M3L_MCP_CLI_ENTRYPOINT boundary validation (Fix 2)", () => {
  test.each([
    ["empty", ""],
    ["relative", "relative/dir/with-SECRET-TOKEN-abc123/m3l.mjs"],
    ["containing a NUL byte", "/abs/dir/with-SECRET-TOKEN-abc123\0/m3l.mjs"],
  ])(
    "rejects a %s M3L_MCP_CLI_ENTRYPOINT as ERR_MCP_CONFIG without leaking it",
    (_label, value) => {
      const paths = unreachablePaths();
      const env = { M3L_MCP_CLI_ENTRYPOINT: value };

      let thrown: unknown;
      try {
        loadM3LMcpSettings({ env, paths });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LMcpError);
      const error = thrown as M3LMcpError;
      expect(error.code).toBe("ERR_MCP_CONFIG");
      expect(error.message).toContain("M3L_MCP_CLI_ENTRYPOINT");
      const serialized = serialize(error);
      expect(serialized).not.toContain("SECRET-TOKEN");
      // getProjectRoot() must never be consulted — validation happens before
      // any path-resolution fallback would even be considered.
      expect(paths.getProjectRoot).not.toHaveBeenCalled();
    },
  );
});

describe("loadM3LMcpSettings — M3L_MCP_MAX_OUTPUT_BYTES ceiling (Fix 2)", () => {
  test("accepts M3L_MCP_MAX_OUTPUT_BYTES exactly at the 67_108_864 ceiling", () => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_MAX_OUTPUT_BYTES: "67108864",
    };

    const settings = loadM3LMcpSettings({ env, paths });

    expect(settings.maxOutputBytes).toBe(67_108_864);
  });

  test("rejects M3L_MCP_MAX_OUTPUT_BYTES one past the 67_108_864 ceiling", () => {
    const paths = unreachablePaths();
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_MAX_OUTPUT_BYTES: "67108865",
    };

    let thrown: unknown;
    try {
      loadM3LMcpSettings({ env, paths });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LMcpError);
    expect((thrown as M3LMcpError).code).toBe("ERR_MCP_CONFIG");
  });
});

describe("loadM3LMcpSettings — does not mutate its inputs", () => {
  test("options.env is never mutated, even when a coercion or range failure is raised", () => {
    const env = Object.freeze({
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_CLI_TIMEOUT_MS: "not-a-number",
      UNRELATED_KEY: "unrelated-value",
    });
    const snapshotBefore = structuredClone(env);
    const paths = unreachablePaths();

    expect(() => loadM3LMcpSettings({ env, paths })).toThrow(M3LMcpError);

    expect(env).toStrictEqual(snapshotBefore);
  });

  test("options.env is never mutated on the happy path", () => {
    const env = {
      M3L_MCP_CLI_ENTRYPOINT: "/custom/entry/m3l.mjs",
      M3L_MCP_CLI_TIMEOUT_MS: "5000",
    };
    const snapshotBefore = structuredClone(env);
    const paths = unreachablePaths();

    loadM3LMcpSettings({ env, paths });

    expect(env).toStrictEqual(snapshotBefore);
  });
});

describe("M3LMcpSettings / LoadM3LMcpSettingsOptions (type level)", () => {
  test("M3LMcpSettings is exactly the documented readonly shape", () => {
    expectTypeOf<M3LMcpSettings>().toEqualTypeOf<{
      readonly nodeExecPath: string;
      readonly cliEntrypoint: string;
      readonly cwd: string;
      readonly cliTimeoutMs: number;
      readonly maxOutputBytes: number;
    }>();
  });

  test("loadM3LMcpSettings returns M3LMcpSettings synchronously (not a Promise)", () => {
    expectTypeOf(loadM3LMcpSettings).returns.toEqualTypeOf<M3LMcpSettings>();
  });

  test("LoadM3LMcpSettingsOptions.paths accepts a plain structural object, not only a real Core.M3LPaths", () => {
    expectTypeOf<
      NonNullable<LoadM3LMcpSettingsOptions["paths"]>
    >().toEqualTypeOf<Pick<Core.M3LPaths, "getProjectRoot">>();
  });
});
