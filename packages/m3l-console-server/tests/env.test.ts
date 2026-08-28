/**
 * Tests for src/config/env.ts — `loadConsoleConfig` (m3l-console-server X2a
 * contract). Every case injects `env` explicitly; `process.env` is never
 * mutated. Direct `isLoopbackHost`/`unwrapBracketedHost` predicate tests live
 * in `tests/loopback.test.ts` (src/net/loopback.ts); the loopback host
 * cases below stay here because they exercise `loadConsoleConfig`'s
 * validation of `M3L_CONSOLE_HOST`, not the predicate directly.
 */
import * as path from "node:path";

import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { loadConsoleConfig } from "../src/config/env.js";
import type {
  LoadConsoleConfigOptions,
  M3LConsoleConfig,
} from "../src/config/env.js";

/** Dotted config key the log-level setting is stored under (mirrors `src/config/env.ts`). */
const LOG_LEVEL_KEY = "m3l.console.log.level";
/** Dotted config key the database path setting is stored under. */
const DB_PATH_KEY = "m3l.console.db.path";
/** Dotted config key the database busy-timeout setting is stored under. */
const DB_BUSY_TIMEOUT_KEY = "m3l.console.db.busy.timeout.ms";
/** Dotted config key the request-body byte cap setting is stored under. */
const MAX_BODY_BYTES_KEY = "m3l.console.max.body.bytes";

/** Hermetic data dir injected via `LoadConsoleConfigOptions.resolveDataDir`. */
const TEST_DATA_DIR = "/test-data";

/** The documented default database path, under the hermetic data dir above. */
const DEFAULT_DB_PATH = path.join(TEST_DATA_DIR, "console", "console.sqlite");

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds a minimal valid env, then applies `overrides` on top. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_OPERATOR_NAME: "ada",
    ...overrides,
  };
}

/** Asserts that `fn` throws an `M3LConsoleError` with the given code. */
function expectConsoleConfigError(
  fn: () => unknown,
  code: M3LConsoleError["code"] = "ERR_CONSOLE_CONFIG_INVALID",
): void {
  expect(fn).toThrow(M3LConsoleError);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(M3LConsoleError);
  expect((thrown as M3LConsoleError).code).toBe(code);
}

describe("M3LConsoleConfig", () => {
  test("has the exact field shape and types the contract declares", () => {
    expectTypeOf<M3LConsoleConfig>().toEqualTypeOf<{
      readonly host: string;
      readonly port: number;
      readonly operatorName: string;
      readonly operatorEmail: string | undefined;
      readonly drainTimeoutMs: number;
      readonly logLevel: Core.M3LLogLevelFloor;
      readonly databasePath: string;
      readonly databaseBusyTimeoutMs: number;
      readonly maxBodyBytes: number;
    }>();
  });
});

describe("LoadConsoleConfigOptions", () => {
  test("gains an optional resolveDataDir seam", () => {
    expectTypeOf<LoadConsoleConfigOptions>().toEqualTypeOf<{
      readonly env?: NodeJS.ProcessEnv;
      readonly resolveDataDir?: () => string;
    }>();
  });
});

describe("loadConsoleConfig — defaults", () => {
  test("resolves every default when only the operator name is set", () => {
    const config = loadConsoleConfig({
      env: buildEnv(),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 8787,
      operatorName: "ada",
      operatorEmail: undefined,
      drainTimeoutMs: 15000,
      logLevel: "info",
      databasePath: DEFAULT_DB_PATH,
      databaseBusyTimeoutMs: 5000,
      maxBodyBytes: 65536,
    });
  });
});

