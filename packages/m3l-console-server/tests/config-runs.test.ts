/**
 * Tests for src/config/runs.ts — `loadRunsConfig` (m3l-console-server X4
 * run-governor contract). Every case injects `env` explicitly; `process.env`
 * is never mutated. Mirrors the `config/env.ts` test style
 * (`tests/env.test.ts`): defaults, every-override, and one validation test
 * per rejected knob.
 */
import * as path from "node:path";

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { loadRunsConfig } from "../src/config/runs.js";
import type {
  LoadRunsConfigOptions,
  M3LConsoleRunsConfig,
} from "../src/config/runs.js";

/** Node's maximum representable 32-bit signed timer delay. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Builds a minimal valid env, then applies `overrides` on top. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    M3L_CONSOLE_RUNS_SCRIPTS_DIR: "/scripts",
    ...overrides,
  };
}

/** Asserts that `fn` throws an `M3LConsoleError` with the given code. */
function expectRunsConfigError(
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

describe("M3LConsoleRunsConfig", () => {
  test("has the exact field shape and readonly types the contract declares", () => {
    expectTypeOf<M3LConsoleRunsConfig>().toEqualTypeOf<{
      readonly scriptsDir: string;
      readonly maxPerScript: number;
      readonly queueCapacity: number;
      readonly streamRetention: number;
      readonly killTimeoutMs: number;
      readonly maxConcurrency: number;
      readonly queueTimeoutMs: number;
    }>();
  });
});

describe("LoadRunsConfigOptions", () => {
  test("has the exact optional-env shape", () => {
    expectTypeOf<LoadRunsConfigOptions>().toEqualTypeOf<{
      readonly env?: NodeJS.ProcessEnv;
    }>();
  });
});

describe("loadRunsConfig — defaults", () => {
  test("resolves every default when only the scripts dir is set", () => {
    const config = loadRunsConfig({
      env: { M3L_CONSOLE_RUNS_SCRIPTS_DIR: "/scripts" },
    });

    expect(config).toEqual({
      scriptsDir: path.resolve("/scripts"),
      maxPerScript: 1,
      queueCapacity: 16,
      streamRetention: 256,
      killTimeoutMs: 5000,
      maxConcurrency: 4,
      queueTimeoutMs: 30000,
    });
  });
});

describe("loadRunsConfig — every setting overridden", () => {
  test("resolves every overridden env var into the config", () => {
    const config = loadRunsConfig({
      env: buildEnv({
        M3L_CONSOLE_RUNS_MAX_PER_SCRIPT: "2",
        M3L_CONSOLE_RUNS_QUEUE_CAPACITY: "32",
        M3L_CONSOLE_RUNS_STREAM_RETENTION: "512",
        M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS: "9000",
        M3L_CONSOLE_RUNS_MAX_CONCURRENCY: "8",
        M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS: "60000",
      }),
    });

    expect(config).toEqual({
      scriptsDir: path.resolve("/scripts"),
      maxPerScript: 2,
      queueCapacity: 32,
      streamRetention: 512,
      killTimeoutMs: 9000,
      maxConcurrency: 8,
      queueTimeoutMs: 60000,
    });
  });
});

describe("loadRunsConfig — scripts dir validation", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID when M3L_CONSOLE_RUNS_SCRIPTS_DIR is missing", () => {
    expectRunsConfigError(() =>
      loadRunsConfig({
        env: buildEnv({ M3L_CONSOLE_RUNS_SCRIPTS_DIR: undefined }),
      }),
    );
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID for an empty scripts dir", () => {
    expectRunsConfigError(() =>
      loadRunsConfig({
        env: buildEnv({ M3L_CONSOLE_RUNS_SCRIPTS_DIR: "" }),
      }),
    );
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID for a whitespace-only scripts dir", () => {
    expectRunsConfigError(() =>
      loadRunsConfig({
        env: buildEnv({ M3L_CONSOLE_RUNS_SCRIPTS_DIR: "   " }),
      }),
    );
  });

  test("resolves an already-absolute scripts dir via path.resolve", () => {
    const config = loadRunsConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_SCRIPTS_DIR: "/abs/path" }),
    });
    expect(config.scriptsDir).toBe(path.resolve("/abs/path"));
  });

  test("resolves a relative scripts dir to an absolute path under process.cwd()", () => {
    const config = loadRunsConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_SCRIPTS_DIR: "./rel" }),
    });
    expect(path.isAbsolute(config.scriptsDir)).toBe(true);
    expect(config.scriptsDir).toBe(path.resolve(process.cwd(), "./rel"));
  });
});

