/**
 * Tests for src/config/telemetry.ts — `loadTelemetryConfig` (m3l-console-server
 * X8 slice 5a telemetry retention policy). Every case injects `env`
 * explicitly; `process.env` is never mutated. Mirrors `tests/config-runs.test.ts`'s
 * harness technique (`buildEnv`, `expect*ConfigError`, defaults/overrides/
 * validation-per-knob structure).
 *
 * RED: `../src/config/telemetry.ts` does not exist yet — every import below
 * is expected to fail to resolve until the implementer lands it.
 */
import { describe, expect, test } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../src/errors/console-error.js";
import { loadTelemetryConfig } from "../src/config/telemetry.js";
import type {
  LoadTelemetryConfigOptions,
  M3LConsoleTelemetryConfig,
} from "../src/config/telemetry.js";
import { TELEMETRY_GRANULARITIES } from "../src/store/telemetry-validation.js";

/** The three documented default retention windows, in milliseconds. */
const DEFAULT_MINUTE_RETENTION_MS = 172_800_000;
const DEFAULT_HOUR_RETENTION_MS = 2_678_400_000;
const DEFAULT_DAY_RETENTION_MS = 31_622_400_000;

/** Builds a minimal valid env, then applies `overrides` on top. */
function buildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { ...overrides };
}

/** Asserts that `fn` throws an `M3LConsoleError` with the given code. */
function expectTelemetryConfigError(
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

describe("LoadTelemetryConfigOptions", () => {
  test("has the exact optional-env shape", () => {
    const options: LoadTelemetryConfigOptions = {};
    expect(options).toEqual({});
  });
});

describe("loadTelemetryConfig — defaults", () => {
  test("resolves the documented default for every tier when unset", () => {
    const config: M3LConsoleTelemetryConfig = loadTelemetryConfig({
      env: buildEnv(),
    });

    expect(config).toEqual({
      retentionMs: {
        minute: DEFAULT_MINUTE_RETENTION_MS,
        hour: DEFAULT_HOUR_RETENTION_MS,
        day: DEFAULT_DAY_RETENTION_MS,
      },
    });
  });

  test("resolves every default with no options argument at all", () => {
    const config = loadTelemetryConfig();

    expect(config.retentionMs).toEqual({
      minute: DEFAULT_MINUTE_RETENTION_MS,
      hour: DEFAULT_HOUR_RETENTION_MS,
      day: DEFAULT_DAY_RETENTION_MS,
    });
  });
});

describe("loadTelemetryConfig — every setting overridden", () => {
  test("resolves every overridden env var into the config", () => {
    const config = loadTelemetryConfig({
      env: buildEnv({
        M3L_CONSOLE_TELEMETRY_RETENTION_MINUTE_MS: "3600000",
        M3L_CONSOLE_TELEMETRY_RETENTION_HOUR_MS: "86400000",
        M3L_CONSOLE_TELEMETRY_RETENTION_DAY_MS: "2592000000",
      }),
    });

    expect(config).toEqual({
      retentionMs: {
        minute: 3_600_000,
        hour: 86_400_000,
        day: 2_592_000_000,
      },
    });
  });
});

describe.each<[string, string, "minute" | "hour" | "day"]>([
  ["minute", "M3L_CONSOLE_TELEMETRY_RETENTION_MINUTE_MS", "minute"],
  ["hour", "M3L_CONSOLE_TELEMETRY_RETENTION_HOUR_MS", "hour"],
  ["day", "M3L_CONSOLE_TELEMETRY_RETENTION_DAY_MS", "day"],
])("loadTelemetryConfig — %s retention validation", (_label, envVar, tier) => {
  test.each<[string]>([["0"], ["-1"], ["1.5"]])(
    `throws ERR_CONSOLE_CONFIG_INVALID for ${tier} retention %s`,
    (value) => {
      expectTelemetryConfigError(() =>
        loadTelemetryConfig({
          env: buildEnv({ [envVar]: value }),
        }),
      );
    },
  );

  test(`accepts the boundary ${tier} retention of 1`, () => {
    const config = loadTelemetryConfig({
      env: buildEnv({ [envVar]: "1" }),
    });
    expect(config.retentionMs[tier]).toBe(1);
  });
});

describe("loadTelemetryConfig — never mutates process.env", () => {
  test("does not touch the real process.env when env is injected", () => {
    const before = { ...process.env };

    loadTelemetryConfig({ env: buildEnv() });

    expect(process.env).toEqual(before);
  });
});

/**
 * The three documented dotted config keys, asserted literally — these must
 * match `docs/reference/console.md`'s configuration table exactly. Deriving
 * each key's env-var name via `Core.deriveEnvVarName` (the same transform
 * `M3LEnvironmentConfigProvider` applies internally) and then confirming
 * that overriding under THAT derived name actually changes the resolved
 * config is a non-vacuous pin: a silent rename of any dotted key changes
 * the derived env-var name, the override below then misses, and the
 * config falls back to its default instead of the distinct probe value —
 * failing this test rather than only making the docs wrong.
 */
const DOTTED_RETENTION_KEYS = {
  minute: "m3l.console.telemetry.retention.minute.ms",
  hour: "m3l.console.telemetry.retention.hour.ms",
  day: "m3l.console.telemetry.retention.day.ms",
} as const;

describe("dotted config key drift pin", () => {
  test("declares exactly the three documented dotted keys, one per store granularity tier", () => {
    expect(Object.keys(DOTTED_RETENTION_KEYS).sort()).toEqual(
      Object.keys(TELEMETRY_GRANULARITIES).sort(),
    );
  });

  test("each literal dotted key's derived env var actually drives its resolved tier", () => {
    const config = loadTelemetryConfig({
      env: buildEnv({
        [Core.deriveEnvVarName(DOTTED_RETENTION_KEYS.minute)]: "11",
        [Core.deriveEnvVarName(DOTTED_RETENTION_KEYS.hour)]: "22",
        [Core.deriveEnvVarName(DOTTED_RETENTION_KEYS.day)]: "33",
      }),
    });

    expect(config.retentionMs).toEqual({ minute: 11, hour: 22, day: 33 });
  });
});