describe("loadConsoleConfig — every setting overridden", () => {
  test("resolves every overridden env var into the config", () => {
    const config = loadConsoleConfig({
      env: buildEnv({
        M3L_CONSOLE_HOST: "localhost",
        M3L_CONSOLE_PORT: "9999",
        M3L_CONSOLE_OPERATOR_NAME: "grace",
        M3L_CONSOLE_OPERATOR_EMAIL: "grace@example.com",
        M3L_CONSOLE_DRAIN_TIMEOUT_MS: "5000",
        M3L_CONSOLE_LOG_LEVEL: "debug",
        M3L_CONSOLE_DB_PATH: "custom/console.sqlite",
        M3L_CONSOLE_DB_BUSY_TIMEOUT_MS: "1234",
        M3L_CONSOLE_MAX_BODY_BYTES: "131072",
      }),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config).toEqual({
      host: "localhost",
      port: 9999,
      operatorName: "grace",
      operatorEmail: "grace@example.com",
      drainTimeoutMs: 5000,
      logLevel: "debug",
      databasePath: path.resolve(TEST_DATA_DIR, "custom/console.sqlite"),
      databaseBusyTimeoutMs: 1234,
      maxBodyBytes: 131072,
    });
  });
});

describe("loadConsoleConfig — operator name is required", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID when M3L_CONSOLE_OPERATOR_NAME is missing", () => {
    expectConsoleConfigError(() =>
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: undefined }),
      }),
    );
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID for an empty operator name", () => {
    expectConsoleConfigError(() =>
      loadConsoleConfig({ env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: "" }) }),
    );
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID for a whitespace-only operator name", () => {
    expectConsoleConfigError(() =>
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_OPERATOR_NAME: "   " }),
      }),
    );
  });
});

describe("loadConsoleConfig — host validation (ADR-0071 loopback-only)", () => {
  test.each<[string]>([
    ["0.0.0.0"],
    ["::"],
    ["192.168.1.1"],
    ["127.0.0.1.evil.com"],
  ])(
    "throws ERR_CONSOLE_CONFIG_INVALID for the non-loopback host %s",
    (host) => {
      expectConsoleConfigError(() =>
        loadConsoleConfig({ env: buildEnv({ M3L_CONSOLE_HOST: host }) }),
      );
    },
  );

  test.each<[string]>([
    ["localhost"],
    ["LOCALHOST"],
    ["127.0.0.1"],
    ["127.1.2.3"],
    ["::1"],
    ["0:0:0:0:0:0:0:1"],
  ])("accepts the loopback host %s", (host) => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_HOST: host }),
    });
    expect(config.host).toBe(host);
  });

  // `listen({ host: "[::1]" })` fails `ENOTFOUND getaddrinfo [::1]` — Node's
  // net/http binder resolves the bracketed form as a literal, unbindable
  // hostname, not the address `::1`. `resolveHost` therefore normalizes a
  // bracketed IPv6 host to its unbracketed form before returning it, even
  // though `isLoopbackHost` (see below) still accepts both spellings.
  test("normalizes the bracketed loopback host [::1] to its unbracketed form", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_HOST: "[::1]" }),
    });
    expect(config.host).toBe("::1");
  });

  // Host is the sole deliberate exception to this module's "never echo the
  // raw value" rule — it IS named in the failure message. This cap exists
  // purely to stop a pathological value (megabytes of text passed as an env
  // var) from flooding a log line; it is not a secrecy control.
  test("truncates a pathologically long rejected host in the failure message instead of echoing it whole", () => {
    const pathologicalHost = "x".repeat(5000);

    let thrown: unknown;
    try {
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_HOST: pathologicalHost }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const message = (thrown as M3LConsoleError).message;
    expect(message).toContain("…(truncated)");
    expect(message).not.toContain(pathologicalHost);
    expect(message.length).toBeLessThan(200);
  });
});

describe("loadConsoleConfig — port validation", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID for a non-numeric port", () => {
    expectConsoleConfigError(() =>
      loadConsoleConfig({ env: buildEnv({ M3L_CONSOLE_PORT: "not-a-port" }) }),
    );
  });

  test.each<[string]>([["0"], ["70000"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for the out-of-range port %s",
    (port) => {
      expectConsoleConfigError(() =>
        loadConsoleConfig({ env: buildEnv({ M3L_CONSOLE_PORT: port }) }),
      );
    },
  );

  test("accepts the boundary port 1", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_PORT: "1" }),
    });
    expect(config.port).toBe(1);
  });

  test("accepts the boundary port 65535", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_PORT: "65535" }),
    });
    expect(config.port).toBe(65535);
  });
});