describe("loadRunsConfig — max per script validation", () => {
  test.each<[string]>([["0"], ["-1"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for max-per-script %s",
    (value) => {
      expectRunsConfigError(() =>
        loadRunsConfig({
          env: buildEnv({ M3L_CONSOLE_RUNS_MAX_PER_SCRIPT: value }),
        }),
      );
    },
  );

  test("accepts the boundary max-per-script of 1", () => {
    const config = loadRunsConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_MAX_PER_SCRIPT: "1" }),
    });
    expect(config.maxPerScript).toBe(1);
  });
});

describe("loadRunsConfig — queue capacity validation", () => {
  test("throws ERR_CONSOLE_CONFIG_INVALID for a negative queue capacity", () => {
    expectRunsConfigError(() =>
      loadRunsConfig({
        env: buildEnv({ M3L_CONSOLE_RUNS_QUEUE_CAPACITY: "-1" }),
      }),
    );
  });

  test("accepts the boundary queue capacity of 0 (no queue)", () => {
    const config = loadRunsConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_QUEUE_CAPACITY: "0" }),
    });
    expect(config.queueCapacity).toBe(0);
  });
});

describe("loadRunsConfig — stream retention validation", () => {
  test.each<[string]>([["0"], ["-1"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for stream retention %s",
    (value) => {
      expectRunsConfigError(() =>
        loadRunsConfig({
          env: buildEnv({ M3L_CONSOLE_RUNS_STREAM_RETENTION: value }),
        }),
      );
    },
  );

  test("accepts the boundary stream retention of 1", () => {
    const config = loadRunsConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_STREAM_RETENTION: "1" }),
    });
    expect(config.streamRetention).toBe(1);
  });
});

describe("loadRunsConfig — kill timeout validation", () => {
  test.each<[string]>([["0"], ["-5"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for the non-positive kill timeout %s",
    (value) => {
      expectRunsConfigError(() =>
        loadRunsConfig({
          env: buildEnv({ M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS: value }),
        }),
      );
    },
  );

  test("accepts the boundary kill timeout of MAX_TIMER_DELAY_MS", () => {
    const config = loadRunsConfig({
      env: buildEnv({
        M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS),
      }),
    });
    expect(config.killTimeoutMs).toBe(MAX_TIMER_DELAY_MS);
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID one above MAX_TIMER_DELAY_MS", () => {
    expectRunsConfigError(() =>
      loadRunsConfig({
        env: buildEnv({
          M3L_CONSOLE_RUNS_KILL_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS + 1),
        }),
      }),
    );
  });
});

describe("loadRunsConfig — max concurrency validation", () => {
  test.each<[string]>([["0"], ["-1"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for max concurrency %s",
    (value) => {
      expectRunsConfigError(() =>
        loadRunsConfig({
          env: buildEnv({ M3L_CONSOLE_RUNS_MAX_CONCURRENCY: value }),
        }),
      );
    },
  );

  test("accepts the boundary max concurrency of 1", () => {
    const config = loadRunsConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_MAX_CONCURRENCY: "1" }),
    });
    expect(config.maxConcurrency).toBe(1);
  });
});

describe("loadRunsConfig — queue timeout validation", () => {
  test.each<[string]>([["0"], ["-5"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for the non-positive queue timeout %s",
    (value) => {
      expectRunsConfigError(() =>
        loadRunsConfig({
          env: buildEnv({ M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS: value }),
        }),
      );
    },
  );

  test("accepts the boundary queue timeout of MAX_TIMER_DELAY_MS", () => {
    const config = loadRunsConfig({
      env: buildEnv({
        M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS),
      }),
    });
    expect(config.queueTimeoutMs).toBe(MAX_TIMER_DELAY_MS);
  });

  test("throws ERR_CONSOLE_CONFIG_INVALID one above MAX_TIMER_DELAY_MS", () => {
    expectRunsConfigError(() =>
      loadRunsConfig({
        env: buildEnv({
          M3L_CONSOLE_RUNS_QUEUE_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS + 1),
        }),
      }),
    );
  });
});

describe("loadRunsConfig — never mutates process.env", () => {
  test("does not touch the real process.env when env is injected", () => {
    const before = { ...process.env };

    loadRunsConfig({ env: buildEnv() });

    expect(process.env).toEqual(before);
  });
});
