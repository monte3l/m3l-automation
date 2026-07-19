import { describe, expect, expectTypeOf, it } from "vitest";

import { Core } from "@m3l-automation/m3l-common";

import {
  resolveAthenaSettings,
  type AthenaQuerySettings,
} from "../../src/steps/resolve-settings.js";

/**
 * Contract: docs/reference/scripts/athena-query.md, `resolve-settings` row +
 * the "Configuration schema" table. Narrows the resolved config into a typed
 * `AthenaQuerySettings`, building `StartAthenaQueryInput` and omitting any
 * unset optional field. `config.ts`'s declared schema already enforces
 * presence/non-emptiness of required parameters at config-load time — this
 * module owns only the per-field type narrowing `M3LConfig#get` cannot
 * express (it returns `unknown`).
 */

function buildConfig(values: Record<string, unknown>): Core.M3LConfig {
  const config = new Core.M3LConfig();
  for (const [key, value] of Object.entries(values)) {
    config.set(key, value);
  }
  return config;
}

const VALID_VALUES: Record<string, unknown> = {
  queryString: "SELECT * FROM orders",
  database: "analytics",
  catalog: "AwsDataCatalog",
  outputLocation: "s3://my-bucket/results/",
  workGroup: "primary",
  executionParameters: ["a", "b"],
  format: "json",
  output: "results.json",
  resume: false,
};

describe("resolveAthenaSettings", () => {
  it("builds the StartAthenaQueryInput and passes through format/output/resume", () => {
    const settings = resolveAthenaSettings(buildConfig(VALID_VALUES));

    expect(settings.startInput).toEqual({
      queryString: "SELECT * FROM orders",
      database: "analytics",
      catalog: "AwsDataCatalog",
      outputLocation: "s3://my-bucket/results/",
      workGroup: "primary",
      executionParameters: ["a", "b"],
    });
    expect(settings.format).toBe("json");
    expect(settings.output).toBe("results.json");
    expect(settings.resume).toBe(false);
  });

  it("omits unset optional fields from startInput rather than passing undefined", () => {
    const settings = resolveAthenaSettings(
      buildConfig({
        queryString: "SELECT 1",
        format: "csv",
        output: "out.csv",
        resume: true,
      }),
    );

    expect(settings.startInput).toEqual({ queryString: "SELECT 1" });
    expect("database" in settings.startInput).toBe(false);
    expect("executionParameters" in settings.startInput).toBe(false);
    expect(settings.format).toBe("csv");
    expect(settings.resume).toBe(true);
  });

  it("throws an M3LError coded ERR_ATHENA_SETTINGS when 'queryString' resolves to a non-string value", () => {
    const config = buildConfig({ ...VALID_VALUES, queryString: 123 });

    expect(() => resolveAthenaSettings(config)).toThrowError(Core.M3LError);
    let thrown: unknown;
    try {
      resolveAthenaSettings(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ATHENA_SETTINGS");
  });

  it("throws ERR_ATHENA_SETTINGS when an optional string field resolves to a non-string value", () => {
    const config = buildConfig({ ...VALID_VALUES, database: 42 });

    let thrown: unknown;
    try {
      resolveAthenaSettings(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ATHENA_SETTINGS");
  });

  it("throws ERR_ATHENA_SETTINGS when 'executionParameters' resolves to a non-array value", () => {
    const config = buildConfig({
      ...VALID_VALUES,
      executionParameters: "not-an-array",
    });

    expect(() => resolveAthenaSettings(config)).toThrowError(Core.M3LError);
  });

  it("throws ERR_ATHENA_SETTINGS when 'executionParameters' contains a non-string element", () => {
    const config = buildConfig({
      ...VALID_VALUES,
      executionParameters: ["ok", 5],
    });

    expect(() => resolveAthenaSettings(config)).toThrowError(Core.M3LError);
  });

  it("throws ERR_ATHENA_SETTINGS when 'output' resolves to a non-string value", () => {
    const config = buildConfig({ ...VALID_VALUES, output: null });

    expect(() => resolveAthenaSettings(config)).toThrowError(Core.M3LError);
  });

  it("throws ERR_ATHENA_SETTINGS when 'format' resolves to an unsupported value", () => {
    const config = buildConfig({ ...VALID_VALUES, format: "xml" });

    let thrown: unknown;
    try {
      resolveAthenaSettings(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Core.M3LError);
    expect((thrown as Core.M3LError).code).toBe("ERR_ATHENA_SETTINGS");
  });

  it("throws ERR_ATHENA_SETTINGS when 'resume' resolves to a non-boolean value", () => {
    const config = buildConfig({ ...VALID_VALUES, resume: "true" });

    expect(() => resolveAthenaSettings(config)).toThrowError(Core.M3LError);
  });

  it("returns the AthenaQuerySettings shape (type contract)", () => {
    expectTypeOf<AthenaQuerySettings>().toMatchTypeOf<{
      startInput: { queryString: string };
      format: "json" | "csv";
      output: string;
      resume: boolean;
    }>();
  });
});
