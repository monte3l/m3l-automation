/**
 * Tests for src/config/sessions.ts — `loadSessionsConfig` (m3l-console-server
 * X6 workbench-sessions module, slice 3). Mirrors `config/runs.ts`'s own test
 * style (`tests/config-runs.test.ts`): every default, every-override, and one
 * validation test per rejected knob — plus the two cross-field checks unique
 * to this module (`artifactMaxBytes >= artifactInlineMaxBytes`,
 * `sessionTotalMaxBytes >= artifactMaxBytes`). Every case injects `env`
 * explicitly; `process.env` is never mutated.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { loadSessionsConfig } from "../src/config/sessions.js";
import type { M3LConsoleSessionsConfig } from "../src/config/sessions.js";

/** The documented defaults, per the contract table. */
const DEFAULTS = {
  artifactInlineMaxBytes: 65536,
  artifactMaxBytes: 33554432,
  sessionTotalMaxBytes: 268435456,
  openSessionsMax: 32,
} as const;

/** Asserts that `fn` throws an `M3LConsoleError` with the given code. */
function expectSessionsConfigError(
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

describe("M3LConsoleSessionsConfig", () => {
  test("has the exact field shape the contract declares", () => {
    expectTypeOf<M3LConsoleSessionsConfig>().toMatchTypeOf<{
      artifactInlineMaxBytes: number;
      artifactMaxBytes: number;
      sessionTotalMaxBytes: number;
      openSessionsMax: number;
    }>();
  });
});

describe("loadSessionsConfig — defaults", () => {
  test("resolves every default when no env vars are set — the subsystem is never 'not configured'", () => {
    const config = loadSessionsConfig({ env: {} });

    expect(config).toEqual(DEFAULTS);
  });

  test("loadSessionsConfig is callable with no options at all", () => {
    expectTypeOf(loadSessionsConfig).toBeCallableWith();
  });
});

describe("loadSessionsConfig — every setting overridden", () => {
  test("resolves every overridden env var into the config", () => {
    const config = loadSessionsConfig({
      env: {
        M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: "1024",
        M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: "2048",
        M3L_CONSOLE_SESSIONS_TOTAL_MAX_BYTES: "4096",
        M3L_CONSOLE_SESSIONS_OPEN_MAX: "8",
      },
    });

    expect(config).toEqual({
      artifactInlineMaxBytes: 1024,
      artifactMaxBytes: 2048,
      sessionTotalMaxBytes: 4096,
      openSessionsMax: 8,
    });
  });
});

describe("loadSessionsConfig — artifact inline max bytes validation", () => {
  test.each<[string]>([["0"], ["-1"], ["not-an-int"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for artifact-inline-max-bytes %s",
    (value) => {
      expectSessionsConfigError(() =>
        loadSessionsConfig({
          env: { M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: value },
        }),
      );
    },
  );

  test("accepts the boundary of 1", () => {
    const config = loadSessionsConfig({
      env: {
        M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: "1",
        // artifactMaxBytes must stay >= the inline cap.
        M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: "1",
      },
    });
    expect(config.artifactInlineMaxBytes).toBe(1);
  });
});

describe("loadSessionsConfig — artifact max bytes validation", () => {
  test.each<[string]>([["0"], ["-1"], ["not-an-int"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for artifact-max-bytes %s",
    (value) => {
      expectSessionsConfigError(() =>
        loadSessionsConfig({
          env: { M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: value },
        }),
      );
    },
  );

  test("accepts artifactMaxBytes exactly equal to artifactInlineMaxBytes (the >= boundary)", () => {
    const config = loadSessionsConfig({
      env: {
        M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: "5000",
        M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: "5000",
      },
    });
    expect(config.artifactMaxBytes).toBe(5000);
    expect(config.artifactInlineMaxBytes).toBe(5000);
  });
});

describe("loadSessionsConfig — artifact max bytes must be >= artifact inline max bytes (cross-field)", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID when artifactMaxBytes is itself a valid positive integer but less than artifactInlineMaxBytes", () => {
    // Both arms are reachable in this setup: artifactMaxBytes=100 passes its
    // own standalone "positive integer" check on its own — only the
    // cross-field comparison against artifactInlineMaxBytes=200 can reject
    // it, discriminating this check from the standalone one above.
    expectSessionsConfigError(() =>
      loadSessionsConfig({
        env: {
          M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: "200",
          M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: "100",
        },
      }),
    );
  });
});

describe("loadSessionsConfig — session total max bytes validation", () => {
  test.each<[string]>([["0"], ["-1"], ["not-an-int"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for session-total-max-bytes %s",
    (value) => {
      expectSessionsConfigError(() =>
        loadSessionsConfig({
          env: { M3L_CONSOLE_SESSIONS_TOTAL_MAX_BYTES: value },
        }),
      );
    },
  );

  test("accepts sessionTotalMaxBytes exactly equal to artifactMaxBytes (the >= boundary)", () => {
    const config = loadSessionsConfig({
      env: {
        M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: "1000",
        M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: "5000",
        M3L_CONSOLE_SESSIONS_TOTAL_MAX_BYTES: "5000",
      },
    });
    expect(config.sessionTotalMaxBytes).toBe(5000);
    expect(config.artifactMaxBytes).toBe(5000);
  });
});

describe("loadSessionsConfig — session total max bytes must be >= artifact max bytes (cross-field)", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID when sessionTotalMaxBytes is itself a valid positive integer but less than artifactMaxBytes", () => {
    // Both arms are reachable: sessionTotalMaxBytes=1000 passes its own
    // standalone "positive integer" check AND is >= nothing else on its
    // own — only the cross-field comparison against artifactMaxBytes=2000
    // (itself already valid, >= a smaller artifactInlineMaxBytes) rejects it.
    expectSessionsConfigError(() =>
      loadSessionsConfig({
        env: {
          M3L_CONSOLE_SESSIONS_ARTIFACT_INLINE_MAX_BYTES: "500",
          M3L_CONSOLE_SESSIONS_ARTIFACT_MAX_BYTES: "2000",
          M3L_CONSOLE_SESSIONS_TOTAL_MAX_BYTES: "1000",
        },
      }),
    );
  });
});

describe("loadSessionsConfig — open sessions max validation", () => {
  test.each<[string]>([["0"], ["-1"], ["not-an-int"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for open-sessions-max %s",
    (value) => {
      expectSessionsConfigError(() =>
        loadSessionsConfig({
          env: { M3L_CONSOLE_SESSIONS_OPEN_MAX: value },
        }),
      );
    },
  );

  test("accepts the boundary of 1, with no cross-field relation to any other setting", () => {
    const config = loadSessionsConfig({
      env: { M3L_CONSOLE_SESSIONS_OPEN_MAX: "1" },
    });
    expect(config.openSessionsMax).toBe(1);
  });
});

describe("loadSessionsConfig — never mutates process.env", () => {
  test("does not touch the real process.env when env is injected", () => {
    const before = { ...process.env };

    loadSessionsConfig({
      env: { M3L_CONSOLE_SESSIONS_OPEN_MAX: "8" },
    });

    expect(process.env).toEqual(before);
  });
});

describe("loadSessionsConfig — never mutates the passed env", () => {
  test("does not mutate the env object it is handed", () => {
    const env: NodeJS.ProcessEnv = {
      M3L_CONSOLE_SESSIONS_OPEN_MAX: "8",
    };
    const before = { ...env };

    loadSessionsConfig({ env });

    expect(env).toEqual(before);
  });
});
