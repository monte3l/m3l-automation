/**
 * Tests for src/config/retention.ts — `loadRetentionConfig` (m3l-console-server
 * X8 slice 5b run-output retention policy). Every case injects `env`
 * explicitly; `process.env` is never mutated. Mirrors
 * `tests/config-telemetry.test.ts`'s harness technique (`buildEnv`,
 * `expect*ConfigError`, defaults/overrides/validation-per-knob structure).
 *
 * RED: `../src/config/retention.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands it.
 */
import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { loadRetentionConfig } from "../src/config/retention.js";
import type {
  LoadRetentionConfigOptions,
  M3LConsoleRetentionConfig,
} from "../src/config/retention.js";

/** The documented default run-output retention window, in milliseconds (30 days). */
const DEFAULT_RUN_OUTPUT_RETENTION_MS = 2_592_000_000;

/** Builds a minimal valid env, then applies `overrides` on top. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { ...overrides };
}

/** Asserts that `fn` throws an `M3LConsoleError` with the given code. */
function expectRetentionConfigError(
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

describe("LoadRetentionConfigOptions", () => {
  test("has the exact optional-env shape", () => {
    const options: LoadRetentionConfigOptions = {};
    expect(options).toEqual({});
  });
});

describe("loadRetentionConfig — defaults", () => {
  test("resolves the documented default when unset", () => {
    const config: M3LConsoleRetentionConfig = loadRetentionConfig({
      env: buildEnv(),
    });

    expect(config).toEqual({
      runOutputMs: DEFAULT_RUN_OUTPUT_RETENTION_MS,
    });
  });

  test("resolves the default with no options argument at all", () => {
    const config = loadRetentionConfig();

    expect(config.runOutputMs).toBe(DEFAULT_RUN_OUTPUT_RETENTION_MS);
  });
});

describe("loadRetentionConfig — overridden", () => {
  test("resolves the overridden env var into the config", () => {
    const config = loadRetentionConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS: "3600000" }),
    });

    expect(config).toEqual({ runOutputMs: 3_600_000 });
  });
});

describe("loadRetentionConfig — validation", () => {
  test.each<[string]>([["0"], ["-1"], ["1.5"]])(
    "throws ERR_CONSOLE_CONFIG_INVALID for run-output retention %s",
    (value) => {
      expectRetentionConfigError(() =>
        loadRetentionConfig({
          env: buildEnv({ M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS: value }),
        }),
      );
    },
  );

  test("accepts the boundary run-output retention of 1", () => {
    const config = loadRetentionConfig({
      env: buildEnv({ M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS: "1" }),
    });
    expect(config.runOutputMs).toBe(1);
  });

  test("accepts a very large value, the documented way to effectively disable the sweep", () => {
    const config = loadRetentionConfig({
      env: buildEnv({
        M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS: "9007199254740991",
      }),
    });
    expect(config.runOutputMs).toBe(9_007_199_254_740_991);
  });
});

describe("loadRetentionConfig — never mutates process.env", () => {
  test("does not touch the real process.env when env is injected", () => {
    const before = { ...process.env };

    loadRetentionConfig({ env: buildEnv() });

    expect(process.env).toEqual(before);
  });
});

/**
 * The documented dotted config key, asserted literally — this must match
 * `docs/reference/console.md`'s configuration table exactly. Deriving the
 * env-var name via `Core.deriveEnvVarName` (the same transform
 * `M3LEnvironmentConfigProvider` applies internally) and then confirming
 * that overriding under THAT derived name actually changes the resolved
 * config is a non-vacuous pin: a silent rename of the dotted key changes
 * the derived env-var name, the override below then misses, and the config
 * falls back to its default instead of the distinct probe value — failing
 * this test rather than only making the docs wrong.
 */
const RUN_OUTPUT_RETENTION_DOTTED_KEY = "m3l.console.runs.output.retention.ms";

describe("dotted config key drift pin", () => {
  test("the literal dotted key's derived env var actually drives the resolved config", () => {
    const config = loadRetentionConfig({
      env: buildEnv({
        [Core.deriveEnvVarName(RUN_OUTPUT_RETENTION_DOTTED_KEY)]: "42",
      }),
    });

    expect(config.runOutputMs).toBe(42);
  });

  test("the derived env var name matches the documented M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS literal", () => {
    expect(Core.deriveEnvVarName(RUN_OUTPUT_RETENTION_DOTTED_KEY)).toBe(
      "M3L_CONSOLE_RUNS_OUTPUT_RETENTION_MS",
    );
  });
});