describe("loadConsoleConfig — drain timeout validation", () => {
  test.each<[string]>([["0"], ["-5"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for the non-positive drain timeout %s",
    (drainTimeoutMs) => {
      expectConsoleConfigError(() =>
        loadConsoleConfig({
          env: buildEnv({ M3L_CONSOLE_DRAIN_TIMEOUT_MS: drainTimeoutMs }),
        }),
      );
    },
  );

  // MAX_DRAIN_TIMEOUT_MS (2_147_483_647) is Node's maximum representable
  // 32-bit signed timer delay. A value above it is silently coerced to 1ms
  // with a TimeoutOverflowWarning, so an operator asking the server to
  // "drain forever" would instead get an immediate kill that drops
  // in-flight work — the exact inverse of the intent. The boundary must be
  // exact: the max itself is still a real, honoured timeout.
  test("accepts the boundary drain timeout 2147483647 (Node's max 32-bit signed timer delay)", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_DRAIN_TIMEOUT_MS: "2147483647" }),
    });
    expect(config.drainTimeoutMs).toBe(2147483647);
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID for a drain timeout one above the 32-bit signed timer bound", () => {
    expectConsoleConfigError(() =>
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_DRAIN_TIMEOUT_MS: "2147483648" }),
      }),
    );
  });
});

describe("loadConsoleConfig — log level validation", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID for an unknown log level", () => {
    expectConsoleConfigError(() =>
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_LOG_LEVEL: "verbose" }),
      }),
    );
  });

  // This failure goes through the `wrapConfigRead` accessor path (no
  // coercion involved: `oneOf` rejects an out-of-vocabulary string) — a
  // distinct wrap site from the `storeFromEnv` coercion failure covered
  // below. Both sites must chain `cause` and name the offending key.
  test("chains the underlying M3LError as cause and names the log-level key for an unknown log level", () => {
    let thrown: unknown;
    try {
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_LOG_LEVEL: "verbose" }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const consoleError = thrown as M3LConsoleError;
    expect(consoleError.cause).toBeInstanceOf(Core.M3LError);
    expect(consoleError.context).toMatchObject({ key: LOG_LEVEL_KEY });
  });

  test.each<[Core.M3LLogLevelFloor]>([
    ["debug"],
    ["info"],
    ["success"],
    ["warning"],
    ["error"],
    ["fatal"],
  ])("accepts the log level %s", (logLevel) => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_LOG_LEVEL: logLevel }),
    });
    expect(config.logLevel).toBe(logLevel);
  });
});

describe("loadConsoleConfig — never mutates process.env", () => {
  test("does not touch the real process.env when env is injected", () => {
    const before = { ...process.env };

    loadConsoleConfig({ env: buildEnv() });

    expect(process.env).toEqual(before);
  });
});

describe("loadConsoleConfig — database path validation", () => {
  test("resolves the default database path under the injected data dir when unset", () => {
    const config = loadConsoleConfig({
      env: buildEnv(),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.databasePath).toBe(DEFAULT_DB_PATH);
  });

  test("resolves M3L_CONSOLE_DB_PATH relative to the injected data dir", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_DB_PATH: "nested/store.sqlite" }),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.databasePath).toBe(
      path.resolve(TEST_DATA_DIR, "nested/store.sqlite"),
    );
  });

  // resolveStoreDatabasePath (src/config/paths.ts) already raises
  // ERR_CONSOLE_CONFIG_INVALID for a rejected path — this asserts the
  // rejection propagates through loadConsoleConfig unchanged, naming the
  // same key, rather than being swallowed or relabelled.
  test("propagates a rejected M3L_CONSOLE_DB_PATH as ERR_CONSOLE_CONFIG_INVALID naming the db path key", () => {
    let thrown: unknown;
    try {
      loadConsoleConfig({
        env: buildEnv({ M3L_CONSOLE_DB_PATH: ":memory:" }),
        resolveDataDir: () => TEST_DATA_DIR,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LConsoleError);
    const error = thrown as M3LConsoleError;
    expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
    expect(error.message).toContain(DB_PATH_KEY);
  });
});

