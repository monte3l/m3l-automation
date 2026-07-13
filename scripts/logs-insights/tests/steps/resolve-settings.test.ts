import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  resolveSettings,
  type LogsInsightsRunSettings,
} from "../../src/steps/resolve-settings.js";

/**
 * Contract: docs/reference/scripts/logs-insights.md, `resolve-settings` row +
 * the "Required parameters" paragraph. Parses the resolved config into a
 * typed run-settings object: ISO-8601 `start`/`end` -> epoch seconds
 * (throwing on an unparseable string or `start >= end`), plus the
 * pass-through fields. `start`/`end` presence/non-emptiness is already
 * enforced by the declared config schema (`required: true` +
 * `Core.M3LConfigValidators.nonEmpty`) before `config` ever reaches this
 * function — this module owns only the cross-parameter/format guard the
 * per-parameter validators cannot express.
 */

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

const VALID_VALUES: Record<string, unknown> = {
  "aws.profile": "my-profile",
  logGroups: ["/aws/lambda/a", "/aws/lambda/b"],
  query: "fields @timestamp, @message",
  start: "2026-07-01T00:00:00Z",
  end: "2026-07-01T01:00:00Z",
  windowMinutes: 60,
  format: "json",
  output: "results.json",
  resume: false,
};

describe("resolveSettings", () => {
  it("converts ISO-8601 start/end to epoch seconds and passes through the rest", () => {
    const settings = resolveSettings(buildConfig(VALID_VALUES));

    expect(settings.startEpochSeconds).toBe(
      Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000),
    );
    expect(settings.endEpochSeconds).toBe(
      Math.floor(Date.parse("2026-07-01T01:00:00Z") / 1000),
    );
    expect(settings.logGroups).toEqual(["/aws/lambda/a", "/aws/lambda/b"]);
    expect(settings.query).toBe("fields @timestamp, @message");
    expect(settings.windowMinutes).toBe(60);
    expect(settings.format).toBe("json");
    expect(settings.output).toBe("results.json");
    expect(settings.resume).toBe(false);
    expect(settings.limit).toBeUndefined();
  });

  it("passes through an optional limit when set", () => {
    const settings = resolveSettings(
      buildConfig({ ...VALID_VALUES, limit: 500 }),
    );
    expect(settings.limit).toBe(500);
  });

  it("throws an M3LError when 'start' is not a parseable ISO-8601 date", () => {
    const config = buildConfig({ ...VALID_VALUES, start: "not-a-date" });

    expect(() => resolveSettings(config)).toThrowError(Core.M3LError);
    let thrown: unknown;
    try {
      resolveSettings(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
  });

  it("throws an M3LError when 'end' is not a parseable ISO-8601 date", () => {
    const config = buildConfig({ ...VALID_VALUES, end: "not-a-date" });

    expect(() => resolveSettings(config)).toThrowError(Core.M3LError);
  });

  it("throws an M3LError when 'start' is equal to 'end'", () => {
    const config = buildConfig({
      ...VALID_VALUES,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-01T00:00:00Z",
    });

    expect(() => resolveSettings(config)).toThrowError(Core.M3LError);
  });

  it("throws an M3LError when 'start' is after 'end'", () => {
    const config = buildConfig({
      ...VALID_VALUES,
      start: "2026-07-01T02:00:00Z",
      end: "2026-07-01T01:00:00Z",
    });

    let thrown: unknown;
    try {
      resolveSettings(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toEqual(expect.any(String));
  });

  it("returns the LogsInsightsRunSettings shape (type contract)", () => {
    expectTypeOf<LogsInsightsRunSettings>().toMatchTypeOf<{
      logGroups: readonly string[];
      query: string;
      startEpochSeconds: number;
      endEpochSeconds: number;
      windowMinutes: number;
      limit: number | undefined;
      format: "json" | "csv";
      output: string;
      resume: boolean;
    }>();
  });
});