describe("loadConsoleConfig — database busy-timeout validation", () => {
  test("resolves the documented default of 5000ms when unset", () => {
    const config = loadConsoleConfig({
      env: buildEnv(),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.databaseBusyTimeoutMs).toBe(5000);
  });

  test("resolves M3L_CONSOLE_DB_BUSY_TIMEOUT_MS when set", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_DB_BUSY_TIMEOUT_MS: "9000" }),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.databaseBusyTimeoutMs).toBe(9000);
  });

  test("accepts the boundary busy timeout 2147483647", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_DB_BUSY_TIMEOUT_MS: "2147483647" }),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.databaseBusyTimeoutMs).toBe(2147483647);
  });

  // Every invalid value below must throw ERR_CONSOLE_CONFIG_INVALID naming
  // the busy-timeout key without ever echoing the raw value — the same
  // never-echo guarantee the drain-timeout/port validators already carry.
  // A non-integer string ("5.5") fails at the earlier INT-coercion step
  // rather than the bounds check below; both sites must still satisfy the
  // same naming/never-echo contract.
  test.each<[string]>([["0"], ["-5"], ["5.5"], ["2147483648"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID naming the key, never the value, for the invalid busy timeout %s",
    (rawValue) => {
      let thrown: unknown;
      try {
        loadConsoleConfig({
          env: buildEnv({ M3L_CONSOLE_DB_BUSY_TIMEOUT_MS: rawValue }),
          resolveDataDir: () => TEST_DATA_DIR,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      const error = thrown as M3LConsoleError;
      expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
      expect(error.message).toContain(DB_BUSY_TIMEOUT_KEY);
      expect(error.message).not.toContain(rawValue);
    },
  );
});

describe("loadConsoleConfig — max body bytes validation", () => {
  test("resolves the documented default of 65536 bytes when unset", () => {
    const config = loadConsoleConfig({
      env: buildEnv(),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.maxBodyBytes).toBe(65536);
  });

  test("resolves M3L_CONSOLE_MAX_BODY_BYTES when set", () => {
    const config = loadConsoleConfig({
      env: buildEnv({ M3L_CONSOLE_MAX_BODY_BYTES: "1048576" }),
      resolveDataDir: () => TEST_DATA_DIR,
    });

    expect(config.maxBodyBytes).toBe(1048576);
  });

  // Unlike the drain/busy timeouts, this is a byte count, not a timer delay,
  // so MAX_TIMER_DELAY_MS does not bound it (see resolveMaxBodyBytes's
  // TSDoc in src/config/env.ts) — only non-positive and non-integer values
  // are rejected. A non-integer string ("5.5") fails at the earlier
  // INT-coercion step rather than the `<= 0` check below; both sites must
  // still satisfy the same naming/never-echo contract.
  test.each<[string]>([["0"], ["-5"], ["5.5"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID naming the key, never the value, for the invalid max body bytes %s",
    (rawValue) => {
      let thrown: unknown;
      try {
        loadConsoleConfig({
          env: buildEnv({ M3L_CONSOLE_MAX_BODY_BYTES: rawValue }),
          resolveDataDir: () => TEST_DATA_DIR,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(M3LConsoleError);
      const error = thrown as M3LConsoleError;
      expect(error.code).toBe("ERR_CONSOLE_CONFIG_INVALID");
      expect(error.message).toContain(MAX_BODY_BYTES_KEY);
      expect(error.message).not.toContain(rawValue);
    },
  );
});
